import test from 'node:test'
import assert from 'node:assert/strict'
import { probeModel } from '../lib/model-test.js'

/** 用给定的流片段造一个只提供 llm.stream 的上下文。 */
function ctxWith(chunks) {
  return {
    llm: {
      stream() {
        return (async function* () {
          for (const chunk of chunks) yield chunk
        })()
      },
    },
  }
}

test('模型正常返回或达到 token 上限时测试通过', async () => {
  const normal = ctxWith([
    { type: 'text-delta', index: 0, text: 'OK' },
    { type: 'finish', reason: { kind: 'stop' } },
  ])
  assert.deepEqual(await probeModel(normal, { provider: 'p', model: 'm' }), { ok: true })

  const truncated = ctxWith([
    { type: 'text-delta', index: 0, text: 'O' },
    { type: 'finish', reason: { kind: 'max-tokens' } },
  ])
  assert.deepEqual(await probeModel(truncated, { provider: 'p', model: 'm' }), { ok: true, truncated: true })
})

test('提供方返回错误时把原因带回设置页', async () => {
  const ctx = ctxWith([
    {
      type: 'finish',
      reason: { kind: 'error', failure: { message: 'The model has reached its end of life.' } },
    },
  ])
  const result = await probeModel(ctx, { provider: 'p', model: 'm' })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'provider')
  assert.match(result.message, /end of life/)
})

test('请求被取消时返回取消状态', async () => {
  const controller = new AbortController()
  controller.abort()
  const ctx = ctxWith([
    { type: 'finish', reason: { kind: 'aborted', failure: { message: 'aborted' } } },
  ])
  const result = await probeModel(ctx, { provider: 'p', model: 'm' }, controller.signal)
  assert.equal(result.ok, false)
  assert.equal(result.code, 'aborted')
})

test('超过总时长上限时返回超时状态', async (t) => {
  // 总时长上限是 30 秒，用 mock 计时器推进，测试本身立刻结束。
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const ctx = {
    llm: {
      stream(options) {
        // 模拟一个一直挂到信号中止的连接。
        return (async function* () {
          await new Promise((_, reject) => {
            options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true })
          })
        })()
      },
    },
  }
  const pending = probeModel(ctx, { provider: 'p', model: 'm' })
  t.mock.timers.tick(30_000)
  const result = await pending
  assert.equal(result.ok, false)
  assert.equal(result.code, 'timeout')
})
