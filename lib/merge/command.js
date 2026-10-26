/**
 * 延迟合并。行文批注先暂存到文件里，称为暂存批注。
 *
 * 用户输入 /humanize 命令时按命令指定的范围合并。用户输入
 * /humanize-loop 命令时循环执行合并和复审，直到收敛。上下文压缩
 * 结束时按会话工作目录合并暂存批注。最终回复输出可以复用这里的
 * 单次合并入口。
 *
 * 本模块负责注册命令和编排合并运行。合并锁在 lock.js，合并子代理
 * 的派发与收尾在 agent.js。
 *
 * 合并运行的状态全部留在内存。插件重载会结束这次运行，暂存批注
 * 原样保留，需要时重新执行命令即可。
 *
 * @module dsh-humanize/merge/command
 */
import { readFile } from 'node:fs/promises'
import { countAnnotations } from '../review/annotations.js'
import { resolveCommandTarget } from '../shared/paths.js'
import { clampInt, LOOP_ROUNDS_DEFAULT, LOOP_ROUNDS_MAX } from '../shared/defaults.js'
import { JOB_KIND_LOOP, JOB_KIND_MERGE, openJob } from '../shared/job-track.js'
import { notify, scheduleMerge } from './agent.js'
import { MERGE_BUSY, acquireMergeRun, addMergeFiles, hasLiveMergeChild, isMergeBusy, releaseMergeRun } from './lock.js'
import { collectStaged } from '../shared/staging.js'

export { isMergeAgent } from './lock.js'

/**
 * 注册 /humanize、/humanize-loop 命令和 compaction/end 触发。
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {{ info: Function, warn: Function }} log
 * @param {{ mergeOnCompaction: boolean, loopMaxRounds?: number }} config
 * @param {ReturnType<import('../review/pipeline.js').createReviewPipeline>['state']} state - 插件共享状态。
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
    // 合并锁跨会话生效，别的会话正在合并时同样拒绝。
    if (starting.has(agent.id) || isMergeBusy(state, agent.id)) {
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
  const startMergeOnce = (agent, target, initialStaged) => startMergeRun(
    ctx,
    log,
    config,
    state,
    scheduleReview,
    discardReviews,
    waitForReviews,
    agent,
    target,
    { mode: 'once', initialStaged },
  )

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
            kind: JOB_KIND_MERGE,
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
            : `批注合并未完成${outcome.error !== undefined ? `：${outcome.error}` : ''}。暂存批注会保留下来。`,
        })
      } catch (error) {
        log.warn('humanize: failed to merge annotations after compaction: %s', error)
        tracked?.settle({ status: 'failed', detail: `批注合并失败：${error instanceof Error ? error.message : String(error)}` })
      }
    })()
  })

  // turn 输出等自动触发方式复用单次合并，不经过斜杠命令。
  return { startMergeOnce }
}

/** 供进度行展示批注条目数。 */
function countStagedAnnotations(staged) {
  let count = 0
  for (const item of staged) count += countAnnotations(item.content)
  return count
}

/**
 * /humanize 与 /humanize-loop 共用的合并运行体。单次合并只跑一轮，复审
 * 完就结束。循环合并复审完还有新批注就继续下一轮，直到收敛或达到轮次
 * 上限。
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

  // 合并进度走 jobs 通道。循环合并的进度行带轮次前缀，客户端据此画进度条。
  let tracked = null
  try {
    tracked = openJob(ctx, log, {
      jobs: ctx.get('jobs'),
      kind: mode === 'loop' ? JOB_KIND_LOOP : JOB_KIND_MERGE,
      label: mode === 'loop' ? `循环合并 ${target}` : `批注合并 ${target}`,
      owner: agent.session.id,
      // 用户在任务列表点取消时在下一轮开始前停下。正在进行的合并按设计跑完，
      // 运行收尾时会自己释放合并锁。
      cancel() {
        cancelled = true
      },
    })
  } catch (error) {
    log.warn('humanize: cannot start the merge job: %s', error)
  }
  const settle = (outcome) => tracked?.settle(outcome)
  const progress = (line) => tracked?.handle?.updateProgress(line)
  /**
   * 结束这次运行：报告第一次派发的结果并结算任务行。派发之后的分支已经
   * 报告过 started，reportStarted 会忽略这里的重复调用。
   */
  const halt = (error, outcome) => {
    reportStarted({ started: false, error })
    settle(outcome)
  }
  // 轮次上限来自设置页，每一轮开始时重新读取。
  const maxRoundsNow = () => {
    if (mode === 'once') return 1
    return clampInt(config.loopMaxRounds, 1, LOOP_ROUNDS_MAX, LOOP_ROUNDS_DEFAULT)
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
    // 复审期间文件又被改时会补排复审，等补排的复审都结束之后，再看还剩多少批注。
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
      if (state.disposed) return halt('插件已重载。', { status: 'killed', detail: '插件已重载，合并结束。' })
      if (cancelled) return halt('合并已取消。', { status: 'killed', detail: `已取消，完成 ${round - 1} 轮。` })
      if (round > maxRounds) {
        const remaining = await collectStaged(target)
        const remainingCount = countStagedAnnotations(remaining)
        return halt(`已完成 ${maxRounds} 轮。`, {
          status: 'completed',
          detail: `已完成 ${maxRounds} 轮，达到轮次上限，仍有 ${remainingCount} 条批注未收敛，分布在 ${remaining.length} 个文件里。`,
        })
      }
      const staged = initialStaged !== undefined ? initialStaged : await collectStaged(target)
      initialStaged = undefined
      if (staged.length === 0) return halt('没有暂存批注。', { status: 'completed', detail: '合并完成。没有暂存批注。' })
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
      if (state.disposed) return halt('插件已重载。', { status: 'killed', detail: '插件已重载，合并结束。' })
      if (!outcome.completed) {
        settle({
          status: 'failed',
          detail: `第 ${round} 轮合并未完成${outcome.error !== undefined ? `：${outcome.error}` : ''}。暂存批注会保留下来。`,
        })
        return
      }
      // 取消在合并收尾后生效，已完成的合并照常清暂存，只是不再复审。
      if (cancelled) return halt('合并已取消。', { status: 'killed', detail: `已取消，完成 ${round} 轮。` })
      const { failed, stagedNow } = await runRoundReviews(outcome.reviewInputs, round, maxRounds)
      if (state.disposed) return halt('插件已重载。', { status: 'killed', detail: '插件已重载，合并结束。' })
      const remaining = await collectStaged(target)
      // 复审结果只放在任务行里，会话上下文只保留合并改动的说明。
      progress(`第 ${round}/${maxRounds} 轮，复审暂存 ${stagedNow} 条批注${failed > 0 ? `，${failed} 个复审失败` : ''}，还有 ${remaining.length} 个文件有批注`)
      // 复审失败说明这次运行还没走完整个流程，应当按失败结束。
      if (failed > 0) {
        const detail = `合并已完成，但第 ${round} 轮复审有 ${failed} 个文件失败，运行结束。可以重新执行 /humanize-review 复审。`
        notify(agent, detail)
        settle({ status: 'failed', detail })
        return
      }
      // 单次合并只跑这一轮，复审产生的新批注留在暂存里，等用户下次合并。
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
    // 单次合并靠命令返回的结果说明告知失败原因。
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
 * 有结果后立即返回，合并和复审继续在后台跑。自动触发方可以再等 done，
 * 确保下一轮不会与这次运行并发。
 */
function startMergeRun(ctx, log, config, state, scheduleReview, discardReviews, waitForReviews, agent, target, options) {
  // 同步占住运行锁。命令处理函数在首次派发后就返回，之后的重复派发
  // 靠这把锁让路。锁跨 agent 生效。
  if (!acquireMergeRun(state, agent, target, options.initialStaged)) {
    return { started: Promise.resolve({ started: false, error: MERGE_BUSY }), done: Promise.resolve() }
  }
  state.running.add(agent.id)
  let settleStarted
  const started = new Promise((resolve) => { settleStarted = resolve })
  // 运行体在后台跑，命令只等第一次派发的结果。运行结束或抛错时都要
  // 给等待 started 的命令一个终态，避免它一直挂着。
  const done = runMergeRounds(ctx, log, config, state, scheduleReview, discardReviews, waitForReviews, agent, target, {
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
  return { started, done }
}
