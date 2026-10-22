import test from 'node:test'
import assert from 'node:assert/strict'
import { buildSpecRules, createSpecMatcher, declaresInclude, renderSpecChain } from '../lib/specs.js'

test('规范链渲染把编号重排成全局连续', () => {
  const chain = [
    { path: '/proj/PROSE.md', content: '1. one\n2. two', include: undefined },
    { path: '/proj/docs/PROSE.md', content: '1. three', include: undefined },
  ]
  const { text, rules } = buildSpecRules(chain)
  assert.ok(text.includes('1. one'))
  assert.ok(text.includes('2. two'))
  assert.ok(text.includes('3. three'))
  assert.deepEqual(rules.map((rule) => rule.text), ['one', 'two', 'three'])
  assert.equal(rules[2].source, '/proj/docs/PROSE.md')
})

test('缩进的编号同样进入规则列表，校验和提示词用同一份编号', () => {
  const chain = [{ path: '/proj/PROSE.md', content: '1. one\n   1. nested\n2. two', include: undefined }]
  const { text, rules } = buildSpecRules(chain)
  assert.ok(text.includes('   2. nested'))
  assert.deepEqual(rules.map((rule) => rule.text), ['one', 'nested', 'two'])
})

test('反引号围栏里的编号保持原样，规则列表只收正文编号', () => {
  const chain = [{ path: '/proj/PROSE.md', content: '1. one\n```\n1. sample\n```\n2. two', include: undefined }]
  const { text, rules } = buildSpecRules(chain)
  assert.ok(text.includes('1. sample'))
  assert.deepEqual(rules.map((rule) => rule.text), ['one', 'two'])
})

test('CRLF 规范里的编号全部保留，编号保持唯一', () => {
  const chain = [{ path: '/proj/PROSE.md', content: '1. one\r\n2. two\r\n' }]
  const { text, rules } = buildSpecRules(chain)
  assert.deepEqual(rules.map((rule) => rule.text), ['one', 'two'])
  assert.ok(text.includes('1. one'))
  assert.ok(text.includes('2. two'))
})

test('波浪线围栏里的编号同样保持原样，规则列表只收正文编号', () => {
  const chain = [{ path: '/proj/PROSE.md', content: '1. one\n~~~\n1. sample\n~~~\n2. two', include: undefined }]
  const { text, rules } = buildSpecRules(chain)
  assert.ok(text.includes('1. sample'))
  assert.deepEqual(rules.map((rule) => rule.text), ['one', 'two'])
})

test('四反引号围栏按最长反引号序列闭合', () => {
  const chain = [{
    path: '/proj/PROSE.md',
    content: '````md\n```\n1. sample\n```\n````\n1. real',
    include: undefined,
  }]
  const { text, rules } = buildSpecRules(chain)
  assert.ok(text.includes('1. sample'))
  assert.deepEqual(rules.map((rule) => rule.text), ['real'])
})

test('renderSpecChain 与 buildSpecRules 的文本一致', () => {
  const chain = [{ path: '/proj/PROSE.md', content: '1. one', include: undefined }]
  assert.equal(renderSpecChain(chain), buildSpecRules(chain).text)
})

test('模式里没有斜杠时，命中任意层级的同名文件', () => {
  const match = createSpecMatcher([{ path: '/proj/PROSE.md', include: ['*.md'] }])
  assert.equal(match('/proj/a.md'), true)
  assert.equal(match('/proj/docs/deep/a.md'), true)
  assert.equal(match('/proj/a.js'), false)
})

test('含斜杠的模式相对声明文件所在目录解析', () => {
  const match = createSpecMatcher([{ path: '/proj/PROSE.md', include: ['docs/**/*.txt'] }])
  assert.equal(match('/proj/docs/x/y.txt'), true)
  assert.equal(match('/proj/docs/y.txt'), true)
  assert.equal(match('/proj/other/y.txt'), false)
})

test('结尾斜杠的目录模式命中该目录下所有文件', () => {
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

test('后声明的 include 覆盖前面的声明', () => {
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

test('规范内容里的分段标记被外层围栏包住', () => {
  const chain = [{ path: '/proj/PROSE.md', content: '1. one\n```\n## Writing rules\n```' }]
  const { text } = buildSpecRules(chain)
  assert.ok(text.includes('````\n'))
  assert.ok(text.includes('## Writing rules'))
})
