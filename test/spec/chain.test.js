import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildSpecRules, loadSpecCandidates, renderSpecChain, resolveSpecChain } from '../../lib/spec/chain.js'

test('规范链渲染把编号重排成全局连续，缩进与 CRLF 都保留', () => {
  const chain = [
    { path: '/proj/PROSE.md', content: '# Rules\r\n1. one\r\n   1. nested\r\n2. two\r\n', include: undefined },
    { path: '/proj/docs/PROSE.md', content: '# Rules\n1. three', include: undefined },
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
  const backtick = buildSpecRules([{ path: '/proj/PROSE.md', content: '# Rules\n1. one\n```\n1. sample\n```\n2. two' }])
  assert.ok(backtick.text.includes('1. sample'))
  assert.deepEqual(backtick.rules.map((rule) => rule.text), ['one', 'two'])

  const tilde = buildSpecRules([{ path: '/proj/PROSE.md', content: '# Rules\n1. one\n~~~\n1. sample\n~~~\n2. two' }])
  assert.ok(tilde.text.includes('1. sample'))
  assert.deepEqual(tilde.rules.map((rule) => rule.text), ['one', 'two'])

  // 四反引号围栏按最长反引号序列闭合，里面的三反引号不提前结束围栏。
  const four = buildSpecRules([{
    path: '/proj/PROSE.md',
    content: '# Rules\n````md\n```\n1. sample\n```\n````\n1. real',
  }])
  assert.ok(four.text.includes('1. sample'))
  assert.deepEqual(four.rules.map((rule) => rule.text), ['real'])
})

test('每份规则的 include 独立筛选，其他来源命中的规则照常保留', () => {
  const candidates = [
    { path: '/proj/.agents/prose/base.md', kind: 'project', base: '/proj', include: ['docs/', '/README.md'] },
    { path: '/proj/docs/PROSE.md', kind: 'directory', base: '/proj/docs', include: undefined },
  ]
  const docs = resolveSpecChain(candidates, '/proj/docs/a.md')
  assert.deepEqual(docs.chain.map((entry) => entry.path), candidates.map((entry) => entry.path))
  assert.deepEqual(resolveSpecChain(candidates, '/proj/src/a.md').chain, [])
  assert.deepEqual(resolveSpecChain(candidates, '/proj/README.md').chain, [candidates[0]])
})

test('base.md 和其他同层规则一样，按 priority 和路径排列', () => {
  const base = { path: '/proj/.agents/prose/base.md', kind: 'project', base: '/proj' }
  const alpha = { path: '/proj/.agents/prose/alpha.md', kind: 'project', base: '/proj' }
  const result = resolveSpecChain([base, alpha], '/proj/a.md')
  assert.deepEqual(result.chain.map((entry) => entry.path), [alpha.path, base.path])

  const prioritized = resolveSpecChain([{ ...base, priority: -1 }, alpha], '/proj/a.md')
  assert.deepEqual(prioritized.chain.map((entry) => entry.path), [base.path, alpha.path])
})

test('缺省 priority 保持用户、项目、目录从浅到深的合并顺序', () => {
  const candidates = [
    { path: '/proj/docs/PROSE.md', kind: 'directory', depth: 1 },
    { path: '/proj/.agents/prose/base.md', kind: 'project', base: '/proj' },
    { path: '/proj/PROSE.md', kind: 'directory', depth: 0 },
    { path: '/global/PROSE.md', kind: 'user', scope: null },
  ]
  const result = resolveSpecChain(candidates, '/proj/docs/a.md')
  assert.deepEqual(result.chain.map((entry) => entry.path), [
    '/global/PROSE.md',
    '/proj/.agents/prose/base.md',
    '/proj/PROSE.md',
    '/proj/docs/PROSE.md',
  ])
})

test('inherit: false 丢弃此前命中的规则，后续规则继续合并', () => {
  const candidates = [
    { path: '/global/PROSE.md', kind: 'user', scope: null },
    { path: '/proj/.agents/prose/base.md', kind: 'project', base: '/proj' },
    { path: '/proj/.agents/prose/special.md', kind: 'project', base: '/proj', include: ['/docs/a.md'], priority: 10, inherit: false },
    { path: '/proj/docs/PROSE.md', kind: 'directory', base: '/proj/docs', priority: 20 },
  ]
  const result = resolveSpecChain(candidates, '/proj/docs/a.md')
  assert.deepEqual(result.chain.map((entry) => entry.path), [
    '/proj/.agents/prose/special.md',
    '/proj/docs/PROSE.md',
  ])
  const unrelated = resolveSpecChain(candidates, '/proj/other.md')
  assert.deepEqual(unrelated.chain.map((entry) => entry.path), [
    '/global/PROSE.md',
    '/proj/.agents/prose/base.md',
  ])
})

test('审查独立于规则 include，可以单独排除文件', () => {
  const candidates = [{
    path: '/proj/.agents/prose/base.md',
    kind: 'project',
    base: '/proj',
    include: ['docs/'],
    review: { include: ['*.md'], exclude: ['drafts/'] },
  }]
  // 文件能否进入审查由 review 单独决定，规则 include 只决定有没有适用规则。
  assert.deepEqual(resolveSpecChain(candidates, '/proj/src/a.md'), { chain: [], review: true })
  assert.equal(resolveSpecChain(candidates, '/proj/docs/a.js').review, false)
  assert.equal(resolveSpecChain(candidates, '/proj/drafts/a.md').review, false)
})

test('只有命中的规则才参与 Rules 结构校验和编号', () => {
  const candidates = [
    { path: '/proj/.agents/prose/invalid.md', base: '/proj', include: ['/other.md'], content: '# Glossary\n1. broken' },
    { path: '/proj/.agents/prose/valid.md', base: '/proj', include: ['/a.md'], content: '# Rules\n1. valid' },
  ]
  const { chain } = resolveSpecChain(candidates, '/proj/a.md')
  const result = buildSpecRules(chain)
  assert.deepEqual(result.rules.map((rule) => rule.text), ['valid'])
})

test('渲染文本标出规范来源路径', () => {
  const chain = [{ path: '/proj/PROSE.md', content: '# Rules\n1. one' }]
  const { text } = buildSpecRules(chain)
  assert.ok(text.includes('Spec source: /proj/PROSE.md'))
  assert.equal(renderSpecChain(chain), text)
})

test('规范内容里的分段标记被外层围栏包住', () => {
  const chain = [{ path: '/proj/PROSE.md', content: '# Rules\n1. one\n```\n## Writing rules\n```' }]
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

test('多个 Rules 章节共用一套编号，围栏里的一级标题按正文处理', () => {
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

test('缺少 Rules 一级标题时抛出错误', () => {
  const chain = [{
    path: '/proj/PROSE.md',
    content: '# Glossary\n1. term\n# Notes\n2. note',
  }]
  assert.throws(
    () => buildSpecRules(chain),
    (error) => error.humanizeSpecError === true
      && /缺少一级标题 # Rules/.test(error.message)
      && error.message.includes('/proj/PROSE.md'),
  )
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

test('YAML 文件头无法解析时 loadSpecCandidates 抛出规范错误', async () => {
  const root = await mkdtemp(join(tmpdir(), 'humanize-spec-yaml-'))
  try {
    const target = join(root, 'a.md')
    const specPath = join(root, 'PROSE.md')
    await writeFile(target, 'x\n', 'utf8')
    // 方括号没有闭合，js-yaml 解析文件头时直接报错。
    await writeFile(specPath, '---\ninclude: [\n---\n# Rules\n1. one\n', 'utf8')
    await assert.rejects(
      loadSpecCandidates(target, root),
      (error) => error.humanizeSpecError === true
        && /YAML 文件头无法解析/.test(error.message)
        && error.message.includes(specPath),
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
