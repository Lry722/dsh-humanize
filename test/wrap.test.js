import test from 'node:test'
import assert from 'node:assert/strict'
import { registerHumanFacingPrompt, wrapAgentTools } from '../lib/wrap.js'

/** 造一个只提供 write 工具的假上下文，登记下来的定义收在 registered 里。 */
function makeCtx() {
  const registered = []
  const original = {
    name: 'write',
    description: 'write a file',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path'],
    },
    async execute(args) {
      return { path: args.path, before: 'old', after: 'new' }
    },
  }
  return {
    registered,
    original,
    tools: { get: (name) => (name === 'write' ? original : undefined) },
  }
}

function makeAgent() {
  const registered = []
  return {
    id: 'agent-1',
    registered,
    ctx: {
      tools: {
        register(definition) {
          registered.push(definition)
          return () => {}
        },
      },
    },
  }
}

test('包装后的 schema 追加必填的 human_facing，原 schema 保持原样', () => {
  const ctx = makeCtx()
  const agent = makeAgent()
  wrapAgentTools(ctx, () => {}, agent, () => {})
  const definition = agent.registered[0]
  assert.equal(definition.parameters.required.includes('human_facing'), true)
  assert.equal(definition.parameters.properties.path.type, 'string')
  // 原工具的参数表没有被改动。
  assert.deepEqual(ctx.original.parameters.required, ['path'])
})

test('human_facing 为 true 时透传参数并触发写入回调', async () => {
  const ctx = makeCtx()
  const agent = makeAgent()
  const calls = []
  wrapAgentTools(ctx, () => {}, agent, (...args) => calls.push(args))
  const definition = agent.registered[0]
  const seen = []
  ctx.original.execute = async (args) => { seen.push(args); return { path: 'a.md', before: 'old', after: 'new' } }

  const value = await definition.execute({ path: 'a.md', human_facing: true }, { agent })
  assert.deepEqual(seen, [{ path: 'a.md' }])
  assert.equal(value.after, 'new')
  assert.equal(calls.length, 1)
  assert.deepEqual(calls[0], [agent, 'a.md', 'old', 'new'])
})

test('缺少 human_facing 时按代码处理，写入照常执行，只提示一次', async () => {
  const ctx = makeCtx()
  const agent = makeAgent()
  const warnings = []
  const calls = []
  wrapAgentTools(ctx, (message, ...args) => warnings.push([message, ...args]), agent, (...args) => calls.push(args))
  const definition = agent.registered[0]

  await definition.execute({ path: 'a.md' }, { agent })
  await definition.execute({ path: 'b.md' }, { agent })
  assert.equal(calls.length, 0)
  assert.equal(warnings.length, 1)
  assert.match(warnings[0][0], /without human_facing/)
})

test('系统提示里补一条 human_facing 约定', () => {
  const sections = []
  const ctx = {
    inject(_services, callback) {
      callback({
        systemPrompt: {
          getSectionOrder: () => 1200,
          section(section) { sections.push(section) },
        },
      })
    },
  }
  registerHumanFacingPrompt(ctx)
  assert.equal(sections.length, 1)
  assert.equal(sections[0].name, 'tool:humanize-write')
  assert.equal(sections[0].order, 1200)
  assert.match(sections[0].text(), /human_facing/)
})
