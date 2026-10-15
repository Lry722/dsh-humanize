/**
 * 延迟合并。审查结果先暂存到文件里，合并有两个触发时机：用户输入
 * /humanize 命令时，按命令指定的范围合并；会话发生上下文压缩时，
 * 合并整个项目的全部暂存批注。插件把规范、批注和文件当前内容发给
 * 主模型，由主模型完成编辑，然后遮蔽这段处理上下文。
 *
 * @module dsh-humanize/merge
 */
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { loadSpecChain, renderSpecChain } from './specs.js'
import { collectStaged, removeStaging } from './staging.js'

/** 文件当前内容超过这个长度就不内联，让主模型自己用 read 查看。 */
const INLINE_CONTENT_LIMIT = 20000

const MERGE_HEADER = `[dsh-humanize] 行文批注合并

以下是暂存的行文批注，由旁路审查按 PROSE.md 规范生成，用户可能手工修改过。请逐个文件处理：
1. 对照“规范”理解“批注”，参考“当前内容”修改文件。批注中的引用基于审查时的版本，与当前内容不符时以当前内容为准。
2. 修改这些文件时，write 和 edit 的 human_facing 参数传 true。
3. 认为某条批注不适用时跳过即可，不必说明。
4. 只做批注要求的行文修改，不做其他改动。完成后用一两句话汇报结果。`

const SURFACE_TYPES = new Set(['user/message', 'assistant/message', 'tool/result'])

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
 * 派发一次合并：组装消息发给主模型，等 agent 空闲后清空批注并遮蔽
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
    agent.followup(createUserMessage({
      content: [{ type: 'text', text }],
      source: { kind: 'plugin', plugin: 'dsh-humanize' },
    }))
    // followup 只进收件箱，回合还没开始，agent 此刻仍是空闲的，
    // whenIdle 会立即解决。所以先等合并回合真正开始，再等它结束。
    afterMergeTurn(ctx, agent, markerSeq, {
      done: () => finalizeMerge(log, state, agent, staged, markerSeq),
      abandon: () => {
        state.merging.delete(agent.id)
        log.info('humanize: merge turn never ran for agent %s, merge lock released', agent.id)
      },
    })
    log.info('humanize: merge dispatched (%s) for %d file(s)', origin, staged.length)
  } catch (error) {
    state.merging.delete(agent.id)
    log.warn('humanize: failed to dispatch merge: %s', error)
  }
}

/**
 * 等 markerSeq 之后的第一个回合从开始走到结束，然后触发 done 回调。
 * 第一个回合不一定处理合并消息，用户可能插话。那种情况遮蔽逻辑会
 * 按放弃条件自行跳过，这里只负责等回合闭合。agent 在回合开始前被
 * 销毁时触发 abandon，防止合并锁永远占住。
 */
function afterMergeTurn(ctx, agent, markerSeq, { done, abandon }) {
  let offStart = null
  let offEnd = null
  const cleanup = () => {
    offStart?.()
    offEnd?.()
    offDisposed()
  }
  const offDisposed = ctx.on('agent/disposed', ({ agent: gone }) => {
    if (gone.id !== agent.id) return
    cleanup()
    abandon()
  })
  offStart = ctx.on('session/event', (session, event) => {
    if (session.id !== agent.session.id) return
    if (event.type !== 'turn/start' || event.seq < markerSeq) return
    offStart()
    offStart = null
    const turnStartSeq = event.seq
    offEnd = ctx.on('session/event', (session2, event2) => {
      if (session2.id !== agent.session.id) return
      if (event2.type !== 'turn/end' || event2.seq < turnStartSeq) return
      cleanup()
      done()
    })
  })
}

/** 组装发给主模型的合并消息：每个文件给出规范、批注和当前内容。 */
async function buildMergeMessage(staged) {
  const sections = []
  for (const item of staged) {
    const chain = await loadSpecChain(item.filePath)
    const spec = chain.length > 0 ? renderSpecChain(chain) : '（未找到 PROSE.md，以批注为准。）'
    const content = await readFile(item.filePath, 'utf8').catch(() => undefined)
    const contentSection = content === undefined
      ? '（当前无法读取文件，请先用 read 工具查看。）'
      : content.length > INLINE_CONTENT_LIMIT
        ? '（文件较大，未内联。请先用 read 工具查看当前内容。）'
        : content
    sections.push([
      `## 文件：${item.filePath}`,
      `### 规范\n${spec}`,
      `### 批注\n${item.content.trim()}`,
      `### 当前内容\n${contentSection}`,
    ].join('\n\n'))
  }
  return [MERGE_HEADER, ...sections].join('\n\n')
}

/** 合并回合结束后：清空对应暂存批注，遮蔽处理上下文。 */
async function finalizeMerge(log, state, agent, staged, markerSeq) {
  state.merging.delete(agent.id)
  for (const item of staged) {
    try {
      await removeStaging(item.filePath)
    } catch (error) {
      log.warn('humanize: failed to clear staging for %s: %s', item.filePath, error)
    }
  }
  try {
    maskMergeSpan(agent, markerSeq, staged)
  } catch (error) {
    log.warn('humanize: failed to mask merge context: %s', error)
  }
  log.info('humanize: merge settled, cleared %d staged annotation file(s)', staged.length)
}

/**
 * 遮蔽合并回合的处理上下文：把 markerSeq 之后、全部由本插件发起的
 * 表层节点折叠成一条简短说明。用户插话、回合未正常关闭、或者范围
 * 已被压缩改写时放弃遮蔽，只保留原始记录。
 */
function maskMergeSpan(agent, markerSeq, staged) {
  const session = agent.session
  let opens = 0
  let closes = 0
  let first
  let last
  for (const event of session.events) {
    if (event.seq < markerSeq) continue
    if (event.type === 'turn/start') opens += 1
    else if (event.type === 'turn/end') closes += 1
    else if (event.type === 'user/message') {
      const source = event.data.source
      if (source === undefined || source.kind !== 'plugin' || source.plugin !== 'dsh-humanize') return
    }
    if (SURFACE_TYPES.has(event.type) && event.surfaceOp !== undefined) {
      if (first === undefined) first = event.seq
      last = event.seq
    }
  }
  if (first === undefined || opens === 0 || opens !== closes) return
  const nodes = session.surface.nodes
  if (!nodes.includes(first) || !nodes.includes(last)) return
  const names = staged.map((item) => item.filePath).join('、')
  session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: `（dsh-humanize：已按行文批注修订 ${names}，处理过程已折叠。）` }],
    source: { kind: 'plugin', plugin: 'dsh-humanize' },
  }), {
    surfaceOp: { op: 'replace', start: first, end: last },
  })
}
