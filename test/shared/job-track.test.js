import test from 'node:test'
import assert from 'node:assert/strict'
import { dropSettled, openJob, registerJobCleanup } from '../../lib/shared/job-track.js'

/** 模拟 jobs 服务，行为对齐 dsh-jobs-local。 */
function makeJobs() {
  const store = new Map()
  let seq = 0
  return {
    store,
    start(options) {
      seq += 1
      const id = `job-${seq}`
      store.set(id, { id, kind: options.kind, owner: options.owner, status: 'running' })
      options.run({ updateProgress() {} })
      return id
    },
    wait() {
      return new Promise(() => {})
    },
    remove(id) {
      if (!store.has(id)) throw new Error(`unknown job: ${id}`)
      store.delete(id)
    },
    /** 按 caller 过滤任务行。 */
    list(caller) {
      return [...store.values()].filter((job) => job.owner === undefined || job.owner === caller)
    },
    /** 只改 store 里的状态字段，挂着的 wait 保持原样。 */
    settleView(id, status = 'completed') {
      store.get(id).status = status
    },
  }
}

const log = { warn() {} }

test('回合开始时摘除该会话名下已结算的任务行', () => {
  const jobs = makeJobs()
  let listener
  const ctx = {
    get(name) { return name === 'jobs' ? jobs : undefined },
    on(event, cb) {
      listener = cb
      return () => {}
    },
  }
  registerJobCleanup(ctx, log)
  const tracked = openJob(ctx, log, { jobs, kind: 'humanize-loop', label: '循环合并', owner: 's1', cancel() {} })
  const orphan = jobs.start({ kind: 'humanize-review', label: '行文审查', owner: 's1', run() {} })
  const live = jobs.start({ kind: 'humanize-review', label: '行文审查', owner: 's1', run() {} })
  jobs.settleView(tracked.jobId)
  jobs.settleView(orphan, 'killed')

  // 清理只在同一会话的回合开始时发生。在途任务会保留。
  listener({ id: 's2' }, { type: 'turn/start' })
  listener({ id: 's1' }, { type: 'compaction/end' })
  assert.deepEqual([...jobs.store.keys()].sort(), [orphan, tracked.jobId, live].sort())
  listener({ id: 's1' }, { type: 'turn/start' })
  assert.deepEqual([...jobs.store.keys()], [live])
})

test('开新任务前只摘除本插件名下已结算的任务行', () => {
  const jobs = makeJobs()
  const ctx = { get: () => jobs, on: () => () => {} }
  const live = jobs.start({ kind: 'humanize-review', label: '行文审查', owner: 's1', run() {} })
  const other = jobs.start({ kind: 'bash', label: '命令', owner: 's1', run() {} })
  const settled = jobs.start({ kind: 'humanize-review', label: '行文审查', owner: 's1', run() {} })
  jobs.settleView(other)
  jobs.settleView(settled)
  dropSettled(jobs, 's1')
  assert.equal(jobs.store.has(live), true)
  assert.equal(jobs.store.has(other), true)
  assert.equal(jobs.store.has(settled), false)

  const next = openJob(ctx, log, { jobs, kind: 'humanize-review', label: '行文审查', owner: 's1', cancel() {} })
  assert.equal(jobs.store.has(next.jobId), true)
})

test('没有 jobs 服务时回合开始直接返回', () => {
  let listener
  const ctx = {
    get: () => undefined,
    on(event, cb) { listener = cb; return () => {} },
  }
  registerJobCleanup(ctx, log)
  assert.equal(typeof listener, 'function')
  assert.doesNotThrow(() => listener({ id: 's1' }, { type: 'turn/start' }))
})

test('没有 jobs 服务时返回可结算的空操作对象', () => {
  const tracked = openJob({}, log, {
    jobs: undefined,
    kind: 'humanize-review',
    label: '行文审查',
    owner: 's1',
    cancel() {},
  })
  assert.equal(tracked.jobId, undefined)
  assert.equal(tracked.handle, undefined)
  assert.equal(typeof tracked.settle, 'function')
  assert.doesNotThrow(() => tracked.settle({ status: 'completed', detail: 'x' }))
})

test('jobs.start 抛错时记录告警并返回空操作对象', () => {
  const warnings = []
  const jobs = {
    list: () => [],
    start() {
      throw new Error('unknown owner')
    },
  }
  const tracked = openJob({}, { warn: (...args) => warnings.push(args) }, {
    jobs,
    kind: 'humanize-review',
    label: '行文审查',
    owner: 's1',
    cancel() {},
  })
  assert.equal(tracked.jobId, undefined)
  assert.equal(tracked.handle, undefined)
  assert.equal(typeof tracked.settle, 'function')
  assert.doesNotThrow(() => tracked.settle({ status: 'failed', detail: 'x' }))
  assert.equal(warnings.length, 1)
  assert.match(String(warnings[0][0]), /cannot start/)
})
