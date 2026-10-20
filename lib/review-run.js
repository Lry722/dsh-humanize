/**
 * /humanize-review 命令：主动触发对一个 PATH 的审查。审查范围
 * 限于 git 仓库里的文件，并且这些文件要命中规范链的 include 模式。
 * 审查在后台进行，进度通过后台任务上报。
 *
 * @module dsh-humanize/review-run
 */
import { execFile } from 'node:child_process'
import { readFile, stat } from 'node:fs/promises'
import { basename, dirname, resolve } from 'node:path'
import { promisify } from 'node:util'
import { countAnnotations } from './annotations.js'
import { resolveCommandTarget } from './command.js'
import { clampInt, REVIEW_CONCURRENCY_DEFAULT } from './defaults.js'
import { closeJob, openJob } from './job-track.js'
import { createSpecMatcher, declaresInclude, loadSpecChain } from './specs.js'
import { readStaging } from './staging.js'

const execFileAsync = promisify(execFile)

/** 进度行格式。开头是完成数和总数，后面是已暂存的批注数。 */
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

/** 批次终态的说明文字，落在任务的 detail 上。 */
function outcomeDetail(total, annotations, noSpec, failures) {
  const extras = []
  if (noSpec > 0) extras.push(`${noSpec} 个没有规范可对照`)
  const head = `完成，${total} 个文件，已暂存 ${annotations} 条批注${extras.length > 0 ? `，其中 ${extras.join('，')}` : ''}`
  if (failures.size === 0) return `${head}，可以运行 /humanize 合并批注`
  return `${head}，${failures.size} 个失败：${failureSummary(failures)}`
}

/**
 * 固定并发跑完一批。每个协程领下标时同步自增，一个文件只领一次。
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
      // 中止后不再领取新文件，已取出的任务仍会跑完。
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
 * 注册 /humanize-review 命令。
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {{ warn: Function, info: Function }} log
 * @param {Record<string, unknown>} config - 插件配置的读取器，并发度和重试次数按批次读取。
 * @param {{ merging: Set<string>, reviewing: Set<string>, reviewBatchAbort: Map<string, AbortController> }} state - 插件共享状态。
 * @param {(agent: import('@deepseek-ai/dsh-agent').Agent, filePath: string, before: string | undefined, after: string, signal?: AbortSignal) => Promise<{ kind: string, annotations?: number, message?: string }>} scheduleReview
 * @param {(filePaths: string[]) => Promise<void>} waitForReviews - 批次结算前等待这些文件的复审跑完。
 */
export function registerReviewCommand(ctx, log, config, state, scheduleReview, waitForReviews) {
  ctx.commands.register({
    name: 'humanize-review',
    description: '主动审查一个文件或目录的行文。审查范围限于 git 仓库里的文件，并且这些文件要命中规范链的 include 模式。',
    input: { hint: '文件或目录路径，缺省为当前工作目录，可留空' },
    handler: ({ agent, rawInput }) => {
      // 锁检查放在处理器里同步返回。重复派发直接返回错误，正在运行的批次
      // 照常推进。
      if (state.reviewing.has(agent.id)) {
        return { kind: 'error', text: '已有一个审查任务在进行，等它结束后再派发。' }
      }
      if (state.merging.has(agent.id)) {
        return { kind: 'error', text: '批注合并进行中，合并完成后再审查。' }
      }
      const target = resolveCommandTarget(agent, rawInput)
      void runReviewBatch(ctx, log, config, state, scheduleReview, waitForReviews, agent, target)
      return { kind: 'success', text: `已派发审查任务。` }
    },
  })
}

/**
 * 静默审查，jobs 服务缺失和任务注册被拒两种情况都走这条路。审查在
 * 后台进行，只记日志。
 */
async function runSilentBatch(log, config, scheduleReview, agent, target) {
  try {
    const files = await collectTargets(target)
    const concurrency = clampInt(config.reviewConcurrency, 1, undefined, REVIEW_CONCURRENCY_DEFAULT)
    let annotations = 0
    await runPool(files, concurrency, () => false, async (file) => {
      const content = await readFile(file, 'utf8').catch(() => undefined)
      if (content === undefined) return
      const outcome = await scheduleReview(agent, file, undefined, content)
      if (outcome?.kind === 'ok') annotations += outcome.annotations ?? 0
    })
    log.info('humanize: review run finished for %s: %d file(s), %d annotation(s)', target, files.length, annotations)
  } catch (error) {
    log.warn('humanize: review run failed: %s', error)
  }
}

/** 后台审查批次。展开目标后按并发度并行审查，并把进度写进任务进度行。 */
async function runReviewBatch(ctx, log, config, state, scheduleReview, waitForReviews, agent, target) {
  state.reviewing.add(agent.id)
  try {
    const sessionId = agent.session.id
    const ac = new AbortController()
    // 批次中止器登记进共享状态，合并触发时由管线侧中止整个批次。
    state.reviewBatchAbort.set(agent.id, ac)
    const tracked = openJob(ctx, log, {
      jobs: ctx.get('jobs'),
      kind: 'humanize-review',
      label: `行文审查 ${target}`,
      owner: sessionId,
      // 用户在任务列表点取消，没有给出原因时用 cancelled 兜底。
      cancel(reason) { ac.abort(reason ?? 'cancelled') },
    })
    // jobs 服务和 owner 对应的 controller 服务都在时 openJob 才返回
    // 任务，否则走静默审查。
    if (tracked === null) {
      await runSilentBatch(log, config, scheduleReview, agent, target)
      return
    }
    // 审查进度通过任务的进度行上报，任务出现在会话头部的任务列表里。
    const progress = (line) => tracked.handle?.updateProgress(line)
    try {
      const files = await collectTargets(target)
      if (files.length === 0) {
        tracked.settle({ status: 'completed', detail: '没有符合范围的文件。审查范围限于 git 仓库里的文件，并且这些文件要命中规范链的 include 模式。' })
        return
      }
      const total = files.length
      const concurrency = clampInt(config.reviewConcurrency, 1, undefined, REVIEW_CONCURRENCY_DEFAULT)
      /** 每个成功文件的批注数。 */
      const annotationsByFile = new Map()
      /** 记录没有规范可对照的文件，结束时用它们统计提示文字。 */
      const noSpecFiles = new Set()
      /** 管线内重试耗尽后仍然失败的文件与原因。 */
      const failures = new Map()
      const staged = () => {
        let sum = 0
        for (const count of annotationsByFile.values()) sum += count
        return sum
      }

      let finished = 0
      progress(progressLine(0, total, 0))
      await runPool(files, concurrency, () => ac.signal.aborted, async (file) => {
        const content = await readFile(file, 'utf8').catch(() => undefined)
        const outcome = content === undefined
          ? { kind: 'failed', message: '读取失败' }
          : await scheduleReview(agent, file, undefined, content, ac.signal)
        if (outcome?.kind === 'ok') {
          annotationsByFile.set(file, outcome.annotations ?? 0)
        } else if (outcome?.kind === 'failed') {
          failures.set(file, outcome.message ?? '审查失败')
        } else if (outcome?.kind === 'no-spec') {
          noSpecFiles.add(file)
        }
        finished += 1
        progress(progressLine(finished, total, staged()))
      })
      if (ac.signal.aborted) {
        tracked.settle({ status: 'killed', detail: `已取消，完成 ${finished}/${total}，已暂存 ${staged()} 条批注` })
        return
      }
      // 审查期间文件被改动会补排复审。等队列排空后，再按暂存的实际
      // 内容结算，终态的批注计数就会包含补复审的结果。
      await waitForReviews(files)
      let stagedTotal = 0
      for (const file of files) {
        stagedTotal += countAnnotations(await readStaging(file) ?? '')
      }
      tracked.settle({
        status: 'completed',
        detail: outcomeDetail(total, stagedTotal, noSpecFiles.size, failures),
      })
    } catch (error) {
      log.warn('humanize: review run failed: %s', error)
      tracked.settle({ status: 'failed', detail: `审查任务失败：${error instanceof Error ? error.message : String(error)}` })
    } finally {
      closeJob(ctx, log, tracked)
    }
  } finally {
    state.reviewBatchAbort.delete(agent.id)
    state.reviewing.delete(agent.id)
  }
}

/** 展开待审文件。只保留 git 仓库里且命中规范链 include 模式的文件，目录结果按路径排序。 */
async function collectTargets(target) {
  const st = await stat(target).catch(() => undefined)
  if (st === undefined) throw new Error(`路径不存在：${target}`)
  if (st.isFile()) {
    const tracked = await isGitTracked(target)
    return tracked && await includeDeclared(target) ? [target] : []
  }
  if (st.isDirectory()) {
    const tracked = await gitTrackedFiles(target)
    const results = []
    for (const file of tracked) {
      if (await includeDeclared(file)) results.push(file)
    }
    return results.sort()
  }
  return []
}

/**
 * 文件路径是否命中其规范链的 include 模式。规范链声明了 include 时
 * 按模式匹配判断，其余情况一律算命中。
 */
export async function includeDeclared(file) {
  const chain = await loadSpecChain(file)
  if (!declaresInclude(chain)) return true
  return createSpecMatcher(chain)(file)
}

/** 列出 git 仓库里某个目录下的文件。 */
async function gitTrackedFiles(dir) {
  try {
    const { stdout } = await execFileAsync('git', ['ls-files', '-z'], { cwd: dir, maxBuffer: 64 * 1024 * 1024 })
    return stdout.split('\0').filter((name) => name.length > 0).map((name) => resolve(dir, name))
  } catch (error) {
    throw gitError(dir, error)
  }
}

async function isGitTracked(file) {
  try {
    await execFileAsync('git', ['ls-files', '--error-unmatch', '--', basename(file)], { cwd: dirname(file) })
    return true
  } catch (error) {
    // --error-unmatch 对未受 git 管理的文件以退出码 1 失败，其余错误按环境问题处理。
    if (typeof error?.code === 'number' && error.code === 1) return false
    throw gitError(dirname(file), error)
  }
}

/** 把 git 调用失败翻译成面向用户的原因。 */
function gitError(dir, error) {
  // ENOENT 是 git 命令本身不存在，其余失败按目标不在仓库里处理。
  if (error?.code === 'ENOENT') return new Error('git 命令不可用，审查范围限于 git 仓库里的文件')
  return new Error(`目标不在 git 仓库中：${dir}`)
}
