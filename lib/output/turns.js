/**
 * 把主会话每个 turn 的最后一段助手正文追加到会话专属文件。
 *
 * 输出写入后立即审查新增区段。有适用规则且审查产出批注时，再执行一轮
 * 合并与复审。同一会话串行处理，避免下一轮追加和上一轮合并同时改文件。
 * 不同会话的自动合并也串行派发，不互相争抢全局合并锁。
 *
 * @module dsh-humanize/output/turns
 */
import { readdir, readFile } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { collectStaged } from '../shared/staging.js'

/** 标题最多占 96 个 UTF-8 字节，给短 id 和扩展名留出充足空间。 */
const OUTPUT_TITLE_MAX_BYTES = 96
const EMPTY_OUTPUT_TITLE = 'untitled-session'

/** 文件系统不安全字符改成下划线，标题仍保留空格和 Unicode 文字。 */
function cleanOutputTitle(title) {
  const cleaned = (typeof title === 'string' ? title : '')
    .replace(/[<>:"/\\|?*\x00-\x1F\x7F]/g, '_')
    .replace(/\s+/gu, ' ')
    .trim()
    .replace(/[. ]+$/g, '')
  if (cleaned.length === 0) return EMPTY_OUTPUT_TITLE
  if (Buffer.byteLength(cleaned, 'utf8') <= OUTPUT_TITLE_MAX_BYTES) return cleaned
  let bytes = 0
  let truncated = ''
  for (const character of cleaned) {
    const size = Buffer.byteLength(character, 'utf8')
    if (bytes + size > OUTPUT_TITLE_MAX_BYTES) break
    truncated += character
    bytes += size
  }
  return truncated.replace(/[. ]+$/g, '') || EMPTY_OUTPUT_TITLE
}

/** 取可读且足够短的会话后缀。常见的 session-<hex> 形式只保留 hex 前缀。 */
function outputSessionSuffix(sessionId) {
  const id = String(sessionId)
  const body = id.startsWith('session-') ? id.slice('session-'.length) : id
  return cleanOutputTitle(body.slice(0, 12))
}

/** 会话输出位于会话工作目录下的 .agents/output，标题后附短 id 防止同名冲突。 */
export function sessionOutputPath(cwd, sessionId, title) {
  const name = `${cleanOutputTitle(title)}--${outputSessionSuffix(sessionId)}.md`
  return join(resolve(cwd), '.agents', 'output', name)
}

/**
 * 标题改过后仍找回这个会话首次使用的文件。短 id 后缀让查找不依赖标题，
 * 插件重载后也同样有效。存在多份历史文件时优先使用当前标题命中的那份。
 */
async function findExistingSessionOutput(preferredPath, sessionId) {
  const directory = dirname(preferredPath)
  const suffix = `--${outputSessionSuffix(sessionId)}.md`
  let entries
  try {
    entries = await readdir(directory, { withFileTypes: true })
  } catch (error) {
    if (error?.code === 'ENOENT') return undefined
    throw error
  }
  const matches = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(suffix))
    .map((entry) => entry.name)
    .sort()
  if (matches.length === 0) return undefined
  if (matches.includes(basename(preferredPath))) return preferredPath
  return join(directory, matches[0])
}

/** 取一条助手消息的可见正文。推理和工具调用不进入输出。 */
export function assistantVisibleText(message) {
  const text = message.content
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('')
  return text.trim().length > 0 ? text : undefined
}

/** 保留已有内容，在两次输出之间补一个空行。 */
export function appendTurnText(before, text) {
  const ending = text.endsWith('\n') ? '' : '\n'
  if (before === undefined || before.length === 0) return text + ending
  const separator = before.endsWith('\n\n') ? '' : before.endsWith('\n') ? '\n' : '\n\n'
  return before + separator + text + ending
}

/** 读取已有输出，只有文件不存在时按新文件处理。 */
async function readOutput(filePath) {
  try {
    return await readFile(filePath, 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT') return undefined
    throw error
  }
}

/**
 * 注册 turn 输出监听。
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {{ info: Function, warn: Function }} log
 * @param {{ saveTurnOutputs: boolean }} config
 * @param {(agent: import('@deepseek-ai/dsh-agent').Agent, filePath: string, before: string | undefined, after: string) => Promise<{ kind: string, annotations?: number, message?: string }>} scheduleReview
 * @param {(agent: import('@deepseek-ai/dsh-agent').Agent, target: string, staged: Array<{ filePath: string, content: string }>) => { started: Promise<{ started: boolean, error?: string }>, done: Promise<void> }} startMergeOnce
 */
export function registerTurnOutputs(ctx, log, config, scheduleReview, startMergeOnce) {
  /** 每个主会话一条队列，键为 session id。 */
  const sessionQueues = new Map()
  /** 当前 turn 最后一条含可见正文的助手消息。turn 结束后立即删除。 */
  const turnCandidates = new Map()
  /** 自动合并共用一条队列，手动合并仍由原有全局锁仲裁。 */
  let mergeQueue = Promise.resolve()
  let disposed = false

  const enqueueMerge = (operation) => {
    const result = mergeQueue.then(operation)
    mergeQueue = result.catch(() => {})
    return result
  }

  const processTurn = async (agent, preferredPath, text) => {
    if (disposed || !config.saveTurnOutputs) return
    const filePath = await findExistingSessionOutput(preferredPath, agent.session.id) ?? preferredPath
    const before = await readOutput(filePath)
    const after = appendTurnText(before, text)
    await writeFileAtomic(filePath, after, { mode: 0o600, dirMode: 0o700 })
    log.info('humanize: saved final turn output to %s', filePath)

    // 立即审查本次追加的区段，不等待写入审查的冷却间隔。
    const reviewed = await scheduleReview(agent, filePath, before, after)
    if (reviewed.kind !== 'ok') {
      if (reviewed.kind !== 'no-spec' && reviewed.kind !== 'unchanged') {
        log.warn('humanize: output review did not run for %s: %s', filePath, reviewed.message ?? reviewed.kind)
      }
      return
    }
    if ((reviewed.annotations ?? 0) === 0 || disposed || !config.saveTurnOutputs) return
    const staged = await collectStaged(filePath)
    if (staged.length === 0) return

    // 只跑一轮。合并后的复审沿用单次合并的现有行为，新批注留到下次。
    await enqueueMerge(async () => {
      if (disposed || !config.saveTurnOutputs) return
      const run = startMergeOnce(agent, filePath, staged)
      const started = await run.started
      if (!started.started) {
        log.warn('humanize: cannot merge output annotations for %s: %s', filePath, started.error ?? 'unknown error')
        return
      }
      await run.done
    })
  }

  ctx.on('session/event', (session, event) => {
    if (disposed || session.header.origin === 'subagent') return
    if (event.type === 'turn/start') {
      turnCandidates.set(session.id, { turn: event.data.turn, text: undefined })
      return
    }
    if (event.type === 'assistant/message') {
      let candidate = turnCandidates.get(session.id)
      if (candidate?.turn !== event.data.turn) {
        candidate = { turn: event.data.turn, text: undefined }
        turnCandidates.set(session.id, candidate)
      }
      // 即使 assistant 同时带工具调用，其中的可见正文仍属于 turn 末尾候选。
      const text = assistantVisibleText(event.data.message)
      if (text !== undefined) candidate.text = text
      return
    }
    if (event.type !== 'turn/end') return
    const candidate = turnCandidates.get(session.id)
    turnCandidates.delete(session.id)
    if (!config.saveTurnOutputs || candidate?.turn !== event.data.turn || candidate.text === undefined) return
    const agent = ctx.agents.get(session.id)
    if (agent === undefined) return
    const text = candidate.text
    // 工作目录可能已在会话中切换，优先读当前生效值而不是创建时的会话头。
    const cwd = ctx.get('workingDirectory')?.get(session) ?? session.header.cwd ?? process.cwd()
    const title = ctx.get('sessionTitle')?.get(session)?.title
    const filePath = sessionOutputPath(cwd, session.id, title)
    const previous = sessionQueues.get(session.id) ?? Promise.resolve()
    const task = previous.then(() => processTurn(agent, filePath, text))
    // 队列本身始终结算，单次失败不会挡住后续 turn。
    const settled = task.catch((error) => {
      log.warn('humanize: failed to process final turn output for %s: %s', filePath, error)
    })
    sessionQueues.set(session.id, settled)
    void settled.finally(() => {
      if (sessionQueues.get(session.id) === settled) sessionQueues.delete(session.id)
    })
  })

  ctx.on('agent/disposed', ({ agent }) => {
    turnCandidates.delete(agent.session.id)
  })

  ctx.effect(() => () => {
    disposed = true
  }, 'dsh-humanize turn outputs')
}
