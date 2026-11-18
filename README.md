# dsh-pool — dsh 模型池故障转移插件

给 [DeepSeek Harness (dsh)](https://github.com/deepseek-ai/deepseek-harness) 用的模型池插件。

一个模型超时，整个任务就停住，人还得把对话重新发一遍 —— 时间和 token 都白烧。
这个插件把几个模型放进一个池子：请求先打第一个，**超时 / 被上游拒绝就自动换下一个**，
会话不中断，也不用重新调用。

## 它怎么工作

插件在本机起一个 OpenAI 兼容的池子网关（默认 `http://127.0.0.1:17890/v1`）。
在 dsh 里新建一个自定义 provider，把 base URL 指向这个网关即可，请求会按池顺序流动：

```
dsh ──> 池子网关 ──> 成员1（超时 60s 没出字）──╳
              └───> 成员2（429 并发满）──────╳
              └───> 成员3 ──> 正常回答 ✓（对 dsh 完全透明）
```

每次切换都留有记录，用工具 `pool_status` 或网关的 `/health` 能看到成员顺序和最近的切换过程。

## 什么时候换、什么时候不换

| 情况 | 换下一个？ | 理由 |
| --- | --- | --- |
| 超时（时限内没响应/没出第一个字节） | ✅ | 这家卡住了，下一家可能很快 |
| 429 并发满 / 容量不足 | ✅ | 换个不挤的模型 |
| 5xx 上游故障 | ✅ | 这家坏了 |
| 网络错误（连不上/连接断） | ✅ | 这条线路不通 |
| 404 model_not_found | ✅ | 这家没这个模型，下一家可能有 |
| 401 / 403 密钥被拒 | ✅ | 各成员可配不同密钥，这家不认不代表下一家不认 |
| 400 / 413 请求本身有问题 | ❌ | 请求体到哪家都一样，换了白浪费时间，直接把错误返回 |

## 配置

成员列表是一个 JSON 数组，三种给法（优先级从高到低）：

1. 环境变量 `DSH_POOL_ENTRIES` 直接放 JSON 字符串
2. 插件配置 `poolFile` 指向的 JSON 文件
3. 默认文件 `~/.dsh/dsh-pool.json`

每项字段：

```json
{
  "name": "mimo",                 // 池内代号，随便起
  "baseUrl": "https://developer.amd.com.cn/radeon/api/v1",
  "model": "MiMo-V2.6-Flash",     // 该成员实际请求的模型 id
  "apiKeyEnv": "AMD_API_KEY",     // 密钥所在环境变量名（不写明文！）
  "timeoutMs": 60000              // 可选，这个成员的单独超时；不填用全局 attemptTimeoutMs
}
```

仓库里的 [`pool.example.json`](pool.example.json) 是一份现成示例：AMD 免费额度的
MiMo-V2.6-Flash → GLM-5.3-Flash → DeepSeek-V4-Flash 三个模型入池（实测速度排序）。

插件配置（profile 的 `cordis.patch.yml` 里 id 为 `pool` 的行）：

```yaml
config:
  port: 17890              # 网关端口
  poolFile: ''             # 成员 JSON 文件路径，空 = 用 ~/.dsh/dsh-pool.json
  attemptTimeoutMs: 60000  # 全局单次尝试超时：这么久没结果就换下一个
```

## 在 dsh 里接上

1. 安装插件：`dsh plugin --profile web add github:uu-qq/dsh-pool`
2. 写好成员 JSON（参考 `pool.example.json`），密钥放进环境变量
3. dsh 设置 → 模型 → 添加自定义 provider：
   - 类型选 OpenAI 兼容（openai-completions）
   - base URL 填 `http://127.0.0.1:17890/v1`
   - 密钥随便填一个占位值即可（真正的密钥由池成员各自的 `apiKeyEnv` 提供）
   - 模型名填任意池成员的 `name`（从该成员开始），或随便填（从池头开始）
4. 之后正常对话，切换在后台自动发生

## 不装插件也能用：独立网关

```sh
node lib/cli.js --config pool.example.json --port 17890
# 然后把任何 OpenAI 兼容客户端的 base URL 指向 http://127.0.0.1:17890/v1
```

## 必须知道的边界

- **流式回答只能在第一个字节出来之前切换。** 已经开始吐字又中途断开的，接不回另一个模型，只能结束 —— 这是流式协议的物理限制，不是偷懒。
- **超时被切掉的请求，上游可能还在继续生成**，那部分 token 省不回来；池子的价值是让你不用把整段对话重新发一遍、任务不用从头再来。
- 网关只监听 127.0.0.1，不对外暴露；密钥只从环境变量读，不落盘、不进日志。
- 全部成员都失败时，网关返回 502 并列出每个成员的失败原因，不会假装成功。

## 开发

```sh
npm test   # 策略单测 + 网关集成测试（模拟上游：挂起/429/400/流式延迟等，node --test，无外部依赖）
```

目录：

- `lib/index.js` — 插件入口：启动网关、注册 `pool_status` 工具
- `lib/pool.js` — 网关本体：按池顺序尝试、超时切断、流式首字节窗口
- `lib/policy.js` — 纯函数策略：什么失败该换、什么不该换
- `lib/cli.js` — 独立运行入口
- `test/` — 策略与集成测试

## 说明

dsh 还在开发者预览期，插件 API 可能有破坏性变更；本插件按 2026-11 的插件规范（Cordis bundle）编写。MIT 许可。
