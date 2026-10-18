/**
 * 延迟合并。行文批注先暂存到文件里，称为暂存批注。
 *
 * 合并有两个触发时机。用户输入 /humanize 命令时按命令指定的范围合并，
 * 会话发生上下文压缩时合并整个项目的全部暂存批注。
 *
 * 合并在独立的子会话里执行。插件把规范和暂存批注组装成一条自包含的
 * 消息，派生一个一次性子代理去完成修订，主会话的上下文不参与。子代理
 * 出结果后插件清掉对应暂存批注，并在主会话留一行结果说明。
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

/** 合并子代理使用的提供方，全新上下文，支持限定工具集。 */
const MERGE_PROVIDER = 'subagent-spawn-in-process'

/** 合并只需要读文件和改文件，不给终端，也不允许再派生子代理。 */
const MERGE_TOOLS = ['read', 'edit', 'write', 'glob', 'grep']

/**
 * 在途合并的落盘记录。等合并结果的监听器住在内存里，插件热重载会把
 * 监听器连同上下文一起拆掉。派发时把子代理的会话 id 和文件清单写进
 * 这个文件，插件加载时对照子代理的状态补做收尾。
 * 键是主会话 id，值是 { childId, files }。
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
    description: '合并 dsh-humanize 暂存的行文批注。参数为文件或目录路径，留空表示当前工作目录。',
    input: { hint: '文件或目录路径，可留空' },
    handler: async ({ agent, rawInput }) => {
      const cwd = agent.session.header.cwd ?? process.cwd()
      const target = rawInput.trim().length > 0 ? resolve(cwd, rawInput.trim()) : cwd
      const staged = await collectStaged(target)
      if (staged.length === 0) return { kind: 'error', text: `没有暂存的批注：${target}` }
      const ok = await scheduleMerge(ctx, log, state, agent, staged, 'command')
      if (!ok) return { kind: 'error', text: '批注合并派发失败，详见运行日志。' }
      return { kind: 'success', text: `已派发批注合并任务，涉及 ${staged.length} 个文件。合并在独立子会话里执行，完成后主会话会收到一行结果。` }
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
 * 派发一次合并：组装消息，派生一个一次性子代理去修订文件，后台等
 * 结果再清批注。同一个 agent 同时只允许一个合并在进行。返回是否
 * 派发成功。
 */
async function scheduleMerge(ctx, log, state, agent, staged, origin) {
  if (state.merging.has(agent.id)) {
    log.info('humanize: a merge is already running for agent %s, skipping the %s trigger', agent.id, origin)
    return false
  }
  const subagents = ctx.get('subagents')
  if (subagents === undefined) {
    log.warn('humanize: subagents service unavailable, cannot dispatch the %s merge', origin)
    return false
  }
  state.merging.add(agent.id)
  try {
    const text = await buildMergeMessage(staged)
    // 跟随主会话当前用的模型，修订质量直接影响成稿。
    const config = agent.session.requestHeader()?.config
    const agentOptions = config === undefined
      ? undefined
      : { provider: config.provider, model: config.model, reasoningEffort: config.reasoningEffort }
    const run = await subagents.start(MERGE_PROVIDER, {
      label: 'humanize 批注合并',
      prompt: [{ type: 'text', text }],
      parent: agent,
      // 子代理独立跑完，插件重载不中止它，收尾由重载后的补做机制接手。
      signal: new AbortController().signal,
      agentOptions,
      toolFilter: { allow: MERGE_TOOLS },
    })
    // 等结果前落盘，插件中途热重载也能在重新加载后补做收尾。
    const pending = await readPending()
    pending[agent.session.id] = { childId: run.id, files: staged.map((item) => item.filePath) }
    await writePending(pending)
    void run.result.then(
      (result) => settleMerge(ctx, log, state, agent, staged, result.stopReason === 'completed'),
      (error) => {
        log.warn('humanize: merge subagent run failed: %s', error)
        return settleMerge(ctx, log, state, agent, staged, false)
      },
    ).finally(() => run.dispose().catch(() => undefined))
    log.info('humanize: merge dispatched (%s) for %d file(s) as subagent %s', origin, staged.length, run.id)
    return true
  } catch (error) {
    state.merging.delete(agent.id)
    log.warn('humanize: failed to dispatch merge: %s', error)
    return false
  }
}

/**
 * 合并有了结果后收尾：成功就清掉对应暂存批注，失败保留批注等下次
 * 合并。两种结果都在主会话留一行说明，然后释放合并锁和落盘记录。
 */
async function settleMerge(ctx, log, state, agent, staged, completed) {
  try {
    if (completed) {
      for (const item of staged) {
        try {
          await removeStaging(item.filePath)
        } catch (error) {
          log.warn('humanize: failed to clear staging for %s: %s', item.filePath, error)
        }
      }
      notify(agent, `已按暂存批注修订 ${staged.map((item) => item.filePath).join('、')}。`)
      log.info('humanize: merge settled, cleared %d staged annotation file(s)', staged.length)
    } else {
      notify(agent, '批注合并未完成，暂存批注保留，可以重新执行 /humanize。')
      log.warn('humanize: merge did not complete, %d staged annotation file(s) kept', staged.length)
    }
  } finally {
    state.merging.delete(agent.id)
    await dropPending(agent.session.id)
  }
}

/** 在主会话留一行合并结果说明，只进记录，不触发新回合。 */
function notify(agent, text) {
  try {
    agent.session.append('user/message', createUserMessage({
      content: [{ type: 'text', text }],
      source: { kind: 'plugin:dsh-humanize', form: 'notice' },
    }))
  } catch {
    // 主会话已销毁时结果说明无处安放，批注状态不受影响。
  }
}

/**
 * 插件加载时补做在途合并的收尾。子代理是独立会话，插件重载不打断它，
 * 这里按子代理的现状决定怎么等：还在跑就等它回合结束，已经出过结果
 * 就直接收尾，子代理离场就放弃收尾，批注保留给下次合并。重载窗口里
 * 主会话的 agent 可能还没恢复，记录留到 agent/created 时再收尾。
 */
export async function reconcilePendingMerges(ctx, log, state) {
  const pending = await readPending()
  let changed = false
  for (const [sessionId, record] of Object.entries(pending)) {
    try {
      const agent = ctx.agents.get(sessionId)
      if (agent === undefined) continue
      const staged = record.files.map((filePath) => ({ filePath }))
      const child = ctx.agents.get(record.childId)
      if (child === undefined) {
        log.warn('humanize: merge subagent %s is gone, keeping %d staged annotation file(s)', record.childId, staged.length)
        delete pending[sessionId]
        changed = true
        continue
      }
      state.merging.add(agent.id)
      awaitMergeChild(ctx, log, state, agent, child, staged)
    } catch (error) {
      log.warn('humanize: failed to reconcile pending merge for %s: %s', sessionId, error)
    }
  }
  if (changed) await writePending(pending)
}

/** 等合并子代理出结果。已经有回合结束记录的当场结算，否则挂监听等。 */
function awaitMergeChild(ctx, log, state, agent, child, staged) {
  const events = child.session.snapshotEvents()
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i]
    if (event.type === 'turn/end') {
      void settleMerge(ctx, log, state, agent, staged, event.data.reason?.kind === 'completed')
      return
    }
  }
  const offEnd = ctx.on('session/event', (session, event) => {
    if (session.id !== child.id || event.type !== 'turn/end') return
    cleanup()
    void settleMerge(ctx, log, state, agent, staged, event.data.reason?.kind === 'completed')
  })
  // 子代理没出结果就被销毁时按失败收尾，合并锁不能一直占着。
  const offDisposed = ctx.on('agent/disposed', ({ agent: gone }) => {
    if (gone.id !== child.id) return
    cleanup()
    void settleMerge(ctx, log, state, agent, staged, false)
  })
  const cleanup = () => {
    offEnd()
    offDisposed()
  }
}

/** 组装发给合并子代理的消息：规范按内容分组，只贴一次，下面按文件列出批注。 */
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
      ...items.map((item) => `### 文件：${item.filePath}\n${item.content}`),
    ].join('\n\n'))
  }
  return `${await loadPrompt('merge-header')}\n\n${sections.join('\n\n')}`
}
