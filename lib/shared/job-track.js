/**
 * 后台任务脚手架。审查批次、合并运行和失败告警共用同一套模式。已结算的
 * 任务行保留到用户发起下一个回合。回合开始时，插件再摘除这些任务行。
 *
 * @module dsh-humanize/shared/job-track
 */

/** 手动 /humanize 单次合并的任务类型。 */
export const JOB_KIND_MERGE = 'humanize'
/** 审查批次的任务类型。 */
export const JOB_KIND_REVIEW = 'humanize-review'
/** 循环合并的任务类型。 */
export const JOB_KIND_LOOP = 'humanize-loop'

/**
 * 本插件登记的全部任务类型。服务端按它判断哪些任务行归本插件摘除，
 * 客户端按它筛选要展示的任务行。
 *
 * 两边都做精确匹配。别的插件用了以 humanize 开头的 kind 时，任务行
 * 不会因此被摘掉。
 */
export const JOB_KINDS = Object.freeze([JOB_KIND_MERGE, JOB_KIND_REVIEW, JOB_KIND_LOOP])

const JOB_KIND_SET = new Set(JOB_KINDS)

/** 抑制完成通知的 wait 超时。任务正常会在超时前结算，因此这个值取大一些即可。 */
const WAIT_HOLD_MS = 24 * 60 * 60 * 1000

/** 任务是否已结算。running 和 stopping 都算在途。 */
function isSettled(view) {
  return view.status !== 'running' && view.status !== 'stopping'
}

/**
 * 摘除一个会话名下本插件已结算的全部任务行。
 *
 * 开新任务前和用户发起下一个回合时都会调用。重复摘除是空操作。
 */
export function dropSettled(jobs, owner) {
  // 不管这些任务行是谁结算的，都一并摘除。
  for (const view of jobs.list(owner)) {
    if (!JOB_KIND_SET.has(view.kind)) continue
    if (!isSettled(view)) continue
    try {
      jobs.remove(view.id, owner)
    } catch {
      // 任务行可能已被其他路径摘除。
    }
  }
}

/**
 * 注册回合开始时的任务行摘除。插件加载时调用一次，监听器挂在插件上下文
 * 上，跟着 fiber 一起创建、一起销毁。
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

/** 没有任务行可用时的空操作对象。调用方照常调 settle，只是不产生任务行。 */
function noopTracked() {
  return { jobId: undefined, handle: undefined, settle() {} }
}

/**
 * 注册一个后台任务。任务创建后挂一个 wait，用它抑制完成通知。
 *
 * jobs 服务不可用或 start 失败时，函数返回空操作对象。调用方按正常路径调
 * settle 即可。
 *
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
  if (jobs === undefined) return noopTracked()
  try {
    // 开新任务前顺手摘除旧的已结算任务行。任务列表里同一会话始终只有这条
    // 在途的任务行。
    dropSettled(jobs, owner)
  } catch {
    // 注册表查询失败时继续开新任务。
  }
  const tracked = { jobId: undefined, handle: undefined, settle: undefined }
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
    return noopTracked()
  }
  // jobs 服务在任务结算时会给 owner 发完成通知。
  // 挂一个 wait，让通知排在本插件结算之后。
  // abort 先发生时，wait 返回的 promise 仍会 resolve。
  void jobs.wait(tracked.jobId, WAIT_HOLD_MS, owner).catch(() => undefined)
  return tracked
}
