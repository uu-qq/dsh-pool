/**
 * pool.js — 模型池网关：一个 OpenAI 兼容的本机端点，背后挂着一串上游模型。
 *
 * 客户端（dsh）把 provider 指向本网关；每个请求按池顺序尝试成员：
 * 先打第一个，超时/429/5xx/网络错就自动换下一个，对客户端完全透明，
 * 会话不用中断、更不用把整段对话重新发一遍。
 *
 * 转移窗口：流式请求在“第一个字节到达之前”可以无损切换；一旦开始往
 * 客户端吐字，中途断了只能结束（已出的内容接不回去），这点必须诚实。
 *
 * 密钥只从成员的 apiKeyEnv 环境变量读取，不写进配置、不出现在日志里。
 */

import { createServer } from 'node:http'
import { shouldFailover } from './policy.js'

export function normalizeEntries(raw) {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new Error('模型池为空：至少要配置一个成员')
  }
  return raw.map((e, i) => {
    if (!e || typeof e.baseUrl !== 'string' || typeof e.model !== 'string') {
      throw new Error(`第 ${i + 1} 个成员缺少 baseUrl 或 model`)
    }
    return {
      name: e.name ?? e.model,
      baseUrl: e.baseUrl.replace(/\/+$/, ''),
      model: e.model,
      apiKeyEnv: e.apiKeyEnv,
      timeoutMs: e.timeoutMs,
    }
  })
}

function keyOf(entry) {
  return entry.apiKeyEnv ? process.env[entry.apiKeyEnv] : undefined
}

async function readBody(req) {
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  return Buffer.concat(chunks).toString('utf8')
}

function sendJson(res, status, value) {
  const body = JSON.stringify(value)
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(body)
}

/**
 * 尝试一个成员。
 * 返回 { done: true } 表示已把响应交给客户端（成功或不可转移的错误）；
 * 返回 { done: false, attempt } 表示按策略应转移到下一个成员。
 */
async function tryEntry(entry, clientBody, { stream, timeoutMs, clientSignal, res }) {
  const started = performance.now()
  const attempt = { name: entry.name, model: entry.model }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new Error('attempt-timeout')), timeoutMs)
  const signals = [controller.signal]
  if (clientSignal) signals.push(clientSignal)
  const signal = signals.length > 1 ? AbortSignal.any(signals) : controller.signal

  let response
  try {
    const key = keyOf(entry)
    response = await fetch(`${entry.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(key ? { Authorization: `Bearer ${key}` } : {}),
      },
      body: JSON.stringify({ ...clientBody, model: entry.model, stream }),
      signal,
    })
  } catch (error) {
    clearTimeout(timer)
    attempt.ms = Math.round(performance.now() - started)
    if (clientSignal?.aborted) {
      attempt.outcome = 'client-aborted'
      return { done: true, attempt }
    }
    const timedOut = error?.cause?.message === 'attempt-timeout' || error?.message === 'attempt-timeout' || error?.name === 'TimeoutError'
    const decision = shouldFailover(
      timedOut
        ? { timedOut: true }
        : { networkError: error?.cause?.code ?? error?.cause?.message ?? error?.message ?? 'fetch failed' },
    )
    attempt.outcome = timedOut ? 'timeout' : 'network-error'
    attempt.reason = decision.reason
    return decision.failover ? { done: false, attempt } : { done: true, attempt, fatal: error }
  }

  // 上游给了 HTTP 错误：读错误体后按策略决定。
  if (!response.ok) {
    clearTimeout(timer)
    const bodyText = await response.text().catch(() => '')
    attempt.ms = Math.round(performance.now() - started)
    attempt.status = response.status
    let code, message
    try {
      const parsed = JSON.parse(bodyText)
      code = parsed?.error?.code
      message = parsed?.error?.message ?? bodyText.slice(0, 200)
    } catch {
      message = bodyText.slice(0, 200)
    }
    const decision = shouldFailover({ status: response.status, code, message })
    attempt.outcome = `http-${response.status}`
    attempt.reason = decision.reason
    if (decision.failover) return { done: false, attempt }
    // 不可转移：把上游的错误原样交回客户端。
    res.writeHead(response.status, {
      'Content-Type': response.headers.get('content-type') ?? 'application/json',
      'x-dsh-pool-entry': entry.name,
    })
    res.end(bodyText)
    return { done: true, attempt }
  }

  // 成功。非流式：整包转发。
  if (!stream) {
    try {
      const bodyText = await response.text()
      clearTimeout(timer)
      attempt.ms = Math.round(performance.now() - started)
      attempt.outcome = 'ok'
      res.writeHead(200, {
        'Content-Type': response.headers.get('content-type') ?? 'application/json',
        'x-dsh-pool-entry': entry.name,
      })
      res.end(bodyText)
      return { done: true, attempt }
    } catch (error) {
      clearTimeout(timer)
      attempt.ms = Math.round(performance.now() - started)
      attempt.outcome = 'network-error'
      attempt.reason = '读取上游响应时连接断开'
      return { done: false, attempt }
    }
  }

  // 流式：第一个字节到达前仍可转移 —— 先读一块再决定是否提交。
  const reader = response.body.getReader()
  let first
  try {
    first = await reader.read()
    clearTimeout(timer)
  } catch (error) {
    clearTimeout(timer)
    attempt.ms = Math.round(performance.now() - started)
    attempt.outcome = 'network-error'
    attempt.reason = '等第一个字节时连接断开'
    return { done: false, attempt }
  }
  if (first.done) {
    attempt.ms = Math.round(performance.now() - started)
    attempt.outcome = 'empty-stream'
    attempt.reason = '上游返回了空流'
    return { done: false, attempt }
  }

  attempt.ms = Math.round(performance.now() - started)
  attempt.outcome = 'ok'
  res.writeHead(200, {
    'Content-Type': response.headers.get('content-type') ?? 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'x-dsh-pool-entry': entry.name,
  })
  res.write(Buffer.from(first.value))
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      res.write(Buffer.from(value))
    }
  } catch {
    // 已经吐过字，中途断开无法再切换，只能结束并在日志里留痕。
    attempt.outcome = 'stream-broken-after-first-byte'
  }
  res.end()
  return { done: true, attempt }
}

export function createPoolServer({ entries, attemptTimeoutMs = 60_000, onAttempts } = {}) {
  const pool = normalizeEntries(entries)
  const history = []

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1')

    if (req.method === 'GET' && url.pathname === '/health') {
      return sendJson(res, 200, { ok: true, entries: pool.map((e) => ({ name: e.name, model: e.model, baseUrl: e.baseUrl })) })
    }
    if (req.method === 'GET' && (url.pathname === '/v1/models' || url.pathname === '/models')) {
      return sendJson(res, 200, {
        object: 'list',
        data: pool.map((e) => ({ id: e.name, object: 'model', owned_by: 'dsh-pool' })),
      })
    }
    if (req.method !== 'POST' || !url.pathname.endsWith('/chat/completions')) {
      return sendJson(res, 404, { error: { message: 'dsh-pool: only POST /v1/chat/completions is supported' } })
    }

    let clientBody
    try {
      clientBody = JSON.parse(await readBody(req))
    } catch {
      return sendJson(res, 400, { error: { message: 'dsh-pool: request body is not valid JSON' } })
    }

    const stream = clientBody.stream === true
    // 客户端点名某个成员（model 等于成员 name 或 model）时从它开始，否则从头。
    let start = pool.findIndex((e) => e.name === clientBody.model || e.model === clientBody.model)
    if (start < 0) start = 0
    const ordered = [...pool.slice(start), ...pool.slice(0, start)]

    const attempts = []
    const clientController = new AbortController()
    let finished = false
    res.on('close', () => {
      finished = true
      clientController.abort(new Error('client-disconnected'))
    })

    for (const entry of ordered) {
      if (finished && !res.writableEnded) break
      const timeoutMs = entry.timeoutMs ?? attemptTimeoutMs
      const result = await tryEntry(entry, clientBody, { stream, timeoutMs, clientSignal: clientController.signal, res })
      attempts.push(result.attempt)
      if (result.done) {
        history.push({ at: new Date().toISOString(), attempts })
        onAttempts?.(attempts)
        return
      }
    }

    history.push({ at: new Date().toISOString(), attempts })
    onAttempts?.(attempts)
    if (!res.headersSent) {
      sendJson(res, 502, {
        error: {
          message: `dsh-pool: 池中 ${attempts.length} 个成员全部失败`,
          attempts,
        },
      })
    } else if (!res.writableEnded) {
      res.end()
    }
  })

  return {
    server,
    history,
    entries: pool,
    listen(port, host = '127.0.0.1') {
      return new Promise((resolve) => server.listen(port, host, () => resolve(server.address())))
    },
    close() {
      server.closeAllConnections?.()
      return new Promise((resolve) => server.close(() => resolve()))
    },
  }
}
