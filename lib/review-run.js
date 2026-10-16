/**
 * /humanize-review 命令：主动触发对一个 PATH 的完整审查。只审查受 git
 * 管理的文件，且其后缀在规范链 extensions 声明范围内。审查在后台进行，
 * 进度和结果以会话通知的形式出现。
 *
 * @module dsh-humanize/review-run
 */
import { execFile } from 'node:child_process'
import { readFile, stat } from 'node:fs/promises'
import { basename, dirname, resolve } from 'node:path'
import { promisify } from 'node:util'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { chainExtensions, loadSpecChain } from './specs.js'

const execFileAsync = promisify(execFile)

/** 文件多于这个数量时，每审查完这么多文件汇报一次进度。 */
const PROGRESS_STEP = 5

/**
 * 往会话里发一条通知。通知是表层追加的普通消息，立即可见，也会进入
 * 模型上下文，所以保持简短。
 * @param {import('@deepseek-ai/dsh-agent').Agent} agent
 * @param {string} summary - 一行的事由，折叠展示用。
 * @param {string} text - 完整内容。
 */
function notify(agent, summary, text) {
  agent.session.append('user/message', createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'plugin', plugin: 'dsh-humanize', form: 'notice', summary },
  }), { surfaceOp: 'append' })
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
      const cwd = agent.session.header.cwd ?? process.cwd()
      const target = rawInput.trim().length > 0 ? resolve(cwd, rawInput.trim()) : cwd
      void runReviewBatch(log, state, scheduleReview, agent, target)
      return { kind: 'success', text: `已派发审查任务：${target}。进度和结果以会话通知的形式出现。` }
    },
  })
}

/** 后台审查批次：展开目标、逐个审查、汇报进度和结果。 */
async function runReviewBatch(log, state, scheduleReview, agent, target) {
  if (state.reviewing.has(agent.id)) {
    notify(agent, '审查任务已在进行', 'dsh-humanize：已有一个审查任务在进行，等它结束后再派发。')
    return
  }
  if (state.merging.has(agent.id)) {
    notify(agent, '批注合并进行中', 'dsh-humanize：批注合并正在进行，合并完成后再审查。')
    return
  }
  state.reviewing.add(agent.id)
  try {
    const files = await collectTargets(target)
    if (files.length === 0) {
      notify(agent, '没有可审查的文件', `dsh-humanize：${target} 没有可审查的文件。只审查受 git 管理的文件，且其后缀在规范链 extensions 声明范围内。`)
      return
    }
    notify(agent, `开始审查 ${files.length} 个文件`, `dsh-humanize：开始审查 ${files.length} 个文件。`)
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
      if (files.length > PROGRESS_STEP && done % PROGRESS_STEP === 0 && done < files.length) {
        notify(agent, `审查进度 ${done}/${files.length}`, `dsh-humanize：审查进度 ${done}/${files.length}。`)
      }
    }
    const extras = [
      ...(noSpec > 0 ? [`${noSpec} 个文件没有规范可对照`] : []),
      ...(failed > 0 ? [`${failed} 个失败`] : []),
    ]
    notify(agent, `审查完成，${annotations} 条批注`, `dsh-humanize：审查完成。共 ${files.length} 个文件，暂存批注 ${annotations} 条${extras.length > 0 ? `，${extras.join('，')}` : ''}。用 /humanize 合并批注。`)
  } catch (error) {
    log.warn('humanize: review run failed: %s', error)
    notify(agent, '审查任务失败', `dsh-humanize：审查任务失败：${error instanceof Error ? error.message : String(error)}`)
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
