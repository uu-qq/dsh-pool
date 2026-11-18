/**
 * policy.js — 故障转移策略：一次尝试失败后，换下一个模型还是直接把错误交出去。
 *
 * 原则：只有“换一家可能成功”的失败才转移。
 *   换：超时（迟迟不出字）、网络错误、429 并发满、5xx 上游故障、
 *       404 model_not_found（这个上游没有该模型，下一个可能有）、
 *       401/403（各成员可配不同密钥，这家不认不代表下一家不认）。
 *   不换：400/413 这类请求本身的问题 —— 请求体到哪家都一样，换了白白浪费时间。
 */

export function shouldFailover({ status, code, message, timedOut, networkError, relayError } = {}) {
  if (timedOut) return { failover: true, reason: '超时（时限内没有响应）' }
  if (networkError) return { failover: true, reason: `网络错误（${networkError}）` }

  // 中转站“假 200”：HTTP 是 200，body 里却是 error（无可用渠道、站内余额等）。
  // 这是中转站的常见脾气，必须看 body 才能发现。请求本身错的（invalid_request）不换。
  if (relayError) {
    const t = `${code ?? ''} ${message ?? ''}`
    if (/invalid_request|bad_request|invalid request|参数错误|请求参数/i.test(t)) {
      return { failover: false, reason: '中转站以 200 返回了请求错误，换哪家都一样，直接返回' }
    }
    return { failover: true, reason: `中转站假 200 错误（${message ?? code ?? 'error in body'}）` }
  }

  if (typeof status === 'number') {
    if (status === 429) return { failover: true, reason: '上游并发/容量已满（429）' }
    if (status >= 500) return { failover: true, reason: `上游故障（${status}）` }
    if (status === 408) return { failover: true, reason: '上游请求超时（408）' }
    if (status === 404 && /model/i.test(`${code ?? ''} ${message ?? ''}`)) {
      return { failover: true, reason: '这个上游没有该模型（404 model_not_found）' }
    }
    if (status === 401 || status === 403) {
      return { failover: true, reason: `密钥被拒（${status}），试试下一个成员的密钥` }
    }
    if (status === 400 || status === 413) {
      return { failover: false, reason: `请求本身有问题（${status}），换哪家都一样，直接返回` }
    }
    if (status === 404) {
      return { failover: false, reason: '接口路径 404，像是 base URL 写错，直接返回' }
    }
    if (status >= 400) return { failover: false, reason: `客户端错误（${status}），直接返回` }
  }

  return { failover: false, reason: '未识别的失败，直接返回' }
}
