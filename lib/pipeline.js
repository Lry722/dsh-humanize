/**
 * 审查管线。负责同一文件的审查排队、失败重试和合并时的审查丢弃。
 *
 * 同一文件的审查串行执行。每个文件同时只能有一个在途审查和一个
 * 排队位置。连续写入合并进排队位置，队列里始终只有一个待办。
 *
 * 审查失败会重试几次，间隔逐次拉长。写入触发的审查和
 * /humanize-review 批次共用这套重试。
 *
 * 合并开始时，丢弃这个 agent 正在跑的和排队的审查。审查持续失败时在任务列表
 * 告警。
 *
 * @module dsh-humanize/pipeline
 */
import { readFile } from 'node:fs/promises'
import { changedRegion } from './diff.js'
import { clampInt, REVIEW_RETRIES_DEFAULT, REVIEW_RETRIES_MAX, REVIEW_RETRY_DELAY_MS } from './defaults.js'
import { openJob } from './job-track.js'
import { createSpecMatcher, declaresInclude, loadSpecChain, renderSpecChain } from './specs.js'
import { readStaging, removeStaging, writeStaging } from './staging.js'
import { runReview } from './review.js'
import { renderStaging } from './annotations.js'
import { fuseAbortSignal } from './signal.js'

/** 连续失败达到这个次数就告警。配置类错误第一次失败即告警。 */
const FAILURE_ALERT_THRESHOLD = 3

/**
 * 创建一个审查管线。
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {object} config - 插件配置读取器，实时反映设置页改动。
 * @param {{ info: Function, warn: Function }} log
 * @returns {{
 *   state: { merging: Set<string>, reviewing: Set<string>, running: Set<string>, reviewBatchAbort: Map<string, AbortController>, reviewQueues: Map<string, { active: Promise<void> | null, pending: object | null }> },
 *   scheduleReview: (agent: import('@deepseek-ai/dsh-agent').Agent, filePath: string, before: string | undefined, after: string, signal?: AbortSignal) => Promise<{ kind: string, annotations?: number, message?: string }>,
 *   waitForReviews: (filePaths: string[]) => Promise<void>,
 *   discardReviews: (agentId: string) => void,
 *   shutdown: () => Promise<void>,
 * }}
 */
export function createReviewPipeline(ctx, config, log) {
  /** 在途审查的 Promise。插件卸载时排空，等它们跑完。 */
  const active = new Set()
  const state = {
    /** 插件已停止接受新审查。fiber 销毁时把 disposed 设为 true，此后的新调用一律拒绝。 */
    disposed: false,
    /** 正在合并的 agent id。合并期间的写入直接跳过。 */
    merging: new Set(),
    /** 有在途审查批次的 agent id。 */
    reviewing: new Set(),
    /** 正在执行的合并运行（单次或循环）的 agent id，期间拒绝手动派发审查批次。 */
    running: new Set(),
    /** /humanize-review 批次的中止器。用户取消批次或批注合并开始时中止整个批次。 */
    reviewBatchAbort: new Map(),
    /** 同一文件的审查队列保留一个在途审查和一个排队位置。 */
    reviewQueues: new Map(),
    /** 记录在途审查的中止器，合并开始时逐个中止。 */
    reviewAbort: new Map(),
    /** 每个 agent 的审查代次，合并开始时加一，只写当前代次的结果。 */
    reviewGen: new Map(),
    /** 每个 agent 的连续审查失败次数，成功一次就把次数清零。 */
    failureStreaks: new Map(),
    /** 已发过失败告警的 agent id，成功一次后就清零。 */
    failureAlerted: new Set(),
  }

  const isDiscarded = (agentId, gen) => (state.reviewGen.get(agentId) ?? 0) !== gen

  /**
   * @param {{ agent: import('@deepseek-ai/dsh-agent').Agent, before: string | undefined, after: string, signal?: AbortSignal }} slot - 排队位置的审查输入。
   * @param {string} filePath
   * @param {AbortSignal} runSignal - 本次执行的中止信号，批次中止和合并丢弃都汇到它上面。
   * @param {number} gen - 领取该排队位置时所属的审查代次。
   */
  const reviewNow = async (slot, filePath, runSignal, gen) => {
    const agent = slot.agent
    // 排队期间会话可能已开始合并，执行前再挡一次。
    if (state.merging.has(agent.id)) return { kind: 'skipped' }
    if (isDiscarded(agent.id, gen)) return { kind: 'discarded' }
    const chain = await loadSpecChain(filePath)
    if (chain.length === 0) return { kind: 'no-spec' }
    // 规范链声明了 include 时，写入触发的审查只看匹配的文件。没声明
    // include 时，作用于所有文件。
    if (declaresInclude(chain) && !createSpecMatcher(chain)(filePath)) return { kind: 'no-spec' }
    // 没有 before 说明是首次全量审查。
    const region = slot.before === undefined ? null : changedRegion(slot.before, slot.after)
    if (slot.before !== undefined && region === null) return { kind: 'unchanged' }
    const existing = await readStaging(filePath)
    const { annotations } = await runReview(ctx, config, agent, filePath, slot.after, region, renderSpecChain(chain), existing, runSignal)
    // 审查在途期间合并已开始，这次结果已经过期，直接丢弃。
    if (isDiscarded(agent.id, gen)) return { kind: 'discarded' }
    // 审查在途期间文件又被改过，这次结果已经过期。过期来源有两种，
    // 热重载后两个实例同时写入，或者写入绕过了包装工具。
    const current = await readFile(filePath, 'utf8').catch(() => undefined)
    if (current !== slot.after) {
      // 文件还在就按当前内容补排一轮复审，改动区段取快照和当前内容的
      // 差异。
      if (current !== undefined && runSignal?.aborted !== true) {
        scheduleReview(agent, filePath, slot.after, current, slot.signal)
      }
      // 文件已经被删掉，没有内容可以补审。
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

  const noteSuccess = (agentId) => {
    state.failureStreaks.delete(agentId)
    state.failureAlerted.delete(agentId)
  }

  /**
   * 记一次审查失败。配置类错误第一次就告警，其余错误连续失败到阈值才
   * 告警，成功一次后告警状态复位。
   *
   * 告警通过任务列表发出。在途审查的失败等批次结束时统一汇报。
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
  }

  /**
   * 执行排队位置里的审查。失败按 reviewRetries 重试，重试间隔逐次
   * 拉长。批次中止和合并丢弃的信号都会中止当前这次执行。
   */
  const runSlot = async (filePath, slot) => {
    const agentId = slot.agent.id
    const gen = state.reviewGen.get(agentId) ?? 0
    const maxRetries = clampInt(config.reviewRetries, 0, REVIEW_RETRIES_MAX, REVIEW_RETRIES_DEFAULT)
    for (let attempt = 0; ; attempt += 1) {
      // 在途的这次调用照常跑完就结束，下一次尝试留给重载后的新实例。
      if (state.disposed) return { kind: 'discarded' }
      const { controller, dispose } = fuseAbortSignal(slot.signal)
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
        // 批次中止和合并丢弃都走这条路。此时直接返回，失败计数保持原值。
        if (controller.signal.aborted) {
          return { kind: isDiscarded(agentId, gen) ? 'discarded' : 'aborted', message }
        }
        noteFailure(slot.agent, message, error)
        if (attempt >= maxRetries) return { kind: 'failed', message }
        await new Promise((resolve) => { setTimeout(resolve, REVIEW_RETRY_DELAY_MS * (attempt + 1)) })
      } finally {
        abortSet.delete(controller)
        if (abortSet.size === 0) state.reviewAbort.delete(agentId)
        dispose()
      }
    }
  }

  /** 当前没有在途审查、且排队位置里有待办的审查时才启动下一轮。 */
  const pump = (filePath, entry) => {
    if (entry.active !== null || entry.pending === null) return
    const slot = entry.pending
    entry.pending = null
    entry.active = runSlot(filePath, slot)
      // 结果结算给排队位置登记的全部等待方。
      .then((outcome) => {
        for (const resolve of slot.waiters) resolve(outcome)
      })
    // 在途审查登记进 active，插件卸载时等它们排空。
    active.add(entry.active)
    void entry.active.finally(() => {
      active.delete(entry.active)
      entry.active = null
      if (entry.pending !== null) {
        pump(filePath, entry)
      } else if (state.reviewQueues.get(filePath) === entry) {
        state.reviewQueues.delete(filePath)
      }
    })
  }

  /**
   * 安排一次审查。合并进行中时跳过这次审查。同一文件的审查串行执行。
   * 每个文件同时只能有一个在途审查和一个排队位置。排队位置已有
   * 审查时，把新的写入合并进去。
   */
  const scheduleReview = (agent, filePath, before, after, signal) => {
    if (state.disposed) return Promise.resolve({ kind: 'skipped' })
    if (state.merging.has(agent.id)) return Promise.resolve({ kind: 'skipped' })
    let entry = state.reviewQueues.get(filePath)
    if (entry === undefined) {
      entry = { active: null, pending: null }
      state.reviewQueues.set(filePath, entry)
    }
    let resolveResult
    const result = new Promise((resolve) => { resolveResult = resolve })
    if (entry.pending !== null) {
      // before 为 undefined 表示全量审查，任一方要求全量就按全量。
      if (before === undefined) entry.pending.before = undefined
      entry.pending.after = after
      // signal 取最新携带的那个，合并时要保住批次的中止信号。
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
   * 合并开始时把该 agent 在途和排队的审查都丢弃。在途审查中止，
   * 排队位置按丢弃结算，旧代次的结果也一并丢弃。
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
      // 这个队列条目已经没活可干，顺手摘除掉，免得越堆越多。
      if (entry.active === null && state.reviewQueues.get(filePath) === entry) {
        state.reviewQueues.delete(filePath)
      }
    }
  }

  /**
   * 等这些文件已排队的审查全部结束。
   * @param {string[]} filePaths
   */
  const waitForReviews = async (filePaths) => {
    // 审查期间文件可能被改过，审查完成后会补排一轮复审，所以要循环等到底。
    for (;;) {
      // 排队位置只在在途审查收尾时才转成在途。inFlight 为空就说明这些文件的
      // 审查都跑完了。
      const inFlight = filePaths
        .map((filePath) => state.reviewQueues.get(filePath)?.active)
        .filter((item) => item !== null && item !== undefined)
      if (inFlight.length === 0) return
      await Promise.allSettled(inFlight)
    }
  }

  /**
   * 停止接受新审查并排空在途审查。fiber 销毁时由插件入口调用。
   */
  const shutdown = async () => {
    state.disposed = true
    // 在途审查结束后才写暂存，写暂存用的是一般的文件写入，这里等它们跑完。
    // 中止只会浪费已经发出的请求。
    await Promise.allSettled([...active])
  }

  return {
    state,
    scheduleReview,
    waitForReviews,
    discardReviews,
    shutdown,
  }
}
