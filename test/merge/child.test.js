import test from 'node:test'
import assert from 'node:assert/strict'
import { Session } from '@deepseek-ai/dsh-session'
import { createSystemMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import { dispatchMergeChild, MERGE_LABEL, MERGE_RESET_TEXT, resetMergeSurface } from '../../lib/merge/child.js'

function deferred() {
  let resolve
  let reject
  const promise = new Promise((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

/** 带最小 surface 投影的子代理，验证替换边界和逐轮占位消息。 */
function makeChild(id = 'child-1', nodes = [0, 1, 2], headType = 'system/message') {
  let nextSeq = nodes.length > 0 ? Math.max(...nodes) + 1 : 0
  const events = new Map(nodes.map((seq, index) => [seq, { type: index === 0 ? headType : 'user/message' }]))
  const appends = []
  const session = {
    id,
    surface: { nodes: [...nodes] },
    append(type, data, options) {
      const seq = nextSeq
      nextSeq += 1
      const surfaceOp = options?.surfaceOp ?? 'append'
      appends.push({ seq, type, data, options })
      if (surfaceOp === 'append') {
        session.surface.nodes.push(seq)
      } else {
        const start = session.surface.nodes.indexOf(surfaceOp.startSeq)
        const end = session.surface.nodes.indexOf(surfaceOp.endSeq)
        assert.ok(start >= 0 && end >= start, 'replacement range must exist in order')
        assert.deepEqual(options.sourceEventSeqs, session.surface.nodes.slice(start, end + 1))
        session.surface.nodes = [...session.surface.nodes.slice(0, start), ...session.surface.nodes.slice(end + 1), seq]
      }
      events.set(seq, { type })
      return { seq, type, data }
    },
  }
  return {
    id,
    status: 'idle',
    session,
    appends,
    events,
    addSurface() {
      session.append('user/message', { content: [{ type: 'text', text: `node ${nextSeq}` }] }, { surfaceOp: 'append' })
    },
  }
}

function makeHarness({ entries = [], children = new Map() } = {}) {
  const listeners = new Map()
  const activations = new Map()
  const sends = []
  const starts = []
  let live
  let drains = 0
  const ctx = {
    sessionQuery: {
      async readEvent({ sessionId, seq }) {
        return { target: children.get(sessionId).events.get(seq) }
      },
    },
    get() { return undefined },
    on(event, callback) {
      const current = listeners.get(event) ?? []
      current.push(callback)
      listeners.set(event, current)
      return () => {
        const list = listeners.get(event) ?? []
        const index = list.indexOf(callback)
        if (index >= 0) list.splice(index, 1)
      }
    },
    agents: { get: (id) => live?.session.id === id ? live : undefined },
    subagents: {
      async listChildren() { return entries },
      async startActivation(spec) {
        const childId = `child-${starts.length + 1}`
        const result = deferred()
        const child = makeChild(childId)
        children.set(childId, child)
        const activation = {
          childId,
          result: result.promise,
          async dispose() {},
          resolve: result.resolve,
          reject: result.reject,
        }
        activations.set(childId, activation)
        entries.push({ id: childId, mode: 'continuable', label: spec.label, createdAt: starts.length })
        starts.push(spec)
        return activation
      },
      async sendMessage(_agent, childId, content) {
        const child = children.get(childId)
        const runId = `run-${sends.length + 1}`
        for (const callback of [...(listeners.get('agent/created') ?? [])]) {
          await callback({ agent: child })
        }
        for (const callback of [...(listeners.get('subagent/start') ?? [])]) {
          callback({ id: childId, runId })
        }
        sends.push({ childId, content, runId, nodes: [...child.session.surface.nodes] })
        return `message-${sends.length}`
      },
      async drainChildren() { drains += 1 },
    },
  }
  return {
    ctx,
    entries,
    children,
    activations,
    sends,
    starts,
    setLive(child) { live = child },
    get drains() { return drains },
    emit(event, ...args) {
      for (const callback of [...(listeners.get(event) ?? [])]) callback(...args)
    },
    async request(child, current) {
      const callbacks = listeners.get('agent/request') ?? []
      const invoke = async (index) => index === callbacks.length
        ? current
        : callbacks[index]({ agent: child }, () => invoke(index + 1))
      return invoke(0)
    },
  }
}

const parent = { id: 'parent-1', session: { id: 'parent-1' } }

test('真实 Session 连续重置后只向模型投影系统头和一条占位消息', async () => {
  const session = new Session('real-merge-reset')
  const replacements = []
  const append = session.append.bind(session)
  session.append = (type, data, options) => {
    if (options?.surfaceOp?.op === 'replace') replacements.push(options)
    return append(type, data, options)
  }
  const head = session.append('system/message', {
    turn: 0,
    step: 0,
    message: createSystemMessage('merge rules'),
  }, { surfaceOp: 'append' })
  const first = session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: 'first request' }], source: { kind: 'humanize' },
  }), { surfaceOp: 'append' })
  const second = session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: 'first follow-up' }], source: { kind: 'humanize' },
  }), { surfaceOp: 'append' })
  const ctx = {
    sessionQuery: { readEvent: async () => ({ target: head }) },
    get() { return undefined },
  }

  await resetMergeSurface(ctx, session)
  assert.deepEqual(session.deriveMessages().map((message) => message.role), ['system', 'user'])
  assert.deepEqual(replacements[0].sourceEventSeqs, [first.seq, second.seq])
  assert.equal(session.deriveMessages()[1].content[0].text, MERGE_RESET_TEXT)

  const third = session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: 'second request' }], source: { kind: 'humanize' },
  }), { surfaceOp: 'append' })
  const fourth = session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: 'second follow-up' }], source: { kind: 'humanize' },
  }), { surfaceOp: 'append' })
  await resetMergeSurface(ctx, session)
  const messages = session.deriveMessages()
  assert.deepEqual(messages.map((message) => message.role), ['system', 'user'])
  assert.equal(messages[0].content[0].text, 'merge rules')
  assert.equal(messages[1].content[0].text, MERGE_RESET_TEXT)
  assert.deepEqual(replacements[1].sourceEventSeqs, [3, third.seq, fourth.seq])
})

test('历史重置保留系统头，下一轮连旧占位消息一起替换', async () => {
  const child = makeChild()
  const children = new Map([[child.id, child]])
  const { ctx } = makeHarness({ children })

  assert.equal(await resetMergeSurface(ctx, child.session), true)
  assert.deepEqual(child.session.surface.nodes, [0, 3])
  const first = child.appends.at(-1)
  assert.equal(first.data.content[0].text, MERGE_RESET_TEXT)
  assert.deepEqual(first.options.sourceEventSeqs, [1, 2])
  assert.deepEqual(first.options.surfaceOp, { op: 'replace', startSeq: 1, endSeq: 2 })

  child.addSurface()
  child.addSurface()
  assert.deepEqual(child.session.surface.nodes, [0, 3, 4, 5])
  assert.equal(await resetMergeSurface(ctx, child.session), true)
  assert.deepEqual(child.session.surface.nodes, [0, 6])
  const second = child.appends.at(-1)
  assert.deepEqual(second.options.sourceEventSeqs, [3, 4, 5])
  assert.deepEqual(second.options.surfaceOp, { op: 'replace', startSeq: 3, endSeq: 5 })
  assert.equal(second.data.content[0].text, first.data.content[0].text)
})

test('空 surface 和只有系统头时不写入；无系统头时从第一个节点替换', async () => {
  const empty = makeChild('empty', [])
  const headOnly = makeChild('head-only', [0])
  const noHead = makeChild('no-head', [0, 1], 'user/message')
  const children = new Map([empty, headOnly, noHead].map((child) => [child.id, child]))
  const { ctx } = makeHarness({ children })

  assert.equal(await resetMergeSurface(ctx, empty.session), false)
  assert.equal(await resetMergeSurface(ctx, headOnly.session), false)
  assert.equal(await resetMergeSurface(ctx, noHead.session), true)
  assert.deepEqual(noHead.appends.at(-1).options.sourceEventSeqs, [0, 1])
  assert.equal(empty.appends.length + headOnly.appends.length, 0)
})

test('读取期间 surface 发生变化时拒绝重置', async () => {
  const child = makeChild()
  const children = new Map([[child.id, child]])
  const { ctx } = makeHarness({ children })
  ctx.sessionQuery.readEvent = async () => {
    child.session.surface.nodes.push(99)
    return { target: { type: 'system/message' } }
  }
  await assert.rejects(resetMergeSurface(ctx, child.session), /历史在重置前发生变化/)
  assert.equal(child.appends.length, 0)
})

test('连续三轮合并只创建一个目录子代理，并复用同一个会话', async () => {
  const harness = makeHarness()
  const { ctx } = harness
  const first = await dispatchMergeChild(ctx, parent, 'first request', { provider: 'p1', model: 'm1' })
  assert.equal(first.reused, false)
  assert.equal(harness.starts.length, 1)
  assert.equal(harness.entries.length, 1)
  assert.equal(harness.starts[0].label, MERGE_LABEL)
  harness.activations.get(first.childId).resolve({ stopReason: 'completed' })
  await first.result
  await first.dispose()

  const child = harness.children.get(first.childId)
  const second = await dispatchMergeChild(ctx, parent, 'second request', { provider: 'p2', model: 'm2' })
  assert.equal(second.reused, true)
  assert.equal(second.childId, first.childId)
  assert.equal(harness.starts.length, 1)
  assert.equal(harness.entries.length, 1)
  assert.equal(harness.sends.length, 1)
  assert.equal(harness.sends[0].content[0].text, 'second request')
  assert.deepEqual(harness.sends[0].nodes, [0, 3])
  child.addSurface()
  child.addSurface()
  harness.emit('subagent/end', { id: child.id, runId: harness.sends[0].runId, stopReason: 'completed' })
  assert.equal((await second.result).stopReason, 'completed')
  await second.dispose()

  const third = await dispatchMergeChild(ctx, parent, 'third request', { provider: 'p3', model: 'm3' })
  assert.equal(third.childId, first.childId)
  assert.equal(harness.starts.length, 1)
  assert.equal(harness.entries.length, 1)
  assert.equal(harness.sends.length, 2)
  assert.deepEqual(harness.sends[1].nodes, [0, 6])
  harness.emit('subagent/end', { id: child.id, runId: harness.sends[1].runId, stopReason: 'completed' })
  await third.result
  await third.dispose()
  assert.equal(harness.drains, 0)
})

test('续用应用本轮模型路由，并保留子代理错误明细', async () => {
  const child = makeChild()
  const harness = makeHarness({
    entries: [{ id: child.id, mode: 'continuable', label: MERGE_LABEL }],
    children: new Map([[child.id, child]]),
  })
  const run = await dispatchMergeChild(harness.ctx, parent, 'request', { provider: 'p2', model: 'm2' })
  const routed = await harness.request(child, {
    provider: 'p1',
    model: 'm1',
    reasoningEffort: 'high',
    maxTokens: 99,
    temperature: 0.4,
  })
  assert.deepEqual(routed, { provider: 'p2', model: 'm2', temperature: 0.4 })
  harness.emit('subagent/end', { id: 'another-child', stopReason: 'completed' })
  assert.equal(await Promise.race([run.result, Promise.resolve('pending')]), 'pending')

  harness.emit('session/event', { id: child.id }, {
    type: 'turn/end',
    data: { reason: { kind: 'error', error: { message: '429 quota exceeded' } } },
  })
  harness.emit('subagent/end', { id: child.id, runId: harness.sends[0].runId, stopReason: 'error' })
  assert.equal((await run.result).stopReason, 'error')
  assert.equal(run.failure, '429 quota exceeded')
  await run.dispose()
})

test('续用保留同路由父 agent 的推理等级和输出上限', async () => {
  const child = makeChild()
  const harness = makeHarness({
    entries: [{ id: child.id, mode: 'continuable', label: MERGE_LABEL }],
    children: new Map([[child.id, child]]),
  })
  const configuredParent = {
    id: parent.id,
    options: { provider: 'p', model: 'm', reasoningEffort: 'high', maxTokens: 123 },
    session: { id: parent.session.id, requestHeader: () => undefined },
  }
  const run = await dispatchMergeChild(harness.ctx, configuredParent, 'request', { provider: 'p', model: 'm' })
  const routed = await harness.request(child, {
    provider: 'p',
    model: 'm',
    reasoningEffort: 'low',
    maxTokens: 99,
    temperature: 0.4,
  })
  assert.deepEqual(routed, {
    provider: 'p',
    model: 'm',
    reasoningEffort: 'high',
    maxTokens: 123,
    temperature: 0.4,
  })
  harness.emit('subagent/end', { id: child.id, runId: harness.sends[0].runId, stopReason: 'completed' })
  await run.result
  await run.dispose()
})

test('只有异常取消续用运行时才 drain 驻留子代理', async () => {
  const child = makeChild()
  const harness = makeHarness({
    entries: [{ id: child.id, mode: 'continuable', label: MERGE_LABEL }],
    children: new Map([[child.id, child]]),
  })
  const run = await dispatchMergeChild(harness.ctx, parent, 'request', undefined)
  await run.cancel()
  await run.cancel()
  assert.equal(harness.drains, 1)
})

test('恢复前重置失败时不发送请求，也不取消原有子代理', async () => {
  const child = makeChild()
  const harness = makeHarness({
    entries: [{ id: child.id, mode: 'continuable', label: MERGE_LABEL }],
    children: new Map([[child.id, child]]),
  })
  harness.ctx.sessionQuery.readEvent = async () => {
    child.session.surface.nodes.push(99)
    return { target: { type: 'system/message' } }
  }
  await assert.rejects(
    dispatchMergeChild(harness.ctx, parent, 'request', undefined),
    /历史在重置前发生变化/,
  )
  assert.equal(harness.sends.length, 0)
  assert.equal(harness.drains, 0)
})

test('旧 epoch 的结束事件不会提前完成新的续用轮次', async () => {
  const child = makeChild()
  const harness = makeHarness({
    entries: [{ id: child.id, mode: 'continuable', label: MERGE_LABEL }],
    children: new Map([[child.id, child]]),
  })
  const sendMessage = harness.ctx.subagents.sendMessage
  const entered = deferred()
  const release = deferred()
  harness.ctx.subagents.sendMessage = async (...args) => {
    entered.resolve()
    await release.promise
    return sendMessage(...args)
  }
  const dispatch = dispatchMergeChild(harness.ctx, parent, 'request', undefined)
  await entered.promise
  harness.emit('subagent/end', { id: child.id, runId: 'previous-epoch', stopReason: 'completed' })
  release.resolve()
  const run = await dispatch
  assert.equal(await Promise.race([run.result, Promise.resolve('pending')]), 'pending')

  harness.emit('subagent/end', { id: child.id, runId: harness.sends[0].runId, stopReason: 'completed' })
  assert.equal((await run.result).stopReason, 'completed')
  await run.dispose()
})

test('驻留子代理尚未退出时拒绝续用，不裁剪也不发送', async () => {
  const child = makeChild()
  const harness = makeHarness({
    entries: [{ id: child.id, mode: 'continuable', label: MERGE_LABEL }],
    children: new Map([[child.id, child]]),
  })
  harness.setLive(child)
  await assert.rejects(
    dispatchMergeChild(harness.ctx, parent, 'request', undefined),
    /子代理还在运行/,
  )
  assert.equal(child.appends.length, 0)
  assert.equal(harness.sends.length, 0)
  assert.equal(harness.drains, 0)
})
