/**
 * 后台任务脚手架。审查批次、合并运行和失败告警共用同一套模式。先注册
 * 任务，再挂 wait 抑制完成通知，结算记录保留到用户在会话里发起下一个
 * 回合。
 *
 * 已结算的任务行会在下一个回合开始时被摘除。
 *
 * @module dsh-humanize/job-track
 */

const KIND_PREFIX = 'humanize'

/** 抑制完成通知的 wait 超时。取足够长即可，任务正常会在超时前结算。 */
const WAIT_HOLD_MS = 24 * 60 * 60 * 1000

/** 任务是否已结算。running 和 stopping 都算在途。 */
function isSettled(view) {
  return view.status !== 'running' && view.status !== 'stopping'
}

/**
 * 摘除一个会话名下本插件已结算的全部任务行。开新任务前和用户发起
 * 下一个回合时都调用，重复摘除是空操作。
 *
 * 每次摘除都直接扫 jobs 注册表。结算任务行的实例是哪个都无所谓。
 * 热重载前旧实例留下的任务行，也会在下一个回合开始时摘除。
 */
export function dropSettled(jobs, owner) {
  for (const view of jobs.list(owner)) {
    if (!view.kind.startsWith(KIND_PREFIX)) continue
    if (!isSettled(view)) continue
    try {
      jobs.remove(view.id, owner)
    } catch {
      // 记录可能已被其他路径摘除。
    }
  }
}

/**
 * 注册回合开始时的任务行摘除。插件加载时调用一次，监听器挂在插件上下文
 * 上，随 fiber 生灭。
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {{ warn: Function }} log
 */
export function registerJobCleanup(ctx, log) {
  ctx.on('session/event', (session, event) => {
    if (event.type !== 'turn/start') return
    // jobs 服务可能晚于插件就绪，放到事件里按需取用。
    const jobs = ctx.get('jobs')
    if (jobs === undefined) return
    try {
      dropSettled(jobs, session.id)
    } catch (error) {
      log.warn('humanize: failed to drop settled jobs for %s: %s', session.id, error)
    }
  })
}

/**
 * 注册一个后台任务，并挂 wait 抑制完成通知。
 *
 * jobs 服务不可用或 start 失败时返回 null，调用方走降级路径。
 *
 * 开新任务前顺手摘除旧的已结算任务行，任务列表里同一会话始终只有一条
 * 在途或待看的记录。
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {{ warn: Function }} log
 * @param {object} options
 * @param {string} options.kind - 任务类型，客户端按它筛选任务行。
 * @param {string} options.label - 任务列表里的显示名。
 * @param {string} options.owner - 任务归属的会话 id。
 * @param {(reason?: string) => void} options.cancel - 用户在任务列表点取消时调用。
 */
export function openJob(ctx, log, options) {
  const { jobs, kind, label, owner, cancel } = options
  if (jobs === undefined) return null
  try {
    dropSettled(jobs, owner)
  } catch {
    // 注册表查询失败时继续开新任务。
  }
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
    // controller 服务找不到这个 owner 时，start 会抛出错误。
    log.warn('humanize: cannot start %s job, running without progress: %s', kind, error)
    return null
  }
  tracked.waitHold = jobs.wait(tracked.jobId, WAIT_HOLD_MS, owner)
    // abort 先发生时，wait 返回的 promise 仍会 resolve。
    .catch(() => undefined)
  return tracked
}
