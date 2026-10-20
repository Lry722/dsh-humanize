import test from 'node:test'
import assert from 'node:assert/strict'
import { closeJob, openJob } from '../lib/job-track.js'

/** 模拟 jobs 服务，登记 start/wait/remove 的调用。 */
function makeJobs() {
  const calls = { start: 0, wait: 0, remove: 0 }
  return {
    calls,
    start(options) {
      calls.start += 1
      const { cancel, done } = options.run({ updateProgress() {} })
      void done.then(() => undefined)
      void cancel
      return 'job-1'
    },
    wait() {
      calls.wait += 1
      return new Promise(() => {})
    },
    remove() {
      calls.remove += 1
    },
  }
}

const log = { warn() {} }

test('失效上下文上结算任务不再抛错', () => {
  const jobs = makeJobs()
  const ctx = {
    on() {
      const error = new Error('cannot create effect on inactive context')
      error.code = 'INACTIVE_EFFECT'
      throw error
    },
  }
  const tracked = openJob(ctx, log, { jobs, kind: 'humanize-review', label: '行文审查', owner: 's1', cancel() {} })
  tracked.settle({ status: 'completed', detail: 'done' })
  assert.doesNotThrow(() => closeJob(ctx, log, tracked))
})

test('活跃上下文上结算任务照常登记回合监听器', () => {
  const jobs = makeJobs()
  let listener
  const ctx = {
    on(event, cb) {
      listener = cb
      return () => {}
    },
  }
  const tracked = openJob(ctx, log, { jobs, kind: 'humanize-review', label: '行文审查', owner: 's1', cancel() {} })
  tracked.settle({ status: 'completed', detail: 'done' })
  closeJob(ctx, log, tracked)
  assert.equal(typeof listener, 'function')
  // 其他会话的回合不触发清理。
  listener({ id: 's2' }, { type: 'turn/start' })
  assert.equal(jobs.calls.remove, 0)
  listener({ id: 's1' }, { type: 'turn/start' })
  assert.equal(jobs.calls.remove, 1)
})
