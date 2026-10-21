import test from 'node:test'
import assert from 'node:assert/strict'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { resolveCommandTarget } from '../lib/command.js'

const cwd = resolve('proj')
const agent = { session: { header: { cwd } } }

test('留空时用会话工作目录', () => {
  assert.equal(resolveCommandTarget(agent, '   '), cwd)
})

test('带空格的路径不需要引号', () => {
  assert.equal(resolveCommandTarget(agent, 'docs/a b.md'), join(cwd, 'docs/a b.md'))
})

test('整体包住的引号会去掉', () => {
  assert.equal(resolveCommandTarget(agent, '"docs/a b.md"'), join(cwd, 'docs/a b.md'))
  assert.equal(resolveCommandTarget(agent, "'docs/a b.md'"), join(cwd, 'docs/a b.md'))
})

test('开头的 ~ 展开成用户目录', () => {
  assert.equal(resolveCommandTarget(agent, '~/notes.md'), join(homedir(), 'notes.md'))
  assert.equal(resolveCommandTarget(agent, '"~/notes.md"'), join(homedir(), 'notes.md'))
})
