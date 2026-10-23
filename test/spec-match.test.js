import test from 'node:test'
import assert from 'node:assert/strict'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSpecMatcher } from '../lib/spec-match.js'

/** 声明的基准目录，测试只算路径，不需要真的创建文件。 */
const base = join(tmpdir(), 'humanize-spec-match')
const specPath = join(base, 'PROSE.md')

test('非锚定的文件名模式命中任意层级的文件', () => {
  const match = createSpecMatcher([{ path: specPath, include: ['*.md'] }])
  assert.equal(match(join(base, 'a.md')), true)
  assert.equal(match(join(base, 'docs', 'deep', 'a.md')), true)
  assert.equal(match(join(base, 'a.js')), false)
})

test('含斜杠的锚定模式相对声明目录匹配', () => {
  const match = createSpecMatcher([{ path: specPath, include: ['docs/**/*.txt'] }])
  assert.equal(match(join(base, 'docs', 'a.txt')), true)
  assert.equal(match(join(base, 'docs', 'x', 'y.txt')), true)
  assert.equal(match(join(base, 'other', 'a.txt')), false)
  // 声明目录之外的同名路径不参与锚定匹配。
  assert.equal(match(join(base, '..', 'docs', 'a.txt')), false)
})

test('! 前缀的目录模式排除该目录下的文件', () => {
  const match = createSpecMatcher([{ path: specPath, include: ['*.md', '!drafts/'] }])
  assert.equal(match(join(base, 'drafts', 'a.md')), false)
  assert.equal(match(join(base, 'keep', 'a.md')), true)
})

test('以 .. 开头的文件名仍在基准目录里，不按外部路径排除', () => {
  // 前导斜杠让模式锚定，匹配时才会比较相对路径。
  const match = createSpecMatcher([{ path: specPath, include: ['/..foo.md'] }])
  assert.equal(match(join(base, '..foo.md')), true)
  assert.equal(match(join(base, '..', 'foo.md')), false)
})
