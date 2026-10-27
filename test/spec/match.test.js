import test from 'node:test'
import assert from 'node:assert/strict'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createIncludeMatcher } from '../../lib/spec/match.js'

/** 声明的基准目录，测试只算路径，不需要真的创建文件。 */
const base = join(tmpdir(), 'humanize-spec-match')
const specPath = join(base, 'PROSE.md')

test('非锚定的文件名模式命中任意层级，作用范围仍限于声明目录', () => {
  const match = createIncludeMatcher({ path: specPath, include: ['*.md'] })
  assert.equal(match(join(base, 'a.md')), true)
  assert.equal(match(join(base, 'docs', 'deep', 'a.md')), true)
  assert.equal(match(join(base, 'a.js')), false)
  assert.equal(match(join(base, '..', 'outside', 'a.md')), false)
})

test('含斜杠的模式相对匹配基准解析，可以覆盖多个目录和单个文件', () => {
  const match = createIncludeMatcher({
    path: join(base, '.agents', 'prose', 'docs.md'),
    base,
    include: ['docs/**/*.txt', 'guides/', '/README.md'],
  })
  assert.equal(match(join(base, 'docs', 'a.txt')), true)
  assert.equal(match(join(base, 'docs', 'x', 'a.txt')), true)
  assert.equal(match(join(base, 'guides', 'deep', 'a.md')), true)
  assert.equal(match(join(base, 'README.md')), true)
  assert.equal(match(join(base, 'docs', 'README.md')), false)
  assert.equal(match(join(base, 'other', 'a.txt')), false)
})

test('感叹号排除和最后匹配优先的判定都只作用于当前规则', () => {
  const match = createIncludeMatcher({ path: specPath, include: ['*.md', '!drafts/', 'drafts/keep.md'] })
  assert.equal(match(join(base, 'drafts', 'a.md')), false)
  assert.equal(match(join(base, 'drafts', 'keep.md')), true)
  assert.equal(match(join(base, 'keep', 'a.md')), true)
})

test('省略 include 时规则作用于整个隐式范围', () => {
  const match = createIncludeMatcher({ path: specPath, scope: base })
  assert.equal(match(join(base, 'deep', 'a.js')), true)
  assert.equal(match(join(base, '..', 'a.js')), false)
})

test('空 include 只关闭当前规则', () => {
  const match = createIncludeMatcher({ path: specPath, include: [] })
  assert.equal(match(join(base, 'a.md')), false)
})

test('有边界的目录模式不匹配 base 自身或祖先目录', () => {
  const nestedBase = join(tmpdir(), 'generated', 'project')
  const entry = {
    path: join(nestedBase, '.agents', 'prose', 'base.md'),
    base: nestedBase,
    scope: nestedBase,
  }
  const target = join(nestedBase, 'src', 'a.md')
  const generated = join(nestedBase, 'generated', 'a.md')

  const include = createIncludeMatcher({ ...entry, include: ['**/*', '!generated/'] })
  assert.equal(include(target), true)
  assert.equal(include(generated), false)
  const positive = createIncludeMatcher({ ...entry, include: ['generated/'] })
  assert.equal(positive(target), false)
  assert.equal(positive(generated), true)
})

test('以 .. 开头的文件名仍在基准目录里，不按外部路径排除', () => {
  const match = createIncludeMatcher({ path: specPath, include: ['/..foo.md'] })
  assert.equal(match(join(base, '..foo.md')), true)
  assert.equal(match(join(base, '..', 'foo.md')), false)
})
