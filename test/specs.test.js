import test from 'node:test'
import assert from 'node:assert/strict'
import { createSpecMatcher, declaresInclude, parseSpecRules, renderSpecChain } from '../lib/specs.js'

test('规范链渲染把编号重排成全局连续', () => {
  const chain = [
    { path: '/proj/PROSE.md', content: '1. one\n2. two', include: undefined },
    { path: '/proj/docs/PROSE.md', content: '1. three', include: undefined },
  ]
  const text = renderSpecChain(chain)
  assert.ok(text.includes('1. one'))
  assert.ok(text.includes('2. two'))
  assert.ok(text.includes('3. three'))
  const rules = parseSpecRules(text)
  assert.equal(rules.get(1), 'one')
  assert.equal(rules.get(3), 'three')
})

test('模式里没有斜杠时，命中任意层级的同名文件', () => {
  const match = createSpecMatcher([{ path: '/proj/PROSE.md', include: ['*.md'] }])
  assert.equal(match('/proj/a.md'), true)
  assert.equal(match('/proj/docs/deep/a.md'), true)
  assert.equal(match('/proj/a.js'), false)
})

test('含斜杠的模式按声明文件所在目录锚定', () => {
  const match = createSpecMatcher([{ path: '/proj/PROSE.md', include: ['docs/**/*.txt'] }])
  assert.equal(match('/proj/docs/x/y.txt'), true)
  assert.equal(match('/proj/docs/y.txt'), true)
  assert.equal(match('/proj/other/y.txt'), false)
})

test('结尾斜杠的目录模式匹配该目录下所有文件', () => {
  const match = createSpecMatcher([{ path: '/proj/PROSE.md', include: ['docs/'] }])
  assert.equal(match('/proj/docs/a.md'), true)
  assert.equal(match('/proj/docs/deep/a.md'), true)
  assert.equal(match('/proj/other/a.md'), false)
})

test('! 前缀的模式表示排除', () => {
  const match = createSpecMatcher([{ path: '/proj/PROSE.md', include: ['*.md', '!drafts/'] }])
  assert.equal(match('/proj/drafts/a.md'), false)
  assert.equal(match('/proj/keep/a.md'), true)
})

test('最后一次命中的结果生效', () => {
  const match = createSpecMatcher([{ path: '/proj/PROSE.md', include: ['!*.md', 'keep.md'] }])
  assert.equal(match('/proj/a.md'), false)
  assert.equal(match('/proj/keep.md'), true)
})

test('范围更小的声明排在后面，命中结果覆盖范围更大的声明', () => {
  // 规范链按文件祖先目录收集，后声明的规则生效。
  const match = createSpecMatcher([
    { path: '/proj/PROSE.md', include: ['*.md'] },
    { path: '/proj/sub/PROSE.md', include: ['!*.md'] },
  ])
  assert.equal(match('/proj/sub/a.md'), false)
  assert.equal(match('/proj/sub/deep/a.md'), false)
})

test('declaresInclude 判断规范链里是否声明了 include', () => {
  assert.equal(declaresInclude([{ path: '/proj/PROSE.md', include: undefined }]), false)
  assert.equal(declaresInclude([
    { path: '/proj/PROSE.md', include: undefined },
    { path: '/proj/sub/PROSE.md', include: ['*.md'] },
  ]), true)
})

test('未声明 include 时匹配器对所有文件都返回 false', () => {
  const match = createSpecMatcher([{ path: '/proj/PROSE.md', include: undefined }])
  assert.equal(match('/proj/a.md'), false)
})
