/**
 * dsh-pool — DeepSeek Harness 模型池故障转移插件。
 *
 * 在本机起一个 OpenAI 兼容的池子网关（默认 127.0.0.1:17890）：
 * dsh 里把一个自定义 provider 指向这个网关，请求会按池顺序尝试成员，
 * 超时 / 429 / 5xx / 网络错就自动换下一个，会话不中断，
 * 不用把整段对话重新发一遍去浪费时间和 token。
 *
 * 成员列表是 JSON：config.poolFile 指向文件，或环境变量
 * DSH_POOL_ENTRIES 直接给 JSON 字符串。每项：
 *   { "name": "mimo", "baseUrl": "https://.../v1", "model": "MiMo-V2.6-Flash",
 *     "apiKeyEnv": "AMD_API_KEY", "timeoutMs": 60000 }
 * 密钥只从 apiKeyEnv 读，绝不写进配置文件或日志。
 */

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { defineTool } from '@deepseek-ai/dsh-tools'
import z from '@deepseek-ai/schemastery'
import { createPoolServer } from './pool.js'

export const name = 'pool'

export const inject = ['tools', 'systemPrompt']

export const Config = z.object({
  port: z.number().default(17890),
  poolFile: z.string().default(''),
  attemptTimeoutMs: z.number().default(60_000),
  breakerThreshold: z.number().default(3),
  breakerCooldownMs: z.number().default(60_000),
})

const GUIDANCE = [
  '当前会话的模型请求经过 dsh-pool 池子网关：池中有多个备用模型，一个超时或被上游拒绝会自动换下一个，属正常现象，不要因为一次切换而重复发送用户的请求。',
  '可用 pool_status 查看池成员和最近的切换记录；只有当它报告全部成员失败时，才需要把失败原因告诉用户。',
  '成员若是中转站：它以 200 返回 error、或连续失败触发熔断冷却，都属池子的正常处理，pool_status 里能看到熔断状态。',
].join('')

function loadEntries(config) {
  if (process.env.DSH_POOL_ENTRIES) {
    return JSON.parse(process.env.DSH_POOL_ENTRIES)
  }
  const file = config.poolFile || join(homedir(), '.dsh', 'dsh-pool.json')
  return JSON.parse(readFileSync(file, 'utf8'))
}

export function apply(ctx, config) {
  const resolved = {
    port: config?.port ?? 17890,
    poolFile: config?.poolFile ?? '',
    attemptTimeoutMs: config?.attemptTimeoutMs ?? 60_000,
    breakerThreshold: config?.breakerThreshold ?? 3,
    breakerCooldownMs: config?.breakerCooldownMs ?? 60_000,
  }

  const log = (message) => {
    try {
      ctx.logger?.('dsh-pool')?.info?.(message)
    } catch {
      /* 日志不能影响插件 */
    }
  }

  let pool = null
  let loadError = null
  try {
    pool = createPoolServer({
      entries: loadEntries(resolved),
      attemptTimeoutMs: resolved.attemptTimeoutMs,
      breakerThreshold: resolved.breakerThreshold,
      breakerCooldownMs: resolved.breakerCooldownMs,
      onAttempts: (attempts) => {
        const switched = attempts.length > 1 || attempts[0]?.outcome !== 'ok'
        if (switched) {
          log(`请求经历 ${attempts.length} 个成员：${attempts.map((a) => `${a.name}:${a.outcome}`).join(' → ')}`)
        }
      },
    })
  } catch (error) {
    loadError = error
    log(`模型池没能启动：${error.message}（检查 poolFile / DSH_POOL_ENTRIES）`)
  }

  if (pool) {
    ctx.effect(() => {
      let closed = false
      pool.listen(resolved.port).then((addr) => {
        if (!closed) log(`池子网关已启动：http://127.0.0.1:${addr.port}/v1，成员 ${pool.entries.map((e) => e.name).join(' → ')}`)
      })
      return () => {
        closed = true
        void pool.close()
      }
    }, 'dsh-pool.gateway')
  }

  ctx.tools.register(
    defineTool({
      name: 'pool_status',
      description:
        '查看 dsh-pool 模型池的状态：成员顺序、网关地址、最近几次请求的切换记录（哪个成员超时/被拒、最后由谁接住）。用户问“刚才是不是换模型了/为什么变慢了”时调用它。',
      parameters: {},
      output: {
        schema: { type: 'json' },
        render: (_args, value) => [{ type: 'text', text: formatStatus(value) }],
      },
      async execute() {
        if (!pool) {
          return { running: false, error: loadError ? String(loadError.message ?? loadError) : '未知错误' }
        }
        return JSON.parse(
          JSON.stringify({
            running: true,
            address: `http://127.0.0.1:${resolved.port}/v1`,
            entries: pool.entries.map((e) => ({ name: e.name, model: e.model, baseUrl: e.baseUrl })),
            breaker: pool.breakerSnapshot(),
            recent: pool.history.slice(-5),
          }),
        )
      },
    }),
  )

  if (ctx.systemPrompt !== undefined) {
    ctx.systemPrompt.section({
      name: 'tool:dsh_pool',
      order: 3200,
      text: () => (pool ? GUIDANCE : ''),
    })
  }
}

function formatStatus(value) {
  if (!value.running) return `模型池未运行：${value.error ?? ''}。检查插件配置 poolFile 或环境变量 DSH_POOL_ENTRIES。`
  const lines = [`模型池运行中：${value.address}`, `成员顺序：${value.entries.map((e) => `${e.name}（${e.model}）`).join(' → ')}`]
  if (value.breaker?.some((b) => b.failures > 0)) {
    lines.push(
      `熔断（保护）状态：${value.breaker.map((b) => `${b.name} 连续出错 ${b.failures} 次${b.coolingDown ? '，正在休息中' : ''}`).join('；')}`,
    )
  }
  if (value.recent?.length) {
    lines.push('最近请求：')
    for (const h of value.recent) {
      lines.push(`  ${h.at} ${h.attempts.map((a) => `${a.name}:${a.outcome}${a.ms !== undefined ? ` ${a.ms}ms` : ''}`).join(' → ')}`)
    }
  } else {
    lines.push('最近还没有经过池子的请求。')
  }
  return lines.join('\n')
}
