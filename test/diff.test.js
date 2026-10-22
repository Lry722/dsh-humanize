import test from 'node:test'
import assert from 'node:assert/strict'
import { changedRegion } from '../lib/diff.js'

test('前后内容相同时返回 null', () => {
  assert.equal(changedRegion('a\nb\nc', 'a\nb\nc'), null)
})

test('单行改动给出带上下文的最小区段', () => {
  const region = changedRegion('a\nb\nc', 'a\nB\nc')
  assert.equal(region.text, 'a\nB\nc')
  assert.equal(region.startLine, 1)
})

test('新增行落在区段里', () => {
  const region = changedRegion('a\nc', 'a\nb\nc')
  assert.equal(region.text, 'a\nb\nc')
  assert.equal(region.startLine, 1)
})

test('改动的那一行靠近围栏时，区段扩展到围栏开头', () => {
  const lines = ['l0', 'l1', 'l2', 'l3', 'l4', 'l5', 'l6', '```js', 'const a = 1', 'const b = 2', 'const c = 3', 'const d = 4', '```', 'l13', 'l14', 'l15', 'l16', 'l17', 'l18', 'l19']
  const after = lines.map((line, index) => (index === 11 ? 'const d = 5' : line)).join('\n')
  const region = changedRegion(lines.join('\n'), after)
  assert.equal(region.startLine, 8)
  assert.ok(region.text.startsWith('```js'))
})

test('未闭合的围栏同样让区段扩展到围栏开头', () => {
  const lines = ['l0', 'l1', 'l2', 'l3', 'l4', 'l5', 'l6', '```js', 'const a = 1', 'const b = 2', 'const c = 3', 'const d = 4', 'const e = 5', 'const f = 6', 'const g = 7', 'const h = 8', 'const i = 9', 'const j = 10', 'const k = 11', 'const l = 12']
  const after = lines.map((line, index) => (index === 11 ? 'const d = 40' : line)).join('\n')
  const region = changedRegion(lines.join('\n'), after)
  assert.equal(region.startLine, 8)
  assert.ok(region.text.startsWith('```js'))
})

test('长代码块中段发生改动时，区段包含闭合围栏', () => {
  const lines = ['l0', '```js', 'a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', '```', 'l13', 'l14']
  const after = lines.map((line, index) => (index === 6 ? 'E' : line)).join('\n')
  const region = changedRegion(lines.join('\n'), after)
  assert.equal(region.startLine, 2)
  assert.ok(region.text.startsWith('```js'))
  assert.ok(region.text.endsWith('```'))
})

test('波浪线围栏同样按完整围栏扩展区段', () => {
  const lines = ['l0', '~~~js', 'a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', '~~~', 'l11']
  const after = lines.map((line, index) => (index === 5 ? 'D' : line)).join('\n')
  const region = changedRegion(lines.join('\n'), after)
  assert.equal(region.startLine, 2)
  assert.ok(region.text.startsWith('~~~js'))
  assert.ok(region.text.endsWith('~~~'))
})
