/**
 * 延迟合并。行文批注先暂存到文件里，称为暂存批注。
 *
 * 合并有三个触发时机。用户输入 /humanize 命令时按命令指定的范围
 * 合并。用户输入 /humanize-loop 命令时循环执行合并和复审，直到收敛。
 * 上下文压缩结束时按会话工作目录合并暂存批注。
 *
 * 合并派发给子代理执行，结果回到暂存批注。
 *
 * 合并收尾后再对被合并的文件逐个复审，合并引入的新违规会作为新
 * 批注回到暂存。
 *
 * 合并运行的状态全部留在内存。插件重载会结束这次运行，暂存批注
 * 原样保留，需要时重新执行命令即可。
 *
 * @module dsh-humanize/merge
 */
import { readFile } from 'node:fs/promises'
import { boundContextSummary, createUserMessage } from '@deepseek-ai/dsh-llm'
import { countAnnotations } from './annotations.js'
import { resolveCommandTarget } from './command.js'
import { LOOP_ROUNDS_DEFAULT, LOOP_ROUNDS_MAX } from './defaults.js'
import { openJob } from './job-track.js'
import { mergeAgentOptions } from './model.js'
import { loadPrompt } from './prompts.js'
import { loadSpecChain, renderSpecChain } from './specs.js'
import { collectStaged, readStaging, removeMergeRequest, removeStaging, writeMergeRequest } from './staging.js'

/**
 * 合并子代理使用的提供方。子代理从空上下文起步，只带本次合并需要的
 * 内容，省得把整段对话历史重新读一遍。
 */
const MERGE_PROVIDER = 'spawn'

/** 合并子代理的 preset id，声明在本包 cordis.patch.yml 的 preset-humanize-merge 行。 */
const MERGE_PRESET = 'humanize-merge'

/** 合并运行的互斥说明。锁跨 agent 和会话生效。 */
const MERGE_BUSY = '已有批注合并运行在进行，等它结束后再派发。'

/**
 * 取得全局合并锁。锁按插件实例生效，不区分 agent，避免两个会话同时
 * 修改同一批暂存和文件。
 * @param {ReturnType<import('./pipeline.js').createReviewPipeline>['state']} state
 * @param {import('@deepseek-ai/dsh-agent').Agent} agent
 * @param {string | null} target
 * @param {Array<{ filePath: string }>} [staged]
 * @returns {boolean}
 */
function acquireMergeRun(state, agent, target, staged = []) {
  if (state.mergeRun !== null && state.mergeRun !== undefined) return false
  state.mergeRun = {
    agentId: agent.id,
    target,
    files: new Set(staged.map((item) => item.filePath)),
  }
  return true
}

/** 释放自己持有的合并锁。其他运行持有时不动。 */
function releaseMergeRun(state, agentId) {
  if (state.mergeRun?.agentId === agentId) state.mergeRun = null
}

/** 把本轮要改的文件加入合并锁，让这些文件上的并发审查让路。 */
function addMergeFiles(state, agentId, staged) {
  if (state.mergeRun?.agentId !== agentId) return
  for (const item of staged) state.mergeRun.files.add(item.filePath)
}

/** 合并子代理结束后放开文件。复审要在这之后才能安排。 */
function clearMergeFiles(state, agentId) {
  if (state.mergeRun?.agentId === agentId) state.mergeRun.files.clear()
}

/**
 * 一个 agent 是不是合并子代理。会话头里的 preset 是持久字段，插件
 * 重载之后仍然读得到。
 * @param {import('@deepseek-ai/dsh-agent').Agent} agent
 * @returns {boolean}
 */
export function isMergeAgent(agent) {
  return agent.session.header.agentPreset === MERGE_PRESET
}

/**
 * 这个会话有没有还活着的合并子代理。插件重载后内存里的合并锁已经
 * 丢了，派发前靠这个检查让路。
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {import('@deepseek-ai/dsh-agent').Agent} agent
 * @returns {boolean}
 */
function hasLiveMergeChild(ctx, agent) {
  return ctx.agents.list().some((candidate) => candidate.session.header.parentSession === agent.session.id
    && isMergeAgent(candidate))
}

/**
 * 注册 /humanize、/humanize-loop 命令和 compaction/end 触发。
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {{ info: Function, warn: Function }} log
 * @param {{ mergeOnCompaction: boolean, loopMaxRounds?: number }} config
 * @param {ReturnType<import('./pipeline.js').createReviewPipeline>['state']} state - 插件共享状态。
 * @param {(agent: import('@deepseek-ai/dsh-agent').Agent, filePath: string, before: string | undefined, after: string) => Promise<unknown>} scheduleReview - 合并收尾后，安排复审这次合并涉及的文件。
 * @param {(filePaths: string[]) => Promise<void>} waitForReviews - 合并运行时，等待复审完成。
 * @param {(agentId: string, filePaths?: string[]) => void} discardReviews - 合并派发时，丢弃正在执行和排队中的复审。
 */
export function registerMerge(ctx, log, config, state, scheduleReview, waitForReviews, discardReviews) {
  /** 正在收集暂存、启动运行的 agent id。这里挡住两个命令同时走到派发。 */
  const starting = new Set()
  /**
   * 两个斜杠命令共用的启动流程。第一次派发的结果通过 started 返回，
   * 命令可以先答复用户，合并和复审继续在后台跑。
   */
  const runCommand = (mode) => async ({ agent, rawInput }) => {
    if (starting.has(agent.id) || state.running.has(agent.id)) {
      return { kind: 'error', text: '已有批注合并运行在进行，等它结束后再派发。' }
    }
    if (state.merging.has(agent.id)) {
      return { kind: 'error', text: '已有批注合并在进行，等结束后再派发。' }
    }
    // 合并锁跨会话生效，别的会话正在合并时同样拒绝。
    if (state.mergeRun !== null && state.mergeRun !== undefined) {
      return { kind: 'error', text: MERGE_BUSY }
    }
    // 插件重载后，上一次合并的子代理可能还在写文件。
    if (hasLiveMergeChild(ctx, agent)) {
      return { kind: 'error', text: '上一次批注合并的子代理还在运行，等它结束后再派发。' }
    }
    starting.add(agent.id)
    try {
      const target = resolveCommandTarget(agent, rawInput)
      const staged = await collectStaged(target)
      if (staged.length === 0) return { kind: 'error', text: '没有暂存批注。' }
      const run = startMergeRun(ctx, log, config, state, scheduleReview, discardReviews, waitForReviews, agent, target, {
        mode,
        initialStaged: staged,
      })
      const started = await run.started
      if (!started.started) return { kind: 'error', text: started.error ?? '批注合并派发失败。' }
      return {
        kind: 'success',
        text: mode === 'once'
          ? `已派发批注合并任务，涉及 ${started.files ?? staged.length} 个文件。`
          : `已派发循环合并任务，涉及 ${started.files ?? staged.length} 个文件。`,
      }
    } finally {
      starting.delete(agent.id)
    }
  }

  ctx.commands.register({
    name: 'humanize',
    description: '合并 dsh-humanize 暂存的行文批注。参数为文件或目录路径，留空表示当前工作目录。',
    input: { hint: '文件或目录路径，可留空' },
    handler: runCommand('once'),
  })
  ctx.commands.register({
    name: 'humanize-loop',
    description: '循环执行批注合并与复审，直到复审没有新批注或达到轮次上限。参数为文件或目录路径。',
    input: { hint: '文件或目录路径，可留空' },
    handler: runCommand('loop'),
  })
  ctx.on('session/event', (session, event) => {
    if (!config.mergeOnCompaction) return
    if (event.type !== 'compaction/end') return
    if (event.data.error !== undefined) return
    const agent = ctx.agents.get(session.id)
    if (agent === undefined) return
    const cwd = session.header.cwd ?? process.cwd()
    // 压缩触发的合并也要留一行用户能看到的任务说明，好让用户知道后台做过什么。
    void (async () => {
      let tracked = null
      try {
        const staged = await collectStaged(cwd)
        if (staged.length === 0) return
        try {
          tracked = openJob(ctx, log, {
            jobs: ctx.get('jobs'),
            kind: 'humanize',
            label: `批注合并 ${cwd}`,
            owner: session.id,
            cancel() {},
          })
        } catch (error) {
          log.warn('humanize: cannot start the compaction merge job: %s', error)
        }
        const dispatch = await scheduleMerge(ctx, log, config, state, scheduleReview, discardReviews, agent, staged, 'compaction')
        if (!dispatch.started) {
          tracked?.settle({
            status: dispatch.disposed || dispatch.busy ? 'killed' : 'failed',
            detail: dispatch.error ?? '批注合并派发失败。',
          })
          return
        }
        const outcome = await dispatch.done
        tracked?.settle({
          status: outcome.completed ? 'completed' : 'failed',
          detail: outcome.completed
            ? '已按暂存批注修订。'
            : `批注合并未完成${outcome.error !== undefined ? `：${outcome.error}` : ''}。暂存批注保留。`,
        })
      } catch (error) {
        log.warn('humanize: failed to merge annotations after compaction: %s', error)
        tracked?.settle({ status: 'failed', detail: `批注合并失败：${error instanceof Error ? error.message : String(error)}` })
      }
    })()
  })
}

/** 统计一批暂存批注的条目数，供进度行展示。 */
function countStagedAnnotations(staged) {
  let count = 0
  for (const item of staged) count += countAnnotations(item.content)
  return count
}

/**
 * 子代理结束原因的文字说明。优先用 provider 给的 diagnostic，其次用
 * 从子代理 turn/end 事件里听到的错误，最后才按 stopReason 给一句概括。
 * @param {{ stopReason: string, diagnostic?: string }} result
 * @param {string | undefined} fallback
 */
function stopReasonText(result, fallback) {
  const diagnostic = typeof result.diagnostic === 'string' ? result.diagnostic.trim() : ''
  if (diagnostic.length > 0) return diagnostic
  if (typeof fallback === 'string' && fallback.trim().length > 0) return fallback
  const labels = { error: '子代理出错', aborted: '子代理被中止', cancelled: '子代理被取消' }
  return labels[result.stopReason] ?? `子代理以 ${String(result.stopReason)} 结束`
}

/** 把失败原因压成一行并截断，任务行和说明都不至于被超长错误淹没。 */
function trimReason(text, max = 400) {
  const oneLine = String(text).replace(/\s+/g, ' ').trim()
  const clipped = oneLine.length <= max ? oneLine : `${oneLine.slice(0, max - 1)}…`
  return clipped.replace(/。$/, '')
}

/**
 * /humanize 与 /humanize-loop 共用的合并运行体。单次合并只跑一轮，复审
 * 完就结束。循环合并复审完还有新批注就继续下一轮，直到收敛或达到轮次
 * 上限。
 *
 * 轮次和待复审文件都留在内存。插件重载后这次运行结束。
 */
async function runMergeRounds(ctx, log, config, state, scheduleReview, discardReviews, waitForReviews, agent, target, options = {}) {
  const mode = options.mode === 'once' ? 'once' : 'loop'
  let round = 1
  let initialStaged = options.initialStaged
  let cancelled = false
  let startedReported = false
  /** 让命令处理函数拿到第一次派发的结果后立即返回。 */
  const reportStarted = (result) => {
    if (startedReported) return
    startedReported = true
    options.onStarted?.(result)
  }

  // 循环合并的进度走 jobs 通道，进度行的 轮次/上限 前缀给客户端画进度条。
  // 单次合并只在命令返回后留一行结果说明，循环合并才开任务行。
  let tracked = null
  try {
    tracked = openJob(ctx, log, {
      jobs: ctx.get('jobs'),
      kind: mode === 'loop' ? 'humanize-loop' : 'humanize',
      label: mode === 'loop' ? `循环合并 ${target}` : `批注合并 ${target}`,
      owner: agent.session.id,
      // 用户在任务列表点取消时在下一轮开始前停下。正在进行的合并按设计跑完，
      // 由运行自己的 finally 释放合并锁。
      cancel() {
        cancelled = true
      },
    })
  } catch (error) {
    log.warn('humanize: cannot start the merge job: %s', error)
  }
  const settle = (outcome) => tracked?.settle(outcome)
  const progress = (line) => tracked?.handle?.updateProgress(line)
  // 轮次上限来自设置页，每一轮开始时重新读取。
  const maxRoundsNow = () => {
    if (mode === 'once') return 1
    const configured = config.loopMaxRounds
    return Math.max(1, Math.min(typeof configured === 'number' ? configured : LOOP_ROUNDS_DEFAULT, LOOP_ROUNDS_MAX))
  }
  /**
   * 对被合并的文件逐个复审，按完成数推进进度行，等补排的复审一起落地。
   * 返回失败数和本轮暂存的批注数，供任务行使用。
   */
  const runRoundReviews = async (reviews, labelRound, maxRounds) => {
    const reviewTotal = reviews.length
    let reviewed = 0
    progress(reviewTotal === 0
      ? `第 ${labelRound}/${maxRounds} 轮，复审进行中`
      : `第 ${labelRound}/${maxRounds} 轮，复审 0/${reviewTotal} 个文件`)
    const scheduled = []
    for (const review of reviews) {
      const after = await readFile(review.filePath, 'utf8').catch(() => undefined)
      if (after === undefined) {
        scheduled.push(Promise.resolve({ kind: 'skipped' }))
        continue
      }
      scheduled.push(scheduleReview(agent, review.filePath, review.before, after))
    }
    const counted = scheduled.map((review) => Promise.resolve(review).finally(() => {
      reviewed += 1
      progress(`第 ${labelRound}/${maxRounds} 轮，复审 ${reviewed}/${reviewTotal} 个文件`)
    }))
    const outcomes = await Promise.allSettled(counted)
    // 复审期间文件又被改时会补排复审，等队列排空再判定剩余批注。
    const reReviewQueued = reviews.some((review) => {
      const entry = state.reviewQueues.get(review.filePath)
      return entry !== undefined && (entry.active !== null || entry.pending.size > 0)
    })
    if (reReviewQueued) progress(`第 ${labelRound}/${maxRounds} 轮，等待补排复审结束`)
    await waitForReviews(reviews.map((review) => review.filePath))
    const failed = outcomes.filter((item) => item.status === 'rejected'
      || (item.status === 'fulfilled' && (item.value?.kind === 'failed'
        || item.value?.kind === 'aborted'
        || item.value?.kind === 'discarded'))).length
    const stagedNow = outcomes.reduce((sum, item) => sum + (item.status === 'fulfilled' && item.value?.kind === 'ok' ? item.value.annotations ?? 0 : 0), 0)
    return { failed, stagedNow }
  }

  try {
    // 设置页里改动的轮次上限，从下一轮开始时生效。
    for (;;) {
      const maxRounds = maxRoundsNow()
      // 插件重载时运行到此结束。暂存批注保持原样，需要时重新执行命令。
      if (state.disposed) {
        reportStarted({ started: false, error: '插件正在重载。' })
        settle({ status: 'killed', detail: '插件已重载，合并结束。' })
        return
      }
      if (cancelled) {
        reportStarted({ started: false, error: '合并已取消。' })
        settle({ status: 'killed', detail: `已取消，完成 ${round - 1} 轮。` })
        return
      }
      if (round > maxRounds) {
        const remaining = await collectStaged(target)
        const remainingCount = countStagedAnnotations(remaining)
        reportStarted({ started: false, error: `已完成 ${maxRounds} 轮。` })
        settle({
          status: 'completed',
          detail: `已完成 ${maxRounds} 轮，达到轮次上限，仍有 ${remainingCount} 条批注未收敛，分布在 ${remaining.length} 个文件里。`,
        })
        return
      }
      const staged = initialStaged !== undefined ? initialStaged : await collectStaged(target)
      initialStaged = undefined
      if (staged.length === 0) {
        reportStarted({ started: false, error: '没有暂存批注。' })
        settle({ status: 'completed', detail: '合并结束：没有暂存批注。' })
        return
      }
      // 本轮涉及的文件加入合并锁，这些文件上的并发审查直接让路。
      addMergeFiles(state, agent.id, staged)
      progress(`第 ${round}/${maxRounds} 轮，合并 ${staged.length} 个文件，共 ${countStagedAnnotations(staged)} 条批注`)
      const dispatch = await scheduleMerge(ctx, log, config, state, scheduleReview, discardReviews, agent, staged, `${mode} round ${round}`, { managed: true })
      if (!dispatch.started) {
        reportStarted({ started: false, error: dispatch.error ?? '批注合并派发失败。' })
        if (dispatch.disposed) settle({ status: 'killed', detail: '插件已重载，合并结束。' })
        else if (dispatch.busy) settle({ status: 'killed', detail: dispatch.error ?? '已有批注合并正在进行。' })
        else settle({ status: 'failed', detail: `批注合并派发失败：${dispatch.error ?? '未知原因'}` })
        return
      }
      reportStarted({ started: true, files: staged.length })
      const outcome = await dispatch.done
      if (state.disposed) {
        settle({ status: 'killed', detail: '插件已重载，合并结束。' })
        return
      }
      if (!outcome.completed) {
        settle({
          status: 'failed',
          detail: `第 ${round} 轮合并未完成${outcome.error !== undefined ? `：${outcome.error}` : ''}。暂存批注保留。`,
        })
        return
      }
      // 取消在合并收尾后生效，已完成的合并照常清暂存，只是不再复审。
      if (cancelled) {
        settle({ status: 'killed', detail: `已取消，完成 ${round} 轮。` })
        return
      }
      const { failed, stagedNow } = await runRoundReviews(outcome.reviewInputs, round, maxRounds)
      if (state.disposed) {
        settle({ status: 'killed', detail: '插件已重载，合并结束。' })
        return
      }
      const remaining = await collectStaged(target)
      // 复审结果只放在任务行里，会话上下文只保留合并改动的说明。
      progress(`第 ${round}/${maxRounds} 轮，复审暂存 ${stagedNow} 条批注${failed > 0 ? `，${failed} 个复审失败` : ''}，还有 ${remaining.length} 个文件有批注`)
      // 复审失败说明这次运行没有完成闭环。不能按“没有新批注”判定收敛。
      if (failed > 0) {
        const detail = `合并已完成，但第 ${round} 轮复审有 ${failed} 个文件失败，运行结束。可以重新执行 /humanize-review 复审。`
        notify(agent, detail)
        settle({ status: 'failed', detail })
        return
      }
      // 单次合并复审完就结束，只跑这一轮。
      if (mode === 'once') {
        settle({ status: 'completed', detail: `合并完成：复审暂存 ${stagedNow} 条批注。` })
        return
      }
      if (remaining.length === 0) {
        settle({ status: 'completed', detail: `循环合并结束：共 ${round} 轮，复审没有新批注。` })
        return
      }
      round += 1
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    log.warn('humanize: merge run failed: %s', message)
    // 单次合并没有任务行，失败只能靠结果说明让用户看到。
    notify(agent, `合并运行失败：${message}。`)
    reportStarted({ started: false, error: message })
    settle({ status: 'failed', detail: `合并失败：${message}` })
  } finally {
    state.running.delete(agent.id)
    releaseMergeRun(state, agent.id)
  }
}

/**
 * 启动一次合并运行，并给出第一次派发的结果。命令处理函数等 started
 * 有结果后立即返回，合并和复审继续在后台跑。
 */
function startMergeRun(ctx, log, config, state, scheduleReview, discardReviews, waitForReviews, agent, target, options) {
  // 同步占住运行锁。命令处理函数在首次派发后就返回，之后的重复派发
  // 靠这把锁让路。锁跨 agent 生效。
  if (!acquireMergeRun(state, agent, target, options.initialStaged)) {
    return { started: Promise.resolve({ started: false, error: MERGE_BUSY }) }
  }
  state.running.add(agent.id)
  let settleStarted
  const started = new Promise((resolve) => { settleStarted = resolve })
  // 运行体在后台跑，命令只等第一次派发的结果。运行结束或抛错时都要
  // 给等待 started 的命令一个终态，避免它一直挂着。
  void runMergeRounds(ctx, log, config, state, scheduleReview, discardReviews, waitForReviews, agent, target, {
    ...options,
    onStarted: settleStarted,
  }).then(() => {
    // 极端情况下运行在首次派发前就走完了。
    settleStarted({ started: false, error: '合并运行已结束。' })
  }).catch((error) => {
    log.warn('humanize: merge run failed: %s', error)
    // 运行体如果在其自己的 finally 之前失败，这里兜底释放两把锁。
    state.running.delete(agent.id)
    releaseMergeRun(state, agent.id)
    settleStarted({ started: false, error: error instanceof Error ? error.message : String(error) })
  })
  return { started }
}

/**
 * 派发一次合并：先组装消息，再派发一个一次性子代理按批注改文件，后台等
 * 结果再清暂存批注。
 *
 * 返回是否派发成功。成功时会附带一个 Promise，它在收尾完成后结算。结算值
 * 里有复审要用的文件清单，调用方从结果里拿。
 */
async function scheduleMerge(ctx, log, config, state, scheduleReview, discardReviews, agent, staged, origin, options = {}) {
  const managed = options.managed === true
  if (state.disposed) {
    // 重载期间派发出去的子代理会失去收尾，这里拒绝新的派发。
    return { started: false, disposed: true, error: '插件正在重载' }
  }
  // 压缩和手动命令都在运行之外触发。同一个 agent 同时只允许一个合并在进行，
  // 已有合并在跑就跳过这次派发。全局锁再挡住其他会话。
  if (!managed && state.running.has(agent.id)) {
    log.info('humanize: a merge run is running for agent %s, skipping the %s trigger', agent.id, origin)
    return { started: false, busy: true, error: '已有批注合并运行在进行，等它结束后再派发。' }
  }
  if (state.merging.has(agent.id)) {
    log.info('humanize: a merge is already running for agent %s, skipping the %s trigger', agent.id, origin)
    return { started: false, busy: true, error: '已有批注合并在进行，等它结束后再派发。' }
  }
  // 合并锁只存在内存里。插件重载后锁已经没了，这时靠还活着的合并子代理
  // 挡住新的派发。
  if (hasLiveMergeChild(ctx, agent)) {
    log.info('humanize: a merge subagent is still running for session %s, skipping the %s trigger', agent.session.id, origin)
    return { started: false, busy: true, error: '上一次批注合并的子代理还在运行，等它结束后再派发。' }
  }
  // 运行编排的合并已经持有锁；压缩这类单独派发在这里取得锁。
  if (managed) {
    if (state.mergeRun?.agentId !== agent.id) {
      return { started: false, busy: true, error: MERGE_BUSY }
    }
  } else if (!acquireMergeRun(state, agent, null, staged)) {
    log.info('humanize: another merge run holds the lock, skipping the %s trigger', origin)
    return { started: false, busy: true, error: MERGE_BUSY }
  }
  state.merging.add(agent.id)
  let requestPath
  let activation
  let stopWatching = () => {}
  try {
    // 记录合并前的文件内容。收尾后的复审只审合并改动的区段。读不到的
    // 文件在复审时改为全量复审。
    for (const item of staged) {
      item.sourceBefore = await readFile(item.filePath, 'utf8').catch(() => undefined)
    }
    // 把完整请求写到临时文件，合并子代理用文件工具自己分段读。
    requestPath = await writeMergeRequest(await buildMergeMessage(staged, agent.session.header.cwd))
    const text = [
      `The merge request is in ${requestPath}.`,
      'Read that file in parts with the file tools; it lists the rules and the staged annotations for each file. Do not edit it.',
    ].join('\n\n')
    // 模型可以单独配置，留空时跟随主会话当前用的模型。
    const agentOptions = mergeAgentOptions(config, agent)
    activation = await ctx.subagents.startActivation({
      provider: MERGE_PROVIDER,
      label: 'humanize 批注合并',
      request: {
        prompt: [{ type: 'text', text }],
        parent: agent,
        // preset 是 cordis.patch.yml 里声明的 humanize-merge，合并用到
        // 的工具是读文件、改文件和检索目录。
        agentPreset: MERGE_PRESET,
        ...(agentOptions !== undefined ? { agentOptions } : {}),
      },
      // 子代理跑完后由插件收尾。
      signal: new AbortController().signal,
      // 结果只回给插件，由插件自己清掉暂存批注并留下结果说明。
      delivery: 'caller',
    })
    // 子代理的结束原因不一定进 result.diagnostic。直接听它的 turn/end，
    // 把 provider 的原始错误留下来，例如配额、模型下线。
    let childFailure
    stopWatching = ctx.on('session/event', (session, event) => {
      if (session.id !== activation.childId || event.type !== 'turn/end') return
      const message = event.data?.reason?.error?.message
      if (typeof message === 'string' && message.trim().length > 0) childFailure = message
    })
    // 派发之后这些复审结果都会过期，先让它们停下。其他 agent 在这些
    // 文件上的在途审查也要停，否则会在合并期间写暂存。
    state.reviewBatchAbort.get(agent.id)?.abort('merge started')
    discardReviews(agent.id, staged.map((item) => item.filePath))
    const done = activation.result.then(
      (result) => {
        const completed = result.stopReason === 'completed'
        const reason = completed ? undefined : stopReasonText(result, childFailure)
        if (!completed) {
          log.warn('humanize: merge subagent %s ended with %s: %s', activation.childId, result.stopReason, reason)
        }
        // 子代理已经不写文件了，先放开文件，随后安排的复审才不会被锁挡住。
        clearMergeFiles(state, agent.id)
        return settleMerge(log, state, scheduleReview, agent, staged, completed, { managed, reason })
      },
      (error) => {
        const message = childFailure ?? (error instanceof Error ? error.message : String(error))
        log.warn('humanize: merge subagent run failed: %s', message)
        clearMergeFiles(state, agent.id)
        return settleMerge(log, state, scheduleReview, agent, staged, false, { managed, reason: message })
      },
    ).finally(async () => {
      stopWatching()
      await activation.dispose().catch(() => undefined)
      if (requestPath !== undefined) await removeMergeRequest(requestPath).catch(() => undefined)
      // 单独派发的合并到这里结束，释放全局锁。运行编排的锁由 runMergeRounds 释放。
      if (!managed) releaseMergeRun(state, agent.id)
    })
    log.info('humanize: merge dispatched (%s) for %d file(s) as subagent %s', origin, staged.length, activation.childId)
    return { started: true, done }
  } catch (error) {
    stopWatching()
    state.merging.delete(agent.id)
    clearMergeFiles(state, agent.id)
    if (!managed) releaseMergeRun(state, agent.id)
    // 子代理可能已经建立，只是后续接线上出错。不能把它留在后台。
    if (activation !== undefined) await activation.dispose().catch(() => undefined)
    if (requestPath !== undefined) await removeMergeRequest(requestPath).catch(() => undefined)
    const message = error instanceof Error ? error.message : String(error)
    log.warn('humanize: failed to dispatch merge: %s', message)
    // web 宿主的用户只看得到终态说明，这里把原因一并带回给命令和任务。
    return { started: false, error: message }
  }
}

/**
 * 合并有结果后收尾，清暂存批注、留结果说明、释放这次合并的标记。
 *
 * 成功时清掉暂存批注，失败时保留，等用户重新执行命令。
 */
async function settleMerge(log, state, scheduleReview, agent, staged, completed, options = {}) {
  const managed = options.managed === true
  // 失败原因来自子代理的 diagnostic 或派发错误，压成一行再放进说明和任务行。
  const reason = typeof options.reason === 'string' ? trimReason(options.reason) : ''
  try {
    // 成功就清暂存批注，失败则保留等下次合并。
    if (completed) {
      for (const item of staged) {
        try {
          // 合并期间可能又跑了一次复审并写入新批注。暂存内容不再是
          // 合并前的快照时保留新内容，别按旧快照删掉。
          const current = await readStaging(item.filePath)
          if (current !== undefined && current !== item.content) continue
          await removeStaging(item.filePath)
        } catch (error) {
          log.warn('humanize: failed to clear staging for %s: %s', item.filePath, error)
        }
      }
    }
  } finally {
    state.merging.delete(agent.id)
  }
  if (completed) {
    // 说明里逐个列出文件。正文保留完整清单。折叠行只放一句概括，避免被
    // 120 字符的 notice 摘要上限截断。
    notify(agent, `已按暂存批注修订 ${staged.map((item) => item.filePath).join('、')}。`,
      `已按暂存批注修订 ${staged.length} 个文件。`)
    log.info('humanize: merge settled, cleared %d staged annotation file(s)', staged.length)
  } else {
    // 失败时把子代理给的原因带到主会话。用户不用打开子代理会话也能知道
    // 是配额、超时还是别的错误。
    const detail = reason.length > 0
      ? `批注合并未完成：${reason}。暂存批注保留，可以重新执行 /humanize。`
      : '批注合并未完成，暂存批注保留，可以重新执行 /humanize。'
    notify(agent, detail, '批注合并未完成，暂存批注保留。')
    log.warn('humanize: merge did not complete (%s), %d staged annotation file(s) kept', reason || 'no reason', staged.length)
  }
  if (!completed) return { completed, reviewInputs: [], error: reason.length > 0 ? reason : undefined }
  // 合并产出是新行文，合并本身可能引入新的违规表述。由运行编排的
  // 合并把清单交给运行自己排；独立的合并没有运行，仍然在这里直接排复审。
  const reviewInputs = []
  for (const item of staged) {
    const after = await readFile(item.filePath, 'utf8').catch(() => undefined)
    if (after === undefined) continue
    reviewInputs.push({ filePath: item.filePath, before: item.sourceBefore })
    if (!managed) void scheduleReview(agent, item.filePath, item.sourceBefore, after)
  }
  return { completed, reviewInputs }
}

/**
 * 在主会话里留一条合并结果说明。走 agent.inject，模型在下一步看到它，
 * 会话记录里的来源是 humanize。
 *
 * summary 是会话里折叠行显示的一句话。正文可以很长，摘要必须保持简短，
 * 否则会被 notice 的摘要上限截断。
 */
function notify(agent, text, summary = text) {
  try {
    agent.inject(createUserMessage({
      content: [{ type: 'text', text }],
      source: { kind: 'humanize', form: 'notice', summary: boundContextSummary(summary) },
    }))
  } catch {
    // 主会话已销毁时结果说明无处安放，批注状态保持原样。
  }
}

/** 组装发给合并子代理的消息：规范按内容分组，只贴一次，下面按文件列出批注。 */
async function buildMergeMessage(staged, boundary) {
  /** @type {Map<string, Array<{ filePath: string, content: string }>>} */
  const groups = new Map()
  for (const item of staged) {
    const chain = await loadSpecChain(item.filePath, boundary)
    const spec = chain.length > 0 ? renderSpecChain(chain) : 'No PROSE.md found; follow the annotations.'
    const group = groups.get(spec) ?? []
    group.push(item)
    groups.set(spec, group)
  }
  const sections = []
  for (const [spec, items] of groups) {
    sections.push([
      `## Rules\n${spec}`,
      ...items.map((item) => item.content),
    ].join('\n\n'))
  }
  return `${loadPrompt('merge-header')}\n\n${sections.join('\n\n')}`
}
