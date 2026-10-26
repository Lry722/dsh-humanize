import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import {
  assistantVisibleText,
  registerTurnOutputs,
  sessionOutputPath,
  sessionOutputRulePath,
  setTurnOutputRootResolver,
  turnOutputText,
} from '../../lib/output/turns.js'
import { readStaging, setStorageRootResolver, writeStaging } from '../../lib/shared/staging.js'
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

function makeSession(id, cwd, events, options = {}) {
  const { origin, title } = options
  return {
    id,
    title,
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
    get(service) {
      if (service === 'workingDirectory') {
        return currentCwd === undefined ? undefined : { get: () => currentCwd }
      }
      if (service === 'sessionTitle') {
        return { get: () => session.title === undefined ? undefined : { title: session.title } }
      }
      return undefined
    },
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

test('每轮正文独立保存，只补末尾换行', () => {
  assert.equal(turnOutputText('最新回复'), '最新回复\n')
  assert.equal(turnOutputText('最新回复\n'), '最新回复\n')
})

test('真实输出在临时根目录，规则路径只在项目内逻辑上映射', () => {
  const root = join(tmpdir(), 'humanize-output-names')
  const actual = sessionOutputPath(root, 'session-e86ff123113c', '  周报/评审  ')
  assert.equal(actual, join(root, '周报_评审--e86ff123113c.md'))
  assert.equal(
    sessionOutputRulePath(join(root, 'project'), actual),
    join(root, 'project', '.agents', 'output', basename(actual)),
  )
  assert.equal(
    sessionOutputPath(root, 'session-empty', '  '),
    join(root, 'untitled-session--empty.md'),
  )
  assert.equal(
    sessionOutputPath(root, 'session-e86ff123113c', '汉'.repeat(40)),
    join(root, `${'汉'.repeat(32)}--e86ff123113c.md`),
  )
  assert.notEqual(
    sessionOutputPath(root, 'session-one', '同名会话'),
    sessionOutputPath(root, 'session-two', '同名会话'),
  )
})

test('设置关闭时不写输出也不审查', async () => {
  const root = await mkdtemp(join(tmpdir(), 'humanize-output-disabled-'))
  const outputRoot = join(root, 'output')
  setTurnOutputRootResolver(() => outputRoot)
  try {
    const events = [turnBoundary('turn/start', 1), assistant(1, 1, [text('不保存')])]
    const session = makeSession('session-off', root, events, { title: '关闭输出' })
    const host = makeHarness(session)
    let reviews = 0
    registerTurnOutputs(host.ctx, log, { saveTurnOutputs: false }, async () => {
      reviews += 1
      return { kind: 'ok', annotations: 0 }
    }, () => { throw new Error('不应合并') })
    events.push(turnBoundary('turn/end', 1))
    host.publish()
    await tick()
    await assert.rejects(readFile(sessionOutputPath(outputRoot, session.id, '关闭输出'), 'utf8'), /ENOENT/)
    assert.equal(reviews, 0)
  } finally {
    setTurnOutputRootResolver()
    await rm(root, { recursive: true, force: true })
  }
})

test('开启后覆盖为最新回复，项目目录不写文件且旧批注被清除', async () => {
  const root = await mkdtemp(join(tmpdir(), 'humanize-output-latest-'))
  const initialCwd = join(root, 'initial')
  const currentCwd = join(root, 'current')
  const outputRoot = join(root, 'output')
  setTurnOutputRootResolver(() => outputRoot)
  setStorageRootResolver(() => join(root, 'storage'))
  try {
    const events = [
      turnBoundary('turn/start', 1),
      assistant(1, 1, [text('中间说明')]),
      assistant(1, 2, [text('第一轮最终回复')]),
      assistant(1, 3, [text('  \n')]),
    ]
    const session = makeSession('session-latest', initialCwd, events, { title: '首轮标题' })
    const host = makeHarness(session, currentCwd)
    const reviews = []
    registerTurnOutputs(host.ctx, log, { saveTurnOutputs: true }, async (agent, filePath, before, after, signal, rulePath) => {
      reviews.push({ filePath, before, after, rulePath, existing: await readStaging(filePath) })
      return { kind: 'ok', annotations: 0 }
    }, () => { throw new Error('没有批注时不应合并') })

    const output = sessionOutputPath(outputRoot, session.id, '首轮标题')
    const legacy = sessionOutputRulePath(currentCwd, output)
    await mkdir(join(currentCwd, '.agents', 'output'), { recursive: true })
    await writeFile(legacy, '旧版项目内输出\n')
    await writeStaging(legacy, '1. "旧版项目内批注"\n')
    events.push(turnBoundary('turn/end', 1))
    host.publish()
    await waitFor(() => reviews.length === 1)
    assert.equal(await readFile(output, 'utf8'), '第一轮最终回复\n')
    assert.equal(reviews[0].before, undefined)
    assert.equal(reviews[0].rulePath, sessionOutputRulePath(currentCwd, output))
    await assert.rejects(readFile(reviews[0].rulePath, 'utf8'), /ENOENT/)
    assert.equal(await readStaging(legacy), undefined)
    await writeStaging(output, '1. "上一轮批注"\n')

    // 标题变化后沿用同一个真实文件，但内容替换为第二轮。
    session.title = '修改后的标题'
    events.push(
      turnBoundary('turn/start', 2),
      assistant(2, 1, [text('第二轮最终回复')]),
      turnBoundary('turn/end', 2),
    )
    host.publish()
    await waitFor(() => reviews.length === 2)
    assert.equal(await readFile(output, 'utf8'), '第二轮最终回复\n')
    await assert.rejects(readFile(sessionOutputPath(outputRoot, session.id, '修改后的标题'), 'utf8'), /ENOENT/)
    assert.equal(reviews[1].before, undefined)
    assert.equal(reviews[1].after, '第二轮最终回复\n')
    assert.equal(reviews[1].existing, undefined)
    assert.equal(reviews[1].rulePath, reviews[0].rulePath)
  } finally {
    setTurnOutputRootResolver()
    setStorageRootResolver(() => '')
    await rm(root, { recursive: true, force: true })
  }
})

test('不同会话写入不同临时文件，子代理的回复会被跳过', async () => {
  const root = await mkdtemp(join(tmpdir(), 'humanize-output-sessions-'))
  const outputRoot = join(root, 'output')
  setTurnOutputRootResolver(() => outputRoot)
  setStorageRootResolver(() => join(root, 'storage'))
  try {
    const firstEvents = [turnBoundary('turn/start', 1), assistant(1, 1, [text('主会话')])]
    const first = makeSession('session-one', root, firstEvents, { title: '同名会话' })
    const firstHost = makeHarness(first)
    const secondEvents = [turnBoundary('turn/start', 1), assistant(1, 1, [text('另一个主会话')])]
    const second = makeSession('session-two', root, secondEvents, { title: '同名会话' })
    const secondHost = makeHarness(second)
    const childEvents = [turnBoundary('turn/start', 1), assistant(1, 1, [text('子代理')])]
    const child = makeSession('session-child', root, childEvents, { origin: 'subagent', title: '子代理' })
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
    assert.equal(await readFile(sessionOutputPath(outputRoot, first.id, '同名会话'), 'utf8'), '主会话\n')
    assert.equal(await readFile(sessionOutputPath(outputRoot, second.id, '同名会话'), 'utf8'), '另一个主会话\n')
    await assert.rejects(readFile(sessionOutputPath(outputRoot, child.id, '子代理'), 'utf8'), /ENOENT/)
  } finally {
    setTurnOutputRootResolver()
    setStorageRootResolver(() => '')
    await rm(root, { recursive: true, force: true })
  }
})

test('自动合并携带规则路径且静默，同一会话等待合并结束再覆盖', async () => {
  const root = await mkdtemp(join(tmpdir(), 'humanize-output-merge-'))
  const outputRoot = join(root, 'output')
  setTurnOutputRootResolver(() => outputRoot)
  setStorageRootResolver(() => join(root, 'storage'))
  let releaseFirstMerge
  try {
    const events = [turnBoundary('turn/start', 1), assistant(1, 1, [text('第一轮')])]
    const session = makeSession('session-merge', root, events, { title: '合并输出' })
    const host = makeHarness(session)
    const reviews = []
    const merges = []
    const review = async (agent, filePath, before, after, signal, rulePath) => {
      await writeStaging(filePath, `1. "第 ${reviews.length + 1} 轮批注"\n`)
      reviews.push({ filePath, rulePath })
      return { kind: 'ok', annotations: 1 }
    }
    const merge = (agent, target, staged, options) => {
      merges.push({ agent, target, staged, options })
      const done = merges.length === 1
        ? new Promise((resolve) => { releaseFirstMerge = resolve })
        : Promise.resolve()
      return { started: Promise.resolve({ started: true }), done }
    }
    registerTurnOutputs(host.ctx, log, { saveTurnOutputs: true }, review, merge)

    events.push(turnBoundary('turn/end', 1))
    host.publish()
    await waitFor(() => merges.length === 1)
    const output = sessionOutputPath(outputRoot, session.id, '合并输出')
    assert.equal(merges[0].target, output)
    assert.equal(merges[0].staged[0].rulePath, sessionOutputRulePath(root, output))
    assert.deepEqual(merges[0].options, { quiet: true })
    assert.match(merges[0].staged[0].content, /第 1 轮批注/)

    events.push(
      turnBoundary('turn/start', 2),
      assistant(2, 1, [text('第二轮')]),
      turnBoundary('turn/end', 2),
    )
    host.publish()
    await tick()
    assert.equal(reviews.length, 1)
    assert.equal(await readFile(output, 'utf8'), '第一轮\n')

    releaseFirstMerge()
    await waitFor(() => merges.length === 2 && reviews.length === 2)
    assert.equal(await readFile(output, 'utf8'), '第二轮\n')
  } finally {
    releaseFirstMerge?.()
    setTurnOutputRootResolver()
    setStorageRootResolver(() => '')
    await rm(root, { recursive: true, force: true })
  }
})

test('保存新输出前清理超过 24 小时的临时文件', async () => {
  const root = await mkdtemp(join(tmpdir(), 'humanize-output-ttl-'))
  const outputRoot = join(root, 'output')
  setTurnOutputRootResolver(() => outputRoot)
  setStorageRootResolver(() => join(root, 'storage'))
  try {
    await mkdir(outputRoot, { recursive: true })
    const expired = sessionOutputPath(outputRoot, 'session-expired', '过期输出')
    const recent = join(outputRoot, 'recent.md')
    await writeFile(expired, '过期内容\n')
    await writeFile(recent, '仍保留\n')
    const old = new Date(Date.now() - 25 * 60 * 60 * 1000)
    await utimes(expired, old, old)

    const events = [turnBoundary('turn/start', 1), assistant(1, 1, [text('最新内容')])]
    const session = makeSession('session-new', root, events, { title: '新输出' })
    const host = makeHarness(session)
    let reviews = 0
    registerTurnOutputs(host.ctx, log, { saveTurnOutputs: true }, async () => {
      reviews += 1
      return { kind: 'no-spec' }
    }, () => { throw new Error('不应合并') })
    events.push(turnBoundary('turn/end', 1))
    host.publish()
    await waitFor(() => reviews === 1)

    await assert.rejects(readFile(expired, 'utf8'), /ENOENT/)
    assert.equal(await readFile(recent, 'utf8'), '仍保留\n')
    assert.equal(await readFile(sessionOutputPath(outputRoot, session.id, '新输出'), 'utf8'), '最新内容\n')
  } finally {
    setTurnOutputRootResolver()
    setStorageRootResolver(() => '')
    await rm(root, { recursive: true, force: true })
  }
})
