import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { createPoolServer } from '../lib/pool.js'

/** 假上游：按 behavior 决定怎么回。hits 记录被打了几次。 */
function fakeUpstream(behavior) {
  const state = { hits: 0 }
  const server = createServer((req, res) => {
    state.hits += 1
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      const parsed = JSON.parse(body || '{}')
      behavior(req, res, parsed)
    })
  })
  return { server, state }
}

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)))
}

function okJson(text) {
  return (req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: text } }] }))
  }
}

function errJson(status, code, message) {
  return (req, res) => {
    res.writeHead(status, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: { code, message } }))
  }
}

async function startPool(upstreams, attemptTimeoutMs = 300) {
  const entries = []
  for (const [i, port] of upstreams.entries()) {
    entries.push({ name: `m${i}`, baseUrl: `http://127.0.0.1:${port}/v1`, model: `model-${i}` })
  }
  const pool = createPoolServer({ entries, attemptTimeoutMs })
  const addr = await pool.listen(0)
  return { pool, url: `http://127.0.0.1:${addr.port}/v1/chat/completions` }
}

async function post(url, payload) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
  return { status: response.status, entry: response.headers.get('x-dsh-pool-entry'), body: await response.text() }
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

test('主成员挂起超时 → 自动换下一个并拿到回答', async () => {
  const slow = await upstream(() => {
    /* 永不回应，靠池子的超时切断 */
  })
  const fast = await upstream(okJson('from-second'))
  const { pool, url } = await startPool([slow.port, fast.port], 300)
  const r = await post(url, { messages: [{ role: 'user', content: 'hi' }] })
  await pool.close()
  assert.equal(r.status, 200)
  assert.equal(r.entry, 'm1')
  assert.ok(r.body.includes('from-second'))
})

test('主成员 429 → 换下一个', async () => {
  const busy = await upstream(errJson(429, 'model_concurrency_rate_limit_exceeded', 'At capacity'))
  const ok = await upstream(okJson('after-429'))
  const { pool, url } = await startPool([busy.port, ok.port])
  const r = await post(url, { messages: [] })
  await pool.close()
  assert.equal(r.status, 200)
  assert.ok(r.body.includes('after-429'))
})

test('主成员 400 → 不换，原样返回且不打扰下一个', async () => {
  const bad = await upstream(errJson(400, 'bad_request', 'messages is required'))
  const ok = await upstream(okJson('should-not-be-used'))
  const { pool, url } = await startPool([bad.port, ok.port])
  const r = await post(url, { messages: [] })
  await pool.close()
  assert.equal(r.status, 400)
  assert.equal(ok.hits(), 0)
})

test('主成员 model_not_found → 换下一个', async () => {
  const noModel = await upstream(errJson(404, 'model_not_found', 'The model x does not exist'))
  const ok = await upstream(okJson('found-elsewhere'))
  const { pool, url } = await startPool([noModel.port, ok.port])
  const r = await post(url, { messages: [] })
  await pool.close()
  assert.equal(r.status, 200)
  assert.ok(r.body.includes('found-elsewhere'))
})

test('全部失败 → 502 并列出每次尝试', async () => {
  const a = await upstream(errJson(503, 'unavailable', 'down'))
  const b = await upstream(errJson(429, 'rate', 'busy'))
  const { pool, url } = await startPool([a.port, b.port])
  const r = await post(url, { messages: [] })
  await pool.close()
  assert.equal(r.status, 502)
  const parsed = JSON.parse(r.body)
  assert.equal(parsed.error.attempts.length, 2)
})

test('流式：主成员迟迟不出第一个字节 → 换下一个并完整收到流', async () => {
  const slowStream = await upstream((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' })
    setTimeout(() => {
      res.write('data: {"choices":[{"delta":{"content":"slow"}}]}\n\n')
      res.end('data: [DONE]\n\n')
    }, 1500)
  })
  const fastStream = await upstream((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' })
    res.write('data: {"choices":[{"delta":{"content":"fast"}}]}\n\n')
    res.end('data: [DONE]\n\n')
  })
  const { pool, url } = await startPool([slowStream.port, fastStream.port], 300)
  const r = await post(url, { messages: [], stream: true })
  await pool.close()
  assert.equal(r.status, 200)
  assert.equal(r.entry, 'm1')
  assert.ok(r.body.includes('fast'))
  assert.ok(!r.body.includes('slow'))
})
