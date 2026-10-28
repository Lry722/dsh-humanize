import test from 'node:test'
import assert from 'node:assert/strict'
import { chmod, mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { registerTurnOutputs, sessionOutputPath, setTurnOutputRootResolver } from '../../lib/output/turns.js'
import { setStorageRootResolver, writeStaging } from '../../lib/shared/staging.js'
import { sleep } from '../helpers.js'

const log = { info() {}, warn() {} }

function assistant(turn, value) {
  return {
    type: 'assistant/message',
    data: { turn, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: value }] } },
  }
}

function boundary(type, turn) {
  return { type, data: type === 'turn/end' ? { turn, reason: { kind: 'completed' } } : { turn } }
}

function makeHarness(root, id, title, enabled = true) {
  const events = [boundary('turn/start', 1), assistant(1, '第一轮')]
  const session = {
    id,
    title,
    header: { cwd: root },
    snapshotEvents: () => events,
  }
  const listeners = new Map()
  let published = 0
  const agent = { id, session }
  const config = { saveTurnOutputs: enabled }
  const ctx = {
    agents: { get: (value) => value === id ? agent : undefined },
    get(service) {
      if (service === 'sessionTitle') return { get: () => ({ title: session.title }) }
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
    config,
    ctx,
    events,
    session,
    publish() {
      while (published < events.length) {
        const event = events[published]
        published += 1
        for (const callback of listeners.get('session/event') ?? []) callback(session, event)
      }
    },
    finish() {
      events.push(boundary('turn/end', 1))
      this.publish()
    },
    addTurn(turn, value) {
      events.push(boundary('turn/start', turn))
      if (value !== undefined) events.push(assistant(turn, value))
      events.push(boundary('turn/end', turn))
      this.publish()
    },
  }
}

function deferred() {
  let resolve
  const promise = new Promise((resolvePromise) => { resolve = resolvePromise })
  return { promise, resolve }
}

async function waitForMetadata(outputs, sessionId, predicate) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const value = await outputs.readOutput(sessionId)
    if (predicate(value)) return value
    await sleep(5)
  }
  throw new Error('timed out waiting for output metadata')
}

async function fixture(t, options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'humanize-output-status-'))
  const outputRoot = join(root, 'output')
  setTurnOutputRootResolver(() => outputRoot)
  setStorageRootResolver(() => join(root, 'storage'))
  t.after(async () => {
    setTurnOutputRootResolver()
    setStorageRootResolver(() => '')
    await rm(root, { recursive: true, force: true })
  })
  const host = makeHarness(root, options.id ?? 'session-status', options.title ?? '状态输出', options.enabled)
  return { host, outputRoot, root }
}

test('状态覆盖处理中和就绪，新 turn 立即作废旧 turn', async (t) => {
  const { host, outputRoot } = await fixture(t)
  const firstReview = deferred()
  const review = async (agent, filePath, before, after) => {
    if (after === '第一轮\n') return firstReview.promise
    await writeStaging(filePath, '1. "需要修订"\n')
    return { kind: 'ok', annotations: 1 }
  }
  const merge = (agent, filePath) => ({
    started: Promise.resolve({ started: true }),
    done: writeFile(filePath, '第二轮（已润色）\n'),
  })
  const outputs = registerTurnOutputs(host.ctx, log, host.config, review, merge)
  const output = sessionOutputPath(outputRoot, host.session.id, '状态输出')
  host.finish()
  await outputs.polishOutput(host.session.id, 1)
  await waitForMetadata(outputs, host.session.id, (value) => value.phase === 'processing')
  assert.equal((await outputs.readOutput(host.session.id)).turn, 1)

  host.addTurn(2, '第二轮')
  const queued = await outputs.readOutput(host.session.id)
  assert.equal(queued.phase, 'saving')
  assert.equal(queued.turn, 2)
  firstReview.resolve({ kind: 'no-spec' })
  await waitForMetadata(outputs, host.session.id, (value) => value.phase === 'pending' && value.turn === 2)
  await outputs.polishOutput(host.session.id, 2)
  await waitForMetadata(outputs, host.session.id, (value) => value.phase === 'ready' && value.turn === 2)
  assert.equal(await readFile(output, 'utf8'), '第二轮（已润色）\n')
})

test('本轮正文写入失败时不把同名旧稿作为失败版本开放', async (t) => {
  if (process.platform === 'win32' || process.getuid?.() === 0) {
    t.skip('需要非 root 用户的目录写权限')
    return
  }
  const { host, outputRoot } = await fixture(t)
  const outputs = registerTurnOutputs(host.ctx, log, host.config, async () => ({ kind: 'no-spec' }), () => {})
  host.finish()
  await outputs.polishOutput(host.session.id, 1)
  await waitForMetadata(outputs, host.session.id, (value) => value.phase === 'no-spec')
  const output = sessionOutputPath(outputRoot, host.session.id, '状态输出')

  await chmod(outputRoot, 0o500)
  try {
    host.addTurn(2, '第二轮无法保存')
    const failed = await waitForMetadata(outputs, host.session.id, (value) => value.turn === 2 && value.phase === 'missing')
    assert.equal(failed.filePath, output)
    assert.equal(await readFile(output, 'utf8'), '第一轮\n')
  } finally {
    await chmod(outputRoot, 0o700)
  }

  host.addTurn(3, '第三轮恢复')
  await outputs.polishOutput(host.session.id, 3)
  await waitForMetadata(outputs, host.session.id, (value) => value.turn === 3 && value.phase === 'no-spec')
  assert.equal(await readFile(output, 'utf8'), '第三轮恢复\n')
})

test('重载时，本轮保存尚未确认的 sidecar 按 missing 报告', async (t) => {
  const { host, outputRoot } = await fixture(t)
  const firstReview = deferred()
  const review = async (agent, filePath, before, after) => after === '第一轮\n'
    ? firstReview.promise
    : { kind: 'no-spec' }
  const outputs = registerTurnOutputs(host.ctx, log, host.config, review, () => {})
  const output = sessionOutputPath(outputRoot, host.session.id, '状态输出')
  host.finish()
  await outputs.polishOutput(host.session.id, 1)
  await waitForMetadata(outputs, host.session.id, (value) => value.phase === 'processing')

  // 第二轮在第一轮审查后排队，saving sidecar 已落盘，但正文仍是第一轮。
  host.addTurn(2, '第二轮')
  await waitForMetadata(outputs, host.session.id, (value) => value.turn === 2 && value.phase === 'saving')
  assert.equal(await readFile(output, 'utf8'), '第一轮\n')
  const restored = registerTurnOutputs(host.ctx, log, host.config, review, () => {})
  const recovered = await restored.readOutput(host.session.id)
  assert.equal(recovered.turn, 2)
  assert.equal(recovered.phase, 'missing')
  assert.equal(recovered.filePath, output)
  assert.equal(await readFile(output, 'utf8'), '第一轮\n')

  firstReview.resolve({ kind: 'no-spec' })
  await waitForMetadata(outputs, host.session.id, (value) => value.turn === 2 && value.phase === 'pending')
})

test('输出开关、无正文和最新有效轮次遵循现有保存语义', async (t) => {
  const { host, outputRoot } = await fixture(t, { enabled: false })
  const outputs = registerTurnOutputs(host.ctx, log, host.config, async () => ({ kind: 'no-spec' }), () => {})
  host.finish()
  assert.equal((await outputs.readOutput(host.session.id)).phase, 'disabled')
  host.config.saveTurnOutputs = true
  assert.equal((await outputs.readOutput(host.session.id)).phase, 'missing')

  host.addTurn(2, '可见输出')
  await outputs.polishOutput(host.session.id, 2)
  await waitForMetadata(outputs, host.session.id, (value) => value.phase === 'no-spec')
  assert.equal((await outputs.readOutput(host.session.id)).turn, 2)
  host.addTurn(3, '  \n')
  const blank = await outputs.readOutput(host.session.id)
  assert.equal(blank.phase, 'no-spec')
  assert.equal(blank.turn, 2)
  assert.equal(await readFile(sessionOutputPath(outputRoot, host.session.id, '状态输出'), 'utf8'), '可见输出\n')
})

test('同名会话相互隔离，改名和重载后仍恢复正确轮次', async (t) => {
  const { host, outputRoot, root } = await fixture(t)
  const outputs = registerTurnOutputs(host.ctx, log, host.config, async () => ({ kind: 'no-spec' }), () => {})
  host.finish()
  await waitForMetadata(outputs, host.session.id, (value) => value.phase === 'pending')
  const originalPath = sessionOutputPath(outputRoot, host.session.id, '状态输出')
  host.session.title = '改名后的标题'

  const restored = registerTurnOutputs(host.ctx, log, host.config, async () => ({ kind: 'no-spec' }), () => {})
  let recovered = await restored.readOutput(host.session.id)
  assert.equal(recovered.filePath, originalPath)
  assert.equal(recovered.turn, 1)
  assert.equal(recovered.phase, 'pending')
  await restored.polishOutput(host.session.id, 1)
  recovered = await waitForMetadata(restored, host.session.id, (value) => value.phase === 'no-spec')
  assert.equal(recovered.filePath, originalPath)

  const other = makeHarness(root, 'session-other', '状态输出')
  const otherOutputs = registerTurnOutputs(other.ctx, log, other.config, async () => ({ kind: 'no-spec' }), () => {})
  other.finish()
  await otherOutputs.polishOutput(other.session.id, 1)
  await waitForMetadata(otherOutputs, other.session.id, (value) => value.phase === 'no-spec')
  assert.notEqual((await otherOutputs.readOutput(other.session.id)).filePath, originalPath)
  assert.equal((await outputs.readOutput(host.session.id)).filePath, originalPath)
})

test('审查失败和合并未启动都保留输出文件并报告失败', async (t) => {
  const { host, outputRoot } = await fixture(t)
  let failReview = false
  const review = async (agent, filePath) => {
    if (failReview) return { kind: 'failed', message: 'review failed' }
    await writeStaging(filePath, '1. "需要修订"\n')
    return { kind: 'ok', annotations: 1 }
  }
  const merge = () => ({ started: Promise.resolve({ started: false, error: 'merge busy' }), done: Promise.resolve() })
  const outputs = registerTurnOutputs(host.ctx, log, host.config, review, merge)
  host.finish()
  await outputs.polishOutput(host.session.id, 1)
  await waitForMetadata(outputs, host.session.id, (value) => value.phase === 'failed')
  const failed = await outputs.readOutput(host.session.id)
  assert.equal(failed.error, 'merge busy')
  assert.equal(failed.turn, 1)
  assert.equal(await readFile(failed.filePath, 'utf8'), '第一轮\n')

  failReview = true
  host.addTurn(2, '审查失败')
  await outputs.polishOutput(host.session.id, 2)
  await waitForMetadata(outputs, host.session.id, (value) => value.phase === 'failed' && value.error === 'review failed')
  assert.equal(await readFile(sessionOutputPath(outputRoot, host.session.id, '状态输出'), 'utf8'), '审查失败\n')
})

test('无变化文件缺失或超过 24 小时分别报告 missing 和 expired', async (t) => {
  const { host, outputRoot } = await fixture(t)
  const outputs = registerTurnOutputs(host.ctx, log, host.config, async () => ({ kind: 'ok', annotations: 0 }), () => {})
  host.finish()
  await outputs.polishOutput(host.session.id, 1)
  await waitForMetadata(outputs, host.session.id, (value) => value.phase === 'unchanged')
  const output = sessionOutputPath(outputRoot, host.session.id, '状态输出')
  await rm(output)
  assert.equal((await outputs.readOutput(host.session.id)).phase, 'missing')

  await writeFile(output, '旧输出\n')
  const old = new Date(Date.now() - 25 * 60 * 60 * 1000)
  await utimes(output, old, old)
  const expired = await outputs.readOutput(host.session.id)
  assert.equal(expired.phase, 'expired')
  assert.equal(expired.turn, 1)
  assert.equal(expired.filePath, output)
})
