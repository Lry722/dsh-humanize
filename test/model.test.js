/**
 * resolveModelTarget 和 mergeAgentOptions 的取值顺序如下。插件配置优先，
 * 留空时依次跟随主会话最近一次请求和 agent 自身的模型设置。提供方和模型
 * 必须成对取用，推理等级单独覆盖。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mergeAgentOptions, resolveModelTarget } from '../lib/model.js'

function makeAgent(config, options) {
  return {
    session: {
      // 最近一次请求头里的模型配置，undefined 表示这个头为空。
      requestHeader: () => (config === undefined ? undefined : { config }),
    },
    ...(options !== undefined ? { options } : {}),
  }
}

test('成对配置优先，半对配置整对退到会话模型', () => {
  const agent = makeAgent({ provider: 'p', model: 'm' }, { provider: 'a', model: 'b' })
  assert.deepEqual(
    resolveModelTarget({ reviewProvider: 'q', reviewModel: 'cheap' }, agent, 'review'),
    { provider: 'q', model: 'cheap' },
  )
  // 只配一半时整对跟随会话模型。
  assert.deepEqual(
    resolveModelTarget({ reviewProvider: 'q' }, agent, 'review'),
    { provider: 'p', model: 'm' },
  )
  assert.deepEqual(
    resolveModelTarget({ reviewModel: 'cheap' }, agent, 'review'),
    { provider: 'p', model: 'm' },
  )
})

test('配置留空时跟随会话最近一次请求的模型', () => {
  assert.deepEqual(
    resolveModelTarget({}, makeAgent({ provider: 'p', model: 'm' }), 'review'),
    { provider: 'p', model: 'm' },
  )
  // 前缀决定读哪一对配置项。
  assert.equal(
    resolveModelTarget({ mergeProvider: 'q', mergeModel: 'cheap' }, makeAgent(undefined), 'review'),
    undefined,
  )
  assert.deepEqual(
    resolveModelTarget({ mergeProvider: 'q', mergeModel: 'cheap' }, makeAgent(undefined), 'merge'),
    { provider: 'q', model: 'cheap' },
  )
})

test('agent 自身的模型设置只在显式兜底时成对取用', () => {
  const agent = makeAgent(undefined, { provider: 'a', model: 'b' })
  assert.deepEqual(
    resolveModelTarget({}, agent, 'review', { fallbackToAgentOptions: true }),
    { provider: 'a', model: 'b' },
  )
  // 只在要求兜底时才读取 agent 设置。
  assert.equal(resolveModelTarget({}, agent, 'review'), undefined)
  // agent.options 缺失时返回 undefined。
  assert.equal(resolveModelTarget({}, makeAgent(undefined), 'review', { fallbackToAgentOptions: true }), undefined)
  // 只有一半时整对不可用。
  assert.equal(
    resolveModelTarget({}, makeAgent(undefined, { provider: 'a' }), 'review', { fallbackToAgentOptions: true }),
    undefined,
  )
})

test('配置和会话都留空时返回 undefined', () => {
  assert.equal(mergeAgentOptions({}, makeAgent(undefined)), undefined)
  assert.equal(resolveModelTarget({}, makeAgent(undefined), 'review'), undefined)
})

test('配置留空时跟随主会话的模型和推理等级', () => {
  assert.deepEqual(
    mergeAgentOptions({}, makeAgent({ provider: 'p', model: 'm', reasoningEffort: 'high' })),
    { provider: 'p', model: 'm', reasoningEffort: 'high' },
  )
  assert.deepEqual(
    mergeAgentOptions({}, makeAgent({ provider: 'p', model: 'm' })),
    { provider: 'p', model: 'm' },
  )
})

test('成对配置覆盖会话模型，推理等级单独覆盖', () => {
  const agent = makeAgent({ provider: 'p', model: 'm', reasoningEffort: 'high' })
  assert.deepEqual(
    mergeAgentOptions({ mergeProvider: 'q', mergeModel: 'cheap' }, agent),
    { provider: 'q', model: 'cheap', reasoningEffort: 'high' },
  )
  assert.deepEqual(
    mergeAgentOptions({ mergeProvider: 'q', mergeModel: 'cheap', mergeReasoningEffort: 'low' }, agent),
    { provider: 'q', model: 'cheap', reasoningEffort: 'low' },
  )
  assert.deepEqual(
    mergeAgentOptions({ mergeReasoningEffort: 'low' }, makeAgent({ provider: 'p', model: 'm' })),
    { provider: 'p', model: 'm', reasoningEffort: 'low' },
  )
})

test('只配一半时整对跟随会话，成对配置在没有会话模型时也能用', () => {
  const agent = makeAgent({ provider: 'p', model: 'm', reasoningEffort: 'high' })
  assert.deepEqual(
    mergeAgentOptions({ mergeProvider: 'q' }, agent),
    { provider: 'p', model: 'm', reasoningEffort: 'high' },
  )
  assert.deepEqual(
    mergeAgentOptions({ mergeModel: 'cheap' }, makeAgent({ provider: 'p', model: 'm' })),
    { provider: 'p', model: 'm' },
  )
  assert.deepEqual(
    mergeAgentOptions({ mergeProvider: 'q', mergeModel: 'cheap' }, makeAgent(undefined)),
    { provider: 'q', model: 'cheap' },
  )
})

test('会话和配置都留空时合并退回 agent 自身的模型设置', () => {
  assert.deepEqual(
    mergeAgentOptions({}, makeAgent(undefined, { provider: 'a', model: 'b' })),
    { provider: 'a', model: 'b' },
  )
  // 推理等级仍然取自会话请求头。
  assert.deepEqual(
    mergeAgentOptions({}, makeAgent({ reasoningEffort: 'high' }, { provider: 'a', model: 'b' })),
    { provider: 'a', model: 'b', reasoningEffort: 'high' },
  )
  assert.equal(mergeAgentOptions({}, makeAgent(undefined, { model: 'b' })), undefined)
})
