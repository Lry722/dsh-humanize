import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runReview } from '../lib/review.js'
import { setRequestRootResolver } from '../lib/staging.js'

const spec = {
  text: '1. 平铺直叙。',
  rules: [{ index: 1, source: 'PROSE.md', text: '平铺直叙。' }],
}
const agent = {
  session: { id: 'session-1', header: { cwd: '/tmp' }, requestHeader: () => undefined },
  options: {},
}

/** 用给定的流片段造一个只提供 llm.stream 的上下文。 */
function ctxWith(chunks, seen = []) {
  return {
    llm: {
      stream(options) {
        seen.push(options)
        return (async function* () {
          for (const chunk of chunks) yield chunk
        })()
      },
    },
  }
}

/** 在给定的上下文上挂一个记录警告的日志服务。 */
function withWarnings(ctx, warnings) {
  return {
    ...ctx,
    logger: () => ({ warn: (...args) => warnings.push(args) }),
  }
}

function finish(kind) {
  return { type: 'finish', reason: { kind } }
}

/** 从错误信息里取出响应留档的路径。 */
function dumpPathOf(error) {
  const match = /raw response: (.+)$/im.exec(error.message)
  assert.ok(match, `错误信息里没有留档路径：${error.message}`)
  return match[1]
}

test('审查请求带上全文、审查范围和已有批注', async () => {
  const root = await mkdtemp(join(tmpdir(), 'humanize-review-'))
  setRequestRootResolver(() => root)
  const seen = []
  const ctx = ctxWith([
    { type: 'text-delta', index: 0, text: '{"annotations":[{"rule":1,"quote":"q","problem":"p","suggestion":"s"}]}' },
    finish('stop'),
  ], seen)
  try {
    const whole = await runReview(ctx, { reviewProvider: 'p', reviewModel: 'm' }, agent, '/tmp/a.md', '正文', null, spec, undefined)
    assert.deepEqual(whole.annotations.map((annotation) => annotation.ruleText), ['平铺直叙。'])
    assert.equal(seen[0].tools, undefined)
    const wholePrompt = seen[0].messages[0].content[0].text
    assert.match(wholePrompt, /## Writing rules\n1\. 平铺直叙。/)
    assert.match(wholePrompt, /## Full file content under review\n\nThe whole file is in scope\.\n\n```\n正文\n```/)
    assert.doesNotMatch(wholePrompt, /review scope starts/)
    const request = await readFile(join(root, 'tmp', 'a.md.request.md'), 'utf8')
    assert.match(request, /## system/)
    assert.match(request, /## user/)
    // 没有已有批注时，用户消息里不出现这个小节。系统提示词里提到它不算。
    assert.doesNotMatch(wholePrompt, /## Existing annotations/)

    const regionCtx = ctxWith([
      { type: 'text-delta', index: 0, text: '{"annotations":[]}' },
      finish('stop'),
    ], seen)
    await runReview(
      regionCtx,
      { reviewProvider: 'p', reviewModel: 'm' },
      agent,
      '/tmp/region.md',
      '第一段\n第二段\n第三段\n第四段',
      [{ startLine: 2, endLine: 2 }, { startLine: 4, endLine: 4 }],
      spec,
      '1. "旧句子"',
    )
    const regionPrompt = seen[1].messages[0].content[0].text
    assert.match(regionPrompt, /## Full file content under review\n\n```\n第一段\n<!-- dsh-humanize: review scope starts \(lines 2-2\) -->\n第二段\n<!-- dsh-humanize: review scope ends -->\n第三段\n<!-- dsh-humanize: review scope starts \(lines 4-4\) -->\n第四段\n<!-- dsh-humanize: review scope ends -->\n```/)
    assert.doesNotMatch(regionPrompt, /whole file is in scope/)
    assert.match(regionPrompt, /## Existing annotations[\s\S]*1\. "旧句子"/)
    // 全文只出现一次，每段改动各有一对标记，已有批注在最后。
    assert.equal(regionPrompt.match(/第二段/g)?.length, 1)
    assert.equal(regionPrompt.match(/第四段/g)?.length, 1)
    assert.equal(regionPrompt.match(/review scope starts/g)?.length, 2)
    assert.equal(regionPrompt.match(/review scope ends/g)?.length, 2)
    assert.ok(regionPrompt.indexOf('## Full file content under review') < regionPrompt.indexOf('<!-- dsh-humanize: review scope starts'))
    assert.ok(regionPrompt.indexOf('<!-- dsh-humanize: review scope ends') < regionPrompt.indexOf('## Existing annotations'))

    // 暂存文件存在但内容为空时，也省略 Existing annotations 小节。
    await runReview(ctx, { reviewProvider: 'p', reviewModel: 'm' }, agent, '/tmp/empty.md', '正文', null, spec, '')
    const emptyPrompt = seen[2].messages[0].content[0].text
    assert.doesNotMatch(emptyPrompt, /## Existing annotations/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('全文里的代码围栏不会提前闭合外层代码块', async () => {
  const root = await mkdtemp(join(tmpdir(), 'humanize-review-fence-'))
  setRequestRootResolver(() => root)
  const seen = []
  const ctx = ctxWith([
    { type: 'text-delta', index: 0, text: '{"annotations":[]}' },
    finish('stop'),
  ], seen)
  try {
    const content = '```js\nconst a = 1\n```'
    await runReview(ctx, { reviewProvider: 'p', reviewModel: 'm' }, agent, '/tmp/fence.md', content, null, spec, undefined)
    const prompt = seen[0].messages[0].content[0].text
    assert.ok(prompt.includes('````\n```js\nconst a = 1\n```\n````'))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('配置和会话都留空时审查退回 agent 的模型设置', async () => {
  const root = await mkdtemp(join(tmpdir(), 'humanize-review-agent-model-'))
  setRequestRootResolver(() => root)
  const seen = []
  const ctx = ctxWith([
    { type: 'text-delta', index: 0, text: '{"annotations":[]}' },
    finish('stop'),
  ], seen)
  const agentWithOptions = { ...agent, options: { provider: 'local', model: 'cheap' } }
  try {
    await runReview(ctx, {}, agentWithOptions, '/tmp/model.md', '正文', null, spec, undefined)
    assert.equal(seen[0].provider, 'local')
    assert.equal(seen[0].model, 'cheap')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('没有 JSON 时把文本、推理和 finish 原因写进响应留档', async () => {
  const root = await mkdtemp(join(tmpdir(), 'humanize-review-dump-'))
  setRequestRootResolver(() => root)
  const ctx = ctxWith([
    { type: 'reasoning-delta', index: 0, text: '先看规范，再看正文。' },
    { type: 'text-delta', index: 1, text: 'The file looks fine.' },
    finish('stop'),
  ])
  try {
    let responsePath
    await assert.rejects(
      runReview(ctx, { reviewProvider: 'p', reviewModel: 'm' }, agent, '/tmp/b.md', '正文', null, spec, undefined),
      (error) => {
        responsePath = dumpPathOf(error)
        return /contains no JSON object/.test(error.message)
      },
    )
    const dumped = await readFile(responsePath, 'utf8')
    assert.match(dumped, /The file looks fine\./)
    assert.match(dumped, /先看规范，再看正文。/)
    assert.match(dumped, /finish: stop/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('输出达到模型上限时也留档，错误信息带上路径', async () => {
  const root = await mkdtemp(join(tmpdir(), 'humanize-review-limit-'))
  setRequestRootResolver(() => root)
  const ctx = ctxWith([
    { type: 'text-delta', index: 0, text: '{"annotations":[{"rule":1,"quote":"半截' },
    finish('max-tokens'),
  ])
  try {
    let responsePath
    await assert.rejects(
      runReview(ctx, { reviewProvider: 'p', reviewModel: 'm' }, agent, '/tmp/c.md', '正文', null, spec, undefined),
      (error) => {
        responsePath = dumpPathOf(error)
        return /output limit/.test(error.message)
      },
    )
    const dumped = await readFile(responsePath, 'utf8')
    assert.match(dumped, /finish: max-tokens/)
    assert.match(dumped, /半截/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('流空闲超过上限时按停顿报错', async (t) => {
  // 空闲上限是 120 秒，用 mock 计时器推进，测试本身立刻结束。
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const root = await mkdtemp(join(tmpdir(), 'humanize-review-idle-'))
  setRequestRootResolver(() => root)
  let onStream
  const streaming = new Promise((resolve) => { onStream = resolve })
  const ctx = {
    llm: {
      stream() {
        onStream()
        // 模拟一个永远不给下一块的连接。
        return (async function* () {
          await new Promise(() => {})
        })()
      },
    },
  }
  try {
    const pending = runReview(ctx, { reviewProvider: 'p', reviewModel: 'm' }, agent, '/tmp/idle.md', '正文', null, spec, undefined)
    await streaming
    // 看门狗在发起读流时就装好了计时器，推进到上限即可触发。
    t.mock.timers.tick(120_000)
    await assert.rejects(pending, /review stalled: no chunk for 120 seconds/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('留档写不进去时不影响审查结果和主错误', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'humanize-review-nodump-'))
  // 把留档根路径做成普通文件，写请求和写响应都会失败。
  const root = join(parent, 'root-is-a-file')
  await writeFile(root, '')
  setRequestRootResolver(() => root)
  const warnings = []
  try {
    const success = withWarnings(ctxWith([
      { type: 'text-delta', index: 0, text: '{"annotations":[{"rule":1,"quote":"q","problem":"p","suggestion":"s"}]}' },
      finish('stop'),
    ]), warnings)
    const result = await runReview(success, { reviewProvider: 'p', reviewModel: 'm' }, agent, '/tmp/ok.md', '正文', null, spec, undefined)
    assert.equal(result.annotations.length, 1)
    // warn 收格式串和参数，参数依次是留档类型、文件路径和错误原因。
    assert.match(String(warnings[0][0]), /failed to write review %s dump/)
    assert.equal(warnings[0][1], 'request')
    assert.equal(warnings[0][2], '/tmp/ok.md')

    const truncated = withWarnings(ctxWith([
      { type: 'text-delta', index: 0, text: '{"annotations":[{"rule":1' },
      finish('max-tokens'),
    ]), warnings)
    await assert.rejects(
      runReview(truncated, { reviewProvider: 'p', reviewModel: 'm' }, agent, '/tmp/truncated.md', '正文', null, spec, undefined),
      (error) => {
        assert.match(error.message, /output limit/)
        // 留档没写成功时不能带一个不存在的路径。
        assert.doesNotMatch(error.message, /Raw response:/)
        return true
      },
    )

    const unparsable = withWarnings(ctxWith([
      { type: 'text-delta', index: 0, text: 'The file looks fine.' },
      finish('stop'),
    ]), warnings)
    await assert.rejects(
      runReview(unparsable, { reviewProvider: 'p', reviewModel: 'm' }, agent, '/tmp/unparsable.md', '正文', null, spec, undefined),
      (error) => {
        assert.match(error.message, /contains no JSON object/)
        assert.doesNotMatch(error.message, /Raw response:/)
        return true
      },
    )
    // 三次审查各记一条请求留档警告，两次响应留档再各记一条。
    assert.equal(warnings.length, 5)
  } finally {
    await rm(parent, { recursive: true, force: true })
  }
})
