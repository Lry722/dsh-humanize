/**
 * 审查管线。承载插件跨模块共享的运行状态（合并锁、审查锁、每文件
 * 串行队列），把一次写入触发的审查编排为：查规范链 → 算改动区段 →
 * 调用审查 → 落暂存。同一文件的审查串行排队，后来的审查在先前的
 * 结束后才开始。
 *
 * @module dsh-humanize/pipeline
 */
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
 *   dispose: () => void,
 * }}
 */
export function createReviewPipeline(ctx, config, log) {
  const state = {
    /** 正在合并的 agent id。合并期间的写入不再触发审查。 */
    merging: new Set(),
    /** 正在执行 /humanize-review 批次的 agent id。 */
    reviewing: new Set(),
    /** 每个文件的审查串行队列，键是 filePath，值是 Promise。 */
    reviewQueues: new Map(),
  }
  /** 在途审查调用的中止句柄，插件卸载时统一中止。 */
  const pendingReviews = new Set()

  const reviewNow = async (agent, filePath, before, after, signal) => {
    const chain = await loadSpecChain(filePath)
    if (chain.length === 0) return { kind: 'no-spec' }
    // before 为 undefined 表示新建文件或全量审查，审查全文。否则只
    // 审查本次改动的区段。
    const region = before === undefined ? null : changedRegion(before, after)
    if (before !== undefined && region === null) return { kind: 'unchanged' }
    const existing = await readStaging(filePath)
    // signal 是批次级取消，批次被取消时在途的审查调用立刻中止，不必等
    // 看门狗跑满十分钟超时。
    const { annotations } = await runReview(ctx, config, agent, filePath, after, region, renderSpecChain(chain), existing, pendingReviews, signal)
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
   * 安排一次审查。合并进行中直接跳过；同一文件的审查串行排队，
   * 排队期间批次可能已被取消，由各自的 signal 兜底。
   */
  const scheduleReview = (agent, filePath, before, after, signal) => {
    if (state.merging.has(agent.id)) return Promise.resolve({ kind: 'skipped' })
    const previous = state.reviewQueues.get(filePath) ?? Promise.resolve()
    const next = previous.then(() => reviewNow(agent, filePath, before, after, signal)).catch((error) => {
      log.warn('humanize: review failed for %s: %s', filePath, error)
      // 失败原因带回批次，重试与终态说明都要用。
      return { kind: 'failed', message: error instanceof Error ? error.message : String(error) }
    })
    state.reviewQueues.set(filePath, next)
    void next.finally(() => {
      if (state.reviewQueues.get(filePath) === next) state.reviewQueues.delete(filePath)
    })
    return next
  }

  return {
    state,
    scheduleReview,
    /** 插件卸载时中止全部在途审查调用。 */
    dispose() {
      for (const controller of pendingReviews) controller.abort()
      pendingReviews.clear()
    },
  }
}
