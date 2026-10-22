/**
 * /humanize-review 命令：触发对一个 PATH 的审查。默认审查全部受 git
 * 管理的文件，--changed 只审查相对 HEAD 的改动。审查范围限于 git 仓库
 * 里的文件，并且这些文件要命中规范链的 include 模式。审查在后台进行，
 * 进度通过后台任务上报。
 *
 * @module dsh-humanize/review-run
 */
import { readFile } from 'node:fs/promises'
import { basename } from 'node:path'
import { countAnnotations } from './annotations.js'
import { resolveCommandTarget } from './command.js'
import { clampInt, REVIEW_CONCURRENCY_DEFAULT } from './defaults.js'
import { collectTargets } from './git-files.js'
import { openJob } from './job-track.js'
import { readStaging } from './staging.js'

function progressLine(done, total, annotations) {
  return `${done}/${total}，已暂存 ${annotations} 条批注`
}

/** 失败清单。最多列出三条文件名和失败原因，多出来的只统计条数。 */
function failureSummary(failures) {
  const entries = [...failures.entries()]
  const shown = entries.slice(0, 3).map(([file, reason]) => `${basename(file)}，${reason}`)
  const rest = entries.length - shown.length
  return `${shown.join('，')}${rest > 0 ? `，等 ${entries.length} 个` : ''}`
}

function outcomeDetail(total, annotations, noSpec, binary, failures, changed = false) {
  const extras = []
  if (binary > 0) extras.push(`${binary} 个二进制文件跳过`)
  if (noSpec > 0) extras.push(`${noSpec} 个没有对应规范`)
  const noun = changed ? '改动文件' : '文件'
  const head = `完成，共 ${total} 个${noun}。已暂存 ${annotations} 条批注。${extras.length > 0 ? `${extras.join('，')}。` : ''}`
  if (failures.size === 0) return `${head}可以运行 /humanize 合并批注`
  return `${head}${failures.size} 个失败：${failureSummary(failures)}`
}

/**
 * 从命令输入里摘出 --changed，剩下的部分按路径处理。参数中间的空格
 * 原样保留。
 * @param {string} rawInput
 * @returns {{ changed: boolean, pathInput: string }}
 */
export function splitReviewArgs(rawInput) {
  const raw = rawInput.trim()
  const changed = /(^|\s)--changed(?=\s|$)/.test(raw)
  const pathInput = raw.replace(/(^|\s)--changed(?=\s|$)\s*/g, '$1').trim()
  return { changed, pathInput }
}

/**
 * 按给定的并发数同时处理一批任务。一个文件只被领取一次。
 * @template T, R
 * @param {readonly T[]} items
 * @param {number} limit - 最大并发数
 * @param {() => boolean} aborted
 * @param {(item: T, index: number) => Promise<R>} worker
 * @returns {Promise<R[]>} 结果按输入顺序排列。
 */
async function runPool(items, limit, aborted, worker) {
  const results = new Array(items.length)
  let next = 0
  const runner = async () => {
    while (true) {
      // 批次被中止后，只跑完已经领取的文件。
      if (aborted()) return
      const index = next
      next += 1
      if (index >= items.length) return
      results[index] = await worker(items[index], index)
    }
  }
  const width = Math.max(1, Math.min(limit, items.length))
  await Promise.all(Array.from({ length: width }, runner))
  return results
}

/**
 * 一次审查的结果。
 * @typedef {object} ReviewOutcome
 * @property {string} kind - 说明这次审查是什么结果。
 * @property {number} [annotations] - 暂存的批注条数。
 * @property {string} [message] - 失败原因。
 */

/**
 * 发起一次审查的回调。合并收尾后的复审和处理单个文件的审查都调用它。
 * @callback ScheduleReview
 * @param {import('@deepseek-ai/dsh-agent').Agent} agent
 * @param {string} filePath
 * @param {string | undefined} before
 * @param {string} after
 * @param {AbortSignal} [signal]
 * @returns {Promise<ReviewOutcome>}
 */

/**
 * 注册 /humanize-review 命令。
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {{ warn: Function, info: Function }} log
 * @param {Record<string, unknown>} config - 插件配置。
 * @param {ReturnType<import('./pipeline.js').createReviewPipeline>['state']} state - 插件共享状态。
 * @param {ScheduleReview} scheduleReview - 发起一次审查。
 * @param {(filePaths: string[]) => Promise<void>} waitForReviews - 批次结束前等待这些文件的审查跑完。
 */
export function registerReviewCommand(ctx, log, config, state, scheduleReview, waitForReviews) {
  ctx.commands.register({
    name: 'humanize-review',
    description: '审查一个文件或目录的行文。--changed 只审查相对 HEAD 有改动的文件。',
    input: { hint: '文件或目录路径，可留空；--changed 只看改动' },
    handler: ({ agent, rawInput }) => {
      // 同一个 agent 同时只跑一个审查批次，这里先拦住重复的派发。
      if (state.reviewing.has(agent.id)) {
        return { kind: 'error', text: '已有一个审查批次在进行，等它结束后再派发。' }
      }
      if (state.merging.has(agent.id) || state.running.has(agent.id)
        || (state.mergeRun !== null && state.mergeRun !== undefined)) {
        return { kind: 'error', text: '批注合并进行中，等它结束后再审查。' }
      }
      const { changed, pathInput } = splitReviewArgs(rawInput)
      const target = resolveCommandTarget(agent, pathInput)
      void runReviewBatch(ctx, log, config, state, scheduleReview, waitForReviews, agent, target, { changed })
        .catch((error) => log.warn('humanize: review run failed before its job started: %s', error))
      return { kind: 'success', text: changed ? '已派发增量审查。' : '已派发审查批次。' }
    },
  })
}

/**
 * 在后台执行一批审查，只记录日志。
 */
async function runSilentBatch(log, config, scheduleReview, agent, target, ac, changed, isDisposed = () => false) {
  try {
    const files = await collectTargets(target, agent.session.header.cwd, { changed })
    const concurrency = clampInt(config.reviewConcurrency, 1, undefined, REVIEW_CONCURRENCY_DEFAULT)
    let annotations = 0
    let skipped = 0
    let binary = 0
    await runPool(files, concurrency, () => ac.signal.aborted || isDisposed(), async (entry) => {
      const content = await readFile(entry.filePath, 'utf8').catch(() => undefined)
      if (content === undefined) return
      const outcome = await scheduleReview(agent, entry.filePath, entry.before, content, ac.signal)
      if (outcome?.kind === 'ok') annotations += outcome.annotations ?? 0
      else if (outcome?.kind === 'binary') binary += 1
      else if (outcome?.kind === 'skipped' || outcome?.kind === 'discarded' || outcome?.kind === 'aborted') skipped += 1
    })
    log.info('humanize: review run finished for %s: %d file(s), %d annotation(s), %d binary file(s), %d skipped', target, files.length, annotations, binary, skipped)
  } catch (error) {
    log.warn('humanize: review run failed: %s', error)
  }
}

/** 在后台跑完一个审查批次，进度和终态都通过后台任务上报。 */
async function runReviewBatch(ctx, log, config, state, scheduleReview, waitForReviews, agent, target, options = {}) {
  const changed = options.changed === true
  state.reviewing.add(agent.id)
  try {
    const sessionId = agent.session.id
    const ac = new AbortController()
    // 批次中止器登记进共享状态。合并触发时，审查管线用它中止整个批次。
    state.reviewBatchAbort.set(agent.id, ac)
    const tracked = openJob(ctx, log, {
      jobs: ctx.get('jobs'),
      kind: 'humanize-review',
      label: `行文审查 ${target}${changed ? '（仅改动）' : ''}`,
      owner: sessionId,
      // 用户在任务列表点取消时中止整个批次。
      cancel(reason) { ac.abort(reason ?? 'cancelled') },
    })
    if (tracked === null) {
      // 走到这里有两种可能。一种是 jobs 服务缺失，另一种是任务注册被拒绝。
      await runSilentBatch(log, config, scheduleReview, agent, target, ac, changed, () => state.disposed)
      return
    }
    const progress = (line) => tracked.handle?.updateProgress(line)
    try {
      const files = await collectTargets(target, agent.session.header.cwd, { changed })
      if (files.length === 0) {
        tracked.settle({
          status: 'completed',
          detail: changed
            ? '没有检测到需要审查的改动文件。'
            : '该路径下没有找到需要审查的文件。请确认路径位于 git 仓库内，并且符合规范链的 include 模式。',
        })
        return
      }
      const total = files.length
      const concurrency = clampInt(config.reviewConcurrency, 1, undefined, REVIEW_CONCURRENCY_DEFAULT)
      const annotationsByFile = new Map()
      const noSpecFiles = new Set()
      const binaryFiles = new Set()
      const failures = new Map()
      const staged = () => {
        let sum = 0
        for (const count of annotationsByFile.values()) sum += count
        return sum
      }

      let finished = 0
      let skipped = 0
      progress(progressLine(0, total, 0))
      // 批次被中止、插件重载或合并开始时，只跑完已经领取的文件。
      await runPool(files, concurrency, () => ac.signal.aborted || state.disposed || state.merging.has(agent.id), async (entry) => {
        const file = entry.filePath
        const content = await readFile(file, 'utf8').catch(() => undefined)
        const outcome = content === undefined
          ? { kind: 'failed', message: '读取失败' }
          : await scheduleReview(agent, file, entry.before, content, ac.signal)
        if (outcome?.kind === 'ok') {
          annotationsByFile.set(file, outcome.annotations ?? 0)
        } else if (outcome?.kind === 'failed') {
          failures.set(file, outcome.message ?? '审查失败')
        } else if (outcome?.kind === 'no-spec') {
          noSpecFiles.add(file)
        } else if (outcome?.kind === 'binary') {
          binaryFiles.add(file)
        } else if (outcome?.kind === 'skipped' || outcome?.kind === 'discarded' || outcome?.kind === 'aborted') {
          skipped += 1
        }
        finished += 1
        progress(progressLine(finished, total, staged()))
      })
      if (ac.signal.aborted || state.disposed || skipped > 0 || state.merging.has(agent.id)) {
        const reason = state.disposed && !ac.signal.aborted
          ? '插件已重载'
          : ac.signal.aborted ? '已取消' : '批注合并已开始'
        tracked.settle({
          status: 'killed',
          detail: `${reason}，完成 ${finished}/${total}，已暂存 ${staged()} 条批注${skipped > 0 ? `，${skipped} 个文件跳过` : ''}`,
        })
        return
      }
      // 审查期间文件被改动会补排一轮审查，这里要等这些补排的审查都跑完。
      await waitForReviews(files.map((entry) => entry.filePath))
      let stagedTotal = 0
      // 批注总数以暂存文件里的实际内容为准。
      for (const entry of files) {
        stagedTotal += countAnnotations(await readStaging(entry.filePath) ?? '')
      }
      tracked.settle({
        status: 'completed',
        detail: outcomeDetail(total, stagedTotal, noSpecFiles.size, binaryFiles.size, failures, changed),
      })
    } catch (error) {
      log.warn('humanize: review run failed: %s', error)
      tracked.settle({ status: 'failed', detail: `审查批次失败：${error instanceof Error ? error.message : String(error)}` })
    }
  } finally {
    state.reviewBatchAbort.delete(agent.id)
    state.reviewing.delete(agent.id)
  }
}
