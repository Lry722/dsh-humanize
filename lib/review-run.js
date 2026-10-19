/**
 * /humanize-review 命令：主动触发对一个 PATH 的完整审查。只审查受 git
 * 管理且路径命中规范链 include 模式的文件。审查在后台进行，进度通过
 * 后台任务 ctx.jobs 上报。
 *
 * 审查事件只走进程内的 jobs 通道。
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

/** 进度行格式。done/total 开头，客户端用它算进度条宽度。 */
function progressLine(done, total, annotations) {
  return `${done}/${total} · 已暂存 ${annotations} 条批注`
}

/** 失败清单。文件与原因各列最多三个，其余折成计数。 */
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
  if (failures.size === 0) return `${head}，用 /humanize 合并`
  return `${head}，${failures.size} 个失败：${failureSummary(failures)}`
}

/**
 * 固定并发跑完一批。领活是同步的，已在途的调用由各自的 signal 中止。
 * @template T, R
 * @param {readonly T[]} items
 * @param {number} limit - 最大在途数
 * @param {() => boolean} aborted
 * @param {(item: T, index: number) => Promise<R>} worker
 * @returns {Promise<R[]>}
 */
async function runPool(items, limit, aborted, worker) {
  const results = new Array(items.length)
  let next = 0
  const runner = async () => {
    while (true) {
      // aborted 时不再领新活。
      if (aborted()) return
      const index = next
      next += 1
      if (index >= items.length) return
      // 结果按输入顺序返回。
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
 * @param {(filePaths: string[]) => Promise<void>} waitForReviews - 批次结算前等补排的复审落地。
 */
export function registerReviewCommand(ctx, log, config, state, scheduleReview, waitForReviews) {
  ctx.commands.register({
    name: 'humanize-review',
    description: '主动审查一个文件或目录的行文。只审查受 git 管理且路径命中规范链 include 模式的文件。',
    input: { hint: '文件或目录路径，缺省为当前工作目录，可留空' },
    handler: ({ agent, rawInput }) => {
      // 锁检查放在处理器里同步返回。重复派发直接返回错误，正在运行的批次
      // 显示不受影响。
      if (state.reviewing.has(agent.id)) {
        return { kind: 'error', text: '已有一个审查任务在进行，等它结束后再派发。' }
      }
      if (state.merging.has(agent.id)) {
        return { kind: 'error', text: '批注合并进行中，合并完成后再审查。' }
      }
      const target = resolveCommandTarget(agent, rawInput)
      void runReviewBatch(ctx, log, config, state, scheduleReview, waitForReviews, agent, target)
      return { kind: 'success', text: `已派发审查任务：${target}。进度显示在输入框上方。` }
    },
  })
}

/**
 * 没有 jobs 通道时的降级路径。静默后台审查，只记日志。jobs 服务缺失
 * 和任务注册被拒两种情况都落到这里。
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

/** 后台审查批次。展开目标、并行审查，用任务进度行上报进度。失败重试由审查管线统一处理。 */
async function runReviewBatch(ctx, log, config, state, scheduleReview, waitForReviews, agent, target) {
  state.reviewing.add(agent.id)
  try {
    const sessionId = agent.session.id
    const ac = new AbortController()
    // 批次中止器登记进共享状态，合并触发时由管线侧中止整个批次。
    state.reviewBatchAbort.set(agent.id, ac)
    // 审查事件走 jobs 通道而不用会话日志。session.append 无法给事件打
    // ignorable 标记，持久化读取端遇到未知事件类型会整份拒读。任务进度
    // 的每次替换都会经 job-controller 的 roster 流推到浏览器，由客户端
    // 渲染成输入框上方的进度条。任务同时出现在会话头部的任务列表里，
    // 用户可以在那里取消。组合里没有 jobs 服务、或没有 controller 服务
    // 这个 owner 时，退化为静默后台审查。
    const tracked = openJob(ctx, log, {
      jobs: ctx.get('jobs'),
      kind: 'humanize-review',
      label: `行文审查 ${target}`,
      owner: sessionId,
      // 用户在任务列表点取消时中止批次循环，由循环结算 killed。
      cancel(reason) { ac.abort(reason ?? 'cancelled') },
    })
    if (tracked === null) {
      await runSilentBatch(log, config, scheduleReview, agent, target)
      return
    }
    const progress = (line) => tracked.handle?.updateProgress(line)
    try {
      const files = await collectTargets(target)
      if (files.length === 0) {
        tracked.settle({ status: 'completed', detail: '没有可审查的文件。只审查受 git 管理且路径命中规范链 include 模式的文件。' })
        return
      }
      const total = files.length
      const concurrency = clampInt(config.reviewConcurrency, 1, undefined, REVIEW_CONCURRENCY_DEFAULT)
      /** 每个成功文件的批注数。 */
      const annotationsByFile = new Map()
      /** 没有规范可对照的文件，终态计数用。 */
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
        // 主动审查按全文审查。
        const outcome = content === undefined
          ? { kind: 'failed', message: '读取失败' }
          : await scheduleReview(agent, file, undefined, content, ac.signal)
        if (outcome?.kind === 'ok') {
          annotationsByFile.set(file, outcome.annotations ?? 0)
        } else if (outcome?.kind === 'failed') {
          failures.set(file, outcome.message ?? '审查失败')
        } else if (outcome?.kind === 'no-spec') {
          // skipped、stale、discarded、aborted 都不算失败。
          noSpecFiles.add(file)
        }
        finished += 1
        progress(progressLine(finished, total, staged()))
      })
      if (ac.signal.aborted) {
        tracked.settle({ status: 'killed', detail: `已取消，完成 ${finished}/${total}，已暂存 ${staged()} 条批注` })
        return
      }
      // 审查在途期间文件被改时会补排复审，等队列排空再按暂存的实际内容
      // 结算，终态的批注计数才包含补复审的结果。
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
      closeJob(ctx, tracked)
    }
  } finally {
    state.reviewBatchAbort.delete(agent.id)
    state.reviewing.delete(agent.id)
  }
}

/** 展开待审文件。只保留受 git 管理且命中 include 的文件，目录结果按路径排序。 */
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
 * 文件路径是否命中其规范链的 include 模式。链里没有任何 include 声明
 * 时规范作用于所有文件，matcher 的判定结果只在有声明时有效。
 */
export async function includeDeclared(file) {
  const chain = await loadSpecChain(file)
  if (!declaresInclude(chain)) return true
  return createSpecMatcher(chain)(file)
}

/** 列出 git 仓库内一个目录下的受管文件。 */
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
    // --error-unmatch 对未受管文件以退出码 1 失败，其余错误按环境问题处理。
    if (typeof error?.code === 'number' && error.code === 1) return false
    throw gitError(dirname(file), error)
  }
}

/** 把 git 调用失败翻译成面向用户的原因。 */
function gitError(dir, error) {
  // ENOENT 是 git 命令本身不存在，其余失败按目标不在仓库里处理。
  if (error?.code === 'ENOENT') return new Error('git 命令不可用，/humanize-review 只审查受 git 管理的文件')
  return new Error(`目标不在 git 仓库中：${dir}`)
}
