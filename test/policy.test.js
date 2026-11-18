import { test } from 'node:test'
import assert from 'node:assert/strict'
import { shouldFailover } from '../lib/policy.js'

test('超时 → 换', () => {
  assert.equal(shouldFailover({ timedOut: true }).failover, true)
})

test('网络错误 → 换', () => {
  assert.equal(shouldFailover({ networkError: 'ECONNRESET' }).failover, true)
})

test('429 → 换', () => {
  assert.equal(shouldFailover({ status: 429 }).failover, true)
})

test('503 → 换', () => {
  assert.equal(shouldFailover({ status: 503 }).failover, true)
})

test('404 model_not_found → 换', () => {
  assert.equal(shouldFailover({ status: 404, code: 'model_not_found', message: 'model not found' }).failover, true)
})

test('404 路径错误 → 不换', () => {
  assert.equal(shouldFailover({ status: 404, message: 'Not Found' }).failover, false)
})

test('401 → 换（下一个成员可能用不同密钥）', () => {
  assert.equal(shouldFailover({ status: 401 }).failover, true)
})

test('400 → 不换', () => {
  assert.equal(shouldFailover({ status: 400 }).failover, false)
})

test('413 → 不换', () => {
  assert.equal(shouldFailover({ status: 413 }).failover, false)
})
