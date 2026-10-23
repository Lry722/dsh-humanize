import test from 'node:test'
import assert from 'node:assert/strict'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { isOutside, resolveCommandTarget } from '../../lib/shared/paths.js'

test('isOutside 区分内部路径、同一路径和外部路径', () => {
  const base = resolve('/base')
  assert.equal(isOutside(base, join(base, 'docs', 'a.md')), false)
  assert.equal(isOutside(base, base), false)
  // 以 .. 开头的文件名仍然在 base 里面。
  assert.equal(isOutside(base, join(base, '..foo.md')), false)
  assert.equal(isOutside(base, join(base, '..', 'x')), true)
  assert.equal(isOutside(base, resolve('/other', 'x')), true)
})

const cwd = resolve('proj')
const agent = { session: { header: { cwd } } }

test('留空时用会话工作目录', () => {
  assert.equal(resolveCommandTarget(agent, '   '), cwd)
})

test('路径里的空格不需要引号，整体包住的引号会去掉', () => {
  assert.equal(resolveCommandTarget(agent, 'docs/a b.md'), join(cwd, 'docs/a b.md'))
  assert.equal(resolveCommandTarget(agent, '"docs/a b.md"'), join(cwd, 'docs/a b.md'))
  assert.equal(resolveCommandTarget(agent, "'docs/a b.md'"), join(cwd, 'docs/a b.md'))
})

test('开头的 ~ 展开成用户目录', () => {
  assert.equal(resolveCommandTarget(agent, '~/notes.md'), join(homedir(), 'notes.md'))
  assert.equal(resolveCommandTarget(agent, '"~/notes.md"'), join(homedir(), 'notes.md'))
})
