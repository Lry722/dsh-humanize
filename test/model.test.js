/**
 * mergeAgentOptions 的取值顺序如下。插件配置优先，留空时跟随主会话最近
 * 一次请求使用的模型，推理等级单独覆盖。
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
  const agent = makeAgent({ provider: 'p', model: 'm', reasoningEffort: 'high' })
  assert.deepEqual(mergeAgentOptions({}, agent), { provider: 'p', model: 'm', reasoningEffort: 'high' })
})

test('配置了合并模型时覆盖会话模型，推理等级留空跟随会话', () => {
  const agent = makeAgent({ provider: 'p', model: 'm', reasoningEffort: 'high' })
  assert.deepEqual(
    mergeAgentOptions({ mergeProvider: 'q', mergeModel: 'cheap' }, agent),
    { provider: 'q', model: 'cheap', reasoningEffort: 'high' },
  )
})

test('配置了推理等级时覆盖会话的推理等级', () => {
  const agent = makeAgent({ provider: 'p', model: 'm', reasoningEffort: 'high' })
  assert.deepEqual(
    mergeAgentOptions({ mergeProvider: 'q', mergeModel: 'cheap', mergeReasoningEffort: 'low' }, agent),
    { provider: 'q', model: 'cheap', reasoningEffort: 'low' },
  )
})

test('配置了推理等级但跟随会话模型时同样生效', () => {
  const agent = makeAgent({ provider: 'p', model: 'm' })
  assert.deepEqual(
    mergeAgentOptions({ mergeReasoningEffort: 'low' }, agent),
    { provider: 'p', model: 'm', reasoningEffort: 'low' },
  )
})

test('仅当会话给出推理等级时，输出才包含 reasoningEffort', () => {
  const agent = makeAgent({ provider: 'p', model: 'm' })
  assert.deepEqual(mergeAgentOptions({}, agent), { provider: 'p', model: 'm' })
})
