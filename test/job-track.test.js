import test from 'node:test'
import assert from 'node:assert/strict'
import { dropSettled, openJob, registerJobCleanup } from '../lib/job-track.js'

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
    /** 只删已存在的条目，删不到时报错。 */
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

test('turn/start 摘除该会话名下已结算的任务行', () => {
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
  jobs.settleView(tracked.jobId)
  // 清理只在同一会话的回合开始时发生，且在途任务会保留。
  listener({ id: 's2' }, { type: 'turn/start' })
  assert.equal(jobs.store.size, 1)
  listener({ id: 's1' }, { type: 'compaction/end' })
  assert.equal(jobs.store.size, 1)
  listener({ id: 's1' }, { type: 'turn/start' })
  assert.equal(jobs.store.size, 0)
})

test('热重载留下的孤儿任务行同样在下一个回合摘除', () => {
  const jobs = makeJobs()
  let listener
  const ctx = {
    get(name) { return name === 'jobs' ? jobs : undefined },
    on(event, cb) {
      listener = cb
      return () => {}
    },
  }
  // 旧实例注册的任务行，新实例加载时只有注册表里的记录。
  const orphan = jobs.start({ kind: 'humanize-review', label: '行文审查', owner: 's1', run() {} })
  jobs.settleView(orphan, 'killed')
  registerJobCleanup(ctx, log)
  listener({ id: 's1' }, { type: 'turn/start' })
  assert.equal(jobs.store.has(orphan), false)
})

test('dropSettled 只摘除本插件名下已结算的任务行', () => {
  const jobs = makeJobs()
  const ctx = { get: () => jobs, on: () => () => {} }
  const live = jobs.start({ kind: 'humanize-review', label: '行文审查', owner: 's1', run() {} })
  const other = jobs.start({ kind: 'bash', label: '命令', owner: 's1', run() {} })
  jobs.settleView(other)
  dropSettled(jobs, 's1')
  assert.equal(jobs.store.has(live), true)
  assert.equal(jobs.store.has(other), true)
})

test('没有 jobs 服务时回合开始不做任何事', () => {
  let listener
  const ctx = {
    get: () => undefined,
    on(event, cb) { listener = cb; return () => {} },
  }
  registerJobCleanup(ctx, log)
  assert.equal(typeof listener, 'function')
  assert.doesNotThrow(() => listener({ id: 's1' }, { type: 'turn/start' }))
})

test('openJob 开新任务前顺手摘除旧的已结算任务行', () => {
  const jobs = makeJobs()
  const ctx = { get: () => jobs, on: () => () => {} }
  const first = openJob(ctx, log, { jobs, kind: 'humanize-review', label: '行文审查', owner: 's1', cancel() {} })
  first.settle({ status: 'completed', detail: 'done' })
  jobs.settleView(first.jobId)
  const second = openJob(ctx, log, { jobs, kind: 'humanize-review', label: '行文审查', owner: 's1', cancel() {} })
  assert.equal(jobs.store.has(first.jobId), false)
  assert.equal(jobs.store.has(second.jobId), true)
})
