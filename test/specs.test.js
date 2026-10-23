import test from 'node:test'
import assert from 'node:assert/strict'
import { createSpecMatcher, declaresInclude } from '../lib/spec-match.js'
import { buildSpecRules, renderSpecChain } from '../lib/specs.js'

test('规范链渲染把编号重排成全局连续，缩进与 CRLF 都保留', () => {
  const chain = [
    { path: '/proj/PROSE.md', content: '1. one\r\n   1. nested\r\n2. two\r\n', include: undefined },
    { path: '/proj/docs/PROSE.md', content: '1. three', include: undefined },
  ]
  const { text, rules } = buildSpecRules(chain)
  assert.ok(text.includes('1. one'))
  assert.ok(text.includes('   2. nested'))
  assert.ok(text.includes('3. two'))
  assert.ok(text.includes('4. three'))
  assert.deepEqual(rules.map((rule) => rule.text), ['one', 'nested', 'two', 'three'])
  assert.equal(rules[3].source, '/proj/docs/PROSE.md')
  assert.equal(renderSpecChain(chain), text)
})

test('代码围栏里的编号保持原样，规则列表只收正文编号', () => {
  const backtick = buildSpecRules([{ path: '/proj/PROSE.md', content: '1. one\n```\n1. sample\n```\n2. two' }])
  assert.ok(backtick.text.includes('1. sample'))
  assert.deepEqual(backtick.rules.map((rule) => rule.text), ['one', 'two'])

  const tilde = buildSpecRules([{ path: '/proj/PROSE.md', content: '1. one\n~~~\n1. sample\n~~~\n2. two' }])
  assert.ok(tilde.text.includes('1. sample'))
  assert.deepEqual(tilde.rules.map((rule) => rule.text), ['one', 'two'])

  // 四反引号围栏按最长反引号序列闭合，里面的三反引号不提前结束围栏。
  const four = buildSpecRules([{
    path: '/proj/PROSE.md',
    content: '````md\n```\n1. sample\n```\n````\n1. real',
  }])
  assert.ok(four.text.includes('1. sample'))
  assert.deepEqual(four.rules.map((rule) => rule.text), ['real'])
})

test('没有斜杠的文件名模式命中任意层级，含斜杠的模式相对声明目录解析', () => {
  const fileName = createSpecMatcher([{ path: '/proj/PROSE.md', include: ['*.md'] }])
  assert.equal(fileName('/proj/a.md'), true)
  assert.equal(fileName('/proj/docs/deep/a.md'), true)
  assert.equal(fileName('/proj/a.js'), false)

  const relative = createSpecMatcher([{ path: '/proj/PROSE.md', include: ['docs/**/*.txt'] }])
  assert.equal(relative('/proj/docs/x/y.txt'), true)
  assert.equal(relative('/proj/docs/y.txt'), true)
  assert.equal(relative('/proj/other/y.txt'), false)
})

test('结尾斜杠的目录模式命中该目录下所有文件', () => {
  const match = createSpecMatcher([{ path: '/proj/PROSE.md', include: ['docs/'] }])
  assert.equal(match('/proj/docs/a.md'), true)
  assert.equal(match('/proj/docs/deep/a.md'), true)
  assert.equal(match('/proj/other/a.md'), false)
})

test('! 前缀的模式表示排除，最后一次命中的结果生效', () => {
  const excluded = createSpecMatcher([{ path: '/proj/PROSE.md', include: ['*.md', '!drafts/'] }])
  assert.equal(excluded('/proj/drafts/a.md'), false)
  assert.equal(excluded('/proj/keep/a.md'), true)

  const lastWins = createSpecMatcher([{ path: '/proj/PROSE.md', include: ['!*.md', 'keep.md'] }])
  assert.equal(lastWins('/proj/a.md'), false)
  assert.equal(lastWins('/proj/keep.md'), true)
})

test('后声明的 include 覆盖前面的声明', () => {
  const match = createSpecMatcher([
    { path: '/proj/PROSE.md', include: ['*.md'] },
    { path: '/proj/sub/PROSE.md', include: ['!*.md'] },
  ])
  assert.equal(match('/proj/sub/a.md'), false)
  assert.equal(match('/proj/sub/deep/a.md'), false)
})

test('declaresInclude 识别链里的声明，未声明时匹配器对所有文件返回 false', () => {
  assert.equal(declaresInclude([{ path: '/proj/PROSE.md', include: undefined }]), false)
  assert.equal(declaresInclude([
    { path: '/proj/PROSE.md', include: undefined },
    { path: '/proj/sub/PROSE.md', include: ['*.md'] },
  ]), true)
  const match = createSpecMatcher([{ path: '/proj/PROSE.md', include: undefined }])
  assert.equal(match('/proj/a.md'), false)
})

test('规范内容里的分段标记被外层围栏包住', () => {
  const chain = [{ path: '/proj/PROSE.md', content: '1. one\n```\n## Writing rules\n```' }]
  const { text } = buildSpecRules(chain)
  assert.ok(text.includes('````\n'))
  assert.ok(text.includes('## Writing rules'))
})

test('一级标题分块后，只有 Rules 章节的编号行算规则', () => {
  const chain = [{
    path: '/proj/PROSE.md',
    content: [
      '# Glossary',
      '1. 滥用：指过度使用。',
      '',
      '# Rules',
      '1. one',
      '## Details',
      '1. nested',
      '',
      '# Notes',
      '1. 这不是规则。',
    ].join('\n'),
  }]
  const { text, rules } = buildSpecRules(chain)
  assert.deepEqual(rules.map((rule) => rule.text), ['one', 'nested'])
  // 规则之外的章节原样保留，编号不参与全局重排。
  assert.ok(text.includes('# Glossary\n1. 滥用：指过度使用。'))
  assert.ok(text.includes('# Notes\n1. 这不是规则。'))
})

test('多个 Rules 章节共用一套编号，围栏里的一级标题不切分章节', () => {
  const chain = [{
    path: '/proj/PROSE.md',
    content: [
      '# Rules',
      '1. one',
      '# Notes',
      '```md',
      '# Rules',
      '1. sample',
      '```',
      '# Rules',
      '1. two',
    ].join('\n'),
  }]
  const { text, rules } = buildSpecRules(chain)
  assert.deepEqual(rules.map((rule) => rule.text), ['one', 'two'])
  assert.deepEqual(rules.map((rule) => rule.index), [1, 2])
  assert.ok(text.includes('1. sample'))
})

test('没有 Rules 一级标题时整份文件仍按规则列表解析', () => {
  const chain = [{
    path: '/proj/PROSE.md',
    content: '# Glossary\n1. term\n# Notes\n2. note',
  }]
  const { rules } = buildSpecRules(chain)
  assert.deepEqual(rules.map((rule) => rule.text), ['term', 'note'])
})

test('Rules 章节没有编号行时保留补充说明，规则列表为空', () => {
  const chain = [{
    path: '/proj/PROSE.md',
    content: '# Rules\n\n# Glossary\n滥用：指过度使用。',
  }]
  const { text, rules } = buildSpecRules(chain)
  assert.deepEqual(rules, [])
  assert.ok(text.includes('滥用：指过度使用。'))
})
