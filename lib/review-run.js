/**
 * /humanize-review 命令：主动触发对一个 PATH 的完整审查。只审查受 git
 * 管理的文件，且其后缀在规范链 extensions 声明范围内。审查在后台进行，
 * 进度写进会话日志的自定义事件，由客户端渲染成进度条。
 *
 * @module dsh-humanize/review-run
 */
import { execFile } from 'node:child_process'
import { readFile, stat } from 'node:fs/promises'
import { basename, dirname, resolve } from 'node:path'
import { promisify } from 'node:util'
import { chainExtensions, loadSpecChain } from './specs.js'

const execFileAsync = promisify(execFile)

/**
 * 往会话日志里写一条审查进度事件。humanize/progress 属于内部事件
 * 类型，只写入会话日志，模型上下文和对话流都看不到它。客户端从
 * 事件流订阅它，渲染成输入框上方的进度条。
 * @param {import('@deepseek-ai/dsh-agent').Agent} agent
 * @param {Record<string, unknown>} data - 进度负载，phase 区分阶段。
 */
function reportProgress(agent, data) {
  agent.session.append('humanize/progress', data)
}

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
      // 锁检查放在处理器里同步返回，重复派发在命令行直接报错，不发
      // 进度事件，避免冲掉正在运行的批次显示。
      if (state.reviewing.has(agent.id)) {
        return { kind: 'error', text: '已有一个审查任务在进行，等它结束后再派发。' }
      }
      if (state.merging.has(agent.id)) {
        return { kind: 'error', text: '批注合并进行中，合并完成后再审查。' }
      }
      const cwd = agent.session.header.cwd ?? process.cwd()
      const target = rawInput.trim().length > 0 ? resolve(cwd, rawInput.trim()) : cwd
      void runReviewBatch(log, state, scheduleReview, agent, target)
      return { kind: 'success', text: `已派发审查任务：${target}。进度显示在输入框上方。` }
    },
  })
}

/** 后台审查批次：展开目标、逐个审查、写进度事件。进入前已通过锁检查。 */
async function runReviewBatch(log, state, scheduleReview, agent, target) {
  state.reviewing.add(agent.id)
  try {
    const files = await collectTargets(target)
    if (files.length === 0) {
      reportProgress(agent, { phase: 'empty', target })
      return
    }
    reportProgress(agent, { phase: 'start', total: files.length })
    let done = 0
    let annotations = 0
    let noSpec = 0
    let failed = 0
    for (const file of files) {
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
      done += 1
      reportProgress(agent, { phase: 'progress', done, total: files.length, annotations })
    }
    reportProgress(agent, { phase: 'done', total: files.length, annotations, noSpec, failed })
  } catch (error) {
    log.warn('humanize: review run failed: %s', error)
    reportProgress(agent, { phase: 'failed', message: error instanceof Error ? error.message : String(error) })
  } finally {
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
