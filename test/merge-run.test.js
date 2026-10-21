/**
 * 合并运行的测试。用假的子代理和审查调度验证：单次合并跑完就结束，
 * 循环合并复审出新批注才继续下一轮，合并失败时暂存批注保留。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isMergeAgent, registerMerge } from '../lib/merge.js'
import { createReviewPipeline } from '../lib/pipeline.js'
import { setStorageRootResolver, stagingPathFor, writeStaging } from '../lib/staging.js'

const log = { info() {}, warn() {} }

/**
 * 造一个假 ctx。jobs 服务缺失，任务进度走空实现。agents.list 返回
 * 注册表里的全部 agent，派发前的合并子代理检查靠它。
 */
function makeCtx(agents, activation, llm) {
  const list = [...agents]
  const byId = new Map(list.map((agent) => [agent.id, agent]))
  const bySession = new Map(list.map((agent) => [agent.session.id, agent]))
  const commands = new Map()
  const listeners = new Map()
  return {
    logger: () => log,
    get: () => undefined,
    agents: {
      get: (id) => byId.get(id) ?? bySession.get(id),
      list: () => list,
    },
    subagents: { startActivation: activation },
    ...(llm !== undefined ? { llm } : {}),
    commands: {
      register(def) { commands.set(def.name, def) },
      get(name) { return commands.get(name) },
    },
    on(event, callback) {
      const callbacks = listeners.get(event) ?? []
      callbacks.push(callback)
      listeners.set(event, callbacks)
      return () => {
        const index = callbacks.indexOf(callback)
        if (index >= 0) callbacks.splice(index, 1)
      }
    },
    effect() {},
    inject() {},
    emit(event, ...args) {
      for (const callback of [...(listeners.get(event) ?? [])]) callback(...args)
    },
  }
}

function makeState() {
  return {
    disposed: false,
    merging: new Set(),
    reviewing: new Set(),
    running: new Set(),
    reviewBatchAbort: new Map(),
    reviewQueues: new Map(),
  }
}

function makeAgent(id, sessionId, cwd) {
  const injected = []
  return {
    id,
    injected,
    inject(message) { injected.push(message) },
    session: {
      id: sessionId,
      header: { cwd, agentPreset: 'standard' },
      requestHeader: () => undefined,
    },
  }
}

function makeChild(id, parentSessionId) {
  return {
    id,
    session: {
      id,
      header: { parentSession: parentSessionId, agentPreset: 'humanize-merge', origin: 'subagent' },
    },
  }
}

/** 可手动放行的合并子代理。 */
function deferredActivation(childId) {
  let resolve
  const result = new Promise((done) => { resolve = done })
  return {
    activation: { childId, result, dispose: async () => {} },
    resolve,
  }
}

/** 记录复审调用的假调度器，全部按“没有新批注”返回。 */
function makeReviews() {
  const calls = []
  return {
    calls,
    async scheduleReview(agent, filePath, before, after) {
      calls.push({ agent, filePath, before, after })
      return { kind: 'ok', annotations: 0 }
    },
  }
}

async function waitFor(predicate, timeoutMs = 3000) {
  const started = Date.now()
  while (!(await predicate())) {
    if (Date.now() - started > timeoutMs) throw new Error('timed out waiting for the merge loop')
    await new Promise((resolve) => { setTimeout(resolve, 10) })
  }
}

async function removeStorage(storage) {
  // 后台循环可能刚好在写真暂存，删除目录时重试几次。
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      await rm(storage, { recursive: true, force: true })
      return
    } catch (error) {
      if (error?.code !== 'ENOTEMPTY' || attempt === 19) throw error
      await new Promise((resolve) => { setTimeout(resolve, 20) })
    }
  }
}

async function makeProject(storage) {
  const project = join(storage, 'project')
  await mkdir(join(project, '.git'), { recursive: true })
  await writeFile(join(project, 'PROSE.md'), '1. 平铺直叙。\n', 'utf8')
  const target = join(project, 'doc.md')
  await writeFile(target, '第一版。\n', 'utf8')
  await writeStaging(target, `# ${target}\n\n1. "第一版。"\n`)
  return { project, target }
}

function noticeTexts(agent) {
  return agent.injected.map((message) => message.content?.[0]?.text ?? '').join('\n')
}

test('一轮合并后复查没有新批注时正常结束', async () => {
  const storage = await mkdtemp(join(tmpdir(), 'humanize-loop-'))
  setStorageRootResolver(() => storage)
  try {
    const { project } = await makeProject(storage)
    const agent = makeAgent('agent-1', 'session-1', project)
    const activation = deferredActivation('child-1')
    const ctx = makeCtx([agent], async () => activation.activation)
    const state = makeState()
    const reviews = makeReviews()
    registerMerge(ctx, log, { loopMaxRounds: 3 }, state, reviews.scheduleReview, async () => {}, () => {})

    const result = await ctx.commands.get('humanize-loop').handler({ agent, rawInput: '' })
    assert.equal(result.kind, 'success')
    activation.resolve({ stopReason: 'completed' })

    await waitFor(() => state.running.size === 0)
    assert.equal(reviews.calls.length, 1)
    assert.match(noticeTexts(agent), /已按暂存批注修订/)
    // 折叠行摘要是概括，完整文件清单留在正文里，不受摘要长度上限影响。
    const notice = agent.injected.find((message) => message.source?.form === 'notice')
    assert.equal(notice.source.summary, '已按暂存批注修订 1 个文件。')
    assert.match(notice.content[0].text, /doc\.md/)
    await assert.rejects(readFile(stagingPathFor(join(project, 'doc.md'))), /ENOENT/)
  } finally {
    await removeStorage(storage)
  }
})

test('合并运行期间持有运行锁，运行结束后释放', async () => {
  const storage = await mkdtemp(join(tmpdir(), 'humanize-loop-lock-'))
  setStorageRootResolver(() => storage)
  try {
    const { project } = await makeProject(storage)
    const agent = makeAgent('agent-1', 'session-1', project)
    const activation = deferredActivation('child-1')
    const ctx = makeCtx([agent], async () => activation.activation)
    const state = makeState()
    registerMerge(ctx, log, { loopMaxRounds: 3 }, state, makeReviews().scheduleReview, async () => {}, () => {})

    assert.equal(state.running.size, 0)
    const result = await ctx.commands.get('humanize-loop').handler({ agent, rawInput: '' })
    assert.equal(result.kind, 'success')
    // 命令返回时首次派发已经完成，运行锁要一直持有到运行结束。
    assert.ok(state.running.has('agent-1'))

    activation.resolve({ stopReason: 'completed' })
    await waitFor(() => state.running.size === 0)
  } finally {
    await removeStorage(storage)
  }
})

test('复审产生新批注后继续下一轮，收敛才结束', async () => {
  const storage = await mkdtemp(join(tmpdir(), 'humanize-loop-rounds-'))
  setStorageRootResolver(() => storage)
  try {
    const { project, target } = await makeProject(storage)
    const agent = makeAgent('agent-1', 'session-1', project)
    let starts = 0
    let reviews = 0
    const ctx = makeCtx([agent], async () => {
      starts += 1
      const activation = deferredActivation(`child-${starts}`)
      // 子代理总是立刻完成，第二轮要看复审是否真的又排了一轮。
      queueMicrotask(() => activation.resolve({ stopReason: 'completed' }))
      return activation.activation
    })
    const state = makeState()
    const scheduleReview = async (reviewAgent, filePath) => {
      reviews += 1
      if (reviews === 1) {
        await writeStaging(filePath, `# ${filePath}\n\n1. "第一版。"\n`)
        return { kind: 'ok', annotations: 1 }
      }
      return { kind: 'ok', annotations: 0 }
    }
    registerMerge(ctx, log, { loopMaxRounds: 3 }, state, scheduleReview, async () => {}, () => {})

    await ctx.commands.get('humanize-loop').handler({ agent, rawInput: '' })
    await waitFor(() => state.running.size === 0)

    assert.equal(starts, 2)
    assert.equal(reviews, 2)
    // 复审结果只进任务行，会话只收到合并修改说明。
    const mergeNotices = agent.injected.filter((message) => /已按暂存批注修订/.test(message.content?.[0]?.text ?? ''))
    assert.equal(mergeNotices.length, 2)
    await assert.rejects(readFile(stagingPathFor(target)), /ENOENT/)
  } finally {
    await removeStorage(storage)
  }
})

test('合并失败时保留暂存批注，不再开下一轮', async () => {
  const storage = await mkdtemp(join(tmpdir(), 'humanize-loop-failed-'))
  setStorageRootResolver(() => storage)
  try {
    const { project, target } = await makeProject(storage)
    const agent = makeAgent('agent-1', 'session-1', project)
    const activation = deferredActivation('child-1')
    const ctx = makeCtx([agent], async () => activation.activation)
    const state = makeState()
    const reviews = makeReviews()
    registerMerge(ctx, log, { loopMaxRounds: 3 }, state, reviews.scheduleReview, async () => {}, () => {})

    await ctx.commands.get('humanize-loop').handler({ agent, rawInput: '' })
    activation.resolve({ stopReason: 'error', diagnostic: '429 quota exceeded; retry in 51s' })
    await waitFor(() => state.running.size === 0)

    assert.equal(reviews.calls.length, 0)
    // 失败原因要带回主会话，用户不用打开子代理会话也能看到。
    assert.match(noticeTexts(agent), /429 quota exceeded/)
    assert.equal(await readFile(stagingPathFor(target), 'utf8').then(() => true), true)
  } finally {
    await removeStorage(storage)
  }
})

test('合并子代理还在运行时拒绝新的派发', async () => {
  const storage = await mkdtemp(join(tmpdir(), 'humanize-merge-busy-'))
  setStorageRootResolver(() => storage)
  try {
    const { project } = await makeProject(storage)
    const agent = makeAgent('agent-1', 'session-1', project)
    const child = makeChild('child-1', 'session-1')
    const ctx = makeCtx([agent, child], async () => { throw new Error('不应派发') })
    const state = makeState()
    registerMerge(ctx, log, { loopMaxRounds: 3 }, state, makeReviews().scheduleReview, async () => {}, () => {})

    const result = await ctx.commands.get('humanize-loop').handler({ agent, rawInput: '' })
    assert.equal(result.kind, 'error')
    assert.match(result.text, /子代理还在运行/)
    assert.equal(state.running.size, 0)
  } finally {
    await removeStorage(storage)
  }
})

test('合并子代理按会话头里的 preset 识别', () => {
  const child = makeChild('child-1', 'session-1')
  const agent = makeAgent('agent-1', 'session-1', '/tmp')
  assert.equal(isMergeAgent(child), true)
  assert.equal(isMergeAgent(agent), false)
})

/** 造一个提交批注的审查流，参数结构对齐 submit_annotations。 */
function submitStream(annotations) {
  const chunks = [
    { type: 'block-start', index: 0, blockType: 'tool-call' },
    { type: 'block-end', index: 0, block: { type: 'tool-call', id: 'call-1', name: 'submit_annotations', arguments: JSON.stringify({ annotations }) } },
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

test('循环复审走真实审查管线，新批注进入下一轮并最终清空', async () => {
  const storage = await mkdtemp(join(tmpdir(), 'humanize-loop-pipeline-'))
  setStorageRootResolver(() => storage)
  try {
    const { project, target } = await makeProject(storage)
    const agent = makeAgent('agent-1', 'session-1', project)
    let starts = 0
    let reviews = 0
    const ctx = makeCtx(
      [agent],
      async () => {
        starts += 1
        const activation = deferredActivation(`child-${starts}`)
        // 合并子代理改写文件，复审才会看到非空改动区段。
        await writeFile(target, starts === 1 ? '第二版。\n' : '第三版。\n', 'utf8')
        queueMicrotask(() => activation.resolve({ stopReason: 'completed' }))
        return activation.activation
      },
      {
        stream() {
          reviews += 1
          return submitStream(reviews === 1
            ? [{ rule: 1, quote: '第二版。', problem: '太短。', suggestion: '展开。' }]
            : [])
        },
      },
    )
    const config = {
      reviewProvider: 'p',
      reviewModel: 'm',
      reviewRetries: 0,
      loopMaxRounds: 3,
    }
    const pipeline = createReviewPipeline(ctx, config, log)
    registerMerge(ctx, log, config, pipeline.state, pipeline.scheduleReview, pipeline.waitForReviews, pipeline.discardReviews)

    await ctx.commands.get('humanize-loop').handler({ agent, rawInput: '' })
    await waitFor(() => pipeline.state.running.size === 0)

    assert.equal(starts, 2)
    assert.equal(reviews, 2)
    assert.equal(await readFile(target, 'utf8'), '第三版。\n')
    // 复审结果只进任务行，会话只收到合并修改说明。
    const mergeNotices = agent.injected.filter((message) => /已按暂存批注修订/.test(message.content?.[0]?.text ?? ''))
    assert.equal(mergeNotices.length, 2)
    await assert.rejects(readFile(stagingPathFor(target)), /ENOENT/)
  } finally {
    await removeStorage(storage)
  }
})

test('一次 /humanize 合并照常清暂存并排复审', async () => {
  const storage = await mkdtemp(join(tmpdir(), 'humanize-merge-once-'))
  setStorageRootResolver(() => storage)
  try {
    const { project } = await makeProject(storage)
    const agent = makeAgent('agent-1', 'session-1', project)
    const activation = deferredActivation('child-1')
    const ctx = makeCtx([agent], async () => activation.activation)
    const state = makeState()
    const reviews = makeReviews()
    registerMerge(ctx, log, { loopMaxRounds: 3 }, state, reviews.scheduleReview, async () => {}, () => {})

    const result = await ctx.commands.get('humanize').handler({ agent, rawInput: '' })
    assert.equal(result.kind, 'success')
    activation.resolve({ stopReason: 'completed' })

    await waitFor(() => reviews.calls.length === 1 && state.running.size === 0)
    assert.match(noticeTexts(agent), /已按暂存批注修订/)
  } finally {
    await removeStorage(storage)
  }
})

test('一次 /humanize 复审还有批注也到此为止，不再开下一轮', async () => {
  const storage = await mkdtemp(join(tmpdir(), 'humanize-run-once-annotations-'))
  setStorageRootResolver(() => storage)
  try {
    const { project, target } = await makeProject(storage)
    const agent = makeAgent('agent-1', 'session-1', project)
    let starts = 0
    const ctx = makeCtx([agent], async () => {
      starts += 1
      const activation = deferredActivation(`child-${starts}`)
      queueMicrotask(() => activation.resolve({ stopReason: 'completed' }))
      return activation.activation
    })
    const state = makeState()
    let reviews = 0
    const scheduleReview = async (reviewAgent, filePath) => {
      reviews += 1
      await writeStaging(filePath, `# ${filePath}\n\n1. "重写后的行文。"\n`)
      return { kind: 'ok', annotations: 1 }
    }
    registerMerge(ctx, log, { loopMaxRounds: 3 }, state, scheduleReview, async () => {}, () => {})

    const result = await ctx.commands.get('humanize').handler({ agent, rawInput: '' })
    assert.equal(result.kind, 'success')
    await waitFor(() => state.running.size === 0)

    assert.equal(starts, 1)
    assert.equal(reviews, 1)
    assert.match(noticeTexts(agent), /已按暂存批注修订/)
    // 单次合并不跟进下一轮，复审产生的批注留在暂存里。
    assert.equal(await readFile(stagingPathFor(target), 'utf8').then(() => true), true)
  } finally {
    await removeStorage(storage)
  }
})

test('插件重载后运行结束，已完成的合并不再复审', async () => {
  const storage = await mkdtemp(join(tmpdir(), 'humanize-loop-reload-'))
  setStorageRootResolver(() => storage)
  try {
    const { project, target } = await makeProject(storage)
    const agent = makeAgent('agent-1', 'session-1', project)
    const activation = deferredActivation('child-1')
    const ctx = makeCtx([agent], async () => activation.activation)
    const state = makeState()
    const reviews = makeReviews()
    registerMerge(ctx, log, { loopMaxRounds: 3 }, state, reviews.scheduleReview, async () => {}, () => {})

    await ctx.commands.get('humanize-loop').handler({ agent, rawInput: '' })
    // 插件重载把 disposed 置位，随后子代理跑完。这次运行到此结束。
    state.disposed = true
    activation.resolve({ stopReason: 'completed' })
    await waitFor(() => state.running.size === 0)

    assert.equal(reviews.calls.length, 0)
    // 子代理已完成时合并照常收尾：清暂存并留下成功说明。
    await assert.rejects(readFile(stagingPathFor(target), 'utf8'), /ENOENT/)
    assert.match(noticeTexts(agent), /已按暂存批注修订/)
  } finally {
    await removeStorage(storage)
  }
})

test('合并期间写入的新暂存批注不会被旧快照清掉', async () => {
  const storage = await mkdtemp(join(tmpdir(), 'humanize-merge-new-staging-'))
  setStorageRootResolver(() => storage)
  try {
    const { project, target } = await makeProject(storage)
    const agent = makeAgent('agent-1', 'session-1', project)
    const activation = deferredActivation('child-1')
    // 派发前先改写暂存，模拟合并期间另一次审查写入了新批注。
    const ctx = makeCtx([agent], async () => {
      await writeStaging(target, `# ${target}\n\n1. "合并期间的新批注。"\n`)
      return activation.activation
    })
    const state = makeState()
    registerMerge(ctx, log, { loopMaxRounds: 1 }, state, makeReviews().scheduleReview, async () => {}, () => {})

    await ctx.commands.get('humanize').handler({ agent, rawInput: '' })
    activation.resolve({ stopReason: 'completed' })
    await waitFor(() => state.running.size === 0)

    // 内容已经和合并前的快照不同，按新内容保留。
    const kept = await readFile(stagingPathFor(target), 'utf8')
    assert.match(kept, /合并期间的新批注/)
  } finally {
    await removeStorage(storage)
  }
})

test('压缩结束触发合并，完成后留下结果说明', async () => {
  const storage = await mkdtemp(join(tmpdir(), 'humanize-compaction-'))
  setStorageRootResolver(() => storage)
  try {
    const { project } = await makeProject(storage)
    const agent = makeAgent('agent-1', 'session-1', project)
    let starts = 0
    const activation = deferredActivation('child-1')
    const ctx = makeCtx([agent], async () => {
      starts += 1
      return activation.activation
    })
    const state = makeState()
    registerMerge(ctx, log, { mergeOnCompaction: true, loopMaxRounds: 3 }, state, makeReviews().scheduleReview, async () => {}, () => {})

    ctx.emit('session/event', { id: 'session-1', header: { cwd: project } }, { type: 'compaction/end', data: {} })
    await waitFor(() => starts === 1)
    activation.resolve({ stopReason: 'completed' })
    await waitFor(() => state.merging.size === 0)

    assert.match(noticeTexts(agent), /已按暂存批注修订/)
  } finally {
    await removeStorage(storage)
  }
})

test('合并请求写到临时文件，子代理完成后清理', async () => {
  const storage = await mkdtemp(join(tmpdir(), 'humanize-merge-request-'))
  setStorageRootResolver(() => storage)
  try {
    const { project } = await makeProject(storage)
    const agent = makeAgent('agent-1', 'session-1', project)
    let activationSpec
    const activation = deferredActivation('child-1')
    const ctx = makeCtx([agent], async (spec) => {
      activationSpec = spec
      return activation.activation
    })
    const state = makeState()
    registerMerge(ctx, log, { loopMaxRounds: 1 }, state, makeReviews().scheduleReview, async () => {}, () => {})

    await ctx.commands.get('humanize').handler({ agent, rawInput: '' })
    const text = activationSpec.request.prompt[0].text
    const match = /The merge request is in (.+?)\.\n/.exec(text)
    assert.ok(match, text)
    const requestPath = match[1]
    assert.match(await readFile(requestPath, 'utf8'), /## Rules/)

    activation.resolve({ stopReason: 'completed' })
    await waitFor(() => state.running.size === 0)
    await assert.rejects(readFile(requestPath, 'utf8'), /ENOENT/)
  } finally {
    await removeStorage(storage)
  }
})
