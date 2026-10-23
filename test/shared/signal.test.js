import test from 'node:test'
import assert from 'node:assert/strict'
import { fuseAbortSignal } from '../../lib/shared/signal.js'

test('上游已中止时立即中止并带上原因', () => {
  const upstream = AbortSignal.abort('merge started')
  const { controller } = fuseAbortSignal(upstream)
  assert.equal(controller.signal.aborted, true)
  assert.equal(controller.signal.reason, 'merge started')
})

test('上游稍后中止时，自身也随之中止并转发原因', () => {
  const source = new AbortController()
  const { controller } = fuseAbortSignal(source.signal)
  source.abort('cancelled')
  assert.equal(controller.signal.aborted, true)
  assert.equal(controller.signal.reason, 'cancelled')
})

test('dispose 后停止跟随上游，没有上游时保持未中止', () => {
  const source = new AbortController()
  const linked = fuseAbortSignal(source.signal)
  linked.dispose()
  source.abort()
  assert.equal(linked.controller.signal.aborted, false)

  const plain = fuseAbortSignal(undefined)
  plain.dispose()
  assert.equal(plain.controller.signal.aborted, false)
})
