import test from 'node:test'
import assert from 'node:assert/strict'
import { changedRegions } from '../../lib/review/diff.js'

/** 从写入后的内容里取出区段文本。 */
function textOf(after, region) {
  return after.split('\n').slice(region.startLine - 1, region.endLine).join('\n')
}

test('前后内容相同时返回 null', () => {
  assert.equal(changedRegions('a\nb\nc', 'a\nb\nc'), null)
})

test('只有行尾不同时返回 null', () => {
  assert.equal(changedRegions('a\r\nb\r\nc\r\n', 'a\nb\nc\n'), null)
})

test('CRLF 内容里的改动仍然能定位', () => {
  const before = 'a\r\nb\r\nc\r\n'
  const after = 'a\r\nB\r\nc\r\n'
  assert.deepEqual(changedRegions(before, after), [{ startLine: 1, endLine: 3 }])
})

test('改动区段包住改动并保留上下文', () => {
  const after = 'a\nB\nc'
  const changed = changedRegions('a\nb\nc', after)
  assert.deepEqual(changed, [{ startLine: 1, endLine: 3 }])
  assert.equal(textOf(after, changed[0]), 'a\nB\nc')

  const insertedAfter = 'a\nb\nc'
  const inserted = changedRegions('a\nc', insertedAfter)
  assert.deepEqual(inserted, [{ startLine: 1, endLine: 3 }])
  assert.equal(textOf(insertedAfter, inserted[0]), 'a\nb\nc')
})

test('分散的多处改动各成一个区段，中间未改的内容不进入范围', () => {
  const lines = Array.from({ length: 30 }, (_, index) => `line ${index + 1}`)
  const after = lines
    .map((line, index) => (index === 4 ? 'LINE 5' : index === 19 ? 'LINE 20' : line))
    .join('\n')
  const regions = changedRegions(lines.join('\n'), after)
  assert.equal(regions.length, 2)
  assert.ok(regions[0].startLine <= 5 && regions[0].endLine >= 5)
  assert.ok(regions[1].startLine <= 20 && regions[1].endLine >= 20)
  // 两段之间的内容保持在第 10 行之外。
  assert.ok(regions[0].endLine < 10)
  assert.ok(regions[1].startLine > 10)
})

test('区段扩展到完整的代码围栏', () => {
  const closed = ['l0', 'l1', 'l2', 'l3', 'l4', 'l5', 'l6', '```js', 'const a = 1', 'const b = 2', 'const c = 3', 'const d = 4', '```', 'l13', 'l14', 'l15', 'l16', 'l17', 'l18', 'l19']
  const closedAfter = closed.map((line, index) => (index === 11 ? 'const d = 5' : line)).join('\n')
  const closedRegions = changedRegions(closed.join('\n'), closedAfter)
  assert.equal(closedRegions.length, 1)
  assert.equal(closedRegions[0].startLine, 8)
  assert.ok(textOf(closedAfter, closedRegions[0]).startsWith('```js'))
  assert.ok(textOf(closedAfter, closedRegions[0]).includes('\n```\n'))

  const unclosed = ['l0', 'l1', 'l2', 'l3', 'l4', 'l5', 'l6', '```js', 'const a = 1', 'const b = 2', 'const c = 3', 'const d = 4', 'const e = 5']
  const unclosedAfter = unclosed.map((line, index) => (index === 11 ? 'const d = 40' : line)).join('\n')
  const unclosedRegions = changedRegions(unclosed.join('\n'), unclosedAfter)
  assert.equal(unclosedRegions.length, 1)
  assert.equal(unclosedRegions[0].startLine, 8)
  assert.ok(textOf(unclosedAfter, unclosedRegions[0]).startsWith('```js'))
})

test('波浪线围栏同样按完整围栏扩展区段', () => {
  const lines = ['l0', '~~~js', 'a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', '~~~', 'l11']
  const after = lines.map((line, index) => (index === 5 ? 'D' : line)).join('\n')
  const regions = changedRegions(lines.join('\n'), after)
  assert.equal(regions.length, 1)
  assert.equal(regions[0].startLine, 2)
  assert.ok(textOf(after, regions[0]).startsWith('~~~js'))
  assert.ok(textOf(after, regions[0]).endsWith('~~~'))
})

test('未闭合围栏只扩展起点，终点止于改动处', () => {
  // 改动在未闭合围栏内部，起点扩到围栏开头，终点只覆盖改动本身。
  const lines = ['l0', 'l1', 'l2', 'l3', 'l4', '```js', 'a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j']
  const after = lines.map((line, index) => (index === 6 ? 'A' : line)).join('\n')
  assert.deepEqual(changedRegions(lines.join('\n'), after, 0), [{ startLine: 6, endLine: 7 }])
})
