import test from 'node:test'
import assert from 'node:assert/strict'
import { countAnnotations, normalizeAnnotations, parseAnnotations, renderStaging } from '../lib/annotations.js'

const rules = new Map([[1, 'rule one'], [2, 'rule two']])

test('编号用同一份规范快照解析回条文', () => {
  const list = normalizeAnnotations({
    annotations: [
      { rule: 1, quote: 'q', problem: 'p', suggestion: 's' },
      { rule: 99, quote: 'q2', problem: 'p2', suggestion: 's2' },
      { rule: '1', quote: 'q3', problem: 'p3', suggestion: 's3' },
    ],
  }, rules)
  assert.equal(list[0].ruleText, 'rule one')
  // 编号在规范快照里找不到时按未对应处理。
  assert.equal(list[1].ruleText, null)
  // 编号不是数字时按未对应处理。
  assert.equal(list[2].ruleText, null)
})

test('缺少 annotations 数组时抛错', () => {
  assert.throws(() => normalizeAnnotations({}, rules))
  assert.throws(() => normalizeAnnotations(null, rules))
})

test('非对象的条目被过滤', () => {
  const list = normalizeAnnotations({ annotations: [null, 'x', { quote: 'q' }] }, rules)
  assert.equal(list.length, 1)
  assert.equal(list[0].quote, 'q')
})

test('文本兜底解析容忍前后缀文字', () => {
  const list = parseAnnotations('开头\n{"annotations": []}\n结尾', rules)
  assert.deepEqual(list, [])
})

test('没有 JSON 对象时抛错', () => {
  assert.throws(() => parseAnnotations('no json here', rules))
})

test('渲染的编号行能被 countAnnotations 数回来', () => {
  const rendered = renderStaging('/f.md', [
    { ruleText: 'rule one', quote: 'q1', problem: 'p1', suggestion: 's1' },
    { ruleText: 'rule one', quote: 'q2', problem: '', suggestion: '' },
    { ruleText: null, quote: 'q3', problem: 'p3', suggestion: 's3' },
  ])
  assert.equal(countAnnotations(rendered), 3)
  assert.equal(countAnnotations('# 没有批注\n', 0), 0)
})
