import test from 'node:test'
import assert from 'node:assert/strict'
import { fenceSpans, longestBacktickRun, outerFence } from '../../lib/shared/markdown.js'

test('带 info string 的反引号围栏连同首尾行一起返回', () => {
  const lines = ['before', '```js', 'const a = 1', '```', 'after']
  assert.deepEqual(fenceSpans(lines), [
    { start: 1, end: 3, closed: true, char: '`', length: 3 },
  ])
})

test('波浪号围栏只接受同字符的闭合行', () => {
  const lines = ['~~~md', 'text', '```', 'still inside', '~~~~', 'tail']
  assert.deepEqual(fenceSpans(lines), [
    { start: 0, end: 4, closed: true, char: '~', length: 3 },
  ])
})

test('未闭合的围栏结算到最后一行', () => {
  const lines = ['a', '````', 'code', '```']
  assert.deepEqual(fenceSpans(lines), [
    { start: 1, end: 3, closed: false, char: '`', length: 4 },
  ])
})

test('更长的围栏包住里面更短的同字符围栏', () => {
  const lines = ['````md', '```', 'inner', '```', '````', 'tail']
  assert.deepEqual(fenceSpans(lines), [
    { start: 0, end: 4, closed: true, char: '`', length: 4 },
  ])
})

test('围栏内同字符但带 info string 的围栏行不关闭当前围栏', () => {
  const lines = ['```', '```js', 'code', '```']
  assert.deepEqual(fenceSpans(lines), [
    { start: 0, end: 3, closed: true, char: '`', length: 3 },
  ])
})

test('longestBacktickRun 统计正文里的内联反引号串', () => {
  assert.equal(longestBacktickRun('no backticks'), 0)
  assert.equal(longestBacktickRun(''), 0)
  assert.equal(longestBacktickRun('a `b` and ``c`` and ```d```'), 3)
  assert.equal(longestBacktickRun('````'), 4)
})

test('outerFence 最少 3 个反引号，并比正文里最长的串更长', () => {
  assert.equal(outerFence('plain'), '```')
  assert.equal(outerFence('a `` b'), '```')
  assert.equal(outerFence('a ``` b'), '````')
  assert.equal(outerFence('a ```` b'), '`````')
})
