import test from 'node:test'
import assert from 'node:assert/strict'
import { clampLine, oneLine, truncateText } from '../lib/text.js'

test('oneLine 把非字符串压成空串，其余折成单行', () => {
  assert.equal(oneLine(undefined), '')
  assert.equal(oneLine(null), '')
  assert.equal(oneLine(42), '')
  assert.equal(oneLine({ text: 'x' }), '')
  assert.equal(oneLine('  a \n\t b  '), 'a b')
  assert.equal(oneLine('a\u3000b'), 'a b')
})

test('clampLine 先折成单行，再按总字数截断', () => {
  assert.equal(clampLine('  a \n b  ', 10), 'a b')
  assert.equal(clampLine(123, 10), '123')
  assert.equal(clampLine(null, 10), 'null')
  // 恰好等于上限时原样返回。
  assert.equal(clampLine('abcde', 5), 'abcde')
  // 省略号计入上限。
  const clipped = clampLine('abcdef', 5)
  assert.equal(clipped, 'abcd…')
  assert.equal(clipped.length, 5)
  assert.equal(clipped.at(-1), '…')
})

test('truncateText 未超长时原样返回，超长时附省略说明', () => {
  assert.equal(truncateText('ab', 3), 'ab')
  assert.equal(truncateText('abc', 3), 'abc')
  assert.equal(truncateText('abcdef', 3), 'abc\n\n[truncated 3 characters]')
  assert.equal(truncateText('line1\nline2', 5), 'line1\n\n[truncated 6 characters]')
})
