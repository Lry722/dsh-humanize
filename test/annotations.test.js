import test from 'node:test'
import assert from 'node:assert/strict'
import { countAnnotations, normalizeAnnotations, parseAnnotations, renderStaging } from '../lib/annotations.js'

const rules = new Map([[1, 'rule one'], [2, 'rule two']])

test('同一份规范快照把编号还原成条文，多行字段压成一行', () => {
  const { annotations, dropped } = normalizeAnnotations({
    annotations: [
      { rule: 1, quote: 'a\nb', problem: 'p\nq', suggestion: 's\n t' },
      { rule: 2, quote: 'q2', problem: 'p2', suggestion: 's2' },
    ],
  }, rules)
  assert.deepEqual(annotations, [
    { rule: 1, ruleText: 'rule one', quote: 'a b', problem: 'p q', suggestion: 's t' },
    { rule: 2, ruleText: 'rule two', quote: 'q2', problem: 'p2', suggestion: 's2' },
  ])
  assert.equal(dropped, 0)
})

test('规则集合之外的编号，条目直接丢弃，并计入丢弃数', () => {
  const { annotations, dropped } = normalizeAnnotations({
    annotations: [
      { rule: 99, quote: 'q', problem: 'p', suggestion: 's' },
      { rule: '1', quote: 'q2', problem: 'p2', suggestion: 's2' },
    ],
  }, rules)
  assert.equal(annotations.length, 0)
  assert.equal(dropped, 2)
})

test('缺少批注数组或文本里没有 JSON 时抛出错误', () => {
  assert.throws(() => normalizeAnnotations({}, rules))
  assert.throws(() => normalizeAnnotations(null, rules))
  assert.throws(() => parseAnnotations('no json here', rules))
})

test('null 和字符串条目丢掉，有效条目保留', () => {
  const { annotations, dropped } = normalizeAnnotations({ annotations: [null, 'x', { rule: 1, quote: 'q' }] }, rules)
  assert.equal(annotations.length, 1)
  assert.equal(annotations[0].quote, 'q')
  assert.equal(dropped, 2)
})

test('解析整段文本时只取中间的 JSON', () => {
  const { annotations, dropped } = parseAnnotations('开头\n{"annotations": []}\n结尾', rules)
  assert.deepEqual(annotations, [])
  assert.equal(dropped, 0)
})

test('渲染的编号行能被统计，批注里的换行不会破坏格式', () => {
  const rendered = renderStaging([
    { rule: 1, ruleText: 'rule one', quote: 'a\n2. injected', problem: 'p\n3. also', suggestion: 's' },
    { rule: 2, ruleText: 'rule two', quote: 'q2', problem: '', suggestion: '' },
  ])
  assert.equal(countAnnotations(rendered), 2)
  assert.match(rendered, /## Rule 1: rule one/)
  assert.match(rendered, /## Rule 2: rule two/)
  assert.match(rendered, /1\. "a 2\. injected"/)
  assert.match(rendered, /Problem: p 3\. also/)
  assert.doesNotMatch(rendered, /\n2\. injected/)
  assert.equal(countAnnotations('# 没有批注\n'), 0)
})

test('规则条文相同的批注按编号分开分组', () => {
  const rendered = renderStaging([
    { rule: 1, ruleText: '同一个条文', quote: 'a', problem: '', suggestion: '' },
    { rule: 2, ruleText: '同一个条文', quote: 'b', problem: '', suggestion: '' },
  ])
  assert.match(rendered, /## Rule 1: 同一个条文/)
  assert.match(rendered, /## Rule 2: 同一个条文/)
  assert.equal(countAnnotations(rendered), 2)
})
