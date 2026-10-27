/**
 * 把主会话每个 turn 的最后一段助手正文写入会话专属的临时文件。
 * 每次覆盖上一版，只保留最新回复。
 *
 * 真实文件位于系统临时目录，规则匹配使用项目内 .agents/output 下的逻辑
 * 路径。逻辑路径只参与 PROSE 发现和匹配，不在项目里创建。写入后立即审查。
 * 有批注时静默执行一轮合并与复审，过程中跳过任务行和会话完成通知。
 * 同一会话串行处理，不同会话的自动合并也串行派发。
 *
 * @module dsh-humanize/output/turns
 */
import { readFile, readdir, rm, rmdir, stat } from 'node:fs/promises'
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
    if (!entry.isFile()) continue
    const isOutput = entry.name.endsWith('.md')
    const isMetadata = entry.name.startsWith('.') && entry.name.endsWith('.md.json')
    if (!isOutput && !isMetadata) continue
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

const OUTPUT_RECORD_PHASES = new Set(['saving', 'processing', 'ready', 'unchanged', 'failed'])

/** 元数据与输出同目录，用户实际阅读和打开的 Markdown 文件名保持不变。 */
function outputMetadataPath(filePath) {
  return join(dirname(filePath), `.${basename(filePath)}.json`)
}

function emptyOutputMetadata(sessionId, phase) {
  return { sessionId, turn: null, filePath: null, phase, updatedAt: null }
}

function publicOutputMetadata(record) {
  const result = {
    sessionId: record.sessionId,
    turn: record.turn,
    filePath: record.filePath,
    phase: record.phase,
    updatedAt: record.updatedAt,
  }
  if (typeof record.error === 'string' && record.error !== '') result.error = record.error
  return result
}

function outputError(error) {
  const message = error instanceof Error ? error.message : String(error)
  return message.slice(0, 500)
}

/** 只接受当前输出文件自己的元数据，拒绝损坏或被替换的 JSON，避免引入别的路径。 */
function parseOutputMetadata(source, sessionId, filePath) {
  const value = JSON.parse(source)
  if (value?.version !== 1 || value.sessionId !== sessionId || value.filePath !== filePath) return undefined
  if (!Number.isInteger(value.turn) || value.turn <= 0 || !OUTPUT_RECORD_PHASES.has(value.phase)) return undefined
  if (!Number.isFinite(value.updatedAt) || (value.error !== undefined && typeof value.error !== 'string')) return undefined
  if (value.bodySaved !== undefined && typeof value.bodySaved !== 'boolean') return undefined
  // 旧版 ready/processing 一定发生在正文写入后；旧版 failed 无法证明写入时机，
  // 保守按未保存处理，避免把同名旧稿当成本轮失败后可读的版本。
  const bodySaved = value.bodySaved ?? (value.phase === 'processing' || value.phase === 'ready')
  return { ...publicOutputMetadata(value), bodySaved }
}

/** 给缺少元数据的旧版输出找一个候选 turn。新版恢复以持久化记录为准。 */
function latestOutputTurn(session) {
  if (session === undefined) return null
  const events = session.snapshotEvents()
  const ended = new Set()
  for (const event of events) {
    if (event.type === 'turn/end') ended.add(event.data.turn)
  }
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event.type !== 'assistant/message' || !ended.has(event.data.turn)) continue
    if (assistantVisibleText(event.data.message) !== undefined) return event.data.turn
  }
  return null
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
  /** 最新输出的权威轮次和状态，旧任务不能覆盖新任务的状态。 */
  const records = new Map()
  const currentRuns = new Map()
  const metadataQueues = new Map()
  /** 自动合并共用一条队列，手动合并仍由原有全局锁仲裁。 */
  let mergeQueue = Promise.resolve()
  let lastCleanup = 0
  let disposed = false

  const enqueueMerge = (operation) => {
    const result = mergeQueue.then(operation)
    mergeQueue = result.catch(() => {})
    return result
  }

  /** 状态写入串行化，较慢的早期状态不能覆盖较晚状态。 */
  const persistRecord = (record) => {
    const previous = metadataQueues.get(record.sessionId) ?? Promise.resolve()
    const task = previous.then(() => writeFileAtomic(
      outputMetadataPath(record.filePath),
      `${JSON.stringify({ version: 1, ...record })}\n`,
      { mode: 0o600, dirMode: 0o700 },
    ))
    const settled = task.catch((error) => {
      log.warn('humanize: failed to save turn output metadata for %s: %s', record.filePath, error)
    })
    metadataQueues.set(record.sessionId, settled)
    void settled.finally(() => {
      if (metadataQueues.get(record.sessionId) === settled) metadataQueues.delete(record.sessionId)
    })
    return settled
  }

  const report = (run, phase, filePath, error) => {
    if (currentRuns.get(run.sessionId) !== run) return Promise.resolve()
    const record = {
      sessionId: run.sessionId,
      turn: run.turn,
      filePath,
      phase,
      bodySaved: run.bodySaved === true,
      updatedAt: Date.now(),
      ...(error === undefined ? {} : { error }),
    }
    records.set(run.sessionId, record)
    return persistRecord(record)
  }

  const findOutput = async (sessionId) => {
    // 空标题只用于生成优选路径。查找仍按现有短 ID 后缀匹配所有标题。
    const preferredPath = sessionOutputPath(turnOutputRoot(), sessionId, '')
    return findExistingSessionOutput(preferredPath, sessionId)
  }

  /** 给 GUI 的只读查询。文件状态每次重新检查，不把浏览器输入当路径。 */
  const readOutput = async (sessionId) => {
    if (!config.saveTurnOutputs) return emptyOutputMetadata(sessionId, 'disabled')
    // 终态对调用方可见前，先让对应元数据落盘。否则紧接重载会把旧
    // processing 误当成中断。原子写仍保证重载期间不会读到半份 JSON。
    await metadataQueues.get(sessionId)
    let record = records.get(sessionId)
    if (record === undefined) {
      const filePath = await findOutput(sessionId)
      if (filePath === undefined) return emptyOutputMetadata(sessionId, 'missing')
      let persisted
      try {
        persisted = parseOutputMetadata(await readFile(outputMetadataPath(filePath), 'utf8'), sessionId, filePath)
      } catch {
        // 旧版输出没有元数据，损坏的元数据也不能阻止正文预览。
      }
      if (persisted !== undefined) {
        record = persisted
        if (record.phase === 'saving' || record.phase === 'processing') {
          record = { ...record, phase: 'failed', error: 'Output processing was interrupted.' }
        }
        records.set(sessionId, record)
      } else {
        let info
        try {
          info = await stat(filePath)
        } catch (error) {
          if (error?.code === 'ENOENT') return emptyOutputMetadata(sessionId, 'missing')
          throw error
        }
        record = {
          sessionId,
          turn: latestOutputTurn(ctx.agents.get(sessionId)?.session),
          filePath,
          phase: 'ready',
          bodySaved: true,
          updatedAt: info.mtimeMs,
        }
      }
    }
    if (record.phase === 'saving' || record.phase === 'processing') return publicOutputMetadata(record)
    // 同名文件可能仍是上一 turn。本轮正文未保存成功时，所有终态都按 missing。
    if ((record.phase === 'ready' || record.phase === 'unchanged' || record.phase === 'failed') && record.bodySaved !== true) {
      return { ...publicOutputMetadata(record), phase: 'missing', error: undefined }
    }
    let info
    try {
      info = await stat(record.filePath)
    } catch (error) {
      if (error?.code === 'ENOENT') return { ...publicOutputMetadata(record), phase: 'missing', error: undefined }
      throw error
    }
    if (Date.now() - info.mtimeMs > OUTPUT_TTL_MS) {
      return { ...publicOutputMetadata(record), phase: 'expired', error: undefined }
    }
    return publicOutputMetadata(record)
  }

  const processTurn = async (agent, cwd, preferredPath, text, run) => {
    if (disposed || !config.saveTurnOutputs) {
      await report(run, 'failed', preferredPath, 'Output saving is not active.')
      return
    }
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
    run.filePath = filePath
    await report(run, 'saving', filePath)
    const after = turnOutputText(text)
    await writeFileAtomic(filePath, after, { mode: 0o600, dirMode: 0o700 })
    run.bodySaved = true
    await report(run, 'processing', filePath)
    const reportFinal = async (error) => {
      if (error !== undefined) return report(run, 'failed', filePath, error)
      const finalText = await readFile(filePath, 'utf8')
      return report(run, finalText === after ? 'unchanged' : 'ready', filePath)
    }
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
      const skipped = reviewed.kind === 'no-spec' || reviewed.kind === 'unchanged'
      if (!skipped) log.warn('humanize: output review did not run for %s: %s', filePath, reviewed.message ?? reviewed.kind)
      await reportFinal(skipped ? undefined : reviewed.message ?? reviewed.kind)
      return
    }
    if ((reviewed.annotations ?? 0) === 0 || disposed || !config.saveTurnOutputs) {
      await reportFinal()
      return
    }
    const staged = (await collectStaged(filePath)).map((item) => ({ ...item, rulePath }))
    if (staged.length === 0) {
      await reportFinal()
      return
    }

    // 自动输出合并只执行一轮，quiet 同时抑制任务进度和会话结果通知。
    let mergeError
    await enqueueMerge(async () => {
      if (disposed || !config.saveTurnOutputs) return
      const merge = startMergeOnce(agent, filePath, staged, { quiet: true })
      const started = await merge.started
      if (!started.started) {
        mergeError = started.error ?? 'unknown error'
        log.warn('humanize: cannot merge output annotations for %s: %s', filePath, mergeError)
        return
      }
      await merge.done
    })
    await reportFinal(mergeError)
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
    const run = { sessionId: session.id, turn: candidate.turn, bodySaved: false }
    currentRuns.set(session.id, run)
    // 新 turn 一入队就作废旧卡片，即使它还在等待上一轮处理结束。
    void report(run, 'saving', filePath)
    const previous = sessionQueues.get(session.id) ?? Promise.resolve()
    const task = previous.then(() => processTurn(agent, cwd, filePath, text, run))
    // 队列本身始终结算，单次失败后，后续 turn 仍会继续处理。
    const settled = task.catch(async (error) => {
      await report(run, 'failed', run.filePath ?? filePath, outputError(error))
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

  return { readOutput }
}
