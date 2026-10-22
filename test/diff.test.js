import test from 'node:test'
import assert from 'node:assert/strict'
import { changedRegion } from '../lib/diff.js'

test('前后内容相同时返回 null', () => {
  assert.equal(changedRegion('a\nb\nc', 'a\nb\nc'), null)
})

test('改动区段包住改动并保留上下文', () => {
  const changed = changedRegion('a\nb\nc', 'a\nB\nc')
  assert.equal(changed.text, 'a\nB\nc')
  assert.equal(changed.startLine, 1)
  assert.equal(changed.endLine, 3)

  const inserted = changedRegion('a\nc', 'a\nb\nc')
  assert.equal(inserted.text, 'a\nb\nc')
  assert.equal(inserted.startLine, 1)
  assert.equal(inserted.endLine, 3)
})

test('区段扩展到完整的代码围栏', () => {
  const closed = ['l0', 'l1', 'l2', 'l3', 'l4', 'l5', 'l6', '```js', 'const a = 1', 'const b = 2', 'const c = 3', 'const d = 4', '```', 'l13', 'l14', 'l15', 'l16', 'l17', 'l18', 'l19']
  const closedAfter = closed.map((line, index) => (index === 11 ? 'const d = 5' : line)).join('\n')
  const closedRegion = changedRegion(closed.join('\n'), closedAfter)
  assert.equal(closedRegion.startLine, 8)
  assert.ok(closedRegion.text.startsWith('```js'))
  assert.ok(closedRegion.text.includes('\n```\n'))

  const unclosed = ['l0', 'l1', 'l2', 'l3', 'l4', 'l5', 'l6', '```js', 'const a = 1', 'const b = 2', 'const c = 3', 'const d = 4', 'const e = 5']
  const unclosedAfter = unclosed.map((line, index) => (index === 11 ? 'const d = 40' : line)).join('\n')
  const unclosedRegion = changedRegion(unclosed.join('\n'), unclosedAfter)
  assert.equal(unclosedRegion.startLine, 8)
  assert.ok(unclosedRegion.text.startsWith('```js'))
})

test('波浪线围栏同样按完整围栏扩展区段', () => {
  const lines = ['l0', '~~~js', 'a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', '~~~', 'l11']
  const after = lines.map((line, index) => (index === 5 ? 'D' : line)).join('\n')
  const region = changedRegion(lines.join('\n'), after)
  assert.equal(region.startLine, 2)
  assert.ok(region.text.startsWith('~~~js'))
  assert.ok(region.text.endsWith('~~~'))
})
