/**
 * 审查管线。负责同一文件的审查排队、两次审查之间的间隔、失败重试和
 * 合并时的审查丢弃。
 *
 * 同一文件的审查串行执行。连续写入合并进排队位置，排队位置里始终只有
 * 一个待处理的审查。
 *
 * 每次审查结束后开始倒计时，倒计时内到达的写入留在待办里，计时结束后
 * 合并成一次审查。倒计时的长度可以配置，默认一分钟。
 *
 * 审查失败会重试几次，间隔逐次拉长。写入触发的审查和
 * /humanize-review 批次共用这套重试。
 *
 * 合并开始时，丢弃这个 agent 在途的和排队的审查。审查持续失败时在任务列表
 * 告警。
 *
 * 二进制文件跳过审查，写入触发的审查和 /humanize-review 批次都按这条规则执行。
 *
 * @module dsh-humanize/review/pipeline
 */
import { readFile } from 'node:fs/promises'
import { isBinaryFile } from './binary-file.js'
import { changedRegions } from './diff.js'
import {
  clampInt,
  clampNumber,
  REVIEW_CONCURRENCY_DEFAULT,
  REVIEW_INTERVAL_SECONDS_DEFAULT,
  REVIEW_INTERVAL_SECONDS_MAX,
  REVIEW_RETRIES_DEFAULT,
  REVIEW_RETRIES_MAX,
  REVIEW_RETRY_DELAY_MS,
} from '../shared/defaults.js'
import { JOB_KIND_REVIEW, openJob } from '../shared/job-track.js'
import { buildSpecRules, resolveSpec } from '../spec/chain.js'
import { readStaging, removeStaging, writeStaging } from '../shared/staging.js'
import { runReview } from './call.js'
import { renderStaging } from './annotations.js'
import { createSemaphore } from '../shared/semaphore.js'
import { fuseAbortSignal } from '../shared/signal.js'

/** 连续失败达到这个次数就告警。配置类错误在第一次失败时就告警。 */
const FAILURE_ALERT_THRESHOLD = 3
/** 插件卸载时等审查任务处理完的最长时间。超时后继续卸载，好让进程能够退出。 */
const SHUTDOWN_DRAIN_MS = 3000

/**
 * 插件共享状态。合并、审查批次和审查管线共用这一份。
 * @typedef {object} PluginState
 * @property {boolean} disposed - 插件已停止接受新审查。
 * @property {Set<string>} merging - 正在合并的 agent id。
 * @property {Set<string>} reviewing - 有在途审查批次的 agent id。
 * @property {Set<string>} running - 正在执行合并运行的 agent id。
 * @property {Map<string, AbortController>} reviewBatchAbort - 审查批次的中止器。
 * @property {Map<string, { active: Promise<unknown> | null, activeAgent: string | null, pending: Map<string, object>, cooldownTimer: ReturnType<typeof setTimeout> | null }>} reviewQueues - 同一文件的审查队列。待办按 agent 分开，避免不同 agent 的写入互相覆盖。cooldownTimer 是审查结束后的倒计时。
 * @property {null | { agentId: string, target: string | null, files: Set<string> }} mergeRun - 全局合并锁。一次只允许一个合并运行，锁里的文件路径用于挡住并发的审查。
 * @property {Map<string, Set<AbortController>>} reviewAbort - 在途审查的中止器。
 * @property {Map<string, number>} reviewGen - 每个 agent 的审查代次。
 * @property {Map<string, number>} failureStreaks - 每个 agent 的连续失败次数。
 * @property {Set<string>} failureAlerted - 已发过失败告警的 agent id。
 */

/**
 * 创建一个审查管线。
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {object} config - 插件配置读取器，实时反映设置页改动。
 * @param {{ info: Function, warn: Function }} log
 * @returns {{
 *   state: PluginState,
 *   scheduleReview: (agent: import('@deepseek-ai/dsh-agent').Agent, filePath: string, before: string | undefined, after: string, signal?: AbortSignal) => Promise<{ kind: string, annotations?: number, message?: string }>,
 *   scheduleWriteReview: (agent: import('@deepseek-ai/dsh-agent').Agent, filePath: string, before: string | undefined, after: string, signal?: AbortSignal) => Promise<{ kind: string, annotations?: number, message?: string }>,
 *   waitForReviews: (filePaths: string[]) => Promise<void>,
 *   discardReviews: (agentId: string) => void,
 *   shutdown: () => Promise<void>,
 * }}
 */
export function createReviewPipeline(ctx, config, log) {
  /** 在途审查的 Promise。插件卸载时排空，等它们跑完。 */
  const active = new Set()
  const state = {
    /** 插件销毁后拒绝新的审查调用。 */
    disposed: false,
    /** 合并期间的写入直接跳过。 */
    merging: new Set(),
    /** 有在途审查批次的 agent id。 */
    reviewing: new Set(),
    /** 正在执行的合并运行的 agent id，期间拒绝手动派发审查批次。 */
    running: new Set(),
    /** /humanize-review 批次的中止器。用户取消批次或批注合并开始时中止整个批次。 */
    reviewBatchAbort: new Map(),
    /** 同一文件的审查队列保留一个在途审查，待办按 agent 分开。 */
    reviewQueues: new Map(),
    /** 全局合并锁，跨会话和 agent 生效。 */
    mergeRun: null,
    /** 记录在途审查的中止器，合并开始时逐个中止。 */
    reviewAbort: new Map(),
    /** 每个 agent 的审查代次，合并开始时加一，只写当前代次的结果。 */
    reviewGen: new Map(),
    /** 每个 agent 的连续审查失败次数，成功一次就把次数清零。 */
    failureStreaks: new Map(),
    /** 已发过失败告警的 agent id，成功一次后就清零。 */
    failureAlerted: new Set(),
  }

  // 所有审查调用共用同一个并发上限。设置页改完立即生效。
  const reviewSlots = createSemaphore(() => clampInt(
    config.reviewConcurrency,
    1,
    undefined,
    REVIEW_CONCURRENCY_DEFAULT,
  ))

  const isDiscarded = (agentId, gen) => (state.reviewGen.get(agentId) ?? 0) !== gen
  /** 这个文件是否正被合并运行修改。 */
  const mergeOwnsFile = (filePath) => state.mergeRun?.files.has(filePath) === true
  /** 取消审查结束后的倒计时。 */
  const clearCooldown = (entry) => {
    if (entry.cooldownTimer === null) return
    clearTimeout(entry.cooldownTimer)
    entry.cooldownTimer = null
  }

  /** 排队位置已经空闲、且仍在表里时把它摘掉。 */
  const dropQueueIfIdle = (filePath, entry) => {
    if (entry.active !== null) return
    if (entry.pending.size > 0) return
    if (state.reviewQueues.get(filePath) !== entry) return
    state.reviewQueues.delete(filePath)
  }

  /** 把排队位置里的全部待办按同一个结果结算，并清空待办。 */
  const settlePending = (entry, outcome) => {
    for (const slot of entry.pending.values()) {
      for (const resolve of slot.waiters) resolve(outcome)
    }
    entry.pending.clear()
  }

  /**
   * @param {{ agent: import('@deepseek-ai/dsh-agent').Agent, before: string | undefined, after: string, signal?: AbortSignal, writeTriggered: boolean }} slot - 排队位置的审查输入。writeTriggered 表示这次审查由写入触发。
   * @param {string} filePath
   * @param {AbortSignal} runSignal - 本次执行的中止信号，批次中止和合并丢弃都汇到它上面。
   * @param {number} gen - 领取该排队位置时所属的审查代次。
   */
  const reviewNow = async (slot, filePath, runSignal, gen) => {
    const agent = slot.agent
    // 排队期间会话可能已开始合并，执行前再检查一次，命中就跳过。
    if (state.merging.has(agent.id) || mergeOwnsFile(filePath)) return { kind: 'skipped' }
    if (isDiscarded(agent.id, gen)) return { kind: 'discarded' }
    // 二进制文件没有行文内容，规范加载和模型调用都跳过。
    if (await isBinaryFile(filePath)) return { kind: 'binary' }
    const { chain, review } = await resolveSpec(filePath, slot.agent.session.header.cwd)
    if (!review || chain.length === 0) return { kind: 'no-spec' }
    // before 为空时按首次全量审查处理。
    const regions = slot.before === undefined ? null : changedRegions(slot.before, slot.after)
    if (slot.before !== undefined && regions === null) return { kind: 'unchanged' }
    const spec = buildSpecRules(chain)
    if (spec.rules.length === 0) return { kind: 'no-spec' }
    const existing = await readStaging(filePath)
    const { annotations, dropped } = await runReview(ctx, config, agent, filePath, slot.after, regions, spec, existing, runSignal)
    // 审查在途期间合并已开始，这次结果已经过期，直接丢弃。
    if (isDiscarded(agent.id, gen)) return { kind: 'discarded' }
    // 审查在途期间文件又被改过，这次结果已经过期。过期来源有两种。
    // 热重载后两个实例会同时写入，或者写入绕过了包装工具。
    const current = await readFile(filePath, 'utf8').catch(() => undefined)
    // 合并可能在这段 await 期间开始。写入暂存文件或删除暂存文件之前再确认一次。
    // 免得把合并前的内容覆盖到合并后的暂存上。
    if (state.merging.has(agent.id) || mergeOwnsFile(filePath) || isDiscarded(agent.id, gen)) {
      return { kind: 'discarded' }
    }
    if (current !== slot.after) {
      // 文件还在就按当前内容补排一轮审查，改动区段取快照和当前内容的
      // 差异。
      if (current !== undefined && runSignal?.aborted !== true) {
        const pending = state.reviewQueues.get(filePath)?.pending.get(agent.id)
        if (slot.writeTriggered === true && pending?.writeTriggered === true) {
          // 写入触发的审查已经在排队，等间隔结束后会按最新内容执行，
          // 这里只更新它的内容快照。
          pending.after = current
        } else {
          scheduleReview(agent, filePath, slot.after, current, slot.signal)
        }
      }
      // 文件已经被删掉，没有内容可以补审。
      return { kind: 'stale' }
    }
    // 批注引用的规则编号全部无法匹配时，按失败处理，保留暂存后重试。
    if (annotations.length === 0 && dropped > 0) {
      throw new Error(`review output cited ${dropped} unknown rule number(s)`)
    }
    if (dropped > 0) {
      log.warn('humanize: dropped %d annotation(s) for %s that cited unknown rule numbers', dropped, filePath)
    }
    if (annotations.length === 0) {
      await removeStaging(filePath, 'review-clear')
      log.info('humanize: %s passed review, staging cleared', filePath)
    } else {
      await writeStaging(filePath, renderStaging(annotations))
      log.info('humanize: %d annotation(s) staged for %s', annotations.length, filePath)
    }
    return { kind: 'ok', annotations: annotations.length }
  }

  const noteSuccess = (agentId) => {
    state.failureStreaks.delete(agentId)
    state.failureAlerted.delete(agentId)
  }

  /**
   * 记一次审查失败。配置类错误和规范结构错误第一次就告警，其余错误
   * 连续失败到阈值才告警，成功一次后告警状态清零。
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
    const specError = error?.humanizeSpecError === true
    if (!configError && !specError && streak < FAILURE_ALERT_THRESHOLD) return
    state.failureAlerted.add(agentId)
    const tracked = openJob(ctx, log, {
      jobs: ctx.get('jobs'),
      kind: JOB_KIND_REVIEW,
      label: '行文审查',
      owner: agent.session.id,
      cancel() {},
    })
    tracked.settle({
      status: 'failed',
      detail: specError
        ? `审查失败：${message}`
        : configError
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
      // 重试等待期间合并可能已经开始，本次结果同样按丢弃处理。
      if (state.disposed || isDiscarded(agentId, gen)) return { kind: 'discarded' }
      const { controller, dispose } = fuseAbortSignal(slot.signal)
      // 记录这次审查对应的文件，合并按目标文件中止在途审查时要用。
      controller.humanizeFilePath = filePath
      let abortSet = state.reviewAbort.get(agentId)
      if (abortSet === undefined) {
        abortSet = new Set()
        state.reviewAbort.set(agentId, abortSet)
      }
      abortSet.add(controller)
      let release
      try {
        // 所有审查调用共用这个并发上限。等待期间被中止时，acquire 会直接
        // 拒绝，走下面的取消分支。
        release = await reviewSlots.acquire(controller.signal)
        // 等待期间插件可能已经卸载，或者这批结果已经过期。
        if (state.disposed || isDiscarded(agentId, gen)) return { kind: 'discarded' }
        // 拿到空位之后、发起调用之前也可能被中止。
        if (controller.signal.aborted) {
          return { kind: isDiscarded(agentId, gen) ? 'discarded' : 'aborted', message: 'review aborted before dispatch' }
        }
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
        // 配置类错误和规范结构错误直接告警，跳过重试环节。
        if (error?.humanizeConfigError === true || error?.humanizeSpecError === true) {
          noteFailure(slot.agent, message, error)
          return { kind: 'failed', message }
        }
        // 重试耗尽的最终失败才计入连续失败次数。一次审查重试多次，中间的
        // 失败都计数就会把告警阈值一次推满。
        if (attempt >= maxRetries) {
          noteFailure(slot.agent, message, error)
          return { kind: 'failed', message }
        }
        await new Promise((resolve) => { setTimeout(resolve, REVIEW_RETRY_DELAY_MS * (attempt + 1)) })
      } finally {
        release?.()
        abortSet.delete(controller)
        if (abortSet.size === 0) state.reviewAbort.delete(agentId)
        dispose()
      }
    }
  }

  /**
   * 把排队位置里的审查提上来执行。一次只执行一个。执行完再检查排队位置
   * 里有没有新到的审查。
   */
  const pump = (filePath, entry) => {
    // 上次审查结束后的间隔还没到，先不领取排队位置。
    if (entry.cooldownTimer !== null) return
    if (entry.active !== null || entry.pending.size === 0) return
    const [agentId, slot] = entry.pending.entries().next().value
    entry.pending.delete(agentId)
    // 记下这条在途审查属于谁，合并按文件中止时要按 agent 找中止器。
    entry.activeAgent = agentId
    entry.active = runSlot(filePath, slot).then(
      (outcome) => {
        // 结果结算给排队位置登记的全部等待方。
        for (const resolve of slot.waiters) resolve(outcome)
        return outcome
      },
      (error) => {
        // runSlot 内部的 try 之前抛错时走不到它自己的失败分支，这里兜住，
        // 保证每个等待方都能拿到结果，也不留下未处理的拒绝。
        const message = error instanceof Error ? error.message : String(error)
        const outcome = { kind: 'failed', message }
        for (const resolve of slot.waiters) resolve(outcome)
        log.warn('humanize: review failed for %s: %s', filePath, message)
        return outcome
      },
    )
    // 在途审查登记到 active，插件卸载时按这份集合排空。
    active.add(entry.active)
    // 审查本身按结果结算，这里只兜住 finally 链自己的拒绝，避免未处理拒绝。
    void entry.active.finally(() => {
      active.delete(entry.active)
      entry.active = null
      entry.activeAgent = null
      // 审查结束后开始倒计时。卸载期间不再安排新的计时器。
      if (!state.disposed) {
        armCooldown(filePath, entry)
        // 批次审查、合并复审这类立即审查不受倒计时限制。
        if (hasImmediatePending(entry)) clearCooldown(entry)
      }
      if (entry.pending.size > 0) {
        pump(filePath, entry)
      } else if (entry.cooldownTimer === null) {
        dropQueueIfIdle(filePath, entry)
      }
    }).catch(() => {})
  }

  /** 按设置里的秒数安排下一次审查的倒计时。 */
  const armCooldown = (filePath, entry) => {
    clearCooldown(entry)
    const seconds = clampNumber(
      config.reviewIntervalSeconds,
      0,
      REVIEW_INTERVAL_SECONDS_MAX,
      REVIEW_INTERVAL_SECONDS_DEFAULT,
    )
    const delayMs = Math.round(seconds * 1000)
    // 0 秒表示不等待。
    if (delayMs <= 0) return
    entry.cooldownTimer = setTimeout(() => {
      entry.cooldownTimer = null
      pump(filePath, entry)
      // 计时结束时没有待办，就把这个排队位置摘掉。
      dropQueueIfIdle(filePath, entry)
    }, delayMs)
  }

  /** 排队位置里是否有批次审查或合并复审这类立即审查。 */
  const hasImmediatePending = (entry) => {
    for (const slot of entry.pending.values()) {
      if (slot.writeTriggered !== true) return true
    }
    return false
  }

  /**
   * 把审查放进排队位置。writeTriggered 为 true 时按写入触发的审查处理，
   * 要等上一次审查结束后的间隔到期；否则立即执行。
   */
  const enqueueReview = (agent, filePath, before, after, signal, writeTriggered) => {
    if (state.disposed) return Promise.resolve({ kind: 'skipped' })
    if (state.merging.has(agent.id) || mergeOwnsFile(filePath)) return Promise.resolve({ kind: 'skipped' })
    let entry = state.reviewQueues.get(filePath)
    if (entry === undefined) {
      entry = { active: null, activeAgent: null, pending: new Map(), cooldownTimer: null }
      state.reviewQueues.set(filePath, entry)
    }
    let resolveResult
    const result = new Promise((resolve) => { resolveResult = resolve })
    const pending = entry.pending.get(agent.id)
    if (pending !== undefined) {
      // before 为 undefined 表示全量审查，任一方要求全量就按全量。
      if (before === undefined) pending.before = undefined
      pending.after = after
      // signal 用最近一次传进来的信号，保证合并后这批审查还带着调用方的中止信号。
      if (signal !== undefined) pending.signal = signal
      pending.waiters.push(resolveResult)
      // 立即审查并进写入审查时按立即审查处理。
      pending.writeTriggered = pending.writeTriggered === true && writeTriggered
    } else {
      entry.pending.set(agent.id, { agent, before, after, signal, waiters: [resolveResult], writeTriggered })
    }
    // 批次审查、合并复审和手动复审不等待倒计时。
    if (!writeTriggered) clearCooldown(entry)
    pump(filePath, entry)
    return result
  }

  /**
   * 安排一次立即执行的审查。合并进行中时跳过这次审查。同一文件的审查
   * 串行执行。排队位置已有审查时，把新的内容合并进去。
   */
  const scheduleReview = (agent, filePath, before, after, signal) => (
    enqueueReview(agent, filePath, before, after, signal, false)
  )

  /**
   * 安排一次写入触发的审查。上一次审查结束后的间隔内先积累，间隔到期
   * 后执行。
   */
  const scheduleWriteReview = (agent, filePath, before, after, signal) => (
    enqueueReview(agent, filePath, before, after, signal, true)
  )

  /**
   * 合并开始时丢弃审查。给了 filePaths 时，连别的 agent 在这些文件上的
   * 在途和排队审查一并丢弃。不给时只处理 agentId 自己的审查。
   * @param {string} agentId
   * @param {string[]} [filePaths]
   */
  const discardReviews = (agentId, filePaths) => {
    const targets = filePaths === undefined ? null : new Set(filePaths)
    state.reviewGen.set(agentId, (state.reviewGen.get(agentId) ?? 0) + 1)
    for (const controller of state.reviewAbort.get(agentId) ?? []) {
      controller.abort('merge started')
    }
    for (const [filePath, entry] of state.reviewQueues) {
      const isTarget = targets?.has(filePath) === true
      // 合并目标上的待办全部丢弃，其余文件只丢弃这个 agent 自己的待办。
      if (isTarget) {
        settlePending(entry, { kind: 'discarded' })
      } else {
        const slot = entry.pending.get(agentId)
        if (slot !== undefined) {
          for (const resolve of slot.waiters) resolve({ kind: 'discarded' })
          entry.pending.delete(agentId)
        }
      }
      // 合并目标上的在途审查来自别的 agent 时，按文件精确中止。
      if (isTarget && entry.activeAgent !== null) {
        for (const controller of state.reviewAbort.get(entry.activeAgent) ?? []) {
          if (controller.humanizeFilePath === filePath) controller.abort('merge started')
        }
      }
      // 排队位置已经清空时，把审查结束后的倒计时一并取消。
      if (entry.pending.size === 0) clearCooldown(entry)
      // 这个排队位置已经没活可干，顺手摘除掉，免得越堆越多。
      dropQueueIfIdle(filePath, entry)
    }
  }

  /**
   * 等这些文件已排队的审查全部结束。
   * @param {string[]} filePaths
   */
  const waitForReviews = async (filePaths) => {
    // 审查期间文件可能被改过，审查完成后会补排一轮审查，所以要循环等到底。
    for (;;) {
      // 排队位置里的审查要等前一条收尾后才提上来，所以每一轮都重新取一次在途审查。
      const activeReviews = filePaths
        .map((filePath) => state.reviewQueues.get(filePath)?.active)
        .filter((item) => item !== null && item !== undefined)
      if (activeReviews.length === 0) return
      await Promise.allSettled(activeReviews)
    }
  }

  /**
   * 停止接受新审查并排空在途审查。fiber 销毁时由插件入口调用。插件卸载
   * 时让在途审查按设计跑完。
   *
   * 排空有时间上限。在途审查可能正在等一个不会回来的模型响应。插件卸载
   * 卡在这里会让整个进程无法重启，所以超时后不再等待，卸载照常继续。
   */
  const shutdown = async () => {
    state.disposed = true
    // 倒计时里的审查还没开始，直接按丢弃结算，并取消计时器，免得
    // 卸载后计时器还挂着。
    for (const [filePath, entry] of state.reviewQueues) {
      if (entry.cooldownTimer === null) continue
      clearCooldown(entry)
      settlePending(entry, { kind: 'discarded' })
      dropQueueIfIdle(filePath, entry)
    }
    // 这里等这些在途审查跑完，它们结束后才会写暂存，用的是普通的文件写入。
    // 这里不中止在途审查，中止只会白白浪费已经发出的请求。
    const drained = Promise.allSettled([...active])
    let timer
    // 超时后直接返回，其余在途审查自己跑完。
    const deadline = new Promise((resolve) => {
      timer = setTimeout(resolve, SHUTDOWN_DRAIN_MS)
      // 别让这个计时器自己拖住进程退出。
      if (typeof timer.unref === 'function') timer.unref()
    })
    try {
      await Promise.race([drained, deadline])
    } finally {
      clearTimeout(timer)
    }
  }

  return {
    state,
    scheduleReview,
    scheduleWriteReview,
    waitForReviews,
    discardReviews,
    shutdown,
  }
}
