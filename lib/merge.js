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
 * @module dsh-humanize/merge
 */
import { randomUUID } from 'node:crypto'
import { readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { withFileLock, writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { countAnnotations } from './annotations.js'
import { resolveCommandTarget } from './command.js'
import { LOOP_ROUNDS_DEFAULT, LOOP_ROUNDS_MAX } from './defaults.js'
import { openJob } from './job-track.js'
import { sessionModelConfig } from './model.js'
import { loadPrompt } from './prompts.js'
import { loadSpecChain, renderSpecChain } from './specs.js'
import { collectStaged, humanizeRoot, removeStaging } from './staging.js'

/**
 * 合并子代理使用的提供方。子代理从空上下文起步，只带本次合并需要的
 * 内容，省得把整段对话历史重新读一遍。
 */
const MERGE_PROVIDER = 'spawn'

/** 合并子代理的 preset id，声明在本包 cordis.patch.yml 的 preset-humanize-merge 行。 */
const MERGE_PRESET = 'humanize-merge'

/**
 * 插件共享状态。合并运行期间拒绝手动合并和审查批次。
 *
 * @typedef {object} PluginState
 * @property {Set<string>} merging - 正在合并的 agent id。
 * @property {Set<string>} reviewing - 有审查批次正在进行中的 agent id。
 * @property {Set<string>} running - 正在执行合并运行的 agent id，可以是单次合并，也可以是循环合并。
 * @property {boolean} disposed - 插件已停止接受新的审查。
 * @property {Map<string, AbortController>} reviewBatchAbort - 用于中止各会话当前审查批次的对象。
 * @property {Map<string, { active: Promise<void> | null, pending: object | null }>} reviewQueues - 各文件的审查队列，记录正在执行和排队等待的审查。
 */

/** 在途合并记录保存到磁盘的位置。 */
function pendingPath() {
  return join(humanizeRoot(), 'merge-pending.json')
}

/** 读在途合并记录，文件缺失或损坏时当作没有记录。 */
async function readPending() {
  try {
    const parsed = JSON.parse(await readFile(pendingPath(), 'utf8'))
    return parsed !== null && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

async function writePending(map) {
  if (Object.keys(map).length === 0) {
    await rm(pendingPath(), { force: true })
    return
  }
  // 进程在写入中途挂掉时，文件内容是替换前或替换后的某一份。
  await writeFileAtomic(pendingPath(), JSON.stringify(map), { mode: 0o600 })
}

/**
 * 读取、修改和写回都放在同一把文件锁里执行。两个触发时机的收尾会依次
 * 执行。
 *
 * beforeDrop 在摘除记录之前执行。它先清暂存批注、推进运行阶段，最后才
 * 摘除记录，接手方看到记录时这些动作已经做完。
 *
 * 返回是否真的摘除了记录，settleMerge 用它判定自己是不是重复的收尾。
 */
async function dropPending(sessionId, beforeDrop) {
  return await withFileLock(pendingPath(), async () => {
    const map = await readPending()
    if (!(sessionId in map)) return false
    if (beforeDrop !== undefined) await beforeDrop()
    delete map[sessionId]
    await writePending(map)
    return true
  })
}

/** 合并运行记录保存到磁盘的位置。 */
function runPath() {
  return join(humanizeRoot(), 'merge-runs.json')
}

/** 读合并运行记录，文件缺失或损坏时当作没有记录。 */
async function readRuns() {
  try {
    const parsed = JSON.parse(await readFile(runPath(), 'utf8'))
    return parsed !== null && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

async function writeRuns(map) {
  if (Object.keys(map).length === 0) {
    await rm(runPath(), { force: true })
    return
  }
  await writeFileAtomic(runPath(), JSON.stringify(map), { mode: 0o600 })
}

/** 在文件锁里读取、修改并写回运行记录。mutate 返回 false 时记录保持原样。 */
async function mutateRuns(mutate) {
  return await withFileLock(runPath(), async () => {
    const map = await readRuns()
    const result = await mutate(map)
    await writeRuns(map)
    return result
  })
}

/**
 * 新建一条运行记录，或把手上的记录换成新的 runId。
 * 热重载后新旧实例都可能走到这里，靠 runId 判定谁是当前执行者。
 */
async function claimRun(sessionId, record, expectedRunId) {
  return await mutateRuns(async (map) => {
    if (expectedRunId !== undefined && map[sessionId]?.runId !== expectedRunId) return false
    map[sessionId] = { ...map[sessionId], ...record }
    return true
  })
}

/** 只更新当前 runId 名下的运行记录。记录被新实例接手后返回 false。 */
async function saveRun(sessionId, runId, patch) {
  return await mutateRuns(async (map) => {
    if (map[sessionId]?.runId !== runId) return false
    map[sessionId] = { ...map[sessionId], ...patch }
    return true
  })
}

/** 运行结束时清掉记录。记录已经换到别的 runId 名下时，这次清理直接跳过。 */
async function clearRun(sessionId, runId) {
  await mutateRuns(async (map) => {
    if (map[sessionId]?.runId !== runId) return false
    delete map[sessionId]
    return true
  })
}

/** 子代理离场时清掉这个会话的运行记录，避免新实例反复接手一个死循环。 */
async function clearRunForSession(sessionId) {
  await mutateRuns(async (map) => {
    if (!(sessionId in map)) return false
    delete map[sessionId]
    return true
  })
}

/** 把取消状态直接写到会话当前的运行记录上，接手方也能看到。 */
async function cancelRun(sessionId) {
  await mutateRuns(async (map) => {
    const record = map[sessionId]
    if (record === undefined) return false
    record.cancelled = true
    return true
  })
}

/**
 * 合并收尾后把记录从 dispatch 推进到 merge。重载如果发生在
 * 派发和落盘之间，接手方据此知道这一轮的合并已经跑过，只补复审。
 */
async function markRunMerged(sessionId) {
  await mutateRuns(async (map) => {
    const record = map[sessionId]
    if (record === undefined || record.phase !== 'dispatch') return false
    record.phase = 'merge'
    return true
  })
}

/**
 * 一个子代理是不是在途合并派发的合并子代理。热重载后内存里的合并锁
 * 会丢失，因此只以在途合并记录为准。
 */
export async function isPendingMergeChild(childId) {
  const pending = await readPending()
  for (const record of Object.values(pending)) {
    if (record !== null && typeof record === 'object' && record.childId === childId) return true
  }
  return false
}

/**
 * 注册 /humanize、/humanize-loop 命令和 compaction/end 触发。
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {{ info: Function, warn: Function }} log
 * @param {{ mergeOnCompaction: boolean, loopMaxRounds?: number }} config
 * @param {PluginState} state - 插件共享状态。
 * @param {(agent: import('@deepseek-ai/dsh-agent').Agent, filePath: string, before: string | undefined, after: string) => Promise<unknown>} scheduleReview - 合并收尾后，安排复审这次合并涉及的文件。
 * @param {(filePaths: string[]) => Promise<void>} waitForReviews - 合并运行时，等待复审完成。
 * @param {(agentId: string) => void} discardReviews - 合并派发时，丢弃正在执行和排队中的复审。
 * @returns {{ resumeRuns: () => Promise<void> }} 热重载后接手未完成的合并运行。
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
    starting.add(agent.id)
    try {
      // 重载后的在途记录可能还没被 reconcile 捡起来，先看磁盘。
      const pending = await readPending()
      if (agent.session.id in pending) {
        return { kind: 'error', text: '已有批注合并记录，等它收尾后再派发。' }
      }
      // 进程重启或重载接手后，上一次运行可能还留着记录。这时先让命令
      // 报错，等旧记录收尾再派发。
      const runs = await readRuns()
      if (agent.session.id in runs) {
        return { kind: 'error', text: '已有合并运行记录，等它收尾后再派发。' }
      }
      const target = resolveCommandTarget(agent, rawInput)
      const staged = await collectStaged(target)
      if (staged.length === 0) return { kind: 'error', text: '没有暂存的批注。' }
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
    collectStaged(cwd).then((staged) => {
      if (staged.length === 0) return
      return scheduleMerge(ctx, log, state, scheduleReview, discardReviews, agent, staged, 'compaction')
    }, (error) => log.warn('humanize: failed to collect staged annotations after compaction: %s', error))
  })

  /**
   * 接手热重载前没跑完的合并运行。在途合并由 reconcilePendingMerges
   * 先收尾，这里只处理已经不在合并阶段的记录。
   *
   * 单次合并补完复审就结束。循环合并补完复审后再接着下一轮。
   *
   * 记录里的 runId 是认领凭据。新旧实例同时走到这里时，只有换到新
   * runId 的一方继续执行，旧实例在下一次检查时退出。
   */
  const resumeRuns = async () => {
    const runs = await readRuns()
    for (const [sessionId, initial] of Object.entries(runs)) {
      try {
        if (state.disposed) return
        const agent = ctx.agents.get(sessionId)
        if (agent === undefined) continue
        if (starting.has(agent.id) || state.running.has(agent.id) || state.merging.has(agent.id)) continue
        // 在途合并还没收尾时先跳过。reconcilePendingMerges 结束会再调
        // 一次这里。
        const pending = await readPending()
        if (sessionId in pending) continue
        // 收尾会在摘除在途合并记录前把运行阶段推进到 merge。这里重新读一次，
        // 避免拿着推进前的 dispatch 快照把同一轮又派发一遍。
        const record = (await readRuns())[sessionId]
        if (record === undefined || record.runId !== initial.runId) continue
        if (typeof record.target !== 'string' || record.target.length === 0) {
          await clearRunForSession(sessionId)
          continue
        }
        // 取消状态已经落盘，这里直接清掉记录并结束运行。
        if (record.cancelled === true) {
          await clearRunForSession(sessionId)
          notify(agent, '合并运行已取消。')
          continue
        }
        const nextRunId = randomUUID()
        if (!(await claimRun(sessionId, { runId: nextRunId }, record.runId))) continue
        const mode = record.mode === 'once' ? 'once' : 'loop'
        const previousRound = Math.max(1, Number.isInteger(record.round) ? record.round : 1)
        // dispatch 表示派发后还没确认合并跑完，next 表示上一轮已经收尾。
        // 这两种情况都从记录里的 round 重新开始。
        const sameRound = record.phase === 'dispatch' || record.phase === 'next'
        // merge 或 review 表示这一轮已经合并过，这些文件先补复审。
        const pendingReviews = sameRound || !Array.isArray(record.reviews) ? [] : record.reviews
        // 单次合并补完复审就结束，循环合并再从下一轮继续。
        const startRound = sameRound ? previousRound : (mode === 'once' ? 1 : previousRound + 1)
        // 运行本身在后台跑。resumeRuns 会被 agent/created 反复触发，
        // state.running 和 runId 保证同一会话只有一条在跑。
        startMergeRun(ctx, log, config, state, scheduleReview, discardReviews, waitForReviews, agent, record.target, {
          mode,
          startRound,
          previousRound,
          pendingReviews,
          runId: nextRunId,
          resume: true,
        })
      } catch (error) {
        log.warn('humanize: failed to resume merge run for %s: %s', sessionId, error)
      }
    }
  }

  return { resumeRuns }
}

/** 统计一批暂存批注的条目数，供进度行展示。 */
function countStagedAnnotations(staged) {
  let count = 0
  for (const item of staged) count += countAnnotations(item.content)
  return count
}

/**
 * /humanize 与 /humanize-loop 共用的合并运行体。单次合并只跑一轮，复审
 * 完就结束。循环合并复审完还有新批注就继续下一轮，直到收敛或达到轮次
 * 上限。
 *
 * 每一轮的目标、阶段和待复审文件都落盘到 merge-runs.json。重载后新实例
 * 按记录补复审，接着派发下一轮。
 */
async function runMergeRounds(ctx, log, config, state, scheduleReview, discardReviews, waitForReviews, agent, target, options = {}) {
  const sessionId = agent.session.id
  const mode = options.mode === 'once' ? 'once' : 'loop'
  const runId = options.runId ?? randomUUID()
  let round = Math.max(1, options.startRound ?? 1)
  let pendingReviews = Array.isArray(options.pendingReviews) ? options.pendingReviews : []
  let initialStaged = options.initialStaged
  const resumeRound = Math.max(1, options.previousRound ?? round - 1)
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
  const tracked = mode === 'loop'
    ? openJob(ctx, log, {
        jobs: ctx.get('jobs'),
        kind: 'humanize-loop',
        label: `循环合并 ${target}`,
        owner: sessionId,
        // 用户在任务列表点取消时在下一轮开始前停下。在途的合并按设计跑完，
        // 由它自己的收尾释放合并锁。取消状态落盘，重载后接手方不会又跑起来。
        cancel() {
          cancelled = true
          void cancelRun(sessionId).catch(() => undefined)
        },
      })
    : null
  const settle = (outcome) => tracked?.settle(outcome)
  const progress = (line) => tracked?.handle?.updateProgress(line)
  // 轮次上限来自设置页，每一轮开始时重新读取。
  const maxRoundsNow = () => {
    if (mode === 'once') return 1
    const configured = config.loopMaxRounds
    return Math.max(1, Math.min(typeof configured === 'number' ? configured : LOOP_ROUNDS_DEFAULT, LOOP_ROUNDS_MAX))
  }
  const owned = async () => (await readRuns())[sessionId]?.runId === runId
  const handoff = () => {
    if (tracked !== null) settle({ status: 'killed', detail: '插件已重载，合并交给新实例继续。' })
  }
  const roundSummary = (value, stagedNow, remaining, failed) => (mode === 'once'
    ? `批注合并结束：复审暂存 ${stagedNow} 条批注${failed > 0 ? `，${failed} 个复审失败` : ''}。`
    : `循环合并第 ${value} 轮结束：复审暂存 ${stagedNow} 条批注，还有 ${remaining.length} 个文件有批注${failed > 0 ? `，${failed} 个复审失败` : ''}。`)

  /**
   * 对被合并的文件逐个复审，按完成数推进进度行，等补排的复审一起落地。
   * 返回失败数和本轮暂存的批注数，供轮末说明使用。
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
      return entry !== undefined && (entry.active !== null || entry.pending !== null)
    })
    if (reReviewQueued) progress(`第 ${labelRound}/${maxRounds} 轮，等待补排复审结束`)
    await waitForReviews(reviews.map((review) => review.filePath))
    const failed = outcomes.filter((item) => item.status === 'fulfilled' && item.value?.kind === 'failed').length
    const stagedNow = outcomes.reduce((sum, item) => sum + (item.status === 'fulfilled' && item.value?.kind === 'ok' ? item.value.annotations ?? 0 : 0), 0)
    return { failed, stagedNow }
  }

  try {
    // 新发起的运行先占住记录。接手旧记录时 runId 由接手方写入，这里只
    // 确认记录仍然归自己，避免旧实例继续派发。
    if (options.resume !== true) {
      const claimed = await claimRun(sessionId, { mode, target, round, phase: 'next', reviews: [], runId, cancelled: false })
      if (!claimed) {
        reportStarted({ started: false, error: '合并运行记录被另一个实例占用。' })
        settle({ status: 'failed', detail: '合并运行记录被另一个实例占用。' })
        return
      }
    } else if (!(await owned())) {
      reportStarted({ started: false, error: '合并运行已由另一个实例接手。' })
      settle({ status: 'killed', detail: '合并运行已由另一个实例接手。' })
      return
    }

    // 热重载前旧实例可能已经合并完但还没复审完，先把这一轮复审补完。
    // 复审跑完再看暂存批注判断是否收敛，由下面的轮次逻辑决定要不要开下一轮。
    if (pendingReviews.length > 0) {
      const maxRounds = maxRoundsNow()
      progress(`第 ${resumeRound}/${maxRounds} 轮，续跑复审`)
      const { failed, stagedNow } = await runRoundReviews(pendingReviews, resumeRound, maxRounds)
      if (state.disposed || !(await owned())) {
        handoff()
        return
      }
      const remaining = await collectStaged(target)
      notify(agent, roundSummary(resumeRound, stagedNow, remaining, failed))
      progress(`第 ${resumeRound}/${maxRounds} 轮，复审暂存 ${stagedNow} 条批注`)
      // 单次合并补完复审就结束，剩下的新批注留到下一次合并。
      if (mode === 'once') {
        await clearRun(sessionId, runId)
        reportStarted({ started: true, files: pendingReviews.length })
        settle({ status: 'completed', detail: `合并完成：复审暂存 ${stagedNow} 条批注。` })
        return
      }
      if (remaining.length === 0) {
        await clearRun(sessionId, runId)
        settle({ status: 'completed', detail: `循环合并结束：共 ${resumeRound} 轮，复审没有新批注。` })
        return
      }
      await saveRun(sessionId, runId, { target, round, phase: 'next', reviews: [] })
      pendingReviews = []
    }

    // 设置页改动下一轮生效。
    for (;;) {
      const maxRounds = maxRoundsNow()
      if (round > maxRounds) {
        const remaining = await collectStaged(target)
        await clearRun(sessionId, runId)
        reportStarted({ started: false, error: `已完成 ${maxRounds} 轮。` })
        settle({
          status: 'completed',
          detail: `已完成 ${maxRounds} 轮，达到轮次上限，仍有 ${remaining.length} 条批注未收敛。`,
        })
        return
      }
      // 取消状态可能由旧实例或任务列表写入，按磁盘上的记录为准。
      const current = (await readRuns())[sessionId]
      if (current === undefined || current.runId !== runId) {
        settle({ status: 'killed', detail: '合并运行已由另一个实例接手。' })
        return
      }
      if (current.cancelled === true) cancelled = true
      if (cancelled) {
        await clearRun(sessionId, runId)
        reportStarted({ started: false, error: '合并已取消。' })
        settle({ status: 'killed', detail: `已取消，完成 ${round - 1} 轮。` })
        return
      }
      // 插件重载时停在轮次边界。本轮记录留在磁盘上，由新实例接手。
      if (state.disposed) {
        handoff()
        reportStarted({ started: false, error: '插件正在重载。' })
        return
      }
      const staged = initialStaged !== undefined && round === (options.startRound ?? 1)
        ? initialStaged
        : await collectStaged(target)
      initialStaged = undefined
      if (staged.length === 0) {
        // 插件停止或交接的窗口里暂存为空，这时收敛与否留给新实例判断。
        if (state.disposed || !(await owned())) {
          handoff()
          reportStarted({ started: false, error: '插件正在重载。' })
          return
        }
        await clearRun(sessionId, runId)
        reportStarted({ started: false, error: '没有暂存的批注。' })
        settle({ status: 'completed', detail: `合并结束：没有暂存的批注。` })
        return
      }
      progress(`第 ${round}/${maxRounds} 轮，合并 ${staged.length} 个文件，共 ${countStagedAnnotations(staged)} 条批注`)
      // 记下合并前的内容，重载后接手的一方据此只复审改动区段。
      const reviewInputs = []
      for (const item of staged) {
        reviewInputs.push({ filePath: item.filePath, before: await readFile(item.filePath, 'utf8').catch(() => undefined) })
      }
      // 先记 dispatch 阶段。派发和落盘之间如果发生重载，接手方会按
      // 同一轮重新派发；合并收尾后 markRunMerged 会把阶段改成 merge。
      if (!(await saveRun(sessionId, runId, { target, round, phase: 'dispatch', reviews: reviewInputs }))) {
        settle({ status: 'killed', detail: '合并运行已由另一个实例接手。' })
        return
      }
      const dispatch = await scheduleMerge(ctx, log, state, scheduleReview, discardReviews, agent, staged, `${mode} round ${round}`, { managed: true })
      if (!dispatch.started) {
        // 派发前刚好发生重载时不能清记录，否则新实例就没有可接手的
        // 轮次了。记录还停在 dispatch 阶段，新实例会按同一轮重派。
        if (state.disposed) {
          handoff()
          reportStarted({ started: false, error: '插件正在重载。' })
          return
        }
        await clearRun(sessionId, runId)
        reportStarted({ started: false, error: dispatch.error ?? '批注合并派发失败。' })
        settle({ status: 'failed', detail: `批注合并派发失败：${dispatch.error ?? '未知原因'}` })
        return
      }
      reportStarted({ started: true, files: staged.length })
      if (!(await saveRun(sessionId, runId, { target, round, phase: 'merge', reviews: reviewInputs }))) {
        settle({ status: 'killed', detail: '合并运行已由另一个实例接手。' })
        return
      }
      const outcome = await dispatch.done
      // 合并期间发生重载时，记录留在 merge 阶段，新实例据此补复审。
      // 合并失败时 settleMerge 已经把运行记录清掉，这里不再交班。
      if (state.disposed || !(await owned())) {
        if (outcome.completed) handoff()
        else settle({ status: 'failed', detail: `第 ${round} 轮合并未完成，暂存批注保留。` })
        return
      }
      if (!outcome.completed) {
        await clearRun(sessionId, runId)
        settle({ status: 'failed', detail: `第 ${round} 轮合并未完成，暂存批注保留。` })
        return
      }
      // 合并子代理直接写文件，复审由运行自己排。这里拿到的是文件清单和
      // 合并前内容。优先用派发前记下的快照，热重载后补收尾的一方没有
      // sourceBefore，会退化成全量复审。
      const reviews = reviewInputs.length > 0 ? reviewInputs : (outcome.reviewInputs ?? [])
      if (reviews.length === 0) {
        await clearRun(sessionId, runId)
        settle({ status: 'failed', detail: `第 ${round} 轮合并后没有可复审的文件，暂存批注保留。` })
        return
      }
      if (!(await saveRun(sessionId, runId, { target, round, phase: 'review', reviews }))) {
        settle({ status: 'killed', detail: '合并运行已由另一个实例接手。' })
        return
      }
      const { failed, stagedNow } = await runRoundReviews(reviews, round, maxRounds)
      // 复审期间重载时记录留在 review 阶段，新实例会重跑这一轮复审。
      if (state.disposed || !(await owned())) {
        handoff()
        return
      }
      const remaining = await collectStaged(target)
      notify(agent, roundSummary(round, stagedNow, remaining, failed))
      progress(`第 ${round}/${maxRounds} 轮，复审暂存 ${stagedNow} 条批注`)
      // 收尾期间刚好发生重载时，记录还在 review 阶段，交给新实例再判一次。
      if (state.disposed || !(await owned())) {
        handoff()
        return
      }
      // 单次合并复审完就结束，不再开下一轮。
      if (mode === 'once') {
        await clearRun(sessionId, runId)
        settle({ status: 'completed', detail: `合并完成：复审暂存 ${stagedNow} 条批注。` })
        return
      }
      if (remaining.length === 0) {
        await clearRun(sessionId, runId)
        settle({ status: 'completed', detail: `循环合并结束：共 ${round} 轮，复审没有新批注。` })
        return
      }
      round += 1
      await saveRun(sessionId, runId, { target, round, phase: 'next', reviews: [] })
    }
  } catch (error) {
    log.warn('humanize: merge run failed: %s', error)
    reportStarted({ started: false, error: error instanceof Error ? error.message : String(error) })
    // 重载引起的收尾异常把记录留给新实例。其余错误清掉记录，避免反复接手。
    if (!state.disposed) {
      await clearRun(sessionId, runId).catch(() => undefined)
      if (mode === 'once') notify(agent, `批注合并失败：${error instanceof Error ? error.message : String(error)}`)
    }
    settle({
      status: state.disposed ? 'killed' : 'failed',
      detail: state.disposed
        ? '插件已重载，合并交给新实例继续。'
        : `合并失败：${error instanceof Error ? error.message : String(error)}`,
    })
  } finally {
    state.running.delete(agent.id)
  }
}

/**
 * 启动一次合并运行，并给出第一次派发的结果。命令处理函数等 started
 * 决议后立即返回，合并和复审继续在后台跑。
 */
function startMergeRun(ctx, log, config, state, scheduleReview, discardReviews, waitForReviews, agent, target, options) {
  // 同步占住运行锁。命令处理函数在首次派发后就返回，之后的重复派发和
  // agent/created 触发的接手都靠这把锁让路。
  state.running.add(agent.id)
  let settleStarted
  const started = new Promise((resolve) => { settleStarted = resolve })
  const done = runMergeRounds(ctx, log, config, state, scheduleReview, discardReviews, waitForReviews, agent, target, {
    ...options,
    onStarted: settleStarted,
  }).then(() => {
    // 极端情况下运行在首次派发前就走完了，比如运行被另一个实例接手。
    // 这时给等待 started 的命令一个终态，避免它一直挂着。
    settleStarted({ started: false, error: '合并运行已结束。' })
  }).catch((error) => {
    log.warn('humanize: merge run failed: %s', error)
    settleStarted({ started: false, error: error instanceof Error ? error.message : String(error) })
  })
  return { started, done }
}

/**
 * 派发一次合并：组装消息，派发一个一次性子代理按批注改文件，后台等
 * 结果再清暂存批注。
 *
 * 同一个 agent 同时只允许一个合并在进行。
 *
 * 返回是否派发成功。成功时附带一个在收尾完成后结算的 Promise，结算值里有
 * 复审要用的文件清单，调用方从结果里拿。
 */
async function scheduleMerge(ctx, log, state, scheduleReview, discardReviews, agent, staged, origin, options = {}) {
  const managed = options.managed === true || options.loop === true
  if (state.disposed) {
    // 插件正在重载，这里直接返回派发失败。
    return { started: false, error: '插件正在重载' }
  }
  // 压缩和手动命令这类运行之外的触发，遇到运行进行中时一律跳过这次派发。
  if (!managed && state.running.has(agent.id)) {
    log.info('humanize: a merge run is running for agent %s, skipping the %s trigger', agent.id, origin)
    return { started: false }
  }
  if (state.merging.has(agent.id)) {
    log.info('humanize: a merge is already running for agent %s, skipping the %s trigger', agent.id, origin)
    return { started: false }
  }
  state.merging.add(agent.id)
  try {
    // 同实例的合并锁只挡内存里的并发。重载窗口里磁盘上可能还有一份
    // 在途记录，这里先拒绝这次派发，等 reconcile 处理完在途记录再继续。
    const pending = await readPending()
    if (agent.session.id in pending) {
      state.merging.delete(agent.id)
      log.info('humanize: a merge is already pending for session %s, skipping the %s trigger', agent.session.id, origin)
      return { started: false, error: '已有批注合并记录，等它收尾后再派发。' }
    }
    // 记录合并前的文件内容。收尾后的复审只审合并改动的区段。读不到的
    // 文件在复审时改为全量复审。
    for (const item of staged) {
      item.sourceBefore = await readFile(item.filePath, 'utf8').catch(() => undefined)
    }
    const text = await buildMergeMessage(staged)
    // 跟随主会话当前用的模型，合并和主会话用同一套模型。
    const agentOptions = sessionModelConfig(agent)
    const activation = await ctx.subagents.startActivation({
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
      // 子代理跑完后由插件收尾，重载后按在途合并记录补做。
      signal: new AbortController().signal,
      // 结果只回给插件，由插件自己清掉暂存批注并留下结果说明。
      delivery: 'caller',
    })
    // 派发之后这些复审结果都会过期，先让它们停下。
    state.reviewBatchAbort.get(agent.id)?.abort('merge started')
    discardReviews(agent.id)
    // 等结果前落盘，插件中途热重载后也能补做收尾。先按主
    // 会话 id 落盘子代理和文件清单。
    await withFileLock(pendingPath(), async () => {
      const pending = await readPending()
      pending[agent.session.id] = {
        childId: activation.childId,
        files: staged.map((item) => item.filePath),
        ...(managed ? { managed: true } : {}),
      }
      await writePending(pending)
    })
    const done = activation.result.then(
      (result) => settleMerge(ctx, log, state, scheduleReview, agent, staged, result.stopReason === 'completed', { managed }),
      (error) => {
        log.warn('humanize: merge subagent run failed: %s', error)
        return settleMerge(ctx, log, state, scheduleReview, agent, staged, false, { managed })
      },
    ).finally(() => activation.dispose().catch(() => undefined))
    log.info('humanize: merge dispatched (%s) for %d file(s) as subagent %s', origin, staged.length, activation.childId)
    return { started: true, done }
  } catch (error) {
    state.merging.delete(agent.id)
    const message = error instanceof Error ? error.message : String(error)
    log.warn('humanize: failed to dispatch merge: %s', message)
    // web 宿主的用户只看得到终态说明，这里把原因一并带回给命令和任务。
    return { started: false, error: message }
  }
}

/**
 * 合并有结果后收尾，清暂存批注、留结果说明、释放合并锁。
 *
 * 热重载后，有两个地方会同时等着收尾。一个是旧实例的结果回调，另一个是
 * 按在途合并记录补挂的监听。
 * 收尾以摘除在途合并记录为准，摘到的一方继续往下做，另一方直接退出。
 *
 * 通知由摘到记录的一方发出，只做一次。复审由合并运行自己排。
 */
async function settleMerge(ctx, log, state, scheduleReview, agent, staged, completed, options = {}) {
  const managed = options.managed === true || options.loop === true
  let owned = false
  try {
    owned = await dropPending(agent.session.id, async () => {
      // 清暂存批注和推进运行阶段都放在摘除记录之前，接手方在收尾中途
      // 看不到空暂存，不会提前判定收敛。
      if (!completed) {
        // 合并失败时运行直接结束。清掉记录，暂存批注留给用户重试。
        if (managed) await clearRunForSession(agent.session.id)
        return
      }
      // 运行记录这时可能还停在 dispatch 阶段。合并确实完成了，推进到
      // merge，重载接手的一方据此只补复审，不重派这一轮。
      if (managed) await markRunMerged(agent.session.id)
      // 成功就清暂存批注，失败则保留等下次合并。
      for (const item of staged) {
        try {
          await removeStaging(item.filePath)
        } catch (error) {
          log.warn('humanize: failed to clear staging for %s: %s', item.filePath, error)
        }
      }
    })
  } finally {
    // 先摘除在途合并记录再释放合并锁。反过来的话，reconcile 会在两步之间
    // 看到锁已释放而记录还在，再挂一套收尾监听。
    state.merging.delete(agent.id)
  }
  if (!owned) {
    log.info('humanize: merge for session %s was already settled, skipping', agent.session.id)
    return { completed, reviews: [], reviewInputs: [] }
  }
  if (completed) {
    notify(agent, `已按暂存批注修订 ${staged.map((item) => item.filePath).join('、')}。`)
    log.info('humanize: merge settled, cleared %d staged annotation file(s)', staged.length)
  } else {
    notify(agent, '批注合并未完成，暂存批注保留，可以重新执行 /humanize。')
    log.warn('humanize: merge did not complete, %d staged annotation file(s) kept', staged.length)
  }
  if (!completed) return { completed, reviews: [], reviewInputs: [] }
  // 合并产出是新行文，合并本身可能引入新的违规表述。由运行编排的
  // 合并把清单交给运行自己排，重载后由接手的一方补上；独立的合并
  // 没有运行记录，仍然在这里直接排复审。
  const reviews = []
  const reviewInputs = []
  for (const item of staged) {
    const after = await readFile(item.filePath, 'utf8').catch(() => undefined)
    if (after === undefined) continue
    reviewInputs.push({ filePath: item.filePath, before: item.sourceBefore })
    if (!managed) reviews.push(scheduleReview(agent, item.filePath, item.sourceBefore, after))
  }
  return { completed, reviews, reviewInputs }
}

/** 在主会话里留一行合并结果说明。 */
function notify(agent, text) {
  try {
    agent.session.append('user/message', createUserMessage({
      content: [{ type: 'text', text }],
      source: { kind: 'plugin:dsh-humanize', form: 'notice' },
    }), { surfaceOp: 'append' })
  } catch {
    // 主会话已销毁时结果说明无处安放，批注状态保持原样。
  }
}

/**
 * 插件加载时按子代理的现状补做收尾。等合并结果的监听器住在内存里，
 * 插件热重载会把监听器连同上下文一起拆掉，在途合并因此落盘成一份
 * 记录。
 *
 * 子代理还在跑就等它回合结束。已经出过结果就直接收尾。子代理离场
 * 就放弃收尾，批注保留给下次合并。重载窗口里主会话的 agent 可能
 * 还没恢复，记录留到 agent/created 时再收尾。
 */
export async function reconcilePendingMerges(ctx, log, state, scheduleReview) {
  const pending = await readPending()
  const settled = []
  for (const [sessionId, record] of Object.entries(pending)) {
    try {
      const agent = ctx.agents.get(sessionId)
      if (agent === undefined) continue
      // 已有收尾在等这个合并时跳过。合并进行中又触发无关的
      // agent/created 就会走到这里。settleMerge 以在途合并记录幂等，重复
      // 挂监听只是多一次空跑，但还是会惊动合并锁，这里仍然跳过。
      if (state.merging.has(agent.id)) continue
      // 重载恢复的记录没有合并前快照，复审时退化为全量复审。
      const staged = record.files.map((filePath) => ({ filePath }))
      const child = ctx.agents.get(record.childId)
      if (child === undefined) {
        log.warn('humanize: merge subagent %s is gone, keeping %d staged annotation file(s)', record.childId, staged.length)
        notify(agent, '批注合并的子代理已离场，合并未完成，暂存批注保留，可以重新执行 /humanize。')
        // 记录删除走文件锁，和另一个实例的收尾不会互相覆盖。
        await withFileLock(pendingPath(), async () => {
          const map = await readPending()
          delete map[sessionId]
          await writePending(map)
        })
        // 子代理没了，循环也没法接着跑，清掉记录，避免新实例反复接手。
        await clearRunForSession(sessionId)
        continue
      }
      state.merging.add(agent.id)
      const managed = record.managed === true || record.loop === true
      const result = await awaitMergeChild(ctx, log, state, scheduleReview, agent, child, staged, { managed })
      settled.push({ sessionId, managed, ...result })
    } catch (error) {
      log.warn('humanize: failed to reconcile pending merge for %s: %s', sessionId, error)
    }
  }
  return settled
}

/** 等合并子代理出结果。已经有回合结束记录的当场结算，否则挂监听等。 */
function awaitMergeChild(ctx, log, state, scheduleReview, agent, child, staged, options = {}) {
  return new Promise((resolve) => {
    let finished = false
    let offEnd
    let offDisposed
    const cleanup = () => {
      offEnd?.()
      offDisposed?.()
    }
    const finish = async (completed) => {
      if (finished) return
      finished = true
      cleanup()
      try {
        resolve(await settleMerge(ctx, log, state, scheduleReview, agent, staged, completed, options))
      } catch (error) {
        log.warn('humanize: failed to settle merge for %s: %s', agent.session.id, error)
        resolve({ completed: false, reviews: [], reviewInputs: [] })
      }
    }
    const events = child.session.snapshotEvents()
    for (let i = events.length - 1; i >= 0; i--) {
      const event = events[i]
      if (event.type === 'turn/end') {
        void finish(event.data.reason?.kind === 'completed')
        return
      }
    }
    offEnd = ctx.on('session/event', (session, event) => {
      if (session.id !== child.id || event.type !== 'turn/end') return
      void finish(event.data.reason?.kind === 'completed')
    })
    // 子代理中途被销毁时按失败收尾，及时释放合并锁。
    offDisposed = ctx.on('agent/disposed', ({ agent: gone }) => {
      if (gone.id !== child.id) return
      void finish(false)
    })
  })
}

/** 组装发给合并子代理的消息：规范按内容分组，只贴一次，下面按文件列出批注。 */
async function buildMergeMessage(staged) {
  /** @type {Map<string, Array<{ filePath: string, content: string }>>} */
  const groups = new Map()
  for (const item of staged) {
    const chain = await loadSpecChain(item.filePath)
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
