/**
 * /humanize-review 命令：主动触发对一个 PATH 的完整审查。只审查受 git
 * 管理的文件，且其后缀在规范链 extensions 声明范围内。审查在后台进行，
 * 进度通过后台任务（ctx.jobs）上报：任务进度的每次替换都会经
 * job-controller 的 roster 流推到浏览器，由客户端渲染成输入框上方的
 * 进度条，同时也出现在会话头部的官方任务列表里（可取消）。
 *
 * 不再走会话日志：session.append 无法给事件打 ignorable 标记，持久化
 * 读取端遇到未知事件类型会整份拒读。jobs 通道是进程内的，不写日志、
 * 不进模型上下文。
 *
 * @module dsh-humanize/review-run
 */
import { execFile } from 'node:child_process'
import { readFile, stat } from 'node:fs/promises'
import { basename, dirname, resolve } from 'node:path'
import { promisify } from 'node:util'
import { chainExtensions, loadSpecChain } from './specs.js'

const execFileAsync = promisify(execFile)

/** 进度行格式：done/total 开头，客户端用它算进度条宽度。 */
function progressLine(done, total, annotations) {
  return `${done}/${total} · 已暂存 ${annotations} 条批注`
}

/** 批次终态的说明文字，落在任务的 detail 上。 */
function outcomeDetail(total, annotations, noSpec, failed) {
  const extras = []
  if (noSpec > 0) extras.push(`${noSpec} 个没有规范可对照`)
  if (failed > 0) extras.push(`${failed} 个失败`)
  return `完成，${total} 个文件，暂存批注 ${annotations} 条${extras.length > 0 ? `，其中 ${extras.join('，')}` : ''}，用 /humanize 合并`
}

/** 结算记录在任务列表里的停留时间，给客户端留出展示终态的窗口。 */
const JOB_LINGER_MS = 8000

/**
 * 通知抑制用的 wait 超时。dsh-tool-jobs 会跳过释放了活跃 wait 的结算
 * （awaited），所以批次全程挂一个 wait：批次由插件自己结算，正常路径
 * 远早于此超时。不设 wait 的话，完成通知会注入模型上下文，agent 空闲
 * 时还会唤醒一个付费 turn。
 *
 * 这个 wait 不能挂任何会提前 abort 的 signal：注册表在 done promise 的
 * 微任务里结算，而 abort 同步把 wait 移出等待集合——一旦 abort 抢在
 * 结算前执行，awaited 就是 false，通知照样发出。
 */
const WAIT_HOLD_MS = 24 * 60 * 60 * 1000

/**
 * 注册 /humanize-review 命令。
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {{ warn: Function }} log
 * @param {{ merging: Set<string>, reviewing: Set<string> }} state - 插件共享状态。
 * @param {(agent: import('@deepseek-ai/dsh-agent').Agent, filePath: string, content: string) => Promise<{ kind: string, annotations?: number }>} scheduleReview
 */
export function registerReviewCommand(ctx, log, state, scheduleReview) {
  ctx.commands.register({
    name: 'humanize-review',
    description: '主动审查一个文件或目录的行文。只审查受 git 管理的文件，且其后缀在规范链 extensions 声明范围内。',
    input: { hint: '文件或目录路径（可空，缺省为当前工作目录）' },
    handler: ({ agent, rawInput }) => {
      // 锁检查放在处理器里同步返回，重复派发在命令行直接报错，不开
      // 新任务，避免冲掉正在运行的批次显示。
      if (state.reviewing.has(agent.id)) {
        return { kind: 'error', text: '已有一个审查任务在进行，等它结束后再派发。' }
      }
      if (state.merging.has(agent.id)) {
        return { kind: 'error', text: '批注合并进行中，合并完成后再审查。' }
      }
      const cwd = agent.session.header.cwd ?? process.cwd()
      const target = rawInput.trim().length > 0 ? resolve(cwd, rawInput.trim()) : cwd
      void runReviewBatch(ctx, log, state, scheduleReview, agent, target)
      return { kind: 'success', text: `已派发审查任务：${target}。进度显示在输入框上方。` }
    },
  })
}

/** 后台审查批次：展开目标、逐个审查、用任务进度行上报进度。进入前已通过锁检查。 */
async function runReviewBatch(ctx, log, state, scheduleReview, agent, target) {
  state.reviewing.add(agent.id)
  const jobs = ctx.get('jobs')
  // 组合里没有 jobs 服务时退化为静默后台审查，只记日志。
  if (jobs === undefined) {
    try {
      const files = await collectTargets(target)
      let annotations = 0
      for (const file of files) {
        const content = await readFile(file, 'utf8').catch(() => undefined)
        if (content === undefined) continue
        const outcome = await scheduleReview(agent, file, undefined, content)
        if (outcome?.kind === 'ok') annotations += outcome.annotations ?? 0
      }
      log.info('humanize: review run finished for %s: %d file(s), %d annotation(s)', target, files.length, annotations)
    } catch (error) {
      log.warn('humanize: review run failed: %s', error)
    } finally {
      state.reviewing.delete(agent.id)
    }
    return
  }
  const sessionId = agent.session.id
  /** @type {(outcome: { status: 'completed' | 'killed' | 'failed', detail?: string }) => void} */
  let settle
  const done = new Promise((resolve) => { settle = resolve })
  const ac = new AbortController()
  /** @type {import('@deepseek-ai/dsh-jobs').JobHandle | undefined} */
  let handle
  // 任务在收集目标之前就建立：展开失败（如路径不存在）也能以 failed
  // 终态呈现在进度条上，而不是只留一条日志。
  let jobId
  try {
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
    // 没有 controller 服务这个 owner 时 start 拒绝。退化为静默审查。
    log.warn('humanize: cannot start review job, running silently: %s', error)
    try {
      const files = await collectTargets(target)
      for (const file of files) {
        const content = await readFile(file, 'utf8').catch(() => undefined)
        if (content !== undefined) await scheduleReview(agent, file, undefined, content)
      }
    } catch (inner) {
      log.warn('humanize: review run failed: %s', inner)
    } finally {
      state.reviewing.delete(agent.id)
    }
    return
  }
  // 批次全程挂一个 wait，让结算被记为 awaited，抑制模型通知。故意不传
  // signal：任何提前 abort 都会让 wait 抢在注册表的微任务结算前离开
  // 等待集合，awaited 变回 false，通知就漏进主会话。
  const waitHold = jobs.wait(jobId, WAIT_HOLD_MS, sessionId).catch(() => undefined)
  try {
    const files = await collectTargets(target)
    if (files.length === 0) {
      settle({ status: 'completed', detail: '没有可审查的文件。只审查受 git 管理且后缀在规范链 extensions 声明范围内的文件。' })
      return
    }
    handle.updateProgress(progressLine(0, files.length, 0))
    let doneCount = 0
    let annotations = 0
    let noSpec = 0
    let failed = 0
    for (const file of files) {
      if (ac.signal.aborted) {
        settle({ status: 'killed', detail: `已取消，完成 ${doneCount}/${files.length}，暂存批注 ${annotations} 条` })
        return
      }
      const content = await readFile(file, 'utf8').catch(() => undefined)
      if (content === undefined) {
        failed += 1
      } else {
        // 主动审查是全量审查，before 传 undefined 表示审查全文。
        const outcome = await scheduleReview(agent, file, undefined, content)
        if (outcome?.kind === 'ok') annotations += outcome.annotations ?? 0
        else if (outcome?.kind === 'no-spec') noSpec += 1
        else failed += 1
      }
      doneCount += 1
      handle.updateProgress(progressLine(doneCount, files.length, annotations))
    }
    // 取消可能落在最后一个文件的审查途中，循环顶的检查来不及生效。
    if (ac.signal.aborted) {
      settle({ status: 'killed', detail: `已取消，完成 ${doneCount}/${files.length}，暂存批注 ${annotations} 条` })
      return
    }
    settle({ status: 'completed', detail: outcomeDetail(files.length, annotations, noSpec, failed) })
  } catch (error) {
    log.warn('humanize: review run failed: %s', error)
    settle({ status: 'failed', detail: `审查任务失败：${error instanceof Error ? error.message : String(error)}` })
  } finally {
    // wait 随结算自然结束，不主动解除（见上方注释）。ac 只服务批次
    // 循环的取消，循环到这里已经停了。
    void waitHold
    // 延迟摘掉结算记录，给客户端留出展示终态的窗口。owner 销毁时
    // 注册表也会清，这里失败无碍。
    const timer = setTimeout(() => {
      try { jobs.remove(jobId, sessionId) } catch { /* 记录已被清理 */ }
    }, JOB_LINGER_MS)
    ctx.on('dispose', () => clearTimeout(timer))
    state.reviewing.delete(agent.id)
  }
}

/** 展开审查目标：受 git 管理的文件，且其后缀在规范链 extensions 声明范围内。 */
async function collectTargets(target) {
  const st = await stat(target).catch(() => undefined)
  if (st === undefined) throw new Error(`路径不存在：${target}`)
  if (st.isFile()) {
    const tracked = await isGitTracked(target)
    return tracked && await extensionDeclared(target) ? [target] : []
  }
  if (st.isDirectory()) {
    const tracked = await gitTrackedFiles(target)
    const results = []
    for (const file of tracked) {
      if (await extensionDeclared(file)) results.push(file)
    }
    return results.sort()
  }
  return []
}

/** 文件后缀是否在其规范链的 extensions 声明范围内。 */
async function extensionDeclared(file) {
  const extensions = chainExtensions(await loadSpecChain(file))
  return extensions.some((ext) => file.endsWith(ext))
}

/** 列出一个目录下所有受 git 管理的文件。目录不在 git 仓库里时返回空。 */
async function gitTrackedFiles(dir) {
  try {
    const { stdout } = await execFileAsync('git', ['ls-files', '-z'], { cwd: dir, maxBuffer: 64 * 1024 * 1024 })
    return stdout.split('\0').filter((name) => name.length > 0).map((name) => resolve(dir, name))
  } catch {
    return []
  }
}

/** 一个文件是否受 git 管理。 */
async function isGitTracked(file) {
  try {
    await execFileAsync('git', ['ls-files', '--error-unmatch', '--', basename(file)], { cwd: dirname(file) })
    return true
  } catch {
    return false
  }
}
