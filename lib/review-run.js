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
import { createSpecMatcher, loadSpecChain } from './specs.js'

const execFileAsync = promisify(execFile)

/** 进度行格式。done/total 开头，客户端用它算进度条宽度。 */
function progressLine(done, total, annotations, retries) {
  const retry = retries > 0 ? ` · 重试 ${retries} 次` : ''
  return `${done}/${total} · 已暂存 ${annotations} 条批注${retry}`
}

/** 失败清单。文件与原因各列最多三个，其余折成计数。 */
function failureSummary(failures) {
  const entries = [...failures.entries()]
  const shown = entries.slice(0, 3).map(([file, reason]) => `${basename(file)}，${reason}`)
  const rest = entries.length - shown.length
  return `${shown.join('，')}${rest > 0 ? `，等 ${entries.length} 个` : ''}`
}

/** 批次终态的说明文字，落在任务的 detail 上。 */
function outcomeDetail(total, annotations, noSpec, failures, retries) {
  const extras = []
  if (noSpec > 0) extras.push(`${noSpec} 个没有规范可对照`)
  if (retries > 0) extras.push(`重试 ${retries} 次`)
  const head = `完成，${total} 个文件，已暂存 ${annotations} 条批注${extras.length > 0 ? `，其中 ${extras.join('，')}` : ''}`
  if (failures.size === 0) return `${head}，用 /humanize 合并`
  return `${head}，${failures.size} 个失败：${failureSummary(failures)}`
}

/**
 * 取一个落在范围内的整数，缺省或非法时用 fallback。max 缺省时视为不设
 * 上限，实际并发由待审文件数兜住。
 */
function clampInt(value, min, max, fallback) {
  if (!Number.isInteger(value)) return fallback
  const upper = max === undefined ? Infinity : max
  return Math.max(min, Math.min(upper, value))
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

/** 结算记录在任务列表里的停留时间，给客户端留出展示终态的窗口。 */
const JOB_LINGER_MS = 8000

/** 并行批次大小的缺省值与边界，设置项缺省或写得离谱时用。 */
const DEFAULT_CONCURRENCY = 3
/** 失败文件的重试轮数缺省值。 */
const DEFAULT_RETRIES = 1

/**
 * 通知抑制用的 wait 超时。dsh-tool-jobs 会跳过释放了活跃 wait 的结算，
 * 也就是 awaited 为 true 的结算。批次由插件自己结算，正常路径远早于此
 * 超时。挂上 wait 就能挡住完成通知注入模型上下文，agent 空闲时也不会被
 * 唤醒去做一个付费 turn。
 *
 * 这个 wait 不能挂任何会提前 abort 的 signal。注册表在 done promise 的
 * 微任务里结算，而 abort 同步把 wait 移出等待集合。一旦 abort 抢在结算前
 * 执行，awaited 就是 false，通知照样发出。
 */
const WAIT_HOLD_MS = 24 * 60 * 60 * 1000

/**
 * 注册 /humanize-review 命令。
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {{ warn: Function, info: Function }} log
 * @param {Record<string, unknown>} config - 插件配置的读取器，并发度和重试次数按批次读取。
 * @param {{ merging: Set<string>, reviewing: Set<string> }} state - 插件共享状态。
 * @param {(agent: import('@deepseek-ai/dsh-agent').Agent, filePath: string, before: string | undefined, after: string, signal?: AbortSignal) => Promise<{ kind: string, annotations?: number, message?: string }>} scheduleReview
 */
export function registerReviewCommand(ctx, log, config, state, scheduleReview) {
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
      const cwd = agent.session.header.cwd ?? process.cwd()
      const target = rawInput.trim().length > 0 ? resolve(cwd, rawInput.trim()) : cwd
      void runReviewBatch(ctx, log, config, state, scheduleReview, agent, target)
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
    const concurrency = clampInt(config.reviewConcurrency, 1, undefined, DEFAULT_CONCURRENCY)
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

/** 后台审查批次。展开目标、并行审查、失败自动重试，用任务进度行上报进度。 */
async function runReviewBatch(ctx, log, config, state, scheduleReview, agent, target) {
  state.reviewing.add(agent.id)
  try {
    // 组合里没有 jobs 服务时退化为静默后台审查，只记日志。
    const jobs = ctx.get('jobs')
    if (jobs === undefined) {
      await runSilentBatch(log, config, scheduleReview, agent, target)
      return
    }
    const sessionId = agent.session.id
    /** @type {(outcome: { status: 'completed' | 'killed' | 'failed', detail?: string }) => void} */
    let settle
    const done = new Promise((resolve) => { settle = resolve })
    const ac = new AbortController()
    /** @type {import('@deepseek-ai/dsh-jobs').JobHandle | undefined} */
    let handle
    // 任务在收集目标之前就建立，路径不存在这类展开失败也会以 failed 终态
    // 呈现在进度条上。
    let jobId
    try {
      // 审查事件走 jobs 通道而不用会话日志。session.append 无法给事件打
      // ignorable 标记，持久化读取端遇到未知事件类型会整份拒读。任务进度
      // 的每次替换都会经 job-controller 的 roster 流推到浏览器，由客户端
      // 渲染成输入框上方的进度条。任务同时出现在会话头部的任务列表里，
      // 用户可以在那里取消。
      jobId = jobs.start({
        kind: 'humanize-review',
        label: `行文审查 ${target}`,
        owner: sessionId,
        run(job) {
          handle = job
          return {
            // 用户在任务列表点取消时中止批次循环，由循环结算 killed。
            cancel(reason) { ac.abort(reason ?? 'cancelled') },
            done,
          }
        },
      })
    } catch (error) {
      // 没有 controller 服务这个 owner 时 start 拒绝。退化为静默后台审查。
      log.warn('humanize: cannot start review job, running silently: %s', error)
      await runSilentBatch(log, config, scheduleReview, agent, target)
      return
    }
    // 这里不传 signal，原因见 WAIT_HOLD_MS 的说明。
    const waitHold = jobs.wait(jobId, WAIT_HOLD_MS, sessionId).catch(() => undefined)
    try {
      const files = await collectTargets(target)
      if (files.length === 0) {
        settle({ status: 'completed', detail: '没有可审查的文件。只审查受 git 管理且路径命中规范链 include 模式的文件。' })
        return
      }
      const total = files.length
      const concurrency = clampInt(config.reviewConcurrency, 1, undefined, DEFAULT_CONCURRENCY)
      const maxRetries = clampInt(config.reviewRetries, 0, 3, DEFAULT_RETRIES)
      /** 每个成功文件的批注数，重试后以最后一次为准。 */
      const annotationsByFile = new Map()
      /** 没有规范可对照的文件，终态计数用。 */
      const noSpecFiles = new Set()
      /** 用尽重试额度后仍然失败的文件与最后一次的原因。 */
      const failures = new Map()
      /** 每个文件已尝试的次数，首次也算在内。 */
      const attempts = new Map()
      const staged = () => {
        let sum = 0
        for (const count of annotationsByFile.values()) sum += count
        return sum
      }

      // 滚动窗口。A B C D E、三个一批时，A 失败后第二批是 A D E，空出的
      // 那一格由队列后面的文件补上。
      const queue = [...files]
      let retries = 0
      let finished = 0
      handle.updateProgress(progressLine(0, total, 0, 0))
      while (queue.length > 0) {
        if (ac.signal.aborted) {
          settle({ status: 'killed', detail: `已取消，完成 ${finished}/${total}，已暂存 ${staged()} 条批注` })
          return
        }
        // 每批取队列头部最多 concurrency 个。
        const batch = queue.splice(0, concurrency)
        const again = []
        await runPool(batch, concurrency, () => ac.signal.aborted, async (file) => {
          const tried = (attempts.get(file) ?? 0) + 1
          attempts.set(file, tried)
          const content = await readFile(file, 'utf8').catch(() => undefined)
          // 主动审查按全文审查。
          const outcome = content === undefined
            ? { kind: 'failed', message: '读取失败' }
            : await scheduleReview(agent, file, undefined, content, ac.signal)
          if (outcome?.kind === 'ok') {
            annotationsByFile.set(file, outcome.annotations ?? 0)
            failures.delete(file)
            finished += 1
          } else if (outcome?.kind === 'no-spec' || outcome?.kind === 'skipped' || outcome?.kind === 'stale') {
            if (outcome.kind === 'no-spec') noSpecFiles.add(file)
            failures.delete(file)
            finished += 1
          } else {
            failures.set(file, outcome?.message ?? '审查失败')
            // 单个文件最多尝试 1 + maxRetries 次。额度没用完就插回队首，
            // 额度用尽才计入最终失败。
            if (tried <= maxRetries) again.push(file)
            else finished += 1
          }
          handle.updateProgress(progressLine(finished, total, staged(), retries))
        })
        if (ac.signal.aborted) {
          settle({ status: 'killed', detail: `已取消，完成 ${finished}/${total}，已暂存 ${staged()} 条批注` })
          return
        }
        if (again.length > 0) {
          retries += again.length
          // 失败文件插回队首，和还没处理过的文件凑成下一批。
          queue.unshift(...again)
          log.info('humanize: retrying %d file(s) alongside %d unprocessed', again.length, queue.length - again.length)
        }
      }
      settle({
        status: 'completed',
        detail: outcomeDetail(total, staged(), noSpecFiles.size, failures, retries),
      })
    } catch (error) {
      log.warn('humanize: review run failed: %s', error)
      settle({ status: 'failed', detail: `审查任务失败：${error instanceof Error ? error.message : String(error)}` })
    } finally {
      // wait 随结算自然结束，ac 只服务批次循环的取消，循环到这里已经停了。
      void waitHold
      // 摘除失败无碍，owner 销毁时注册表也会清。
      const timer = setTimeout(() => {
        try { jobs.remove(jobId, sessionId) } catch { /* 记录已被清理 */ }
      }, JOB_LINGER_MS)
      // cordis 不派发 dispose 事件，ctx.on('dispose') 不会触发，清理要用
      // ctx.effect 返回的拆卸函数。
      ctx.effect(() => () => clearTimeout(timer))
    }
  } finally {
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

/** 文件路径是否命中其规范链的 include 模式。 */
async function includeDeclared(file) {
  const chain = await loadSpecChain(file)
  return createSpecMatcher(chain)(file)
}

/** 列出 git 仓库内一个目录下的受管文件，仓库外的目录返回空数组。 */
async function gitTrackedFiles(dir) {
  try {
    const { stdout } = await execFileAsync('git', ['ls-files', '-z'], { cwd: dir, maxBuffer: 64 * 1024 * 1024 })
    return stdout.split('\0').filter((name) => name.length > 0).map((name) => resolve(dir, name))
  } catch {
    return []
  }
}

async function isGitTracked(file) {
  try {
    await execFileAsync('git', ['ls-files', '--error-unmatch', '--', basename(file)], { cwd: dirname(file) })
    return true
  } catch {
    return false
  }
}
