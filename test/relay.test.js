import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { createPoolServer } from '../lib/pool.js'
import { shouldFailover } from '../lib/policy.js'

function fakeUpstream(behavior) {
  const state = { hits: 0 }
  const server = createServer((req, res) => {
    state.hits += 1
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => behavior(req, res))
  })
  return { server, state }
}

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)))
}

const servers = []
async function upstream(behavior) {
  const u = fakeUpstream(behavior)
  servers.push(u.server)
  const port = await listen(u.server)
  return { port, hits: () => u.state.hits }
}

after(() => {
  for (const s of servers) {
    s.closeAllConnections?.()
    s.close()
  }
})

function okJson(text) {
  return (req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: text } }] }))
  }
}

function fake200Error(message, code) {
  return (req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: { code, message } }))
  }
}

function errJson(status, message) {
  return (req, res) => {
    res.writeHead(status, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: { message } }))
  }
}

async function startPool(ports, options = {}) {
  const entries = ports.map((port, i) => ({ name: `m${i}`, baseUrl: `http://127.0.0.1:${port}/v1`, model: `model-${i}` }))
  const pool = createPoolServer({ entries, attemptTimeoutMs: 300, ...options })
  const addr = await pool.listen(0)
  return { pool, url: `http://127.0.0.1:${addr.port}/v1/chat/completions` }
}

async function post(url, payload = { messages: [] }) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
  return { status: response.status, entry: response.headers.get('x-dsh-pool-entry'), body: await response.text() }
}

test('策略：假 200 的渠道错误 → 换；请求错误 → 不换', () => {
  assert.equal(shouldFailover({ relayError: true, message: '无可用渠道' }).failover, true)
  assert.equal(shouldFailover({ relayError: true, code: 'invalid_request_error', message: 'bad' }).failover, false)
})

test('中转站假 200（无可用渠道）→ 换下一个', async () => {
  const relay = await upstream(fake200Error('无可用渠道', 'channel_error'))
  const ok = await upstream(okJson('from-second'))
  const { pool, url } = await startPool([relay.port, ok.port])
  const r = await post(url)
  await pool.close()
  assert.equal(r.status, 200)
  assert.equal(r.entry, 'm1')
  assert.ok(r.body.includes('from-second'))
})

test('中转站假 200 但属于请求错误 → 不换，原样返回', async () => {
  const relay = await upstream(fake200Error('messages 参数错误', 'invalid_request_error'))
  const ok = await upstream(okJson('should-not-be-used'))
  const { pool, url } = await startPool([relay.port, ok.port])
  const r = await post(url)
  await pool.close()
  assert.equal(r.status, 200)
  assert.ok(r.body.includes('messages 参数错误'))
  assert.equal(ok.hits(), 0)
})

test('流式：第一块是 SSE 错误事件 → 换下一个', async () => {
  const relayStream = await upstream((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' })
    res.end('data: {"error":{"code":"channel_error","message":"无可用渠道"}}\n\n')
  })
  const okStream = await upstream((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' })
    res.write('data: {"choices":[{"delta":{"content":"good"}}]}\n\n')
    res.end('data: [DONE]\n\n')
  })
  const { pool, url } = await startPool([relayStream.port, okStream.port])
  const r = await post(url, { messages: [], stream: true })
  await pool.close()
  assert.equal(r.status, 200)
  assert.equal(r.entry, 'm1')
  assert.ok(r.body.includes('good'))
})

test('熔断：连续失败到阈值后跳过该成员，冷却到期后恢复尝试', async () => {
  const dead = await upstream(errJson(503, 'down'))
  const ok = await upstream(okJson('alive'))
  const { pool, url } = await startPool([dead.port, ok.port], { breakerThreshold: 2, breakerCooldownMs: 300 })

  await post(url) // dead 失败 1 次
  await post(url) // dead 失败 2 次 → 进入冷却
  assert.equal(dead.hits(), 2)

  const r3 = await post(url) // 冷却中：不应再打 dead
  assert.equal(r3.status, 200)
  assert.equal(dead.hits(), 2)
  const snap = pool.breakerSnapshot()
  assert.equal(snap[0].coolingDown, true)

  await new Promise((r) => setTimeout(r, 350))
  await post(url) // 冷却到期：重新尝试 dead（仍失败），再落到 ok
  assert.equal(dead.hits(), 3)
  await pool.close()
})

test('熔断：全部成员都在冷却时，仍会回头尝试而不是直接放弃', async () => {
  const a = await upstream(errJson(503, 'down'))
  const b = await upstream(errJson(503, 'down'))
  const { pool, url } = await startPool([a.port, b.port], { breakerThreshold: 1, breakerCooldownMs: 60_000 })

  const r1 = await post(url)
  assert.equal(r1.status, 502)
  assert.equal(a.hits(), 1)
  assert.equal(b.hits(), 1)

  const r2 = await post(url) // 都在冷却 → 回退尝试，两家各再被打一次
  assert.equal(r2.status, 502)
  assert.equal(a.hits(), 2)
  assert.equal(b.hits(), 2)
  await pool.close()
})

test('熔断不误伤：400 这类请求错误不计入失败次数', async () => {
  const bad = await upstream(errJson(400, 'bad request'))
  const ok = await upstream(okJson('unused'))
  const { pool, url } = await startPool([bad.port, ok.port], { breakerThreshold: 1, breakerCooldownMs: 60_000 })
  await post(url)
  await post(url)
  const snap = pool.breakerSnapshot()
  assert.equal(snap[0].failures, 0)
  assert.equal(bad.hits(), 2) // 没被熔断跳过，每次都真的打了
  await pool.close()
})
