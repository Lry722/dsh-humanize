import test from 'node:test'
import assert from 'node:assert/strict'
import { registerTurnOutputInfo } from '../../lib/output/routes.js'

function makeRoute(outputs) {
  let definition
  const ctx = {
    inject(services, callback) {
      assert.deepEqual(services, ['connection'])
      callback({
        ...ctx,
        connection: {
          fetch: {
            register(value) {
              definition = value
              return () => {}
            },
          },
        },
      })
    },
    effect(callback) { callback() },
  }
  registerTurnOutputInfo(ctx, outputs)
  assert.equal(definition.path, '/api/humanize.turn-output')
  assert.deepEqual(definition.methods, ['GET'])
  return definition.fetch
}

test('输出路由只返回会话元数据并禁止路径参数', async () => {
  const calls = []
  const fetch = makeRoute({
    async readOutput(sessionId) {
      calls.push(sessionId)
      return { sessionId, turn: 3, filePath: '/tmp/owned-output.md', phase: 'ready', updatedAt: 123 }
    },
  })
  const response = await fetch(new Request('http://localhost/api/humanize.turn-output?sessionId=session-1'))
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('cache-control'), 'no-store')
  assert.deepEqual(await response.json(), {
    sessionId: 'session-1', turn: 3, filePath: '/tmp/owned-output.md', phase: 'ready', updatedAt: 123,
  })
  assert.deepEqual(calls, ['session-1'])

  for (const query of ['path=%2Fetc%2Fpasswd', 'filePath=%2Fetc%2Fpasswd']) {
    const rejected = await fetch(new Request(`http://localhost/api/humanize.turn-output?sessionId=session-1&${query}`))
    assert.equal(rejected.status, 400)
    assert.equal(rejected.headers.get('cache-control'), 'no-store')
  }
  assert.deepEqual(calls, ['session-1'])
})

test('输出路由校验 sessionId 并隐藏内部读取异常', async () => {
  const fetch = makeRoute({ async readOutput() { throw new Error('private path') } })
  const missing = await fetch(new Request('http://localhost/api/humanize.turn-output'))
  assert.equal(missing.status, 400)
  const repeated = await fetch(new Request('http://localhost/api/humanize.turn-output?sessionId=one&sessionId=two'))
  assert.equal(repeated.status, 400)
  const failed = await fetch(new Request('http://localhost/api/humanize.turn-output?sessionId=..%2F..%2Fetc%2Fpasswd'))
  assert.equal(failed.status, 500)
  assert.deepEqual(await failed.json(), { error: 'Output status is unavailable.' })
  assert.equal(failed.headers.get('cache-control'), 'no-store')
})
