/**
 * 合并运行的测试。用假的子代理和复审调度验证三种情况。单次合并跑完就结束。
 * 循环合并复审出新批注才继续下一轮。合并失败时暂存批注保留。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LOOP_ROUNDS_DEFAULT } from '../../lib/shared/defaults.js'
import { registerMerge } from '../../lib/merge/command.js'
import { setStorageRootResolver, stagingPathFor, writeStaging } from '../../lib/shared/staging.js'
import { waitFor } from '../helpers.js'

const log = { info() {}, warn() {} }

function makeCtx(agents, activation, llm) {
  const list = [...agents]
  const byId = new Map(list.map((agent) => [agent.id, agent]))
  const bySession = new Map(list.map((agent) => [agent.session.id, agent]))
  const commands = new Map()
  const listeners = new Map()
  return {
    logger: () => log,
    // jobs 服务缺失，取用外部服务一律返回 undefined。
    get: () => undefined,
    agents: {
      get: (id) => byId.get(id) ?? bySession.get(id),
      // 派发前的合并子代理检查要看全部 agent。
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
    // 副作用和注入走空实现，测试只验证派发和通知。
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
    mergeRun: null,
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

/** 合并子代理，由测试决定何时放行。 */
function deferredActivation(childId) {
  let resolve
  const result = new Promise((done) => { resolve = done })
  return {
    activation: { childId, result, dispose: async () => {} },
    resolve,
  }
}

/** 记录复审调用的假调度器，全部返回批注数为零的结果。 */
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

async function removeStorage(storage) {
  // 后台循环可能正在写暂存文件，删除目录时重试几次。
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
  await writeFile(join(project, 'PROSE.md'), '# Rules\n1. 平铺直叙。\n', 'utf8')
  const target = join(project, 'doc.md')
  await writeFile(target, '第一版。\n', 'utf8')
  await writeStaging(target, `1. "第一版。"\n`)
  return { project, target }
}

function noticeTexts(agent) {
  return agent.injected.map((message) => message.content?.[0]?.text ?? '').join('\n')
}

test('一轮合并后复审没有新批注时正常结束', async () => {
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
    // 摘要长度上限只作用于折叠行，正文的完整文件清单照常显示。
    const notice = agent.injected.find((message) => message.source?.form === 'notice')
    assert.equal(notice.source.summary, '已按暂存批注修订 1 个文件。')
    assert.match(notice.content[0].text, /doc\.md/)
    await assert.rejects(readFile(stagingPathFor(join(project, 'doc.md'))), /ENOENT/)
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
      // 合并子代理总是立刻完成，第二轮要看复审是否真的又排了一轮。
      queueMicrotask(() => activation.resolve({ stopReason: 'completed' }))
      return activation.activation
    })
    const state = makeState()
    const scheduleReview = async (reviewAgent, filePath) => {
      reviews += 1
      if (reviews === 1) {
        await writeStaging(filePath, `1. "第一版。"\n`)
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

test('合并失败时保留暂存批注，停在当前轮', async () => {
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
    // result.diagnostic 为空时，从子代理的 turn/end 事件里拿实际错误。
    ctx.emit('session/event', { id: 'child-1' }, {
      type: 'turn/end',
      data: { turn: 1, reason: { kind: 'error', error: { message: '429 quota exceeded; retry in 51s' } } },
    })
    activation.resolve({ stopReason: 'error' })
    await waitFor(() => state.running.size === 0)

    assert.equal(reviews.calls.length, 0)
    // 失败原因要带回主会话，方便用户查看。
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

test('不同会话的合并运行互斥', async () => {
  const storage = await mkdtemp(join(tmpdir(), 'humanize-merge-global-lock-'))
  setStorageRootResolver(() => storage)
  try {
    const { project } = await makeProject(storage)
    const firstAgent = makeAgent('agent-1', 'session-1', project)
    const secondAgent = makeAgent('agent-2', 'session-2', project)
    const activation = deferredActivation('child-1')
    const ctx = makeCtx([firstAgent, secondAgent], async () => activation.activation)
    const state = makeState()
    registerMerge(ctx, log, { loopMaxRounds: 3 }, state, makeReviews().scheduleReview, async () => {}, () => {})

    const first = await ctx.commands.get('humanize').handler({ agent: firstAgent, rawInput: '' })
    assert.equal(first.kind, 'success')
    assert.equal(state.mergeRun.agentId, 'agent-1')

    const second = await ctx.commands.get('humanize').handler({ agent: secondAgent, rawInput: '' })
    assert.equal(second.kind, 'error')
    assert.match(second.text, /已有批注合并正在进行/)

    activation.resolve({ stopReason: 'completed' })
    await waitFor(() => state.running.size === 0 && state.mergeRun === null)
    await assert.rejects(readFile(stagingPathFor(join(project, 'doc.md'))), /ENOENT/)
  } finally {
    await removeStorage(storage)
  }
})

test('复审失败时按失败结束，不再宣称收敛', async () => {
  const storage = await mkdtemp(join(tmpdir(), 'humanize-merge-review-failed-'))
  setStorageRootResolver(() => storage)
  try {
    const { project } = await makeProject(storage)
    const agent = makeAgent('agent-1', 'session-1', project)
    const activation = deferredActivation('child-1')
    const ctx = makeCtx([agent], async () => activation.activation)
    const state = makeState()
    const scheduleReview = async () => ({ kind: 'failed', message: 'review provider error' })
    registerMerge(ctx, log, { loopMaxRounds: 3 }, state, scheduleReview, async () => {}, () => {})

    const result = await ctx.commands.get('humanize-loop').handler({ agent, rawInput: '' })
    assert.equal(result.kind, 'success')
    activation.resolve({ stopReason: 'completed' })
    await waitFor(() => state.running.size === 0)

    assert.match(noticeTexts(agent), /第 1 轮复审有 1 个文件失败/)
    assert.doesNotMatch(noticeTexts(agent), /循环合并结束/)
    assert.equal(state.mergeRun, null)
  } finally {
    await removeStorage(storage)
  }
})

test('一次 /humanize 复审还有批注也到此为止，只跑这一轮', async () => {
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
      await writeStaging(filePath, `1. "重写后的行文。"\n`)
      return { kind: 'ok', annotations: 1 }
    }
    registerMerge(ctx, log, { loopMaxRounds: 3 }, state, scheduleReview, async () => {}, () => {})

    const result = await ctx.commands.get('humanize').handler({ agent, rawInput: '' })
    assert.equal(result.kind, 'success')
    await waitFor(() => state.running.size === 0)

    assert.equal(starts, 1)
    assert.equal(reviews, 1)
    assert.match(noticeTexts(agent), /已按暂存批注修订/)
    // 单次合并只跑一轮，复审产生的批注留在暂存里。
    assert.equal(await readFile(stagingPathFor(target), 'utf8').then(() => true), true)
  } finally {
    await removeStorage(storage)
  }
})

test('插件重载后运行结束，已完成的合并直接收尾', async () => {
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
    // 子代理已完成时合并照常收尾。清掉暂存，并留下成功说明。
    await assert.rejects(readFile(stagingPathFor(target), 'utf8'), /ENOENT/)
    assert.match(noticeTexts(agent), /已按暂存批注修订/)
  } finally {
    await removeStorage(storage)
  }
})

test('合并期间写入的新暂存批注按新内容保留', async () => {
  const storage = await mkdtemp(join(tmpdir(), 'humanize-merge-new-staging-'))
  setStorageRootResolver(() => storage)
  try {
    const { project, target } = await makeProject(storage)
    const agent = makeAgent('agent-1', 'session-1', project)
    const activation = deferredActivation('child-1')
    // 派发前先改写暂存，模拟合并期间另一次审查写入了新批注。
    const ctx = makeCtx([agent], async () => {
      await writeStaging(target, `1. "合并期间的新批注。"\n`)
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

test('合并请求写到临时文件，子代理收到路径，完成后清理', async () => {
  const storage = await mkdtemp(join(tmpdir(), 'humanize-merge-request-'))
  setStorageRootResolver(() => storage)
  try {
    const { project, target } = await makeProject(storage)
    const specs = join(project, '.agents', 'prose')
    await mkdir(specs, { recursive: true })
    await writeFile(join(specs, 'single.md'), '---\ninclude: ["/doc.md"]\n---\n# Rules\n1. 单文件规则。\n')
    await writeFile(join(specs, 'unrelated.md'), '---\ninclude: ["/other.md"]\n---\n# Rules\n1. 无关规则。\n')
    const agent = makeAgent('agent-1', 'session-1', project)
    const activation = deferredActivation('child-1')
    let activationSpec
    const ctx = makeCtx([agent], async (spec) => {
      activationSpec = spec
      return activation.activation
    })
    const state = makeState()
    registerMerge(ctx, log, { loopMaxRounds: 1 }, state, makeReviews().scheduleReview, async () => {}, () => {})

    await ctx.commands.get('humanize').handler({ agent, rawInput: '' })
    const text = activationSpec.request.prompt[0].text
    const match = /The merge request is in (\S+\.merge\.md)\./.exec(text)
    assert.ok(match, text)
    const requestPath = match[1]
    assert.doesNotMatch(text, /\{\{requestPath\}\}/)
    const request = await readFile(requestPath, 'utf8')
    assert.match(request, /## Rules/)
    assert.match(request, /单文件规则/)
    assert.doesNotMatch(request, /无关规则/)
    // 合并请求按文件列出批注。
    assert.ok(request.includes(`# ${target}`))

    activation.resolve({ stopReason: 'completed' })
    await waitFor(() => state.running.size === 0)
    await assert.rejects(readFile(requestPath, 'utf8'), /ENOENT/)
  } finally {
    await removeStorage(storage)
  }
})

test('循环轮次上限不是整数时按缺省轮次运行', async () => {
  const storage = await mkdtemp(join(tmpdir(), 'humanize-loop-fractional-'))
  setStorageRootResolver(() => storage)
  try {
    const { project } = await makeProject(storage)
    const agent = makeAgent('agent-1', 'session-1', project)
    let starts = 0
    const ctx = makeCtx([agent], async () => {
      starts += 1
      const activation = deferredActivation(`child-${starts}`)
      queueMicrotask(() => activation.resolve({ stopReason: 'completed' }))
      return activation.activation
    })
    const state = makeState()
    // 每轮复审都写回新批注，循环会一直跑到轮次上限。
    const scheduleReview = async (reviewAgent, filePath) => {
      await writeStaging(filePath, `1. "重写后的行文。"\n`)
      return { kind: 'ok', annotations: 1 }
    }
    registerMerge(ctx, log, { loopMaxRounds: 1.5 }, state, scheduleReview, async () => {}, () => {})

    await ctx.commands.get('humanize-loop').handler({ agent, rawInput: '' })
    await waitFor(() => state.running.size === 0)

    // 1.5 不是合法轮次，按缺省值跑满，而不是被截成 1 轮或 2 轮。
    assert.equal(starts, LOOP_ROUNDS_DEFAULT)
  } finally {
    await removeStorage(storage)
  }
})

test('PROSE.md 文件头写坏时合并按失败结束，暂存批注保留', async () => {
  const storage = await mkdtemp(join(tmpdir(), 'humanize-merge-bad-spec-'))
  setStorageRootResolver(() => storage)
  try {
    const { project, target } = await makeProject(storage)
    // include 声明没有闭合，规范解析在组装合并请求时抛出错误。
    await writeFile(join(project, 'PROSE.md'), '---\ninclude: [\n---\n# Rules\n1. 平铺直叙。\n', 'utf8')
    const agent = makeAgent('agent-1', 'session-1', project)
    const ctx = makeCtx([agent], async () => { throw new Error('不应派发') })
    const state = makeState()
    registerMerge(ctx, log, { loopMaxRounds: 3 }, state, makeReviews().scheduleReview, async () => {}, () => {})

    const result = await ctx.commands.get('humanize').handler({ agent, rawInput: '' })
    assert.equal(result.kind, 'error')
    // 规范错误要变成一次清楚的合并失败，而不是未处理的异常。
    assert.match(result.text, /YAML 文件头无法解析/)
    await waitFor(() => state.running.size === 0 && state.mergeRun === null)
    // 失败保留暂存批注，修好规范后可以重新执行命令。
    assert.match(await readFile(stagingPathFor(target), 'utf8'), /第一版/)
  } finally {
    await removeStorage(storage)
  }
})
