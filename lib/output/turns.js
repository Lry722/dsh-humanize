/**
 * 把主会话每个 turn 的最后一段助手正文写入会话专属的临时文件。
 * 每次覆盖上一版，只保留最新回复。
 *
 * 真实文件位于系统临时目录，规则匹配使用项目内 .agents/output 下的逻辑
 * 路径。逻辑路径只参与 PROSE 发现和匹配，不在项目里创建。写入后立即审查。
 * 有批注时静默执行一轮合并与复审，不创建任务行或会话完成通知。
 * 同一会话串行处理，不同会话的自动合并也串行派发。
 *
 * @module dsh-humanize/output/turns
 */
import { readdir, rm, rmdir, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { collectStaged, removeStaging } from '../shared/staging.js'

const OUTPUT_TITLE_MAX_BYTES = 96
const EMPTY_OUTPUT_TITLE = 'untitled-session'
const OUTPUT_TTL_MS = 24 * 60 * 60 * 1000
const OUTPUT_CLEAN_INTERVAL_MS = 60 * 60 * 1000

/** 默认输出按用户隔离，目录权限仍由原子写入设为 0o700。 */
const defaultTurnOutputRoot = () => join(tmpdir(), `dsh-humanize-${process.getuid?.() ?? 'user'}`, 'output')
let resolveTurnOutputRoot = defaultTurnOutputRoot

/** 测试可覆盖输出根目录。不传参数时恢复系统临时目录。 */
export function setTurnOutputRootResolver(next) {
  resolveTurnOutputRoot = next ?? defaultTurnOutputRoot
}

export function turnOutputRoot() {
  return resolveTurnOutputRoot()
}

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

/** 取足够短、能区分不同会话的后缀。常见的 session-<hex> 形式只保留 hex 前缀。 */
function outputSessionSuffix(sessionId) {
  const id = String(sessionId)
  const body = id.startsWith('session-') ? id.slice('session-'.length) : id
  return cleanOutputTitle(body.slice(0, 12))
}

/** 真实输出直接位于临时输出根目录，标题后附短 id 防止同名冲突。 */
export function sessionOutputPath(root, sessionId, title) {
  const name = `${cleanOutputTitle(title)}--${outputSessionSuffix(sessionId)}.md`
  return join(resolve(root), name)
}

/** 只用于规则发现和匹配的项目内逻辑路径。此函数不会创建任何目录。 */
export function sessionOutputRulePath(cwd, filePath) {
  return join(resolve(cwd), '.agents', 'output', basename(filePath))
}

/** 标题改过后仍按短 id 找回首次使用的真实文件，插件重载后也同样有效。 */
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

/** 新版首次写入后移除这个会话旧版留在项目里的输出和批注。 */
async function clearLegacyOutputs(cwd, sessionId) {
  const directory = join(resolve(cwd), '.agents', 'output')
  let entries
  try {
    entries = await readdir(directory, { withFileTypes: true })
  } catch (error) {
    if (error?.code === 'ENOENT') return
    throw error
  }
  const suffix = `--${outputSessionSuffix(sessionId)}.md`
  const idOnlyName = `${encodeURIComponent(sessionId)}.md`
  for (const entry of entries) {
    if (!entry.isFile() || (!entry.name.endsWith(suffix) && entry.name !== idOnlyName)) continue
    const legacyPath = join(directory, entry.name)
    await removeStaging(legacyPath, 'turn-output-move')
    await rm(legacyPath, { force: true })
  }
  // 只移除已经为空的 output 目录，.agents 里可能还有用户的规则。
  await rmdir(directory).catch((error) => {
    if (error?.code !== 'ENOENT' && error?.code !== 'ENOTEMPTY' && error?.code !== 'EEXIST') throw error
  })
}

/** 清理 24 小时未更新的输出。清理失败不阻挡本轮保存。 */
async function cleanExpiredOutputs(root) {
  let entries
  try {
    entries = await readdir(root, { withFileTypes: true })
  } catch (error) {
    if (error?.code === 'ENOENT') return
    throw error
  }
  const now = Date.now()
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.md')) continue
    const filePath = join(root, entry.name)
    const info = await stat(filePath)
    if (now - info.mtimeMs > OUTPUT_TTL_MS) await rm(filePath, { force: true })
  }
}

/** 取一条助手消息的可见正文，推理和工具调用会被过滤掉。 */
export function assistantVisibleText(message) {
  const text = message.content
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('')
  return text.trim().length > 0 ? text : undefined
}

/** 每轮正文独立成文，只补一个末尾换行，不保留上一轮内容。 */
export function turnOutputText(text) {
  return text + (text.endsWith('\n') ? '' : '\n')
}

/**
 * 注册 turn 输出监听。
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {{ info: Function, warn: Function }} log
 * @param {{ saveTurnOutputs: boolean }} config
 * @param {(agent: import('@deepseek-ai/dsh-agent').Agent, filePath: string, before: string | undefined, after: string, signal?: AbortSignal, rulePath?: string) => Promise<{ kind: string, annotations?: number, message?: string }>} scheduleReview
 * @param {(agent: import('@deepseek-ai/dsh-agent').Agent, target: string, staged: Array<{ filePath: string, content: string, rulePath?: string }>, options?: { quiet?: boolean }) => { started: Promise<{ started: boolean, error?: string }>, done: Promise<void> }} startMergeOnce
 */
export function registerTurnOutputs(ctx, log, config, scheduleReview, startMergeOnce) {
  /** 每个主会话一条队列，键为 session id。 */
  const sessionQueues = new Map()
  /** 当前 turn 最后一条含可见正文的助手消息。turn 结束后立即删除。 */
  const turnCandidates = new Map()
  /** 自动合并共用一条队列，手动合并仍由原有全局锁仲裁。 */
  let mergeQueue = Promise.resolve()
  let lastCleanup = 0
  let disposed = false

  const enqueueMerge = (operation) => {
    const result = mergeQueue.then(operation)
    mergeQueue = result.catch(() => {})
    return result
  }

  const processTurn = async (agent, cwd, preferredPath, text) => {
    if (disposed || !config.saveTurnOutputs) return
    const now = Date.now()
    if (now - lastCleanup >= OUTPUT_CLEAN_INTERVAL_MS) {
      lastCleanup = now
      try {
        await cleanExpiredOutputs(dirname(preferredPath))
      } catch (error) {
        log.warn('humanize: failed to clean expired turn outputs: %s', error)
      }
    }
    const filePath = await findExistingSessionOutput(preferredPath, agent.session.id) ?? preferredPath
    const after = turnOutputText(text)
    await writeFileAtomic(filePath, after, { mode: 0o600, dirMode: 0o700 })
    // 上一轮的批注对应已被覆盖的正文，先归档并清除，再全量审查最新回复。
    await removeStaging(filePath, 'turn-output-replace')
    try {
      await clearLegacyOutputs(cwd, agent.session.id)
    } catch (error) {
      log.warn('humanize: failed to remove legacy project output for %s: %s', filePath, error)
    }
    const rulePath = sessionOutputRulePath(cwd, filePath)
    log.info('humanize: saved final turn output to %s', filePath)

    const reviewed = await scheduleReview(agent, filePath, undefined, after, undefined, rulePath)
    if (reviewed.kind !== 'ok') {
      if (reviewed.kind !== 'no-spec' && reviewed.kind !== 'unchanged') {
        log.warn('humanize: output review did not run for %s: %s', filePath, reviewed.message ?? reviewed.kind)
      }
      return
    }
    if ((reviewed.annotations ?? 0) === 0 || disposed || !config.saveTurnOutputs) return
    const staged = (await collectStaged(filePath)).map((item) => ({ ...item, rulePath }))
    if (staged.length === 0) return

    // 自动输出合并只执行一轮，quiet 同时抑制任务进度和会话结果通知。
    await enqueueMerge(async () => {
      if (disposed || !config.saveTurnOutputs) return
      const run = startMergeOnce(agent, filePath, staged, { quiet: true })
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
    // cwd 只决定规则归属。真实输出始终放在系统临时目录。
    const cwd = ctx.get('workingDirectory')?.get(session) ?? session.header.cwd ?? process.cwd()
    const title = ctx.get('sessionTitle')?.get(session)?.title
    const filePath = sessionOutputPath(turnOutputRoot(), session.id, title)
    const previous = sessionQueues.get(session.id) ?? Promise.resolve()
    const task = previous.then(() => processTurn(agent, cwd, filePath, text))
    // 队列本身始终结算，单次失败后，后续 turn 仍会继续处理。
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
