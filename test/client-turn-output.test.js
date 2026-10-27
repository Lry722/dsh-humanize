import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'
import { tick } from './helpers.js'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

async function loadChunk() {
  let definition
  const window = { __ModuleLoader__: { load(value) { definition = value } } }
  const source = await readFile(join(root, 'client/client.turn-output.js'), 'utf8')
  vm.runInNewContext(source, { window, AbortController, setTimeout, clearTimeout })
  const react = {
    createElement() {},
    useEffect() {},
    useRef() {},
    useState() {},
    useSyncExternalStore() {},
    useCallback() {},
  }
  return definition.factory((name) => {
    if (name === 'react') return react
    throw new Error(`unexpected module ${name}`)
  })
}

function deferred() {
  let resolve
  let reject
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

function response(body, ok = true) {
  return { ok, json: async () => body }
}

function metadata(sessionId, turn, phase) {
  return {
    sessionId,
    turn,
    filePath: phase === 'ready' || phase === 'failed' ? `/tmp/${sessionId}-${turn}.md` : null,
    phase,
    updatedAt: 123,
  }
}

function timers() {
  let next = 0
  const pending = new Map()
  return {
    pending,
    setTimeout(callback) {
      const id = ++next
      pending.set(id, callback)
      return id
    },
    clearTimeout(id) { pending.delete(id) },
  }
}

async function settle() {
  await tick()
  await tick()
}

test('最新有效 turn 跳过空白正文和尚未结束的轮次', async () => {
  const { latestOutputTurn } = await loadChunk()
  const turns = new Map([1, 2, 3, 4].map((turn) => [turn, { end: turn === 4 ? undefined : {} }]))
  const nodes = new Map([
    ['a1', { kind: 'assistant-step', data: { blocks: [{ kind: 'text', text: '第一轮' }] } }],
    ['a2', { kind: 'assistant-step', data: { blocks: [{ kind: 'text', text: '第二轮' }] } }],
    ['a3', { kind: 'assistant-step', data: { blocks: [{ kind: 'text', text: '  \n' }] } }],
    ['a4', { kind: 'assistant-step', data: { blocks: [{ kind: 'text', text: '尚未结束' }] } }],
  ])
  const snapshot = {
    timeline: { turnOrder: [1, 2, 3, 4], turns },
    locations: { getTurn: (turn) => [`a${turn}`] },
    nodes: { get: (key) => nodes.get(key) },
  }
  assert.equal(latestOutputTurn(snapshot), 2)
})

test('状态响应严格匹配会话和 turn', async () => {
  const { metadataForTurn } = await loadChunk()
  const value = metadata('session-1', 2, 'ready')
  assert.equal(metadataForTurn(value, 'session-1', 2), value)
  assert.equal(metadataForTurn(value, 'session-1', 1), undefined)
  assert.equal(metadataForTurn(value, 'session-2', 2), undefined)
  assert.equal(metadataForTurn({ ...value, filePath: null }, 'session-1', 2), undefined)
})

test('点击后才开始润色，仅处理中且可见时刷新', async () => {
  const { createTurnOutputStore } = await loadChunk()
  const clock = timers()
  const requests = []
  const store = createTurnOutputStore({
    fetch(url, options) {
      const item = deferred()
      requests.push({ ...item, url, options })
      return item.promise
    },
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    pollMs: 10,
  })
  store.start('session-1', 1)
  assert.equal(requests.length, 0)
  store.setVisible(true)
  assert.equal(requests.length, 1)
  requests[0].resolve(response(metadata('session-1', 1, 'pending')))
  await settle()
  assert.equal(store.getSnapshot().metadata.phase, 'pending')
  assert.equal(clock.pending.size, 0)

  store.polish()
  assert.equal(requests.length, 2)
  assert.equal(requests[1].options.method, 'POST')
  assert.match(requests[1].url, /sessionId=session-1&turn=1/)
  assert.equal(store.getSnapshot().metadata.phase, 'processing')
  requests[1].resolve(response(metadata('session-1', 1, 'processing')))
  await settle()
  assert.equal(store.getSnapshot().metadata.phase, 'processing')
  assert.equal(clock.pending.size, 1)

  store.setVisible(false)
  assert.equal(clock.pending.size, 0)
  for (const callback of [...clock.pending.values()]) callback()
  assert.equal(requests.length, 2)
  store.setVisible(true)
  assert.equal(requests.length, 3)
  requests[2].resolve(response(metadata('session-1', 1, 'ready')))
  await settle()
  assert.equal(store.getSnapshot().metadata.phase, 'ready')
  assert.equal(clock.pending.size, 0)
  store.stop()
})

test('切换 turn 和隐藏会使迟到响应失效', async () => {
  const { createTurnOutputStore } = await loadChunk()
  const requests = []
  const store = createTurnOutputStore({
    fetch() {
      const item = deferred()
      requests.push(item)
      return item.promise
    },
  })
  store.start('session-1', 1)
  store.setVisible(true)
  assert.equal(requests.length, 1)
  store.start('session-1', 2)
  assert.equal(requests.length, 2)
  requests[0].resolve(response(metadata('session-1', 1, 'ready')))
  await settle()
  assert.equal(store.getSnapshot().status, 'loading')
  requests[1].resolve(response(metadata('session-1', 2, 'ready')))
  await settle()
  assert.equal(store.getSnapshot().metadata.turn, 2)

  store.start('session-1', 3)
  assert.equal(requests.length, 3)
  store.setVisible(false)
  requests[2].resolve(response(metadata('session-1', 3, 'ready')))
  await settle()
  assert.equal(store.getSnapshot().status, 'loading')
  store.setVisible(true)
  assert.equal(requests.length, 4)
  store.stop()
})

test('网络错误不自动重试，不匹配响应不轮询', async () => {
  const { createTurnOutputStore } = await loadChunk()
  const clock = timers()
  let calls = 0
  const store = createTurnOutputStore({
    fetch: async () => {
      calls += 1
      if (calls === 1) return response(metadata('session-1', 99, 'processing'))
      throw new Error('offline')
    },
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
  })
  store.start('session-1', 1)
  store.setVisible(true)
  await settle()
  assert.equal(store.getSnapshot().metadata.turn, 99)
  assert.equal(clock.pending.size, 0)
  store.retry()
  await settle()
  assert.equal(store.getSnapshot().status, 'error')
  assert.equal(calls, 2)
  assert.equal(clock.pending.size, 0)
  store.stop()
})
