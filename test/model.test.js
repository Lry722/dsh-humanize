/**
 * mergeAgentOptions 的取值顺序如下。插件配置优先，留空时跟随主会话最近
 * 一次请求使用的模型。推理等级单独覆盖。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mergeAgentOptions } from '../lib/model.js'

function makeAgent(config) {
  return {
    session: {
      // 最近一次请求头里的模型配置，undefined 表示这个头为空。
      requestHeader: () => (config === undefined ? undefined : { config }),
    },
  }
}

test('配置和会话都留空时返回 undefined', () => {
  assert.equal(mergeAgentOptions({}, makeAgent(undefined)), undefined)
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
