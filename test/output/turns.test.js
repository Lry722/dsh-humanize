import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  appendTurnText,
  assistantVisibleText,
  registerTurnOutputs,
  sessionOutputPath,
} from '../../lib/output/turns.js'
import { setStorageRootResolver, writeStaging } from '../../lib/shared/staging.js'
import { tick, waitFor } from '../helpers.js'

const log = { info() {}, warn() {} }

function assistant(turn, step, blocks) {
  return {
    type: 'assistant/message',
    data: {
      turn,
      step,
      message: { role: 'assistant', content: blocks },
    },
  }
}

function text(value) {
  return { type: 'text', text: value }
}

function turnBoundary(type, turn) {
  return { type, data: type === 'turn/end' ? { turn, reason: { kind: 'completed' } } : { turn } }
}

function makeSession(id, cwd, events, origin) {
  return {
    id,
    header: { cwd, ...(origin === undefined ? {} : { origin }) },
    snapshotEvents: () => events,
  }
}

function makeHarness(session, currentCwd) {
  const listeners = new Map()
  let published = 0
  const agent = { id: session.id, session }
  const ctx = {
    agents: { get: (id) => id === agent.id ? agent : undefined },
    get: (service) => service === 'workingDirectory' && currentCwd !== undefined
      ? { get: () => currentCwd }
      : undefined,
    on(type, callback) {
      const callbacks = listeners.get(type) ?? []
      callbacks.push(callback)
      listeners.set(type, callbacks)
      return () => {}
    },
    effect(callback) { callback() },
  }
  return {
    agent,
    ctx,
    publish() {
      const events = session.snapshotEvents()
      while (published < events.length) {
        const event = events[published]
        published += 1
        for (const callback of listeners.get('session/event') ?? []) callback(session, event)
      }
    },
  }
}

test('只拼接可见正文，保留原文并忽略空白、推理和工具调用', () => {
  const message = assistant(2, 2, [
    text(' 最终'),
    text('回复 '),
    { type: 'reasoning', text: '隐藏推理' },
    { type: 'tool-call', name: 'write' },
  ]).data.message
  assert.equal(assistantVisibleText(message), ' 最终回复 ')
  assert.equal(assistantVisibleText(assistant(2, 3, [text('  \n')]).data.message), undefined)
  assert.equal(assistantVisibleText(assistant(2, 3, [{ type: 'reasoning', text: '隐藏推理' }]).data.message), undefined)
})

test('追加输出时保留已有内容并补空行', () => {
  assert.equal(appendTurnText(undefined, '第一轮'), '第一轮\n')
  assert.equal(appendTurnText('第一轮\n', '第二轮\n'), '第一轮\n\n第二轮\n')
  assert.equal(appendTurnText('第一轮\n\n', '第二轮'), '第一轮\n\n第二轮\n')
})

test('设置关闭时不写输出也不审查', async () => {
  const root = await mkdtemp(join(tmpdir(), 'humanize-output-disabled-'))
  try {
    const events = [turnBoundary('turn/start', 1), assistant(1, 1, [text('不保存')])]
    const session = makeSession('session-off', root, events)
    const host = makeHarness(session)
    let reviews = 0
    registerTurnOutputs(host.ctx, log, { saveTurnOutputs: false }, async () => {
      reviews += 1
      return { kind: 'ok', annotations: 0 }
    }, () => { throw new Error('不应合并') })
    events.push(turnBoundary('turn/end', 1))
    host.publish()
    await tick()
    await assert.rejects(readFile(sessionOutputPath(root, session.id), 'utf8'), /ENOENT/)
    assert.equal(reviews, 0)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('开启后使用当前工作目录并按 turn 追加最终回复', async () => {
  const root = await mkdtemp(join(tmpdir(), 'humanize-output-append-'))
  const initialCwd = join(root, 'initial')
  const currentCwd = join(root, 'current')
  try {
    const events = [
      turnBoundary('turn/start', 1),
      assistant(1, 1, [text('中间说明')]),
      assistant(1, 2, [text('第一轮最终回复')]),
      // 末尾的空白消息不会覆盖上一条有效回复。
      assistant(1, 3, [text('  \n')]),
    ]
    const session = makeSession('session-append', initialCwd, events)
    const host = makeHarness(session, currentCwd)
    const reviews = []
    registerTurnOutputs(host.ctx, log, { saveTurnOutputs: true }, async (agent, filePath, before, after) => {
      reviews.push({ filePath, before, after })
      return { kind: 'ok', annotations: 0 }
    }, () => { throw new Error('没有批注时不应合并') })

    events.push(turnBoundary('turn/end', 1))
    host.publish()
    await waitFor(() => reviews.length === 1)
    const output = sessionOutputPath(currentCwd, session.id)
    assert.equal(await readFile(output, 'utf8'), '第一轮最终回复\n')

    events.push(
      turnBoundary('turn/start', 2),
      assistant(2, 1, [text('第二轮最终回复')]),
      turnBoundary('turn/end', 2),
    )
    host.publish()
    await waitFor(() => reviews.length === 2)
    assert.equal(await readFile(output, 'utf8'), '第一轮最终回复\n\n第二轮最终回复\n')
    assert.equal(reviews[0].before, undefined)
    assert.equal(reviews[1].before, '第一轮最终回复\n')
    assert.equal(reviews[1].after, '第一轮最终回复\n\n第二轮最终回复\n')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('不同会话写入不同文件，子代理回复跳过', async () => {
  const root = await mkdtemp(join(tmpdir(), 'humanize-output-sessions-'))
  try {
    const firstEvents = [turnBoundary('turn/start', 1), assistant(1, 1, [text('主会话')])]
    const first = makeSession('session-one', root, firstEvents)
    const firstHost = makeHarness(first)
    const secondEvents = [turnBoundary('turn/start', 1), assistant(1, 1, [text('另一个主会话')])]
    const second = makeSession('session-two', root, secondEvents)
    const secondHost = makeHarness(second)
    const childEvents = [turnBoundary('turn/start', 1), assistant(1, 1, [text('子代理')])]
    const child = makeSession('session-child', root, childEvents, 'subagent')
    const childHost = makeHarness(child)
    let reviews = 0
    const review = async () => {
      reviews += 1
      return { kind: 'no-spec' }
    }
    const merge = () => { throw new Error('不应合并') }
    registerTurnOutputs(firstHost.ctx, log, { saveTurnOutputs: true }, review, merge)
    registerTurnOutputs(secondHost.ctx, log, { saveTurnOutputs: true }, review, merge)
    registerTurnOutputs(childHost.ctx, log, { saveTurnOutputs: true }, review, merge)

    firstEvents.push(turnBoundary('turn/end', 1))
    secondEvents.push(turnBoundary('turn/end', 1))
    childEvents.push(turnBoundary('turn/end', 1))
    firstHost.publish()
    secondHost.publish()
    childHost.publish()
    await waitFor(() => reviews === 2)
    assert.equal(await readFile(sessionOutputPath(root, first.id), 'utf8'), '主会话\n')
    assert.equal(await readFile(sessionOutputPath(root, second.id), 'utf8'), '另一个主会话\n')
    await assert.rejects(readFile(sessionOutputPath(root, child.id), 'utf8'), /ENOENT/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('有批注时执行一轮合并，同一会话等待合并结束再处理下一轮', async () => {
  const root = await mkdtemp(join(tmpdir(), 'humanize-output-merge-'))
  setStorageRootResolver(() => join(root, 'storage'))
  let releaseFirstMerge
  try {
    const events = [turnBoundary('turn/start', 1), assistant(1, 1, [text('第一轮')])]
    const session = makeSession('session-merge', root, events)
    const host = makeHarness(session)
    const reviews = []
    const merges = []
    const review = async (agent, filePath) => {
      await writeStaging(filePath, `1. "第 ${reviews.length + 1} 轮批注"\n`)
      reviews.push(filePath)
      return { kind: 'ok', annotations: 1 }
    }
    const merge = (agent, target, staged) => {
      merges.push({ agent, target, staged })
      const done = merges.length === 1
        ? new Promise((resolve) => { releaseFirstMerge = resolve })
        : Promise.resolve()
      return { started: Promise.resolve({ started: true }), done }
    }
    registerTurnOutputs(host.ctx, log, { saveTurnOutputs: true }, review, merge)

    events.push(turnBoundary('turn/end', 1))
    host.publish()
    await waitFor(() => merges.length === 1)
    assert.equal(merges[0].target, sessionOutputPath(root, session.id))
    assert.match(merges[0].staged[0].content, /第 1 轮批注/)

    events.push(
      turnBoundary('turn/start', 2),
      assistant(2, 1, [text('第二轮')]),
      turnBoundary('turn/end', 2),
    )
    host.publish()
    await tick()
    assert.equal(reviews.length, 1)
    assert.equal(await readFile(sessionOutputPath(root, session.id), 'utf8'), '第一轮\n')

    releaseFirstMerge()
    await waitFor(() => merges.length === 2 && reviews.length === 2)
    assert.equal(await readFile(sessionOutputPath(root, session.id), 'utf8'), '第一轮\n\n第二轮\n')
  } finally {
    releaseFirstMerge?.()
    setStorageRootResolver(() => '')
    await rm(root, { recursive: true, force: true })
  }
})
