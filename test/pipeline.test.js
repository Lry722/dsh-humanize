/**
 * 审查管线生命周期的单元测试。模拟一次受控的审查流，验证插件停止
 * 接受新审查后的行为：关门、排空在途调用、丢弃排队中的待办。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createReviewPipeline } from '../lib/pipeline.js'
import { setStorageRootResolver } from '../lib/staging.js'

/**
 * 造一个假 ctx。审查管线只用到 ctx.get（jobs 服务缺省返回
 * undefined，告警走降级路径）。
 */
function fakeContext() {
  return { get: () => undefined, logger: () => ({ info() {}, warn() {} }) }
}

/** 造一个假 agent，模型配置直接由管线配置提供，不读会话。 */
function fakeAgent() {
  return { id: 'agent-1', session: { id: 'session-1', header: {} } }
}

/** 空的提交批注负载，审查通过后清掉暂存。 */
const EMPTY_SUBMIT = JSON.stringify({ annotations: [] })

/**
 * 造一个可手动放行的审查流。gate 之前的块先发不消费，调用 release
 * 后一次性交出全部块并结束。
 */
function gatedStream(gate) {
  const chunks = [
    { type: 'block-start', index: 0, blockType: 'tool-call' },
    { type: 'block-end', index: 0, block: { type: 'tool-call', id: 'call-1', name: 'submit_annotations', arguments: EMPTY_SUBMIT } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
  return {
    [Symbol.asyncIterator]() {
      let i = 0
      return {
        async next() {
          await gate
          if (i >= chunks.length) return { done: true, value: undefined }
          i += 1
          return { done: false, value: chunks[i - 1] }
        },
      }
    },
  }
}

/** 等一个微任务排空，让排队的审查走到流上。 */
const tick = () => new Promise((resolve) => { setImmediate(resolve) })

test('shutdown 关门：新审查直接跳过，在途审查照常跑完', async () => {
  const storage = await mkdtemp(join(tmpdir(), 'humanize-pipeline-'))
  setStorageRootResolver(() => storage)
  const project = join(storage, 'project')
  await mkdir(join(project, '.git'), { recursive: true })
  await writeFile(join(project, 'PROSE.md'), '1. 平铺直叙。\n', 'utf8')
  const target = join(project, 'doc.md')
  await writeFile(target, '写给人看的文档。\n', 'utf8')

  let release
  const gate = new Promise((resolve) => { release = resolve })
  const ctx = { ...fakeContext(), llm: { stream: () => gatedStream(gate) } }
  const config = { reviewProvider: 'p', reviewModel: 'm', reviewRetries: 0 }
  const pipeline = createReviewPipeline(ctx, config, { info() {}, warn() {} })
  const agent = fakeAgent()

  const inFlight = pipeline.scheduleReview(agent, target, undefined, '写给人看的文档。\n')
  await tick()
  assert.equal(pipeline.state.disposed, false)

  const draining = pipeline.shutdown()
  assert.equal(pipeline.state.disposed, true)
  // 关门后排队的复审请求直接跳过，不再发起调用。
  assert.deepEqual(await pipeline.scheduleReview(agent, target, undefined, '又一次写入。\n'), { kind: 'skipped' })

  // 放行在途审查的流，shutdown 等它自然结束。
  release()
  const outcome = await inFlight
  assert.equal(outcome.kind, 'ok')
  await draining
  await rm(storage, { recursive: true, force: true })
})

test('shutdown 前排进待办槽的审查按丢弃结算，不再发起调用', async () => {
  const storage = await mkdtemp(join(tmpdir(), 'humanize-pipeline-'))
  setStorageRootResolver(() => storage)
  const project = join(storage, 'project')
  await mkdir(join(project, '.git'), { recursive: true })
  await writeFile(join(project, 'PROSE.md'), '1. 平铺直叙。\n', 'utf8')
  const target = join(project, 'doc.md')
  await writeFile(target, '第一版。\n', 'utf8')

  let release
  const gate = new Promise((resolve) => { release = resolve })
  let calls = 0
  const ctx = {
    ...fakeContext(),
    llm: { stream: () => { calls += 1; return gatedStream(gate) } },
  }
  const config = { reviewProvider: 'p', reviewModel: 'm', reviewRetries: 0 }
  const pipeline = createReviewPipeline(ctx, config, { info() {}, warn() {} })
  const agent = fakeAgent()

  const first = pipeline.scheduleReview(agent, target, undefined, '第一版。\n')
  await tick()
  // 在途审查未结束时再写一次，进入待办槽。
  const second = pipeline.scheduleReview(agent, target, '第一版。\n', '第二版。\n')
  await tick()

  const draining = pipeline.shutdown()
  release()
  assert.equal((await first).kind, 'ok')
  // 待办槽的审查没有等到第二次调用，直接按丢弃结算。
  assert.equal((await second).kind, 'discarded')
  assert.equal(calls, 1)
  await draining
  await rm(storage, { recursive: true, force: true })
})
