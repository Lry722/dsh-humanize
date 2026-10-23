import test from 'node:test'
import assert from 'node:assert/strict'
import { join, resolve } from 'node:path'
import { isOutside } from '../lib/paths.js'

test('isOutside 区分内部路径、同一路径和外部路径', () => {
  const base = resolve('/base')
  assert.equal(isOutside(base, join(base, 'docs', 'a.md')), false)
  assert.equal(isOutside(base, base), false)
  // 以 .. 开头的文件名仍然在 base 里面。
  assert.equal(isOutside(base, join(base, '..foo.md')), false)
  assert.equal(isOutside(base, join(base, '..', 'x')), true)
  assert.equal(isOutside(base, resolve('/other', 'x')), true)
})
