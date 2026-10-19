import test from 'node:test'
import assert from 'node:assert/strict'
import { createSpecMatcher, declaresInclude, parseSpecRules, renderSpecChain } from '../lib/specs.js'

test('规范链渲染把编号重排成全局连续，解析能取回条文', () => {
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

test('不含斜杠的模式匹配任意层级的文件名', () => {
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

test('结尾斜杠的目录模式匹配该目录下所有文件，! 前缀排除', () => {
  const match = createSpecMatcher([{ path: '/proj/PROSE.md', include: ['*.md', '!drafts/'] }])
  assert.equal(match('/proj/drafts/a.md'), false)
  assert.equal(match('/proj/keep/a.md'), true)
})

test('最后一次命中的结果生效', () => {
  const match = createSpecMatcher([{ path: '/proj/PROSE.md', include: ['!*.md', 'keep.md'] }])
  assert.equal(match('/proj/a.md'), false)
  assert.equal(match('/proj/keep.md'), true)
})

test('范围更小的声明后命中，覆盖范围更大的', () => {
  // 规范链按文件祖先目录收集，范围小的排在后面，后命中生效。
  const match = createSpecMatcher([
    { path: '/proj/PROSE.md', include: ['*.md'] },
    { path: '/proj/sub/PROSE.md', include: ['!*.md'] },
  ])
  assert.equal(match('/proj/sub/a.md'), false)
  assert.equal(match('/proj/sub/deep/a.md'), false)
})

test('链里是否有 include 声明', () => {
  assert.equal(declaresInclude([{ path: '/proj/PROSE.md', include: undefined }]), false)
  assert.equal(declaresInclude([
    { path: '/proj/PROSE.md', include: undefined },
    { path: '/proj/sub/PROSE.md', include: ['*.md'] },
  ]), true)
})

test('没有任何 include 声明时 matcher 不命中任何文件', () => {
  // 调用方靠 declaresInclude 区分"没声明"和"声明了但没命中"，没声明时
  // 规范作用于所有文件，不能直接用 matcher 的结果。
  const match = createSpecMatcher([{ path: '/proj/PROSE.md', include: undefined }])
  assert.equal(match('/proj/a.md'), false)
})
