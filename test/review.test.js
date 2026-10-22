import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
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

function finish(kind) {
  return { type: 'finish', reason: { kind } }
}

/** 从错误信息里取出响应留档的路径。 */
function dumpPathOf(error) {
  const match = /raw response: (.+)$/im.exec(error.message)
  assert.ok(match, `错误信息里没有留档路径：${error.message}`)
  return match[1]
}

test('审查按文本 JSON 读批注，请求里只放审查提示词', async () => {
  const root = await mkdtemp(join(tmpdir(), 'humanize-review-'))
  setRequestRootResolver(() => root)
  const seen = []
  const ctx = ctxWith([
    {
      type: 'text-delta',
      index: 0,
      text: '{"annotations":[{"rule":1,"quote":"q","problem":"p","suggestion":"s"}]}',
    },
    finish('stop'),
  ], seen)
  try {
    const result = await runReview(ctx, { reviewProvider: 'p', reviewModel: 'm' }, agent, '/tmp/a.md', '正文', null, spec, undefined)
    assert.deepEqual(result.annotations.map((annotation) => annotation.ruleText), ['平铺直叙。'])
    // 请求里只放审查提示词，模型只能看到审查所需内容。
    assert.equal(seen[0].tools, undefined)
    const prompt = seen[0].messages[0].content[0].text
    assert.match(prompt, /## Full file under review: \/tmp\/a\.md\n正文/)
    assert.match(prompt, /## Review scope: whole file\nAdd new annotations anywhere in the full file\./)
    assert.doesNotMatch(prompt, /## Review scope: lines/)
    const request = await readFile(join(root, 'tmp', 'a.md.request.md'), 'utf8')
    assert.match(request, /exactly one JSON object/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('改动区段审查同时发送全文、审查范围和已有批注', async () => {
  const root = await mkdtemp(join(tmpdir(), 'humanize-review-region-'))
  setRequestRootResolver(() => root)
  const seen = []
  const ctx = ctxWith([
    { type: 'text-delta', index: 0, text: '{"annotations":[]}' },
    finish('stop'),
  ], seen)
  try {
    await runReview(
      ctx,
      { reviewProvider: 'p', reviewModel: 'm' },
      agent,
      '/tmp/region.md',
      '第一段\n第二段\n第三段',
      { text: '第二段', startLine: 2, endLine: 2 },
      spec,
      '1. "旧句子"',
    )
    const prompt = seen[0].messages[0].content[0].text
    assert.match(prompt, /## Full file under review: \/tmp\/region\.md\n第一段\n第二段\n第三段/)
    assert.match(prompt, /## Review scope: lines 2-2\nAdd new annotations only inside the region below\.\n\n第二段/)
    assert.match(prompt, /## Existing annotations\nReconcile these against the full file\. Return the complete updated list\.\n\n1\. "旧句子"/)
    // 全文在前、审查范围居中、已有批注在最后，模型先看全文再做对账。
    assert.ok(prompt.indexOf('## Full file under review') < prompt.indexOf('## Review scope: lines'))
    assert.ok(prompt.indexOf('## Review scope: lines') < prompt.indexOf('## Existing annotations'))
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
