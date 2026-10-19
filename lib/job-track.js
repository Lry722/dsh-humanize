/**
 * 后台任务脚手架。审查批次、循环合并和失败告警共用同一套模式：注册
 * 任务、挂 wait 抑制完成通知、结算记录保留到用户在会话里发起下一个
 * 回合。
 *
 * @module dsh-humanize/job-track
 */

/**
 * 通知抑制用的 wait 超时。dsh-tool-jobs 会跳过释放了活跃 wait 的结算，
 * 也就是 awaited 为 true 的结算。任务由插件自己结算，正常路径远早于此
 * 超时。挂上 wait 就能挡住完成通知注入模型上下文，agent 空闲时也不会被
 * 唤醒去做一个付费 turn。
 *
 * 这个 wait 不能挂任何会提前 abort 的 signal。注册表在 done promise 的
 * 微任务里结算，而 abort 同步把 wait 移出等待集合。一旦 abort 抢在结算前
 * 执行，awaited 就是 false，通知照样发出。
 */
const WAIT_HOLD_MS = 24 * 60 * 60 * 1000

/**
 * 每个会话最近一条已结算的任务记录和它的回合监听器。结算记录保留到
 * 用户在会话里发起下一个回合：用户开了新回合，说明已经看过这条终态。
 * 下一条任务开始时会提前摘掉。插件热重载后这份内存记录丢失，旧记录
 * 留到会话销毁时由注册表清理。
 */
const lastSettled = new Map()

/** 摘掉一个会话的已结算记录，连同它的回合监听器。 */
function dropSettled(jobs, owner) {
  const entry = lastSettled.get(owner)
  if (entry === undefined) return
  lastSettled.delete(owner)
  entry.off()
  try { jobs.remove(entry.jobId, owner) } catch { /* 记录可能已被清理 */ }
}

/**
 * 注册一个后台任务并挂上抑制通知的 wait。jobs 服务缺失或 start 被拒时
 * 返回 null，调用方走降级路径。
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
  // 新任务开始时摘掉该会话上一条已结算的记录。
  dropSettled(jobs, owner)
  const tracked = { jobs, owner, jobId: undefined, handle: undefined, settle: undefined, waitHold: undefined }
  const done = new Promise((resolve) => { tracked.settle = resolve })
  try {
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
    // 没有 controller 服务这个 owner 时 start 拒绝。
    log.warn('humanize: cannot start %s job, running without progress: %s', kind, error)
    return null
  }
  // 这里不传 signal，原因见 WAIT_HOLD_MS 的说明。
  tracked.waitHold = jobs.wait(tracked.jobId, WAIT_HOLD_MS, owner).catch(() => undefined)
  return tracked
}

/**
 * 任务结算后收尾。wait 随结算自然结束，结算记录登记下来，用户在会话
 * 里发起下一个回合时摘除。
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {object | null} tracked - openJob 的返回值。
 */
export function closeJob(ctx, tracked) {
  if (tracked === null) return
  void tracked.waitHold
  // 同一时刻一个会话只有一条在途任务，防御性地先摘再上。
  dropSettled(tracked.jobs, tracked.owner)
  const entry = { jobId: tracked.jobId, off: undefined }
  entry.off = ctx.on('session/event', (session, event) => {
    if (session.id !== tracked.owner || event.type !== 'turn/start') return
    dropSettled(tracked.jobs, tracked.owner)
  })
  lastSettled.set(tracked.owner, entry)
}
