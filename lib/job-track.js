/**
 * 后台任务脚手架。审查批次、循环合并和失败告警共用同一套模式。先注册
 * 任务，再挂 wait 抑制完成通知，结算记录保留到用户在会话里发起下一个
 * 回合。
 *
 * @module dsh-humanize/job-track
 */

/** 抑制完成通知的 wait 超时。取足够长即可，任务正常会在超时前结算。 */
const WAIT_HOLD_MS = 24 * 60 * 60 * 1000

/**
 * 每个会话最近一条结算记录和它的回合监听器。
 *
 * 用户开了下一个回合，说明已经看过这条终态，记录随即摘掉。下一条
 * 任务开始时也会提前摘掉。
 *
 * 插件热重载后这份内存记录丢失，旧记录留到会话销毁时由注册表摘掉。
 */
const lastSettled = new Map()

function dropSettled(jobs, owner) {
  const entry = lastSettled.get(owner)
  if (entry === undefined) return
  lastSettled.delete(owner)
  entry.off()
  try { jobs.remove(entry.jobId, owner) } catch { /* 记录可能已被摘掉 */ }
}

/**
 * 注册一个后台任务并挂 wait 抑制完成通知。jobs 服务不可用或 start
 * 失败时返回 null，调用方走降级路径。
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {{ warn: Function }} log
 * @param {object} options
 * @param {object | undefined} options.jobs - ctx.get('jobs') 的结果。
 * @param {string} options.kind - 任务类型，客户端按它筛选任务行。
 * @param {string} options.label - 任务列表里的显示名。
 * @param {string} options.owner - 任务归属的会话 id。
 * @param {(reason?: string) => void} options.cancel - 用户在任务列表点取消时调用。
 */
export function openJob(ctx, log, options) {
  const { jobs, kind, label, owner, cancel } = options
  if (jobs === undefined) return null
  dropSettled(jobs, owner)
  const tracked = { jobs, owner, jobId: undefined, handle: undefined, settle: undefined, waitHold: undefined }
  const done = new Promise((resolve) => { tracked.settle = resolve })
  try {
    // 任务事件走 jobs 通道发布。
    tracked.jobId = jobs.start({
      kind,
      label,
      owner,
      run(job) {
        tracked.handle = job
        return { cancel, done }
      },
    })
  } catch (error) {
    // controller 服务找不到这个 owner 时，start 会抛出错误。
    log.warn('humanize: cannot start %s job, running without progress: %s', kind, error)
    return null
  }
  // 这里调用 wait 时省略 signal 参数，靠 wait 在结算后自己结束来收尾。
  // 注册表在 done promise 的微任务里结算，abort 先于结算执行时，
  // wait 仍会发出通知，signal 派不上用场。
  tracked.waitHold = jobs.wait(tracked.jobId, WAIT_HOLD_MS, owner).catch(() => undefined)
  return tracked
}

/**
 * 任务结算后收尾。这个 wait 随结算一起结束，结算记录登记到
 * lastSettled。
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {{ warn: Function }} log
 * @param {object | null} tracked - openJob 的返回值。
 */
export function closeJob(ctx, log, tracked) {
  if (tracked === null) return
  void tracked.waitHold
  // 同一时刻一个会话只有一条在途任务，先摘掉旧记录，再登记新记录。
  dropSettled(tracked.jobs, tracked.owner)
  const entry = { jobId: tracked.jobId, off: undefined }
  try {
    entry.off = ctx.on('session/event', (session, event) => {
      if (session.id !== tracked.owner || event.type !== 'turn/start') return
      dropSettled(tracked.jobs, tracked.owner)
    })
  } catch (error) {
    // 这个分支只在热重载后出现，旧实例的收尾还会跑到这里。旧上下文
    // 已经失效，ctx.on 会抛 INACTIVE_EFFECT。这里提前返回，结算记录
    // 留给注册表在会话销毁时摘掉。
    log.warn('humanize: cannot track settled job %s, context inactive: %s', tracked.jobId, error)
    return
  }
  lastSettled.set(tracked.owner, entry)
}
