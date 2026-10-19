/**
 * 审查管线。承载插件跨模块共享的运行状态，包括合并锁、审查锁、审查批次
 * 的中止器和每文件审查队列。一次写入触发的审查流程是：加载规范链，
 * 计算改动区段，调用审查，写入暂存。同一文件的审查串行，一个在途审查
 * 加一个待办槽，连续写入合并进待办槽而不是逐个排队。失败按
 * reviewRetries 重试，间隔逐次递增，写入触发的审查和 /humanize-review
 * 批次共用这套重试。合并触发时丢弃该会话在途和排队的审查。审查持续
 * 失败时在任务列表告警。
 *
 * @module dsh-humanize/pipeline
 */
import { readFile } from 'node:fs/promises'
import { changedRegion } from './diff.js'
import { clampInt, REVIEW_RETRIES_DEFAULT, REVIEW_RETRIES_MAX, REVIEW_RETRY_DELAY_MS } from './defaults.js'
import { closeJob, openJob } from './job-track.js'
import { createSpecMatcher, declaresInclude, loadSpecChain, renderSpecChain } from './specs.js'
import { readStaging, removeStaging, writeStaging } from './staging.js'
import { runReview } from './review.js'
import { renderStaging } from './annotations.js'

/** 连续失败达到这个次数就告警。配置类错误第一次失败即告警。 */
const FAILURE_ALERT_THRESHOLD = 3

/**
 * 建一个审查管线。
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {object} config - 插件配置读取器，实时反映设置页改动。
 * @param {{ info: Function, warn: Function }} log
 * @returns {{
 *   state: { merging: Set<string>, reviewing: Set<string>, reviewBatchAbort: Map<string, AbortController>, reviewQueues: Map<string, { active: Promise<void> | null, pending: object | null }> },
 *   scheduleReview: (agent: import('@deepseek-ai/dsh-agent').Agent, filePath: string, before: string | undefined, after: string, signal?: AbortSignal) => Promise<{ kind: string, annotations?: number, message?: string }>,
 *   waitForReviews: (filePaths: string[]) => Promise<void>,
 *   discardReviews: (agentId: string) => void,
 * }}
 */
export function createReviewPipeline(ctx, config, log) {
  const state = {
    /** 正在合并的 agent id。合并期间的写入不再触发审查。 */
    merging: new Set(),
    /** 正在执行 /humanize-review 批次的 agent id。 */
    reviewing: new Set(),
    /** 每个 agent 进行中的审查批次的中止器，合并触发时中止批次。 */
    reviewBatchAbort: new Map(),
    /** 同一文件的审查队列：一个在途审查，一个待办槽。 */
    reviewQueues: new Map(),
    /** 每个 agent 的在途审查调用的中止器，合并触发时统一中止。 */
    reviewAbort: new Map(),
    /** 每个 agent 的审查代次，合并触发时加一，旧代次的结果不写暂存。 */
    reviewGen: new Map(),
    /** 每个 agent 的连续审查失败次数，成功即清零。 */
    failureStreaks: new Map(),
    /** 已发过失败告警的 agent id，成功一次后复位。 */
    failureAlerted: new Set(),
  }

  const isDiscarded = (agentId, gen) => (state.reviewGen.get(agentId) ?? 0) !== gen

  /**
   * @param {{ agent: import('@deepseek-ai/dsh-agent').Agent, before: string | undefined, after: string, signal?: AbortSignal }} slot - 待办槽的审查输入。
   * @param {AbortSignal} runSignal - 本次执行的中止信号，批次取消和合并丢弃都汇到它上面。
   */
  const reviewNow = async (slot, filePath, runSignal, gen) => {
    const agent = slot.agent
    // 排队期间会话可能已开始合并，执行前再挡一次：合并期间的写入不审查。
    if (state.merging.has(agent.id)) return { kind: 'skipped' }
    // 合并触发后旧代次的审查不再执行。
    if (isDiscarded(agent.id, gen)) return { kind: 'discarded' }
    const chain = await loadSpecChain(filePath)
    if (chain.length === 0) return { kind: 'no-spec' }
    // include 声明是规范链的属性，写入触发的审查同样受它约束。
    // 链里没有任何 include 声明时，规范作用于所有文件。
    if (declaresInclude(chain) && !createSpecMatcher(chain)(filePath)) return { kind: 'no-spec' }
    // before 为 undefined 表示新建文件或全量审查，审查全文。否则只
    // 审查本次改动的区段。
    const region = slot.before === undefined ? null : changedRegion(slot.before, slot.after)
    if (slot.before !== undefined && region === null) return { kind: 'unchanged' }
    const existing = await readStaging(filePath)
    const { annotations } = await runReview(ctx, config, agent, filePath, slot.after, region, renderSpecChain(chain), existing, runSignal)
    // 审查在途期间合并已触发：结果过期，不写暂存也不补复审。
    if (isDiscarded(agent.id, gen)) return { kind: 'discarded' }
    // 审查在途期间文件又被改过（热重载后新旧实例并发、绕过包装工具的
    // 写入等），这次结果已过期：按当前内容补一轮复审，复审的改动区段由
    // 快照和当前内容的差异算出，等于把这期间的改动攒在一起审。文件已
    // 被删除时无法复审，直接放弃。
    const current = await readFile(filePath, 'utf8').catch(() => undefined)
    if (current !== slot.after) {
      if (current !== undefined && runSignal?.aborted !== true) {
        scheduleReview(agent, filePath, slot.after, current, slot.signal)
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

  /** 审查成功一次，连续失败计数和告警状态复位。 */
  const noteSuccess = (agentId) => {
    state.failureStreaks.delete(agentId)
    state.failureAlerted.delete(agentId)
  }

  /**
   * 记一次审查失败。配置类错误第一次就告警，其余错误连续失败到阈值才
   * 告警，成功一次后告警状态复位。告警走任务列表，不写会话。批次进行
   * 中的失败由批次终态统一汇报，不重复告警。
   */
  const noteFailure = (agent, message, error) => {
    const agentId = agent.id
    const streak = (state.failureStreaks.get(agentId) ?? 0) + 1
    state.failureStreaks.set(agentId, streak)
    if (state.reviewing.has(agentId)) return
    if (state.failureAlerted.has(agentId)) return
    const configError = error?.humanizeConfigError === true
    if (!configError && streak < FAILURE_ALERT_THRESHOLD) return
    state.failureAlerted.add(agentId)
    const tracked = openJob(ctx, log, {
      jobs: ctx.get('jobs'),
      kind: 'humanize-review',
      label: '行文审查',
      owner: agent.session.id,
      cancel() {},
    })
    if (tracked === null) return
    tracked.settle({
      status: 'failed',
      detail: configError
        ? `审查失败：${message}。请到设置页检查审查模型的配置。`
        : `审查连续失败 ${streak} 次，可能是审查模型的配置有问题。最近一次失败：${message}`,
    })
    closeJob(ctx, tracked)
  }

  /**
   * 执行待办槽里的审查。失败按 reviewRetries 重试，间隔逐次递增。
   * 批次中止信号和合并触发的丢弃信号都汇到每次执行的 controller 上。
   */
  const runSlot = async (filePath, slot) => {
    const agentId = slot.agent.id
    const gen = state.reviewGen.get(agentId) ?? 0
    const maxRetries = clampInt(config.reviewRetries, 0, REVIEW_RETRIES_MAX, REVIEW_RETRIES_DEFAULT)
    for (let attempt = 0; ; attempt += 1) {
      const controller = new AbortController()
      const batchSignal = slot.signal
      const onBatchAbort = () => controller.abort(batchSignal.reason)
      const listening = batchSignal !== undefined && !batchSignal.aborted
      if (batchSignal !== undefined) {
        if (batchSignal.aborted) controller.abort(batchSignal.reason)
        else batchSignal.addEventListener('abort', onBatchAbort, { once: true })
      }
      let abortSet = state.reviewAbort.get(agentId)
      if (abortSet === undefined) {
        abortSet = new Set()
        state.reviewAbort.set(agentId, abortSet)
      }
      abortSet.add(controller)
      try {
        const outcome = await reviewNow(slot, filePath, controller.signal, gen)
        if (outcome.kind !== 'discarded') noteSuccess(agentId)
        return outcome
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        log.warn('humanize: review failed for %s: %s', filePath, message)
        // 批次取消和合并丢弃不算失败，不重试也不计连续失败。
        if (controller.signal.aborted) {
          return { kind: isDiscarded(agentId, gen) ? 'discarded' : 'aborted', message }
        }
        noteFailure(slot.agent, message, error)
        if (attempt >= maxRetries) return { kind: 'failed', message }
        await new Promise((resolve) => { setTimeout(resolve, REVIEW_RETRY_DELAY_MS * (attempt + 1)) })
      } finally {
        abortSet.delete(controller)
        if (abortSet.size === 0) state.reviewAbort.delete(agentId)
        if (listening) batchSignal.removeEventListener('abort', onBatchAbort)
      }
    }
  }

  /**
   * 推进一个文件的审查队列。在途审查结束且待办槽非空时开跑下一次，
   * 结果结算给待办槽登记的全部等待方。队列清空时摘除条目。
   */
  const pump = (filePath, entry) => {
    if (entry.active !== null || entry.pending === null) return
    const slot = entry.pending
    entry.pending = null
    entry.active = runSlot(filePath, slot)
      .then((outcome) => {
        for (const resolve of slot.waiters) resolve(outcome)
      })
    void entry.active.finally(() => {
      entry.active = null
      if (entry.pending !== null) {
        pump(filePath, entry)
      } else if (state.reviewQueues.get(filePath) === entry) {
        state.reviewQueues.delete(filePath)
      }
    })
  }

  /**
   * 安排一次审查。合并进行中直接跳过。同一文件的审查串行：一个在途，
   * 一个待办槽。待办槽已有审查时不再追加排队，新写入合并进待办槽，
   * 中间稿的审查被省掉。排队期间批次可能已被取消、会话可能已开始
   * 合并，分别由 signal 和 reviewNow 执行前的合并锁检查兜底。
   */
  const scheduleReview = (agent, filePath, before, after, signal) => {
    if (state.merging.has(agent.id)) return Promise.resolve({ kind: 'skipped' })
    let entry = state.reviewQueues.get(filePath)
    if (entry === undefined) {
      entry = { active: null, pending: null }
      state.reviewQueues.set(filePath, entry)
    }
    let resolveResult
    const result = new Promise((resolve) => { resolveResult = resolve })
    if (entry.pending !== null) {
      // 合并进待办槽。before 为 undefined 表示全量审查，任一方要求
      // 全量就按全量。after 用最新写入的内容。signal 取最新携带的，
      // 批次的中止信号不能因为合并丢失。
      if (before === undefined) entry.pending.before = undefined
      entry.pending.after = after
      if (signal !== undefined) entry.pending.signal = signal
      entry.pending.agent = agent
      entry.pending.waiters.push(resolveResult)
    } else {
      entry.pending = { agent, before, after, signal, waiters: [resolveResult] }
    }
    pump(filePath, entry)
    return result
  }

  /**
   * 丢弃一个会话在途和排队的全部审查。合并触发时调用：合并一开始，
   * 进行中的审查结果都会过期。在途调用中止，排队项以 discarded 结算，
   * 代次加一，旧代次已完成调用但还没写暂存的结果也不写。
   * @param {string} agentId
   */
  const discardReviews = (agentId) => {
    state.reviewGen.set(agentId, (state.reviewGen.get(agentId) ?? 0) + 1)
    for (const controller of state.reviewAbort.get(agentId) ?? []) {
      controller.abort('merge started')
    }
    for (const [filePath, entry] of state.reviewQueues) {
      if (entry.pending === null || entry.pending.agent.id !== agentId) continue
      for (const resolve of entry.pending.waiters) resolve({ kind: 'discarded' })
      entry.pending = null
      // 不变式是待办槽必有在途审查相伴，兜底清掉意外落单的条目。
      if (entry.active === null && state.reviewQueues.get(filePath) === entry) {
        state.reviewQueues.delete(filePath)
      }
    }
  }

  /**
   * 等这些文件已排队的审查全部结束。审查完成可能补排复审（审查期间
   * 文件被改），所以循环读到队列空为止。待办槽只在在途审查的收尾里
   * 转成在途，读到时没有 active 就没有未完成的审查。
   * @param {string[]} filePaths
   */
  const waitForReviews = async (filePaths) => {
    for (;;) {
      const inFlight = filePaths
        .map((filePath) => state.reviewQueues.get(filePath)?.active)
        .filter((item) => item !== null && item !== undefined)
      if (inFlight.length === 0) return
      await Promise.allSettled(inFlight)
    }
  }

  return {
    state,
    scheduleReview,
    waitForReviews,
    discardReviews,
  }
}
