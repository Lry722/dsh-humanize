/**
 * 合并运行（单次和循环）的热重载测试。用假的子代理和审查调度
 * 验证：一轮合并结束后不会把“暂存为空”误判成收敛；重载后新实例
 * 会补完上一轮复审，单次合并到此结束，循环合并继续下一轮。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { reconcilePendingMerges, registerMerge } from '../lib/merge.js'
import { createReviewPipeline } from '../lib/pipeline.js'
import { setStorageRootResolver, stagingPathFor, writeStaging } from '../lib/staging.js'

const log = { info() {}, warn() {} }

/**
 * 造一个假 ctx。jobs 服务缺失，任务进度走空实现；事件监听存在
 * emit 里，测试可以手动发出子代理的 turn/end。
 */
function makeCtx(agents, activation, llm) {
  const commands = new Map()
  const listeners = new Map()
  return {
    logger: () => log,
    get: () => undefined,
    agents: { get: (id) => agents.get(id), list: () => [] },
    subagents: { startActivation: activation },
    ...(llm !== undefined ? { llm } : {}),
    commands: {
      register(def) { commands.set(def.name, def) },
      get(name) { return commands.get(name) },
    },
    on(event, callback) {
      const list = listeners.get(event) ?? []
      list.push(callback)
      listeners.set(event, list)
      return () => {
        const index = list.indexOf(callback)
        if (index >= 0) list.splice(index, 1)
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
  const appended = []
  return {
    id,
    appended,
    session: {
      id: sessionId,
      header: { cwd },
      requestHeader: () => undefined,
      append(type, message) { appended.push(message) },
      snapshotEvents: () => [],
    },
  }
}

function makeChild(id) {
  return {
    id,
    session: {
      id,
      snapshotEvents: () => [],
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
  // 后台循环可能刚好在写锁文件，删除目录时重试几次。
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
  return agent.appended.map((message) => message.content?.[0]?.text ?? '').join('\n')
}

test('一轮合并后复查没有新批注时正常结束', async () => {
  const storage = await mkdtemp(join(tmpdir(), 'humanize-loop-'))
  setStorageRootResolver(() => storage)
  try {
    const { project } = await makeProject(storage)
    const agent = makeAgent('agent-1', 'session-1', project)
    const activation = deferredActivation('child-1')
    const ctx = makeCtx(new Map([['agent-1', agent]]), async () => activation.activation)
    const state = makeState()
    const reviews = makeReviews()
    registerMerge(ctx, log, { loopMaxRounds: 3 }, state, reviews.scheduleReview, async () => {}, () => {})

    const result = await ctx.commands.get('humanize-loop').handler({ agent, rawInput: '' })
    assert.equal(result.kind, 'success')
    activation.resolve({ stopReason: 'completed' })

    await waitFor(() => state.running.size === 0 && !existsSync(join(storage, 'merge-runs.json')))
    assert.equal(reviews.calls.length, 1)
    assert.match(noticeTexts(agent), /循环合并第 1 轮结束：复审暂存 0 条批注，还有 0 个文件有批注/)
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
    const ctx = makeCtx(new Map([['agent-1', agent]]), async () => activation.activation)
    const state = makeState()
    registerMerge(ctx, log, { loopMaxRounds: 3 }, state, makeReviews().scheduleReview, async () => {}, () => {})

    assert.equal(state.running.size, 0)
    const result = await ctx.commands.get('humanize-loop').handler({ agent, rawInput: '' })
    assert.equal(result.kind, 'success')
    // 命令返回时首次派发已经完成，运行锁要一直持有到运行结束，
    // 重复派发和 agent/created 触发的接手都靠它让路。
    assert.ok(state.running.has('agent-1'))

    activation.resolve({ stopReason: 'completed' })
    await waitFor(() => state.running.size === 0 && !existsSync(join(storage, 'merge-runs.json')))
  } finally {
    await removeStorage(storage)
  }
})

test('合并期间热重载：新实例补完复审，而不是把暂存为空当成收敛', async () => {
  const storage = await mkdtemp(join(tmpdir(), 'humanize-loop-reload-'))
  setStorageRootResolver(() => storage)
  try {
    const { project, target } = await makeProject(storage)
    const agent = makeAgent('agent-1', 'session-1', project)
    const child = makeChild('child-1')
    const agents = new Map([['agent-1', agent], ['session-1', agent], ['child-1', child]])
    const activation = deferredActivation('child-1')
    const ctxA = makeCtx(agents, async () => activation.activation)
    const stateA = makeState()
    const reviewsA = makeReviews()
    registerMerge(ctxA, log, { loopMaxRounds: 3 }, stateA, reviewsA.scheduleReview, async () => {}, () => {})

    await ctxA.commands.get('humanize-loop').handler({ agent, rawInput: '' })
    // 等派发真正落到在途合并记录上，再模拟重载。
    await waitFor(() => existsSync(join(storage, 'merge-pending.json')))

    // 旧实例被热重载销毁。
    stateA.disposed = true
    const reviewsB = makeReviews()
    const ctxB = makeCtx(agents, async () => activation.activation)
    const stateB = makeState()
    const mergeB = registerMerge(ctxB, log, { loopMaxRounds: 3 }, stateB, reviewsB.scheduleReview, async () => {}, () => {})

    // 新实例先按在途记录补收尾，再接手循环。
    const reconciled = reconcilePendingMerges(ctxB, log, stateB, reviewsB.scheduleReview)
    // 等新实例挂上子代理的 turn/end 监听，再放行子代理，避免事件发空。
    await waitFor(() => stateB.merging.has('agent-1'))
    activation.resolve({ stopReason: 'completed' })
    ctxB.emit('session/event', child.session, { type: 'turn/end', data: { reason: { kind: 'completed' } } })
    await reconciled
    await mergeB.resumeRuns()

    await waitFor(() => stateB.running.size === 0 && stateA.running.size === 0 && !existsSync(join(storage, 'merge-runs.json')))
    // 复审由新实例补跑，文件是合并后的内容，before 是合并前的快照。
    assert.equal(reviewsB.calls.length, 1)
    assert.equal(reviewsB.calls[0].filePath, target)
    assert.equal(reviewsB.calls[0].before, '第一版。\n')
    assert.match(noticeTexts(agent), /循环合并第 1 轮结束：复审暂存 0 条批注，还有 0 个文件有批注/)
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
    const child = makeChild('child-1')
    const agents = new Map([['agent-1', agent], ['session-1', agent], ['child-1', child]])
    let starts = 0
    let reviews = 0
    const ctx = makeCtx(agents, async () => {
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
    await waitFor(() => state.running.size === 0 && !existsSync(join(storage, 'merge-runs.json')))

    assert.equal(starts, 2)
    assert.equal(reviews, 2)
    assert.match(noticeTexts(agent), /循环合并第 1 轮结束：复审暂存 1 条批注/)
    assert.match(noticeTexts(agent), /循环合并第 2 轮结束：复审暂存 0 条批注/)
    await assert.rejects(readFile(stagingPathFor(target)), /ENOENT/)
  } finally {
    await removeStorage(storage)
  }
})

test('记录停在 review 阶段时，接手方先补复审再结束', async () => {
  const storage = await mkdtemp(join(tmpdir(), 'humanize-loop-review-'))
  setStorageRootResolver(() => storage)
  try {
    const { project, target } = await makeProject(storage)
    // 模拟合并已经收尾、复审还没跑完就被重载打断。
    await rm(stagingPathFor(target), { force: true })
    await writeFile(join(storage, 'merge-runs.json'), JSON.stringify({
      'session-1': {
        target: project,
        round: 1,
        phase: 'review',
        runId: 'old-run',
        reviews: [{ filePath: target, before: '第一版。\n' }],
      },
    }), 'utf8')

    const agent = makeAgent('agent-1', 'session-1', project)
    const agents = new Map([['agent-1', agent], ['session-1', agent]])
    const ctx = makeCtx(agents, async () => { throw new Error('不应再派发合并') })
    const state = makeState()
    const reviews = makeReviews()
    const merge = registerMerge(ctx, log, { loopMaxRounds: 3 }, state, reviews.scheduleReview, async () => {}, () => {})

    await merge.resumeRuns()
    await waitFor(() => state.running.size === 0 && !existsSync(join(storage, 'merge-runs.json')))

    assert.equal(reviews.calls.length, 1)
    assert.equal(reviews.calls[0].filePath, target)
    assert.equal(reviews.calls[0].before, '第一版。\n')
    assert.match(noticeTexts(agent), /循环合并第 1 轮结束：复审暂存 0 条批注/)
  } finally {
    await removeStorage(storage)
  }
})

test('重载接手后复审仍有批注时继续下一轮合并', async () => {
  const storage = await mkdtemp(join(tmpdir(), 'humanize-loop-reload-rounds-'))
  setStorageRootResolver(() => storage)
  try {
    const { project, target } = await makeProject(storage)
    const agent = makeAgent('agent-1', 'session-1', project)
    const child = makeChild('child-1')
    const agents = new Map([['agent-1', agent], ['session-1', agent], ['child-1', child]])
    const first = deferredActivation('child-1')
    let starts = 0
    const activation = async () => {
      starts += 1
      if (starts === 1) return first.activation
      const next = deferredActivation(`child-${starts}`)
      queueMicrotask(() => next.resolve({ stopReason: 'completed' }))
      return next.activation
    }
    const ctxA = makeCtx(agents, activation)
    const stateA = makeState()
    const reviewsA = makeReviews()
    registerMerge(ctxA, log, { loopMaxRounds: 3 }, stateA, reviewsA.scheduleReview, async () => {}, () => {})

    await ctxA.commands.get('humanize-loop').handler({ agent, rawInput: '' })
    await waitFor(() => existsSync(join(storage, 'merge-pending.json')))

    // 第一轮合并期间重载。新实例接手复审，复审又产出一条批注。
    stateA.disposed = true
    const ctxB = makeCtx(agents, activation)
    const stateB = makeState()
    let reviewed = 0
    const scheduleReview = async (reviewAgent, filePath) => {
      reviewed += 1
      if (reviewed === 1) {
        await writeStaging(filePath, `# ${filePath}\n\n1. "重写后的行文。"\n`)
        return { kind: 'ok', annotations: 1 }
      }
      return { kind: 'ok', annotations: 0 }
    }
    const mergeB = registerMerge(ctxB, log, { loopMaxRounds: 3 }, stateB, scheduleReview, async () => {}, () => {})
    const reconciled = reconcilePendingMerges(ctxB, log, stateB, scheduleReview)
    await waitFor(() => stateB.merging.has('agent-1'))
    first.resolve({ stopReason: 'completed' })
    ctxB.emit('session/event', child.session, { type: 'turn/end', data: { reason: { kind: 'completed' } } })
    await reconciled
    await mergeB.resumeRuns()

    await waitFor(() => stateB.running.size === 0 && stateA.running.size === 0 && !existsSync(join(storage, 'merge-runs.json')))
    assert.equal(starts, 2)
    assert.equal(reviewed, 2)
    assert.match(noticeTexts(agent), /循环合并第 1 轮结束：复审暂存 1 条批注/)
    assert.match(noticeTexts(agent), /循环合并第 2 轮结束：复审暂存 0 条批注/)
    await assert.rejects(readFile(stagingPathFor(target)), /ENOENT/)
  } finally {
    await removeStorage(storage)
  }
})

test('合并失败时清掉循环记录，不会把失败当成下一轮', async () => {
  const storage = await mkdtemp(join(tmpdir(), 'humanize-loop-failed-'))
  setStorageRootResolver(() => storage)
  try {
    const { project } = await makeProject(storage)
    const agent = makeAgent('agent-1', 'session-1', project)
    const child = makeChild('child-1')
    const agents = new Map([['agent-1', agent], ['session-1', agent], ['child-1', child]])
    const activation = deferredActivation('child-1')
    const ctxA = makeCtx(agents, async () => activation.activation)
    const stateA = makeState()
    const reviewsA = makeReviews()
    registerMerge(ctxA, log, { loopMaxRounds: 3 }, stateA, reviewsA.scheduleReview, async () => {}, () => {})

    await ctxA.commands.get('humanize-loop').handler({ agent, rawInput: '' })
    await waitFor(() => existsSync(join(storage, 'merge-pending.json')))
    stateA.disposed = true

    const reviewsB = makeReviews()
    const ctxB = makeCtx(agents, async () => activation.activation)
    const stateB = makeState()
    const mergeB = registerMerge(ctxB, log, { loopMaxRounds: 3 }, stateB, reviewsB.scheduleReview, async () => {}, () => {})
    const reconciled = reconcilePendingMerges(ctxB, log, stateB, reviewsB.scheduleReview)
    await waitFor(() => stateB.merging.has('agent-1'))
    activation.resolve({ stopReason: 'aborted' })
    ctxB.emit('session/event', child.session, { type: 'turn/end', data: { reason: { kind: 'aborted' } } })
    await reconciled
    await mergeB.resumeRuns()

    await waitFor(() => stateA.running.size === 0 && stateB.running.size === 0)
    assert.equal(reviewsB.calls.length, 0)
    assert.equal(existsSync(join(storage, 'merge-runs.json')), false)
    assert.match(noticeTexts(agent), /批注合并未完成，暂存批注保留/)
  } finally {
    await removeStorage(storage)
  }
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
      new Map([['agent-1', agent], ['session-1', agent]]),
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
    await waitFor(() => pipeline.state.running.size === 0 && !existsSync(join(storage, 'merge-runs.json')))

    assert.equal(starts, 2)
    assert.equal(reviews, 2)
    assert.equal(await readFile(target, 'utf8'), '第三版。\n')
    assert.match(noticeTexts(agent), /循环合并第 1 轮结束：复审暂存 1 条批注/)
    assert.match(noticeTexts(agent), /循环合并第 2 轮结束：复审暂存 0 条批注/)
    await assert.rejects(readFile(stagingPathFor(target)), /ENOENT/)
  } finally {
    await removeStorage(storage)
  }
})

test('记录停在 dispatch 阶段时按同一轮重新派发', async () => {
  const storage = await mkdtemp(join(tmpdir(), 'humanize-loop-dispatch-'))
  setStorageRootResolver(() => storage)
  try {
    const { project, target } = await makeProject(storage)
    await writeFile(join(storage, 'merge-runs.json'), JSON.stringify({
      'session-1': {
        target: project,
        round: 1,
        phase: 'dispatch',
        runId: 'old-run',
        reviews: [{ filePath: target, before: '第一版。\n' }],
      },
    }), 'utf8')

    const agent = makeAgent('agent-1', 'session-1', project)
    const agents = new Map([['agent-1', agent], ['session-1', agent]])
    let starts = 0
    const ctx = makeCtx(agents, async () => {
      starts += 1
      const activation = deferredActivation(`child-${starts}`)
      queueMicrotask(() => activation.resolve({ stopReason: 'completed' }))
      return activation.activation
    })
    const state = makeState()
    const reviews = makeReviews()
    const merge = registerMerge(ctx, log, { loopMaxRounds: 3 }, state, reviews.scheduleReview, async () => {}, () => {})

    await merge.resumeRuns()
    await waitFor(() => state.running.size === 0 && !existsSync(join(storage, 'merge-runs.json')))

    assert.equal(starts, 1)
    assert.equal(reviews.calls.length, 1)
    assert.match(noticeTexts(agent), /循环合并第 1 轮结束/)
  } finally {
    await removeStorage(storage)
  }
})

test('一次 /humanize 合并照常清暂存并排复审', async () => {
  const storage = await mkdtemp(join(tmpdir(), 'humanize-merge-once-'))
  setStorageRootResolver(() => storage)
  try {
    const { project, target } = await makeProject(storage)
    const agent = makeAgent('agent-1', 'session-1', project)
    const activation = deferredActivation('child-1')
    const ctx = makeCtx(new Map([['agent-1', agent], ['session-1', agent]]), async () => activation.activation)
    const state = makeState()
    const reviews = makeReviews()
    registerMerge(ctx, log, { loopMaxRounds: 3 }, state, reviews.scheduleReview, async () => {}, () => {})

    const result = await ctx.commands.get('humanize').handler({ agent, rawInput: '' })
    assert.equal(result.kind, 'success')
    activation.resolve({ stopReason: 'completed' })

    await waitFor(() => reviews.calls.length === 1 && state.running.size === 0 && !existsSync(join(storage, 'merge-runs.json')))
    assert.match(noticeTexts(agent), /已按暂存批注修订/)
    assert.equal(existsSync(join(storage, 'merge-runs.json')), false)
  } finally {
    await removeStorage(storage)
  }
})

test('一次 /humanize 合并期间重载，新实例补完复审再结束', async () => {
  const storage = await mkdtemp(join(tmpdir(), 'humanize-run-once-reload-'))
  setStorageRootResolver(() => storage)
  try {
    const { project, target } = await makeProject(storage)
    const agent = makeAgent('agent-1', 'session-1', project)
    const child = makeChild('child-1')
    const agents = new Map([['agent-1', agent], ['session-1', agent], ['child-1', child]])
    const activation = deferredActivation('child-1')
    let starts = 0
    const ctxA = makeCtx(agents, async () => { starts += 1; return activation.activation })
    const stateA = makeState()
    const reviewsA = makeReviews()
    registerMerge(ctxA, log, { loopMaxRounds: 3 }, stateA, reviewsA.scheduleReview, async () => {}, () => {})

    const result = await ctxA.commands.get('humanize').handler({ agent, rawInput: '' })
    assert.equal(result.kind, 'success')
    await waitFor(() => existsSync(join(storage, 'merge-pending.json')))

    // 单次合并跑到一半时重载。
    stateA.disposed = true
    const reviewsB = makeReviews()
    const ctxB = makeCtx(agents, async () => { starts += 1; return activation.activation })
    const stateB = makeState()
    const mergeB = registerMerge(ctxB, log, { loopMaxRounds: 3 }, stateB, reviewsB.scheduleReview, async () => {}, () => {})
    const reconciled = reconcilePendingMerges(ctxB, log, stateB, reviewsB.scheduleReview)
    await waitFor(() => stateB.merging.has('agent-1'))
    activation.resolve({ stopReason: 'completed' })
    ctxB.emit('session/event', child.session, { type: 'turn/end', data: { reason: { kind: 'completed' } } })
    await reconciled
    await mergeB.resumeRuns()

    await waitFor(() => stateA.running.size === 0 && stateB.running.size === 0 && !existsSync(join(storage, 'merge-runs.json')))
    assert.equal(starts, 1)
    assert.equal(reviewsB.calls.length, 1)
    assert.equal(reviewsB.calls[0].filePath, target)
    assert.equal(reviewsB.calls[0].before, '第一版。\n')
    assert.match(noticeTexts(agent), /已按暂存批注修订/)
    assert.match(noticeTexts(agent), /批注合并结束：复审暂存 0 条批注/)
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
    const ctx = makeCtx(new Map([['agent-1', agent], ['session-1', agent]]), async () => {
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
    await waitFor(() => state.running.size === 0 && !existsSync(join(storage, 'merge-runs.json')))

    assert.equal(starts, 1)
    assert.equal(reviews, 1)
    assert.match(noticeTexts(agent), /批注合并结束：复审暂存 1 条批注/)
    // 单次合并不跟进下一轮，复审产生的批注留在暂存里。
    assert.equal(await readFile(stagingPathFor(target), 'utf8').then(() => true), true)
  } finally {
    await removeStorage(storage)
  }
})
