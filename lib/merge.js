/**
 * 延迟合并。行文批注先暂存到文件里，合并有两个触发时机。用户输入
 * /humanize 命令时，按命令指定的范围合并。会话发生上下文压缩时，
 * 合并整个项目的全部暂存批注。插件把规范和批注发给主模型，主模型
 * 自行读取文件当前内容完成编辑，然后遮蔽这段处理上下文。
 *
 * @module dsh-humanize/merge
 */
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { loadPrompt } from './prompts.js'
import { loadSpecChain, renderSpecChain } from './specs.js'
import { collectStaged, removeStaging } from './staging.js'

/**
 * 在途合并的落盘记录。合并的收尾靠内存里的监听器等回合结束，插件
 * 热重载会把监听器连同上下文一起拆掉，批注就永远清不掉。派发时把
 * 待收尾的合并写进这个文件，插件加载时对照会话日志补做收尾。
 * 键是 session id，值是 { markerSeq, files }。
 */
function pendingPath() {
  return dshHomePath('humanize', 'merge-pending.json')
}

async function readPending() {
  try {
    const parsed = JSON.parse(await readFile(pendingPath(), 'utf8'))
    return parsed !== null && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

async function writePending(map) {
  if (Object.keys(map).length === 0) {
    await rm(pendingPath(), { force: true })
    return
  }
  await mkdir(dirname(pendingPath()), { recursive: true })
  await writeFile(pendingPath(), JSON.stringify(map), 'utf8')
}

/** 认领一个会话的在途合并记录。记录不存在说明已被其他路径收尾。 */
async function takePending(sessionId) {
  const map = await readPending()
  if (!(sessionId in map)) return false
  delete map[sessionId]
  await writePending(map)
  return true
}

async function dropPending(sessionId) {
  const map = await readPending()
  if (!(sessionId in map)) return
  delete map[sessionId]
  await writePending(map)
}

/**
 * 注册 /humanize 命令和 compaction/end 触发。
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {{ mergeOnCompaction: boolean }} config
 * @param {{ info: Function, warn: Function }} log
 * @param {{ merging: Set<string> }} state - 插件共享状态。
 */
export function registerMerge(ctx, config, log, state) {
  ctx.commands.register({
    name: 'humanize',
    description: '合并 dsh-humanize 暂存的行文批注。参数为文件或目录路径，缺省为当前工作目录。',
    input: { hint: '文件或目录路径（可空）' },
    handler: async ({ agent, rawInput }) => {
      const cwd = agent.session.header.cwd ?? process.cwd()
      const target = rawInput.trim().length > 0 ? resolve(cwd, rawInput.trim()) : cwd
      const staged = await collectStaged(target)
      if (staged.length === 0) return { kind: 'error', text: `没有暂存的批注：${target}` }
      await scheduleMerge(ctx, log, state, agent, staged, 'command')
      return { kind: 'success', text: `已派发批注合并任务，涉及 ${staged.length} 个文件，完成后将清空对应批注。` }
    },
  })
  ctx.on('session/event', (session, event) => {
    if (!config.mergeOnCompaction) return
    if (event.type !== 'compaction/end') return
    if (event.data.error !== undefined) return
    const agent = ctx.agents.get(session.id)
    if (agent === undefined) return
    const cwd = session.header.cwd ?? process.cwd()
    collectStaged(cwd).then((staged) => {
      if (staged.length === 0) return
      return scheduleMerge(ctx, log, state, agent, staged, 'compaction')
    }, (error) => log.warn('humanize: failed to collect staged annotations after compaction: %s', error))
  })
}

/**
 * 派发一次合并：组装消息发给主模型，等合并回合结束后清空批注并遮蔽
 * 处理上下文。同一个 agent 同时只允许一个合并在进行。
 */
async function scheduleMerge(ctx, log, state, agent, staged, origin) {
  if (state.merging.has(agent.id)) {
    log.info('humanize: a merge is already running for agent %s, skipping the %s trigger', agent.id, origin)
    return
  }
  state.merging.add(agent.id)
  try {
    const text = await buildMergeMessage(staged)
    // 在 followup 之前记下日志位置，合并回合的全部事件都在这个位置之后。
    const markerSeq = agent.session.seq
    // 派发前先落盘，插件中途热重载也能在重新加载后补做收尾。
    const pending = await readPending()
    pending[agent.session.id] = { markerSeq, files: staged.map((item) => item.filePath) }
    await writePending(pending)
    agent.followup(createUserMessage({
      content: [{ type: 'text', text }],
      source: { kind: 'plugin:dsh-humanize' },
    }))
    afterMergeTurn(ctx, agent, markerSeq, {
      done: (messageSeq, turnEndSeq) => finalizeMerge(ctx, log, state, agent, staged, messageSeq, turnEndSeq),
      abandon: () => {
        state.merging.delete(agent.id)
        void dropPending(agent.session.id)
        log.info('humanize: merge turn never ran for agent %s, merge lock released', agent.id)
      },
    })
    log.info('humanize: merge dispatched (%s) for %d file(s)', origin, staged.length)
  } catch (error) {
    state.merging.delete(agent.id)
    log.warn('humanize: failed to dispatch merge: %s', error)
  }
}

/** 等合并消息进日志，再等处理它的回合结束，然后触发 done 回调。 */
function afterMergeTurn(ctx, agent, markerSeq, { done, abandon }) {
  let offMessage = null
  let offEnd = null
  const cleanup = () => {
    offMessage?.()
    offEnd?.()
    offDisposed()
  }
  // agent 在消息进日志前被销毁时触发 abandon，防止合并锁永远占住。
  const offDisposed = ctx.on('agent/disposed', ({ agent: gone }) => {
    if (gone.id !== agent.id) return
    cleanup()
    abandon()
  })
  // followup 只进收件箱，消息被回合认领时才进日志，所以直接监听消息事件。
  offMessage = ctx.on('session/event', (session, event) => {
    if (session.id !== agent.session.id) return
    if (event.type !== 'user/message' || event.seq < markerSeq) return
    const source = event.data?.source
    if (source?.kind !== 'plugin:dsh-humanize' || source.form === 'notice') return
    offMessage()
    offMessage = null
    offEnd = armTurnEnd(ctx, agent, event.seq, { done, abandon })
  })
}

/** 合并消息已在日志里时，只等处理它的回合结束。 */
function armTurnEnd(ctx, agent, messageSeq, { done, abandon }) {
  const offEnd = ctx.on('session/event', (session, event) => {
    if (session.id !== agent.session.id) return
    if (event.type !== 'turn/end' || event.seq < messageSeq) return
    offDisposed()
    offEnd()
    done(messageSeq, event.seq)
  })
  const offDisposed = ctx.on('agent/disposed', ({ agent: gone }) => {
    if (gone.id !== agent.id) return
    offEnd()
    offDisposed()
    abandon()
  })
  return offEnd
}

/** 在会话日志里找 markerSeq 之后第一条本插件的合并消息。 */
function findMergeMessageSeq(events, markerSeq) {
  for (const event of events) {
    if (event.seq < markerSeq) continue
    if (event.type !== 'user/message') continue
    const source = event.data?.source
    if (source?.kind !== 'plugin:dsh-humanize' || source.form === 'notice') continue
    return event.seq
  }
  return undefined
}

/** 找 messageSeq 之后第一个回合结束事件。 */
function findTurnEndSeq(events, messageSeq) {
  for (const event of events) {
    if (event.seq < messageSeq) continue
    if (event.type === 'turn/end') return event.seq
  }
  return undefined
}

/**
 * 插件加载时补做在途合并的收尾。对照会话日志判断合并回合的状态：
 * 已结束的当场清空批注并遮蔽，仍在进行的重新挂上监听等结束。重载
 * 窗口里 agent 可能还没恢复，记录留到 agent/created 时再收尾。
 */
export async function reconcilePendingMerges(ctx, log, state) {
  const pending = await readPending()
  let changed = false
  for (const [sessionId, record] of Object.entries(pending)) {
    let settled = false
    try {
      const agent = ctx.agents.get(sessionId)
      if (agent === undefined) continue
      const events = agent.session.snapshotEvents()
      const messageSeq = findMergeMessageSeq(events, record.markerSeq)
      const staged = record.files.map((filePath) => ({ filePath }))
      if (messageSeq === undefined) {
        state.merging.add(agent.id)
        afterMergeTurn(ctx, agent, record.markerSeq, {
          done: (s, e) => finalizeMerge(ctx, log, state, agent, staged, s, e),
          abandon: () => {
            state.merging.delete(agent.id)
            void dropPending(sessionId)
          },
        })
      } else {
        const turnEndSeq = findTurnEndSeq(events, messageSeq)
        if (turnEndSeq === undefined) {
          state.merging.add(agent.id)
          armTurnEnd(ctx, agent, messageSeq, {
            done: (s, e) => finalizeMerge(ctx, log, state, agent, staged, s, e),
            abandon: () => {
              state.merging.delete(agent.id)
              void dropPending(sessionId)
            },
          })
        } else {
          await finalizeMerge(ctx, log, state, agent, staged, messageSeq, turnEndSeq)
          settled = true
        }
      }
    } catch (error) {
      log.warn('humanize: failed to reconcile pending merge for %s: %s', sessionId, error)
    }
    if (settled) {
      delete pending[sessionId]
      changed = true
    }
  }
  if (changed) await writePending(pending)
}

/** 组装发给主模型的合并消息：规范按内容分组，只贴一次，下面按文件列出批注。 */
async function buildMergeMessage(staged) {
  /** @type {Map<string, Array<{ filePath: string, content: string }>>} */
  const groups = new Map()
  for (const item of staged) {
    const chain = await loadSpecChain(item.filePath)
    const spec = chain.length > 0 ? renderSpecChain(chain) : '未找到 PROSE.md，以批注为准。'
    const group = groups.get(spec) ?? []
    group.push(item)
    groups.set(spec, group)
  }
  const sections = []
  for (const [spec, items] of groups) {
    sections.push([
      `## 规范（适用于以下文件）\n${spec}`,
      ...items.map((item) => `### 文件：${item.filePath}\n${stripStagingHeader(item.filePath, item.content)}`),
    ].join('\n\n'))
  }
  return [loadPrompt('merge-header'), ...sections].join('\n\n')
}

/** 批注文件自带的标题行和说明行在合并消息里是冗余，剥掉。用户手工改动过头部时保留原样。 */
function stripStagingHeader(filePath, content) {
  const lines = content.trim().split('\n')
  if (lines[0] !== `# ${filePath}`) return content.trim()
  let index = 1
  if (lines[index] === '') index++
  if (lines[index] !== undefined && lines[index].startsWith('> ')) index++
  if (lines[index] === '') index++
  return lines.slice(index).join('\n')
}

/**
 * 合并回合结束后，清空对应暂存批注并遮蔽处理上下文。先认领落盘
 * 记录再动手，重载后的补收尾和仍在运行的监听器只会有一个生效。
 */
async function finalizeMerge(ctx, log, state, agent, staged, messageSeq, turnEndSeq) {
  state.merging.delete(agent.id)
  if (!(await takePending(agent.session.id))) return
  for (const item of staged) {
    try {
      await removeStaging(item.filePath)
    } catch (error) {
      log.warn('humanize: failed to clear staging for %s: %s', item.filePath, error)
    }
  }
  try {
    if (messageSeq !== undefined) maskMergeSpan(agent, messageSeq, turnEndSeq, staged)
  } catch (error) {
    log.warn('humanize: failed to mask merge context: %s', error)
  }
  log.info('humanize: merge settled, cleared %d staged annotation file(s)', staged.length)
}

/**
 * 遮蔽合并回合的处理上下文：把合并消息到回合结束之间的表层节点
 * 折叠成一条简短说明。合并回合里出现用户插话，或者范围内找不到表层
 * 节点时，放弃遮蔽，只保留原始记录。范围已被压缩改写时同样放弃遮蔽。
 */
function maskMergeSpan(agent, messageSeq, turnEndSeq, staged) {
  const session = agent.session
  for (const event of session.snapshotEvents()) {
    if (event.seq < messageSeq || event.seq > turnEndSeq) continue
    if (event.type === 'user/message') {
      const source = event.data.source
      if (source === undefined || source.kind !== 'plugin:dsh-humanize') return
    }
  }
  const nodes = session.surface.nodes
  const startIdx = nodes.indexOf(messageSeq)
  if (startIdx === -1) return
  // turn/end 不在表层上，区间终点取合并回合最后一个表层节点。
  let endIdx = startIdx
  for (let i = startIdx + 1; i < nodes.length; i++) {
    if (nodes[i] > turnEndSeq) break
    endIdx = i
  }
  // replace 操作必须携带 sourceEventSeqs，列出被折叠的每一个表层
  // 节点，这是平台校验的溯源要求。
  const shadowed = nodes.slice(startIdx, endIdx + 1)
  const names = staged.map((item) => item.filePath).join('、')
  session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: `已按行文批注修订 ${names}，处理过程已遮蔽。` }],
    source: { kind: 'plugin:dsh-humanize' },
  }), {
    surfaceOp: { op: 'replace', startSeq: messageSeq, endSeq: nodes[endIdx] },
    sourceEventSeqs: shadowed,
  })
}
