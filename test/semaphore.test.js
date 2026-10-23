import test from 'node:test'
import assert from 'node:assert/strict'
import { createSemaphore } from '../lib/semaphore.js'

const tick = () => new Promise((resolve) => { setImmediate(resolve) })

test('信号量限制同时进行的获取操作数', async () => {
  const semaphore = createSemaphore(2)
  const releaseFirst = await semaphore.acquire()
  const releaseSecond = await semaphore.acquire()
  let releaseThird
  const third = semaphore.acquire().then((release) => { releaseThird = release })

  await tick()
  assert.equal(releaseThird, undefined)

  releaseFirst()
  await tick()
  assert.equal(typeof releaseThird, 'function')

  releaseSecond()
  releaseThird()
  await third
})

test('等待中的获取操作可以中止', async () => {
  const semaphore = createSemaphore(1)
  const release = await semaphore.acquire()
  const controller = new AbortController()
  const waiting = semaphore.acquire(controller.signal)

  controller.abort()
  await assert.rejects(waiting, /aborted while waiting/)
  release()
})

test('上限调大后，新的获取操作能立即占用空出的名额', async () => {
  let limit = 1
  const semaphore = createSemaphore(() => limit)
  const releaseFirst = await semaphore.acquire()
  limit = 2

  const releaseSecond = await semaphore.acquire()
  assert.equal(typeof releaseSecond, 'function')

  releaseFirst()
  releaseSecond()
})
