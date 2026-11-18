#!/usr/bin/env node
/**
 * cli.js — 不装进 dsh 也能单独跑池子网关（任何 OpenAI 兼容客户端都能用）。
 *
 *   node lib/cli.js --config pool.json [--port 17890] [--timeout 60000]
 *   DSH_POOL_ENTRIES='[{"baseUrl":"...","model":"...","apiKeyEnv":"..."}]' node lib/cli.js
 */

import { readFileSync } from 'node:fs'
import { createPoolServer } from './pool.js'

function parseArgs(argv) {
  const args = { port: 17890, timeout: 60_000, breakerThreshold: 3, breakerCooldown: 60_000 }
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]
    if (a === '--config') args.config = argv[++i]
    else if (a === '--port') args.port = Number(argv[++i])
    else if (a === '--timeout') args.timeout = Number(argv[++i])
    else if (a === '--breaker-threshold') args.breakerThreshold = Number(argv[++i])
    else if (a === '--breaker-cooldown') args.breakerCooldown = Number(argv[++i])
    else if (a === '--help' || a === '-h') args.help = true
  }
  return args
}

const args = parseArgs(process.argv.slice(2))

if (args.help) {
  console.log('用法：node lib/cli.js --config pool.json [--port 17890] [--timeout 60000]')
  process.exit(0)
}

let entries
try {
  if (process.env.DSH_POOL_ENTRIES) entries = JSON.parse(process.env.DSH_POOL_ENTRIES)
  else if (args.config) entries = JSON.parse(readFileSync(args.config, 'utf8'))
  else throw new Error('需要 --config <文件> 或环境变量 DSH_POOL_ENTRIES')
} catch (error) {
  console.error(`读取池配置失败：${error.message}`)
  process.exit(1)
}

const pool = createPoolServer({
  entries,
  attemptTimeoutMs: args.timeout,
  breakerThreshold: args.breakerThreshold,
  breakerCooldownMs: args.breakerCooldown,
  onAttempts: (attempts) => {
    console.log(`[${new Date().toISOString()}] ${attempts.map((a) => `${a.name}:${a.outcome}${a.reason ? `（${a.reason}）` : ''}`).join(' → ')}`)
  },
})

const addr = await pool.listen(args.port)
console.log(`dsh-pool 网关已启动：http://127.0.0.1:${addr.port}/v1`)
console.log(`成员顺序：${pool.entries.map((e) => `${e.name}（${e.model} @ ${e.baseUrl}）`).join(' → ')}`)
console.log('把客户端的 base URL 指向上面的地址即可；Ctrl+C 停止。')

process.on('SIGINT', async () => {
  await pool.close()
  process.exit(0)
})
