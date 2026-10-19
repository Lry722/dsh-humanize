/**
 * 审查管线。承载插件跨模块共享的运行状态，包括合并锁、审查锁和
 * 每文件串行队列。一次写入触发的审查流程是：加载规范链，计算改动
 * 区段，调用审查，写入暂存。同一文件的审查串行排队，后来的审查在
 * 先前的结束后才开始。
 *
 * @module dsh-humanize/pipeline
 */
import { readFile } from 'node:fs/promises'
import { changedRegion } from './diff.js'
import { loadSpecChain, renderSpecChain } from './specs.js'
import { readStaging, removeStaging, writeStaging } from './staging.js'
import { runReview } from './review.js'
import { renderStaging } from './annotations.js'

/**
 * 建一个审查管线。
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {object} config - 插件配置读取器，实时反映设置页改动。
 * @param {{ info: Function, warn: Function }} log
 * @returns {{
 *   state: { merging: Set<string>, reviewing: Set<string>, reviewQueues: Map<string, Promise<unknown>> },
 *   scheduleReview: (agent: import('@deepseek-ai/dsh-agent').Agent, filePath: string, before: string | undefined, after: string, signal?: AbortSignal) => Promise<{ kind: string, annotations?: number, message?: string }>,
 *   waitForReviews: (filePaths: string[]) => Promise<void>,
 * }}
 */
export function createReviewPipeline(ctx, config, log) {
  const state = {
    /** 正在合并的 agent id。合并期间的写入不再触发审查。 */
    merging: new Set(),
    /** 正在执行 /humanize-review 批次的 agent id。 */
    reviewing: new Set(),
    /** 同一文件的审查按顺序排队。 */
    reviewQueues: new Map(),
  }

  const reviewNow = async (agent, filePath, before, after, signal) => {
    // 排队期间会话可能已开始合并，执行前再挡一次：合并期间的写入不审查。
    if (state.merging.has(agent.id)) return { kind: 'skipped' }
    const chain = await loadSpecChain(filePath)
    if (chain.length === 0) return { kind: 'no-spec' }
    // before 为 undefined 表示新建文件或全量审查，审查全文。否则只
    // 审查本次改动的区段。
    const region = before === undefined ? null : changedRegion(before, after)
    if (before !== undefined && region === null) return { kind: 'unchanged' }
    const existing = await readStaging(filePath)
    // signal 是批次级取消。批次取消后，在途审查调用立即中止。
    const { annotations } = await runReview(ctx, config, agent, filePath, after, region, renderSpecChain(chain), existing, signal)
    // 审查在途期间文件又被改过（热重载后新旧实例并发、绕过包装工具的
    // 写入等），这次结果已过期：按当前内容补一轮复审，复审的改动区段由
    // 快照和当前内容的差异算出，等于把这期间的改动攒在一起审。文件已
    // 被删除时无法复审，直接放弃。
    const current = await readFile(filePath, 'utf8').catch(() => undefined)
    if (current !== after) {
      if (current !== undefined && signal?.aborted !== true) {
        scheduleReview(agent, filePath, after, current, signal)
      }
      return { kind: 'stale' }
    }
    if (annotations.length === 0) {
      await removeStaging(filePath)
      log.info('humanize: %s passed review, staging cleared', filePath)
    } else {
      await writeStaging(filePath, renderStaging(filePath, annotations))
      log.info('humanize: %d annotation(s) staged for %s', annotations.length, filePath)
    }
    return { kind: 'ok', annotations: annotations.length }
  }

  /**
   * 安排一次审查。合并进行中直接跳过。同一文件的审查串行排队，
   * 排队期间批次可能已被取消、会话可能已开始合并，分别由各自的
   * signal 和 reviewNow 执行前的合并锁检查兜底。
   */
  const scheduleReview = (agent, filePath, before, after, signal) => {
    if (state.merging.has(agent.id)) return Promise.resolve({ kind: 'skipped' })
    const previous = state.reviewQueues.get(filePath) ?? Promise.resolve()
    const next = previous.then(() => reviewNow(agent, filePath, before, after, signal)).catch((error) => {
      log.warn('humanize: review failed for %s: %s', filePath, error)
      // 把失败原因返回给批次，供重试和终态说明使用。
      return { kind: 'failed', message: error instanceof Error ? error.message : String(error) }
    })
    state.reviewQueues.set(filePath, next)
    void next.finally(() => {
      if (state.reviewQueues.get(filePath) === next) state.reviewQueues.delete(filePath)
    })
    return next
  }

  /**
   * 等这些文件已排队的审查全部结束。审查完成可能补排复审（审查期间
   * 文件被改），所以循环读到队列空为止。
   * @param {string[]} filePaths
   */
  const waitForReviews = async (filePaths) => {
    for (;;) {
      const pending = filePaths.map((filePath) => state.reviewQueues.get(filePath)).filter((item) => item !== undefined)
      if (pending.length === 0) return
      await Promise.allSettled(pending)
    }
  }

  return {
    state,
    scheduleReview,
    waitForReviews,
  }
}
