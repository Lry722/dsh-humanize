import test from 'node:test'
import assert from 'node:assert/strict'
import { apply } from '../lib/index.js'

/**
 * 造一个最小的宿主上下文。工具注册像真实的作用域层一样同步发出
 * tools/change，卸载包装工具时同样发出。
 */
function makeHost(options = {}) {
  const listeners = new Map()
  const cleanups = []
  const registrations = []
  let cleaning = false
  let available = options.available !== false
  const emit = (event, ...args) => {
    for (const callback of [...(listeners.get(event) ?? [])]) callback(...args)
  }
  const original = {
    name: 'write',
    parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
    async execute() { return {} },
  }
  const agent = {
    id: 'agent-1',
    session: { id: 'session-1', header: { cwd: '/tmp', agentPreset: 'standard' }, requestHeader: () => undefined },
    inject() {},
    ctx: {
      tools: {
        register(definition) {
          // 卸载期间只允许一次重新注册，超过就说明重新注册循环没被挡住。
          if (cleaning && registrations.length >= 2) throw new Error('tools were rewrapped during teardown')
          registrations.push(definition)
          emit('tools/change')
          return () => { emit('tools/change') }
        },
      },
    },
  }
  const log = { info() {}, warn() {}, debug() {}, error() {} }
  const ctx = {
    logger: () => log,
    fiber: {},
    get: () => undefined,
    on(event, callback) {
      const list = listeners.get(event) ?? []
      list.push(callback)
      listeners.set(event, list)
      return () => {}
    },
    effect(fn) {
      const cleanup = fn()
      if (typeof cleanup === 'function') cleanups.push(cleanup)
      return () => {}
    },
    inject(services, callback) {
      if (services.includes('settings')) {
        callback({ ...ctx, settings: { configure: () => () => {} } })
      }
      if (services.includes('systemPrompt')) {
        callback({ ...ctx, systemPrompt: { getSectionOrder: () => 1200, section() {} } })
      }
    },
    agents: { list: () => [agent], get: () => agent },
    tools: { get: (name) => (available && name === 'write' ? original : undefined) },
    commands: { register() {} },
    subagents: { startActivation: async () => { throw new Error('unexpected activation') } },
    llm: { stream: () => { throw new Error('unexpected review') } },
  }
  return {
    ctx,
    registrations,
    cleanups,
    beginTeardown() { cleaning = true },
    setAvailable(next) {
      available = next
      emit('tools/change')
    },
  }
}

test('插件卸载期间工具定义保持原样', async () => {
  const host = makeHost()
  apply(host.ctx, undefined)
  // 当前只解析到 write 这一个原工具。
  assert.equal(host.registrations.length, 1)

  host.beginTeardown()
  for (const cleanup of host.cleanups) await cleanup()

  assert.equal(host.registrations.length, 1)
})

test('工具晚于 agent 就绪时，tools/change 会补上新工具的重新注册', () => {
  const host = makeHost({ available: false })
  apply(host.ctx, undefined)
  assert.equal(host.registrations.length, 0)

  host.setAvailable(true)
  assert.equal(host.registrations.length, 1)
  assert.equal(host.registrations[0].parameters.required.includes('human_facing'), true)
})
