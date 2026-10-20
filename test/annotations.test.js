import test from 'node:test'
import assert from 'node:assert/strict'
import { countAnnotations, normalizeAnnotations, parseAnnotations, renderStaging } from '../lib/annotations.js'

const rules = new Map([[1, 'rule one'], [2, 'rule two']])

test('用同一份规范快照，把编号还原成对应的条文', () => {
  const list = normalizeAnnotations({
    annotations: [
      { rule: 1, quote: 'q', problem: 'p', suggestion: 's' },
      { rule: 2, quote: 'q2', problem: 'p2', suggestion: 's2' },
    ],
  }, rules)
  assert.equal(list[0].ruleText, 'rule one')
  assert.equal(list[1].ruleText, 'rule two')
})

test('规则集合里没有的编号，条目直接丢掉', () => {
  const list = normalizeAnnotations({
    annotations: [
      { rule: 99, quote: 'q', problem: 'p', suggestion: 's' },
      { rule: '1', quote: 'q2', problem: 'p2', suggestion: 's2' },
    ],
  }, rules)
  assert.equal(list.length, 0)
})

test('缺少 annotations 数组时抛错', () => {
  assert.throws(() => normalizeAnnotations({}, rules))
  assert.throws(() => normalizeAnnotations(null, rules))
})

test('null 和字符串条目直接丢掉', () => {
  const list = normalizeAnnotations({ annotations: [null, 'x', { rule: 1, quote: 'q' }] }, rules)
  assert.equal(list.length, 1)
  assert.equal(list[0].quote, 'q')
})

test('解析整段文本时只取中间的 JSON', () => {
  const list = parseAnnotations('开头\n{"annotations": []}\n结尾', rules)
  assert.deepEqual(list, [])
})

test('传入的文本里没有 JSON 对象时抛错', () => {
  assert.throws(() => parseAnnotations('no json here', rules))
})

test('渲染的编号行能被 countAnnotations 数回来', () => {
  const rendered = renderStaging('/f.md', [
    { ruleText: 'rule one', quote: 'q1', problem: 'p1', suggestion: 's1' },
    { ruleText: 'rule one', quote: 'q2', problem: '', suggestion: '' },
    { ruleText: 'rule two', quote: 'q3', problem: 'p3', suggestion: 's3' },
  ])
  assert.equal(countAnnotations(rendered), 3)
  assert.equal(countAnnotations('# 没有批注\n', 0), 0)
})
