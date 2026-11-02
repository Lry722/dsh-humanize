/**
 * 审查管线生命周期的单元测试。模拟一次受控的审查流，验证插件停止
 * 接受新审查后的行为：关门、排空在途审查、丢弃排队中的待办。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createReviewPipeline } from '../../lib/review/pipeline.js'
import { historyRoot, requestRoot, setRequestRootResolver, setStorageRootResolver, stagingPathFor, writeStaging } from '../../lib/shared/staging.js'
import { sleep, tick, waitFor } from '../helpers.js'

/**
 * 造一个假 ctx。审查管线只用到 ctx.get。
 */
function fakeContext() {
  // jobs 服务缺失时，告警走降级路径。
  return { get: () => undefined, logger: () => ({ info() {}, warn() {} }) }
}

/** 造一个假 agent，模型配置只从管线配置读取。 */
function fakeAgent(id = 'agent-1', sessionId = 'session-1') {
  return { id, session: { id: sessionId, header: {} } }
}

/** 管线配置。测试默认不等待审查间隔，需要时再覆盖。 */
function fakeConfig(overrides = {}) {
  return {
    reviewProvider: 'p',
    reviewModel: 'm',
    reviewRetries: 0,
    reviewIntervalSeconds: 0,
    ...overrides,
  }
}

/** 空的提交批注负载，审查通过后清掉暂存。 */
const EMPTY_SUBMIT = JSON.stringify({ annotations: [] })

/** 造一个能手动放行的审查流。 */
function gatedStream(gate) {
  const chunks = [
    { type: 'block-start', index: 0, blockType: 'tool-call' },
    { type: 'block-end', index: 0, block: { type: 'tool-call', id: 'call-1', name: 'submit_annotations', arguments: EMPTY_SUBMIT } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
  return {
    [Symbol.asyncIterator]() {
      let i = 0
      return {
        async next() {
          // gate 放行后一次性交出全部块，然后结束。
          await gate
          if (i >= chunks.length) return { done: true, value: undefined }
          i += 1
          return { done: false, value: chunks[i - 1] }
        },
      }
    },
  }
}

/**
 * 造一组受闸门控制的审查流。每调用一次 stream 记一次启动，调用 release
 * 之后才返回结束块，用来观察同时进行的审查数。
 */
function heldStreams() {
  let active = 0
  let peak = 0
  let started = 0
  const releases = []
  const stream = () => {
    active += 1
    started += 1
    peak = Math.max(peak, active)
    let release
    const gate = new Promise((resolve) => { release = resolve })
    releases.push(release)
    return (async function* () {
      try {
        await gate
        yield { type: 'text-delta', index: 0, text: '{"annotations":[]}' }
        yield { type: 'finish', reason: { kind: 'stop' } }
      } finally {
        active -= 1
      }
    })()
  }
  return {
    stream,
    releases,
    active: () => active,
    peak: () => peak,
    started: () => started,
  }
}

test('shutdown 关门：新审查直接跳过，在途审查照常跑完', async () => {
  const storage = await mkdtemp(join(tmpdir(), 'humanize-pipeline-'))
  setStorageRootResolver(() => storage)
  const project = join(storage, 'project')
  await mkdir(join(project, '.git'), { recursive: true })
  await writeFile(join(project, 'PROSE.md'), '# Rules\n1. 平铺直叙。\n', 'utf8')
  const target = join(project, 'doc.md')
  await writeFile(target, '写给人看的文档。\n', 'utf8')

  let release
  const gate = new Promise((resolve) => { release = resolve })
  const ctx = { ...fakeContext(), llm: { stream: () => gatedStream(gate) } }
  const config = fakeConfig()
  const pipeline = createReviewPipeline(ctx, config, { info() {}, warn() {} })
  const agent = fakeAgent()

  const inFlight = pipeline.scheduleReview(agent, target, undefined, '写给人看的文档。\n')
  await tick()
  assert.equal(pipeline.state.disposed, false)

  const draining = pipeline.shutdown()
  assert.equal(pipeline.state.disposed, true)
  // 关门后排队的审查直接跳过。
  assert.deepEqual(await pipeline.scheduleReview(agent, target, undefined, '又一次写入。\n'), { kind: 'skipped' })

  // 放行在途审查的流，shutdown 等它自然结束。
  release()
  const outcome = await inFlight
  assert.equal(outcome.kind, 'ok')
  await draining
  await rm(storage, { recursive: true, force: true })
})

test('shutdown 前进入待办槽的审查按丢弃结算', async () => {
  const storage = await mkdtemp(join(tmpdir(), 'humanize-pipeline-'))
  setStorageRootResolver(() => storage)
  const project = join(storage, 'project')
  await mkdir(join(project, '.git'), { recursive: true })
  await writeFile(join(project, 'PROSE.md'), '# Rules\n1. 平铺直叙。\n', 'utf8')
  const target = join(project, 'doc.md')
  await writeFile(target, '第一版。\n', 'utf8')

  let release
  const gate = new Promise((resolve) => { release = resolve })
  let calls = 0
  const ctx = {
    ...fakeContext(),
    llm: { stream: () => { calls += 1; return gatedStream(gate) } },
  }
  const config = fakeConfig()
  const pipeline = createReviewPipeline(ctx, config, { info() {}, warn() {} })
  const agent = fakeAgent()

  const first = pipeline.scheduleReview(agent, target, undefined, '第一版。\n')
  await tick()
  // 趁在途审查还在跑再写一次，进入待办槽。
  const second = pipeline.scheduleReview(agent, target, '第一版。\n', '第二版。\n')
  await tick()

  const draining = pipeline.shutdown()
  release()
  assert.equal((await first).kind, 'ok')
  // 待办槽的审查直接按丢弃结算，调用次数为 1。
  assert.equal((await second).kind, 'discarded')
  assert.equal(calls, 1)
  await draining
  await rm(storage, { recursive: true, force: true })
})

test('合并锁覆盖的文件直接跳过审查', async () => {
  const pipeline = createReviewPipeline(fakeContext(), fakeConfig(), { info() {}, warn() {} })
  const target = '/tmp/humanize-locked-doc.md'
  pipeline.state.mergeRun = { agentId: 'agent-c', target: null, files: new Set([target]) }
  assert.deepEqual(
    await pipeline.scheduleReview(fakeAgent(), target, undefined, 'x\n'),
    { kind: 'skipped' },
  )
  await pipeline.shutdown()
})

test('同一文件的待办按 agent 分开，后写入的 agent 不覆盖前一个', async () => {
  const storage = await mkdtemp(join(tmpdir(), 'humanize-pipeline-agents-'))
  setStorageRootResolver(() => storage)
  const project = join(storage, 'project')
  await mkdir(join(project, '.git'), { recursive: true })
  await writeFile(join(project, 'PROSE.md'), '# Rules\n1. 平铺直叙。\n', 'utf8')
  const target = join(project, 'doc.md')
  await writeFile(target, '第一版。\n', 'utf8')

  let release
  const gate = new Promise((resolve) => { release = resolve })
  const ctx = { ...fakeContext(), llm: { stream: () => gatedStream(gate) } }
  const config = fakeConfig()
  const pipeline = createReviewPipeline(ctx, config, { info() {}, warn() {} })
  const firstAgent = fakeAgent('agent-a', 'session-a')
  const secondAgent = fakeAgent('agent-b', 'session-b')

  const first = pipeline.scheduleReview(firstAgent, target, undefined, '第一版。\n')
  await tick()
  const second = pipeline.scheduleReview(secondAgent, target, '第一版。\n', '第二版。\n')
  await tick()
  // 同一个 agent 再次写入时只合并自己的待办，各 agent 的待办互相独立。
  const third = pipeline.scheduleReview(firstAgent, target, '第二版。\n', '第三版。\n')
  await tick()

  const entry = pipeline.state.reviewQueues.get(target)
  assert.equal(entry.activeAgent, 'agent-a')
  assert.deepEqual([...entry.pending.keys()].sort(), ['agent-a', 'agent-b'])

  const draining = pipeline.shutdown()
  release()
  await Promise.allSettled([first, second, third])
  await draining
  await rm(storage, { recursive: true, force: true })
})

test('合并目标上的其他 agent 审查会被丢弃或中止', async () => {
  const storage = await mkdtemp(join(tmpdir(), 'humanize-pipeline-discard-'))
  setStorageRootResolver(() => storage)
  const project = join(storage, 'project')
  await mkdir(join(project, '.git'), { recursive: true })
  await writeFile(join(project, 'PROSE.md'), '# Rules\n1. 平铺直叙。\n', 'utf8')
  const target = join(project, 'doc.md')
  await writeFile(target, '第一版。\n', 'utf8')

  let release
  const gate = new Promise((resolve) => { release = resolve })
  const ctx = { ...fakeContext(), llm: { stream: () => gatedStream(gate) } }
  const config = fakeConfig()
  const pipeline = createReviewPipeline(ctx, config, { info() {}, warn() {} })
  const firstAgent = fakeAgent('agent-a', 'session-a')
  const secondAgent = fakeAgent('agent-b', 'session-b')

  const first = pipeline.scheduleReview(firstAgent, target, undefined, '第一版。\n')
  await tick()
  const second = pipeline.scheduleReview(secondAgent, target, '第一版。\n', '第二版。\n')
  await tick()

  // 模拟第三个 agent 开始合并这个文件。它要丢弃待办，并中止在途审查。
  pipeline.discardReviews('agent-c', [target])
  assert.equal(pipeline.state.reviewQueues.get(target).pending.size, 0)

  release()
  assert.equal((await second).kind, 'discarded')
  assert.ok(['aborted', 'discarded'].includes((await first).kind))
  await pipeline.shutdown()
  await rm(storage, { recursive: true, force: true })
})

/** 造一个提交指定批注负载的审查流。 */
function submitStream(payload) {
  const chunks = [
    { type: 'block-start', index: 0, blockType: 'tool-call' },
    { type: 'block-end', index: 0, block: { type: 'tool-call', id: 'call-1', name: 'submit_annotations', arguments: JSON.stringify(payload) } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
  return {
    [Symbol.asyncIterator]() {
      let index = 0
      return {
        async next() {
          if (index >= chunks.length) return { done: true, value: undefined }
          index += 1
          return { done: false, value: chunks[index - 1] }
        },
      }
    },
  }
}

test('项目外真实文件可按项目内逻辑路径匹配规则', async () => {
  const storage = await mkdtemp(join(tmpdir(), 'humanize-pipeline-rule-path-'))
  setStorageRootResolver(() => storage)
  const project = join(storage, 'project')
  await mkdir(join(project, '.git'), { recursive: true })
  await writeFile(join(project, 'PROSE.md'), '# Rules\n1. 平铺直叙。\n', 'utf8')
  const target = join(storage, 'outside.md')
  await writeFile(target, '写给人看的文档。\n', 'utf8')
  const rulePath = join(project, '.agents', 'output', 'latest.md')
  const agent = fakeAgent()
  agent.session.header.cwd = project
  let calls = 0
  const ctx = {
    ...fakeContext(),
    llm: { stream: () => {
      calls += 1
      return submitStream({ annotations: [] })
    } },
  }
  const pipeline = createReviewPipeline(ctx, fakeConfig(), { info() {}, warn() {} })
  try {
    const outcome = await pipeline.scheduleReview(agent, target, undefined, '写给人看的文档。\n', undefined, rulePath)
    assert.equal(outcome.kind, 'ok')
    assert.equal(calls, 1)
  } finally {
    await pipeline.shutdown()
    setStorageRootResolver(() => '')
    await rm(storage, { recursive: true, force: true })
  }
})

test('批注全部对不上规则编号时按失败处理，暂存批注保留', async () => {
  const storage = await mkdtemp(join(tmpdir(), 'humanize-pipeline-dropped-'))
  setStorageRootResolver(() => storage)
  const project = join(storage, 'project')
  await mkdir(join(project, '.git'), { recursive: true })
  await writeFile(join(project, 'PROSE.md'), '# Rules\n1. 平铺直叙。\n', 'utf8')
  const target = join(project, 'doc.md')
  await writeFile(target, '写给人看的文档。\n', 'utf8')
  await writeStaging(target, `1. "写给人看的文档。"\n`)

  let seenTools
  const ctx = {
    ...fakeContext(),
    llm: {
      stream(options) {
        seenTools = options.tools
        return submitStream({ annotations: [{ rule: 99, quote: 'q', problem: 'p', suggestion: 's' }] })
      },
    },
  }
  const config = fakeConfig()
  const pipeline = createReviewPipeline(ctx, config, { info() {}, warn() {} })

  const outcome = await pipeline.scheduleReview(fakeAgent(), target, undefined, '写给人看的文档。\n')
  assert.equal(outcome.kind, 'failed')
  // 暂存原样保留。
  assert.equal(await readFile(stagingPathFor(target), 'utf8').then(() => true), true)
  // 审查请求的 tools 参数为 undefined，模型直接输出文本 JSON。
  assert.equal(seenTools, undefined)
  await rm(storage, { recursive: true, force: true })
})

test('部分批注对不上编号时保留有效批注，并记一条丢弃日志', async () => {
  const storage = await mkdtemp(join(tmpdir(), 'humanize-pipeline-partial-'))
  setStorageRootResolver(() => storage)
  const project = join(storage, 'project')
  await mkdir(join(project, '.git'), { recursive: true })
  await writeFile(join(project, 'PROSE.md'), '# Rules\n1. 平铺直叙。\n', 'utf8')
  const target = join(project, 'doc.md')
  await writeFile(target, '写给人看的文档。\n', 'utf8')

  const warnings = []
  const ctx = {
    ...fakeContext(),
    llm: {
      stream() {
        return submitStream({
          annotations: [
            { rule: 1, quote: 'q', problem: 'p', suggestion: 's' },
            { rule: 42, quote: 'q2', problem: 'p2', suggestion: 's2' },
          ],
        })
      },
    },
  }
  const config = fakeConfig()
  const pipeline = createReviewPipeline(ctx, config, { info() {}, warn: (...args) => warnings.push(args) })

  const outcome = await pipeline.scheduleReview(fakeAgent(), target, undefined, '写给人看的文档。\n')
  assert.equal(outcome.kind, 'ok')
  assert.equal(outcome.annotations, 1)
  assert.equal(warnings.some((args) => String(args[0]).includes('unknown rule numbers')), true)
  await rm(storage, { recursive: true, force: true })
})

test('空批注清除当前暂存时保留审查前的版本', async () => {
  const storage = await mkdtemp(join(tmpdir(), 'humanize-pipeline-history-'))
  setStorageRootResolver(() => storage)
  const previousRequestRoot = requestRoot()
  setRequestRootResolver(() => join(storage, 'requests'))
  const project = join(storage, 'project')
  await mkdir(join(project, '.git'), { recursive: true })
  await writeFile(join(project, 'PROSE.md'), '# Rules\n1. 平铺直叙。\n', 'utf8')
  const target = join(project, 'doc.md')
  await writeFile(target, '写给人看的文档。\n', 'utf8')
  const previous = '1. "审查前的批注"\n'
  await writeStaging(target, previous)

  const ctx = {
    ...fakeContext(),
    llm: { stream: () => submitStream({ annotations: [] }) },
  }
  const pipeline = createReviewPipeline(ctx, fakeConfig(), { info() {}, warn() {} })
  try {
    const outcome = await pipeline.scheduleReview(fakeAgent(), target, undefined, '写给人看的文档。\n')
    assert.deepEqual(outcome, { kind: 'ok', annotations: 0 })
    await assert.rejects(readFile(stagingPathFor(target), 'utf8'), (error) => error?.code === 'ENOENT')
    const files = (await readdir(historyRoot(), { recursive: true }))
      .filter((path) => path.endsWith('.md'))
    assert.equal(files.length, 1)
    assert.match(files[0], /-before-review-clear-[0-9a-f-]+\.md$/)
    assert.equal(await readFile(join(historyRoot(), files[0]), 'utf8'), previous)
  } finally {
    await pipeline.shutdown()
    setStorageRootResolver(() => '')
    setRequestRootResolver(() => previousRequestRoot)
    await rm(storage, { recursive: true, force: true })
  }
})

test('规则分片汇总新批注，已有批注只进入对应分片', async () => {
  const storage = await mkdtemp(join(tmpdir(), 'humanize-pipeline-shards-'))
  const previousRequestRoot = requestRoot()
  setStorageRootResolver(() => storage)
  setRequestRootResolver(() => join(storage, 'requests'))
  const project = join(storage, 'project')
  await mkdir(join(project, '.git'), { recursive: true })
  await writeFile(join(project, 'PROSE.md'), [
    '# Rules',
    '1. one',
    '2. two',
    '3. three',
    '4. four',
    '# Notes',
    '这份说明在每个相关分片里都完整保留。',
    '1. 说明里的编号不是规则。',
  ].join('\n'), 'utf8')
  const target = join(project, 'doc.md')
  await writeFile(target, '旧一\n新二\n旧三\n新四\n', 'utf8')
  await writeStaging(target, [
    '## one',
    '1. "旧一"',
    '',
    '## three',
    '1. "旧三"',
    '',
    '## removed',
    '1. "孤立批注"',
    '',
  ].join('\n'))

  const prompts = []
  const ctx = {
    ...fakeContext(),
    llm: {
      stream(options) {
        const prompt = options.messages[0].content[0].text
        prompts.push(prompt)
        return submitStream({
          annotations: prompt.includes('1. one')
            ? [
                { rule: 1, quote: '旧一', problem: '', suggestion: '' },
                { rule: 2, quote: '新二', problem: 'p2', suggestion: 's2' },
              ]
            : [
                { rule: 3, quote: '旧三', problem: '', suggestion: '' },
                { rule: 4, quote: '新四', problem: 'p4', suggestion: 's4' },
              ],
        })
      },
    },
  }
  const warnings = []
  const pipeline = createReviewPipeline(ctx, fakeConfig({ reviewRuleShardSize: 2 }), {
    info() {}, warn: (...args) => warnings.push(args),
  })
  try {
    const outcome = await pipeline.scheduleReview(fakeAgent(), target, undefined, '旧一\n新二\n旧三\n新四\n')
    assert.deepEqual(outcome, { kind: 'ok', annotations: 4 })
    assert.equal(prompts.length, 2)
    const first = prompts.find((prompt) => prompt.includes('1. one'))
    const second = prompts.find((prompt) => prompt.includes('3. three'))
    assert.ok(first.includes('2. two'))
    assert.ok(!first.includes('3. three'))
    assert.ok(first.includes('这份说明在每个相关分片里都完整保留。'))
    assert.ok(first.includes('1. 说明里的编号不是规则。'))
    const firstExisting = first.split('## Existing annotations\n')[1] ?? ''
    const secondExisting = second.split('## Existing annotations\n')[1] ?? ''
    // 全文本身包含这些引用，所以只检查 Existing annotations 小节。
    assert.ok(firstExisting.includes('旧一') && !firstExisting.includes('旧三') && !firstExisting.includes('孤立批注'))
    assert.ok(second.includes('4. four') && !second.includes('1. one'))
    assert.ok(second.includes('这份说明在每个相关分片里都完整保留。'))
    assert.ok(secondExisting.includes('旧三') && !secondExisting.includes('旧一') && !secondExisting.includes('孤立批注'))

    const staged = await readFile(stagingPathFor(target), 'utf8')
    assert.equal(staged.match(/^\d+\./gm)?.length, 4)
    for (const quote of ['旧一', '新二', '旧三', '新四']) assert.ok(staged.includes(quote))
    assert.ok(!staged.includes('孤立批注'))
    assert.ok(warnings.some((args) => String(args[0]).includes('run /humanize before changing rules')))

    const dumps = (await readdir(requestRoot(), { recursive: true }))
      .filter((path) => path.endsWith('.request.md'))
    assert.equal(dumps.length, 2)
    assert.ok(dumps.some((path) => path.endsWith('doc.md.shard-1.request.md')))
    assert.ok(dumps.some((path) => path.endsWith('doc.md.shard-2.request.md')))
  } finally {
    await pipeline.shutdown()
    setStorageRootResolver(() => '')
    setRequestRootResolver(() => previousRequestRoot)
    await rm(storage, { recursive: true, force: true })
  }
})

test('只重试失败分片，成功分片不重复调用', async () => {
  const storage = await mkdtemp(join(tmpdir(), 'humanize-pipeline-shard-retry-'))
  setStorageRootResolver(() => storage)
  const project = join(storage, 'project')
  await mkdir(join(project, '.git'), { recursive: true })
  await writeFile(join(project, 'PROSE.md'), '# Rules\n1. one\n2. two\n3. three\n4. four\n', 'utf8')
  const target = join(project, 'doc.md')
  await writeFile(target, '正文\n', 'utf8')

  const calls = [0, 0]
  const ctx = {
    ...fakeContext(),
    llm: {
      stream(options) {
        const prompt = options.messages[0].content[0].text
        const shard = prompt.includes('1. one') ? 0 : 1
        calls[shard] += 1
        if (shard === 1 && calls[shard] === 1) throw new Error('temporary shard failure')
        return submitStream({
          annotations: [{ rule: shard === 0 ? 1 : 3, quote: `分片 ${shard}`, problem: 'p', suggestion: 's' }],
        })
      },
    },
  }
  const pipeline = createReviewPipeline(ctx, fakeConfig({ reviewRuleShardSize: 2, reviewRetries: 1 }), { info() {}, warn() {} })
  try {
    const outcome = await pipeline.scheduleReview(fakeAgent(), target, undefined, '正文\n')
    assert.deepEqual(outcome, { kind: 'ok', annotations: 2 })
    assert.deepEqual(calls, [1, 2])
  } finally {
    await pipeline.shutdown()
    setStorageRootResolver(() => '')
    await rm(storage, { recursive: true, force: true })
  }
})

test('任一分片失败时保留完整旧暂存，不写入其他分片的新批注', async () => {
  const storage = await mkdtemp(join(tmpdir(), 'humanize-pipeline-shard-failure-'))
  setStorageRootResolver(() => storage)
  const project = join(storage, 'project')
  await mkdir(join(project, '.git'), { recursive: true })
  await writeFile(join(project, 'PROSE.md'), '# Rules\n1. one\n2. two\n3. three\n4. four\n', 'utf8')
  const target = join(project, 'doc.md')
  await writeFile(target, '正文\n', 'utf8')
  const previous = '## one\n1. "旧批注"\n'
  await writeStaging(target, previous)

  const calls = [0, 0]
  const ctx = {
    ...fakeContext(),
    llm: {
      stream(options) {
        const prompt = options.messages[0].content[0].text
        const shard = prompt.includes('1. one') ? 0 : 1
        calls[shard] += 1
        if (shard === 1) throw new Error('second shard failed')
        return submitStream({
          annotations: [{ rule: 2, quote: '不应写入', problem: 'p', suggestion: 's' }],
        })
      },
    },
  }
  const pipeline = createReviewPipeline(ctx, fakeConfig({ reviewRuleShardSize: 2, reviewRetries: 1 }), { info() {}, warn() {} })
  try {
    const outcome = await pipeline.scheduleReview(fakeAgent(), target, undefined, '正文\n')
    assert.equal(outcome.kind, 'failed')
    assert.match(outcome.message, /second shard failed/)
    // 成功片只调用一次，失败片用完自己的首次尝试和一次重试。
    assert.deepEqual(calls, [1, 2])
    assert.equal(await readFile(stagingPathFor(target), 'utf8'), previous)
  } finally {
    await pipeline.shutdown()
    setStorageRootResolver(() => '')
    await rm(storage, { recursive: true, force: true })
  }
})

test('一片编号全部无效时不能被另一片的有效批注掩盖', async () => {
  const storage = await mkdtemp(join(tmpdir(), 'humanize-pipeline-shard-unknown-'))
  setStorageRootResolver(() => storage)
  const project = join(storage, 'project')
  await mkdir(join(project, '.git'), { recursive: true })
  await writeFile(join(project, 'PROSE.md'), '# Rules\n1. one\n2. two\n3. three\n4. four\n', 'utf8')
  const target = join(project, 'doc.md')
  await writeFile(target, '正文\n', 'utf8')
  const previous = '## three\n1. "第二片的旧批注"\n'
  await writeStaging(target, previous)

  const ctx = {
    ...fakeContext(),
    llm: {
      stream(options) {
        const prompt = options.messages[0].content[0].text
        return submitStream({
          annotations: prompt.includes('1. one')
            ? [{ rule: 1, quote: '第一片的有效批注', problem: 'p', suggestion: 's' }]
            : [{ rule: 999, quote: '未知编号', problem: 'p', suggestion: 's' }],
        })
      },
    },
  }
  const pipeline = createReviewPipeline(ctx, fakeConfig({ reviewRuleShardSize: 2 }), { info() {}, warn() {} })
  try {
    const outcome = await pipeline.scheduleReview(fakeAgent(), target, undefined, '正文\n')
    assert.equal(outcome.kind, 'failed')
    assert.match(outcome.message, /unknown rule number/)
    assert.equal(await readFile(stagingPathFor(target), 'utf8'), previous)
  } finally {
    await pipeline.shutdown()
    setStorageRootResolver(() => '')
    await rm(storage, { recursive: true, force: true })
  }
})

test('二进制文件跳过审查', async () => {
  const storage = await mkdtemp(join(tmpdir(), 'humanize-pipeline-binary-'))
  setStorageRootResolver(() => storage)
  const project = join(storage, 'project')
  await mkdir(join(project, '.git'), { recursive: true })
  await writeFile(join(project, 'PROSE.md'), '# Rules\n1. 平铺直叙。\n', 'utf8')
  const target = join(project, 'image.png')
  await writeFile(target, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00]))

  let calls = 0
  const ctx = {
    ...fakeContext(),
    llm: { stream: () => { calls += 1; return submitStream({ annotations: [] }) } },
  }
  const config = fakeConfig()
  const pipeline = createReviewPipeline(ctx, config, { info() {}, warn() {} })

  assert.deepEqual(
    await pipeline.scheduleReview(fakeAgent(), target, undefined, ''),
    { kind: 'binary' },
  )
  // 被判定为二进制的文件跳过模型调用。
  assert.equal(calls, 0)
  await pipeline.shutdown()
  await rm(storage, { recursive: true, force: true })
})

test('写入审查共用 reviewConcurrency 上限', async () => {
  const storage = await mkdtemp(join(tmpdir(), 'humanize-pipeline-limit-'))
  setStorageRootResolver(() => storage)
  const project = join(storage, 'project')
  await mkdir(join(project, '.git'), { recursive: true })
  await writeFile(join(project, 'PROSE.md'), '# Rules\n1. 平铺直叙。\n', 'utf8')
  const targets = []
  for (let index = 0; index < 3; index += 1) {
    const path = join(project, `doc${index}.md`)
    const content = `第 ${index} 篇。\n`
    await writeFile(path, content, 'utf8')
    targets.push({ path, content })
  }

  const held = heldStreams()
  const ctx = { ...fakeContext(), llm: { stream: held.stream } }
  const config = fakeConfig({ reviewConcurrency: 2 })
  const pipeline = createReviewPipeline(ctx, config, { info() {}, warn() {} })
  const agent = fakeAgent()
  const reviews = targets.map((target) => pipeline.scheduleReview(agent, target.path, undefined, target.content))
  try {
    await waitFor(() => held.started() === 2)
    assert.equal(held.active(), 2)
    assert.equal(held.peak(), 2)

    const release = held.releases.shift()
    assert.equal(typeof release, 'function')
    release()
    await waitFor(() => held.started() === 3)
    assert.equal(held.active(), 2)
    assert.equal(held.peak(), 2)

    while (held.releases.length > 0) held.releases.shift()()
    const outcomes = await Promise.all(reviews)
    assert.deepEqual(outcomes.map((outcome) => outcome.kind), ['ok', 'ok', 'ok'])
    assert.equal(held.peak(), 2)
  } finally {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      while (held.releases.length > 0) held.releases.shift()()
      await tick()
    }
    await Promise.allSettled(reviews)
    await pipeline.shutdown()
    await rm(storage, { recursive: true, force: true })
  }
})

test('同一文件的规则分片也受 reviewConcurrency 上限约束', async () => {
  const storage = await mkdtemp(join(tmpdir(), 'humanize-pipeline-shard-limit-'))
  setStorageRootResolver(() => storage)
  const project = join(storage, 'project')
  await mkdir(join(project, '.git'), { recursive: true })
  await writeFile(join(project, 'PROSE.md'), '# Rules\n1. one\n2. two\n3. three\n4. four\n', 'utf8')
  const target = join(project, 'doc.md')
  const content = '正文\n'
  await writeFile(target, content, 'utf8')

  const held = heldStreams()
  const ctx = { ...fakeContext(), llm: { stream: held.stream } }
  const pipeline = createReviewPipeline(
    ctx,
    fakeConfig({ reviewConcurrency: 2, reviewRuleShardSize: 1 }),
    { info() {}, warn() {} },
  )
  const review = pipeline.scheduleReview(fakeAgent(), target, undefined, content)
  try {
    await waitFor(() => held.started() === 2)
    assert.equal(held.active(), 2)
    assert.equal(held.peak(), 2)
    for (let attempt = 0; attempt < 20 && (held.started() < 4 || held.active() > 0); attempt += 1) {
      while (held.releases.length > 0) held.releases.shift()()
      await tick()
    }
    while (held.releases.length > 0) held.releases.shift()()
    assert.deepEqual(await review, { kind: 'ok', annotations: 0 })
    assert.equal(held.started(), 4)
    assert.equal(held.peak(), 2)
  } finally {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      while (held.releases.length > 0) held.releases.shift()()
      await tick()
    }
    await Promise.allSettled([review])
    await pipeline.shutdown()
    setStorageRootResolver(() => '')
    await rm(storage, { recursive: true, force: true })
  }
})

test('没有命中规范的写入跳过审查，不调用模型', async () => {
  const storage = await mkdtemp(join(tmpdir(), 'humanize-pipeline-review-scope-'))
  setStorageRootResolver(() => storage)
  const project = join(storage, 'project')
  await mkdir(join(project, '.git'), { recursive: true })
  await writeFile(join(project, 'PROSE.md'), '---\ninclude: ["docs/"]\n---\n# Rules\n1. 平铺直叙。\n')
  const target = join(project, 'generated', 'doc.md')
  await mkdir(join(project, 'generated'), { recursive: true })
  await writeFile(target, '生成内容。\n')

  let calls = 0
  const ctx = {
    ...fakeContext(),
    llm: { stream() { calls += 1; throw new Error('review should not run') } },
  }
  const pipeline = createReviewPipeline(ctx, fakeConfig(), { info() {}, warn() {} })
  try {
    const outcome = await pipeline.scheduleReview(fakeAgent(), target, undefined, '生成内容。\n')
    assert.deepEqual(outcome, { kind: 'no-spec' })
    assert.equal(calls, 0)
  } finally {
    await pipeline.shutdown()
    await rm(storage, { recursive: true, force: true })
  }
})

test('规范缺少 Rules 一级标题时直接失败，不重试也不调用模型', async () => {
  const storage = await mkdtemp(join(tmpdir(), 'humanize-pipeline-spec-'))
  setStorageRootResolver(() => storage)
  const project = join(storage, 'project')
  await mkdir(join(project, '.git'), { recursive: true })
  await writeFile(join(project, 'PROSE.md'), '# Glossary\n1. 术语\n', 'utf8')
  const target = join(project, 'doc.md')
  await writeFile(target, '写给人看的文档。\n', 'utf8')

  let calls = 0
  const ctx = {
    ...fakeContext(),
    llm: {
      stream() {
        calls += 1
        throw new Error('review should not run')
      },
    },
  }
  const config = fakeConfig({ reviewRetries: 2 })
  const pipeline = createReviewPipeline(ctx, config, { info() {}, warn() {} })
  try {
    const outcome = await pipeline.scheduleReview(fakeAgent(), target, undefined, '写给人看的文档。\n')
    assert.equal(outcome.kind, 'failed')
    assert.match(outcome.message, /缺少一级标题 # Rules/)
    assert.equal(calls, 0)
  } finally {
    await pipeline.shutdown()
    await rm(storage, { recursive: true, force: true })
  }
})

test('等待并发闸门的审查可以中止', async () => {
  const storage = await mkdtemp(join(tmpdir(), 'humanize-pipeline-abort-'))
  setStorageRootResolver(() => storage)
  const project = join(storage, 'project')
  await mkdir(join(project, '.git'), { recursive: true })
  await writeFile(join(project, 'PROSE.md'), '# Rules\n1. 平铺直叙。\n', 'utf8')
  const firstTarget = join(project, 'first.md')
  const secondTarget = join(project, 'second.md')
  await writeFile(firstTarget, '第一篇。\n', 'utf8')
  await writeFile(secondTarget, '第二篇。\n', 'utf8')

  const held = heldStreams()
  const ctx = { ...fakeContext(), llm: { stream: held.stream } }
  const config = fakeConfig({ reviewConcurrency: 1 })
  const pipeline = createReviewPipeline(ctx, config, { info() {}, warn() {} })
  const agent = fakeAgent()
  const controller = new AbortController()
  const first = pipeline.scheduleReview(agent, firstTarget, undefined, '第一篇。\n')
  const second = pipeline.scheduleReview(agent, secondTarget, undefined, '第二篇。\n', controller.signal)
  try {
    await waitFor(() => held.started() === 1)
    await tick()
    controller.abort()
    const outcome = await second
    assert.equal(outcome.kind, 'aborted')
    assert.equal(held.started(), 1)

    held.releases.shift()()
    assert.equal((await first).kind, 'ok')
    assert.equal(held.started(), 1)
  } finally {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      while (held.releases.length > 0) held.releases.shift()()
      await tick()
    }
    await Promise.allSettled([first, second])
    await pipeline.shutdown()
    await rm(storage, { recursive: true, force: true })
  }
})

test('首次写入立即审查，审查结束后才开始倒计时', async () => {
  const storage = await mkdtemp(join(tmpdir(), 'humanize-pipeline-interval-first-'))
  setStorageRootResolver(() => storage)
  const project = join(storage, 'project')
  await mkdir(join(project, '.git'), { recursive: true })
  await writeFile(join(project, 'PROSE.md'), '# Rules\n1. 平铺直叙。\n', 'utf8')
  const target = join(project, 'doc.md')
  await writeFile(target, '第一版。\n', 'utf8')

  let calls = 0
  const ctx = {
    ...fakeContext(),
    llm: { stream: () => { calls += 1; return submitStream({ annotations: [] }) } },
  }
  // 配置缺少 reviewIntervalSeconds 时取默认值 60 秒，首次审查立即执行。
  const config = { reviewProvider: 'p', reviewModel: 'm', reviewRetries: 0 }
  const pipeline = createReviewPipeline(ctx, config, { info() {}, warn() {} })
  const first = pipeline.scheduleWriteReview(fakeAgent(), target, undefined, '第一版。\n')
  const outcome = await Promise.race([first, sleep(1000).then(() => ({ kind: 'timeout' }))])
  assert.equal(outcome.kind, 'ok')
  assert.equal(calls, 1)
  // 审查结束后才开始倒计时。
  await waitFor(() => Boolean(pipeline.state.reviewQueues.get(target)?.cooldownTimer))
  await pipeline.shutdown()
  assert.equal(pipeline.state.reviewQueues.size, 0)
  await rm(storage, { recursive: true, force: true })
})

test('审查结束后开始倒计时，间隔内的写入合并到下一次审查', async () => {
  const storage = await mkdtemp(join(tmpdir(), 'humanize-pipeline-interval-'))
  setStorageRootResolver(() => storage)
  const project = join(storage, 'project')
  await mkdir(join(project, '.git'), { recursive: true })
  await writeFile(join(project, 'PROSE.md'), '# Rules\n1. 平铺直叙。\n', 'utf8')
  const target = join(project, 'doc.md')
  await writeFile(target, '第一版。\n', 'utf8')

  let calls = 0
  const ctx = {
    ...fakeContext(),
    llm: { stream: () => { calls += 1; return submitStream({ annotations: [] }) } },
  }
  const pipeline = createReviewPipeline(ctx, fakeConfig({ reviewIntervalSeconds: 0.3 }), { info() {}, warn() {} })
  const agent = fakeAgent()

  const first = pipeline.scheduleWriteReview(agent, target, undefined, '第一版。\n')
  assert.equal((await first).kind, 'ok')
  assert.equal(calls, 1)
  await waitFor(() => Boolean(pipeline.state.reviewQueues.get(target)?.cooldownTimer))

  await writeFile(target, '第二版。\n', 'utf8')
  const second = pipeline.scheduleWriteReview(agent, target, '第一版。\n', '第二版。\n')
  await writeFile(target, '第三版。\n', 'utf8')
  const third = pipeline.scheduleWriteReview(agent, target, '第二版。\n', '第三版。\n')
  await sleep(120)
  // 倒计时内只积累待办，不发起新的审查。
  assert.equal(calls, 1)
  await waitFor(() => calls === 2)
  // 两次写入合并成一次审查，两个等待方拿到同一个结果。
  assert.equal((await second).kind, 'ok')
  assert.equal((await third).kind, 'ok')
  // 第二次审查结束后重新开始倒计时。
  await waitFor(() => Boolean(pipeline.state.reviewQueues.get(target)?.cooldownTimer))
  await pipeline.shutdown()
  await rm(storage, { recursive: true, force: true })
})

test('批次审查不受间隔限制，结束后重新倒计时', async () => {
  const storage = await mkdtemp(join(tmpdir(), 'humanize-pipeline-interval-batch-'))
  setStorageRootResolver(() => storage)
  const project = join(storage, 'project')
  await mkdir(join(project, '.git'), { recursive: true })
  await writeFile(join(project, 'PROSE.md'), '# Rules\n1. 平铺直叙。\n', 'utf8')
  const target = join(project, 'doc.md')
  await writeFile(target, '第一版。\n', 'utf8')

  let calls = 0
  const ctx = {
    ...fakeContext(),
    llm: { stream: () => { calls += 1; return submitStream({ annotations: [] }) } },
  }
  const pipeline = createReviewPipeline(ctx, fakeConfig({ reviewIntervalSeconds: 5 }), { info() {}, warn() {} })
  const agent = fakeAgent()

  const first = pipeline.scheduleWriteReview(agent, target, undefined, '第一版。\n')
  assert.equal((await first).kind, 'ok')
  await waitFor(() => Boolean(pipeline.state.reviewQueues.get(target)?.cooldownTimer))
  await writeFile(target, '第二版。\n', 'utf8')
  // 批次审查或合并复审直接执行，不等倒计时。
  const manual = pipeline.scheduleReview(agent, target, '第一版。\n', '第二版。\n')
  const outcome = await Promise.race([manual, sleep(1000).then(() => ({ kind: 'timeout' }))])
  assert.equal(outcome.kind, 'ok')
  assert.equal(calls, 2)
  // 立即审查结束后同样重新开始倒计时。
  await waitFor(() => Boolean(pipeline.state.reviewQueues.get(target)?.cooldownTimer))
  await pipeline.shutdown()
  await rm(storage, { recursive: true, force: true })
})

test('间隔为 0 时写入审查不等待', async () => {
  const storage = await mkdtemp(join(tmpdir(), 'humanize-pipeline-interval-zero-'))
  setStorageRootResolver(() => storage)
  const project = join(storage, 'project')
  await mkdir(join(project, '.git'), { recursive: true })
  await writeFile(join(project, 'PROSE.md'), '# Rules\n1. 平铺直叙。\n', 'utf8')
  const target = join(project, 'doc.md')
  await writeFile(target, '第一版。\n', 'utf8')

  let calls = 0
  const ctx = {
    ...fakeContext(),
    llm: { stream: () => { calls += 1; return submitStream({ annotations: [] }) } },
  }
  const pipeline = createReviewPipeline(ctx, fakeConfig(), { info() {}, warn() {} })
  const agent = fakeAgent()

  assert.equal((await pipeline.scheduleWriteReview(agent, target, undefined, '第一版。\n')).kind, 'ok')
  await writeFile(target, '第二版。\n', 'utf8')
  assert.equal((await pipeline.scheduleWriteReview(agent, target, '第一版。\n', '第二版。\n')).kind, 'ok')
  assert.equal(calls, 2)
  await tick()
  assert.equal(pipeline.state.reviewQueues.size, 0)
  await pipeline.shutdown()
  await rm(storage, { recursive: true, force: true })
})

test('合并或卸载会丢弃倒计时中的写入审查', async () => {
  const storage = await mkdtemp(join(tmpdir(), 'humanize-pipeline-interval-discard-'))
  setStorageRootResolver(() => storage)
  const project = join(storage, 'project')
  await mkdir(join(project, '.git'), { recursive: true })
  await writeFile(join(project, 'PROSE.md'), '# Rules\n1. 平铺直叙。\n', 'utf8')
  const firstTarget = join(project, 'first.md')
  const secondTarget = join(project, 'second.md')
  await writeFile(firstTarget, '第一篇。\n', 'utf8')
  await writeFile(secondTarget, '第二篇。\n', 'utf8')

  let calls = 0
  const ctx = {
    ...fakeContext(),
    llm: { stream: () => { calls += 1; return submitStream({ annotations: [] }) } },
  }
  const pipeline = createReviewPipeline(ctx, fakeConfig({ reviewIntervalSeconds: 5 }), { info() {}, warn() {} })
  const agent = fakeAgent()

  const first = pipeline.scheduleWriteReview(agent, firstTarget, undefined, '第一篇。\n')
  const second = pipeline.scheduleWriteReview(agent, secondTarget, undefined, '第二篇。\n')
  assert.deepEqual((await Promise.all([first, second])).map((item) => item.kind), ['ok', 'ok'])
  assert.equal(calls, 2)
  await waitFor(() => Boolean(pipeline.state.reviewQueues.get(firstTarget)?.cooldownTimer)
    && Boolean(pipeline.state.reviewQueues.get(secondTarget)?.cooldownTimer))

  await writeFile(firstTarget, '第一篇改。\n', 'utf8')
  const discarded = pipeline.scheduleWriteReview(agent, firstTarget, '第一篇。\n', '第一篇改。\n')
  await writeFile(secondTarget, '第二篇改。\n', 'utf8')
  const skipped = pipeline.scheduleWriteReview(agent, secondTarget, '第二篇。\n', '第二篇改。\n')

  // 合并开始时丢弃倒计时里的待办，并取消计时器。
  pipeline.discardReviews('agent-2', [firstTarget])
  assert.deepEqual(await discarded, { kind: 'discarded' })
  assert.equal(pipeline.state.reviewQueues.has(firstTarget), false)
  // 关门时丢弃另一条倒计时里的待办。
  await pipeline.shutdown()
  assert.deepEqual(await skipped, { kind: 'discarded' })
  assert.equal(pipeline.state.reviewQueues.size, 0)
  await rm(storage, { recursive: true, force: true })
})

test('runSlot 在内部 try 之前抛错时按失败结算等待方', async () => {
  const pipeline = createReviewPipeline(fakeContext(), fakeConfig(), { info() {}, warn() {} })
  // 审查代次发生在 runSlot 的 try 之前，用它模拟同步的管线状态错误。
  pipeline.state.reviewGen = {
    get() {
      throw new Error('状态读取失败')
    },
  }
  const target = '/tmp/humanize-pump-reject-doc.md'

  const outcome = await pipeline.scheduleReview(fakeAgent(), target, undefined, '写给人看的文档。\n')
  assert.deepEqual(outcome, { kind: 'failed', message: '状态读取失败' })
  // 失败结算后排队位置被摘掉。
  await waitFor(() => !pipeline.state.reviewQueues.has(target))
  await pipeline.shutdown()
})
