/**
 * 延迟合并。行文批注先暂存到文件里，称为暂存批注。
 *
 * 合并有三个触发时机。用户输入 /humanize 命令时按命令指定的范围合并，
 * 输入 /humanize-loop 命令时循环执行合并和复审直到收敛。会话发生
 * 上下文压缩时按会话工作目录合并暂存批注。
 *
 * 合并在独立的子会话里执行。插件把规范和暂存批注组装成一条自包含的
 * 消息，派生一个一次性子代理去完成修订，主会话的记录不参与。子代理
 * 出结果后插件清掉对应暂存批注，对被合并的文件逐个复审，修订引入的
 * 新违规会作为新批注回到暂存，并在主会话留一行结果说明。
 *
 * @module dsh-humanize/merge
 */
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { countAnnotations } from './annotations.js'
import { resolveCommandTarget } from './command.js'
import { LOOP_ROUNDS_DEFAULT, LOOP_ROUNDS_MAX } from './defaults.js'
import { closeJob, openJob } from './job-track.js'
import { loadPrompt } from './prompts.js'
import { loadSpecChain, renderSpecChain } from './specs.js'
import { collectStaged, removeStaging } from './staging.js'

/**
 * 合并子代理使用的提供方，全新上下文。fork 提供方能继承主会话历史，
 * 但实测第一次请求几乎全量未命中缓存，继承的历史按全价输入一遍，
 * 比全新上下文贵得多。
 */
const MERGE_PROVIDER = 'spawn'

/** 合并只需要读文件和改文件，不给终端，也不允许再派生子代理。 */
const MERGE_TOOLS = ['read', 'edit', 'write', 'glob', 'grep']

/**
 * 在途合并的落盘记录。等合并结果的监听器住在内存里，插件热重载会把
 * 监听器连同上下文一起拆掉。派发时把子代理的会话 id 和文件清单写进
 * 这个文件，插件加载时对照子代理的状态补做收尾。
 * 键是主会话 id，值是 { childId, files }。平台不变量保证 agent.id 与
 * session.id 同值，merging 锁和这里的键是同一个键空间。
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
 * 一个子代理是不是在途合并派生的合并子代理。识别合并子代理不能只看
 * 内存里的合并锁：热重载后锁随上下文拆掉，落盘记录才是完整依据。
 */
export async function isPendingMergeChild(childId) {
  const pending = await readPending()
  for (const record of Object.values(pending)) {
    if (record !== null && typeof record === 'object' && record.childId === childId) return true
  }
  return false
}

/**
 * 注册 /humanize、/humanize-loop 命令和 compaction/end 触发。
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {{ info: Function, warn: Function }} log
 * @param {{ mergeOnCompaction: boolean, loopMaxRounds?: number }} config
 * @param {{ merging: Set<string>, reviewing: Set<string> }} state - 插件共享状态。
 * @param {(agent: import('@deepseek-ai/dsh-agent').Agent, filePath: string, before: string | undefined, after: string) => Promise<unknown>} scheduleReview - 合并收尾后复审被合并的文件。
 * @param {(filePaths: string[]) => Promise<void>} waitForReviews - 循环合并等复审落地用。
 */
export function registerMerge(ctx, log, config, state, scheduleReview, waitForReviews) {
  ctx.commands.register({
    name: 'humanize',
    description: '合并 dsh-humanize 暂存的行文批注。参数为文件或目录路径，留空表示当前工作目录。',
    input: { hint: '文件或目录路径，可留空' },
    handler: async ({ agent, rawInput }) => {
      // 锁检查放在处理器里同步返回。重复派发直接返回错误，正在进行的
      // 合并不受影响。
      if (state.reviewing.has(agent.id)) return { kind: 'error', text: '审查任务进行中，审查完成后再合并。' }
      if (state.merging.has(agent.id)) return { kind: 'error', text: '已有批注合并在进行，等它结束后再派发。' }
      const target = resolveCommandTarget(agent, rawInput)
      const staged = await collectStaged(target)
      if (staged.length === 0) return { kind: 'error', text: `没有暂存的批注：${target}` }
      const dispatch = await scheduleMerge(ctx, log, state, scheduleReview, agent, staged, 'command')
      if (!dispatch.started) return { kind: 'error', text: '批注合并派发失败，详见运行日志。' }
      return { kind: 'success', text: `已派发批注合并任务，涉及 ${staged.length} 个文件。合并在独立子会话里执行，完成后主会话会收到一行结果。` }
    },
  })
  ctx.commands.register({
    name: 'humanize-loop',
    description: '循环执行批注合并与复审，直到复审没有新批注或达到轮次上限。参数为文件或目录路径。',
    input: { hint: '文件或目录路径，可留空' },
    handler: async ({ agent, rawInput }) => {
      // 锁检查放在处理器里同步返回。重复派发直接返回错误，正在运行的
      // 循环显示不受影响。
      if (state.reviewing.has(agent.id)) return { kind: 'error', text: '审查任务进行中，审查完成后再合并。' }
      if (state.merging.has(agent.id)) return { kind: 'error', text: '已有批注合并在进行，等它结束后再派发。' }
      const target = resolveCommandTarget(agent, rawInput)
      const staged = await collectStaged(target)
      if (staged.length === 0) return { kind: 'error', text: `没有暂存的批注：${target}` }
      void runMergeLoop(ctx, log, config, state, scheduleReview, waitForReviews, agent, target)
      return { kind: 'success', text: `已派发循环合并任务：${target}。进度显示在输入框上方。` }
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
      return scheduleMerge(ctx, log, state, scheduleReview, agent, staged, 'compaction')
    }, (error) => log.warn('humanize: failed to collect staged annotations after compaction: %s', error))
  })
}

/** 数一批暂存批注的条目数，给进度行展示用。 */
function countStagedAnnotations(staged) {
  let count = 0
  for (const item of staged) count += countAnnotations(item.content)
  return count
}

/**
 * /humanize-loop 的执行体。合并产出是新行文，修订本身可能引入新的
 * 违规表述，所以每轮在合并收尾后等复审落地，还有新批注就继续合并，
 * 直到没有新批注或达到轮次上限。轮次上限来自设置页，按轮读取。
 * 进度走 jobs 通道，进度行的 `轮次/上限` 前缀给客户端画进度条。
 */
async function runMergeLoop(ctx, log, config, state, scheduleReview, waitForReviews, agent, target) {
  const sessionId = agent.session.id
  let cancelled = false
  // 组合里没有 jobs 服务、或没有 controller 服务这个 owner 时，退化为
  // 无进度展示的后台循环，每轮结果仍会在主会话留一行说明。
  const tracked = openJob(ctx, log, {
    jobs: ctx.get('jobs'),
    kind: 'humanize-loop',
    label: `循环合并 ${target}`,
    owner: sessionId,
    // 用户在任务列表点取消时在下一轮开始前停下。在途的合并按设计跑完，
    // 由它自己的收尾释放合并锁。
    cancel() { cancelled = true },
  })
  const settle = (outcome) => tracked?.settle(outcome)
  const progress = (line) => tracked?.handle?.updateProgress(line)
  try {
    // 轮次上限每轮开头重读，设置页的改动下一轮就生效。
    for (let round = 1; ; round += 1) {
      const configured = config.loopMaxRounds
      const maxRounds = Math.max(1, Math.min(typeof configured === 'number' ? configured : LOOP_ROUNDS_DEFAULT, LOOP_ROUNDS_MAX))
      if (round > maxRounds) {
        settle({ status: 'completed', detail: `达到轮次上限（${maxRounds} 轮），仍有批注未收敛，检查后可以再次执行 /humanize-loop。` })
        return
      }
      if (cancelled) {
        settle({ status: 'killed', detail: `已取消，完成 ${round - 1} 轮。` })
        return
      }
      const staged = await collectStaged(target)
      if (staged.length === 0) {
        settle({ status: 'completed', detail: `循环合并结束：第 ${round - 1} 轮复审后没有新批注。` })
        return
      }
      progress(`第 ${round}/${maxRounds} 轮 · 合并 ${staged.length} 个文件（${countStagedAnnotations(staged)} 条批注）…`)
      const dispatch = await scheduleMerge(ctx, log, state, scheduleReview, agent, staged, `loop round ${round}`)
      if (!dispatch.started) {
        settle({ status: 'failed', detail: '批注合并派发失败，详见运行日志。' })
        return
      }
      const outcome = await dispatch.done
      if (!outcome.completed) {
        settle({ status: 'failed', detail: `第 ${round} 轮合并未完成，暂存批注保留，可以重新执行 /humanize-loop。` })
        return
      }
      progress(`第 ${round}/${maxRounds} 轮 · 复审中…`)
      const outcomes = await Promise.allSettled(outcome.reviews)
      // 复审期间文件又被改时会补排复审，等队列排空再判定剩余批注。
      await waitForReviews(staged.map((item) => item.filePath))
      const failed = outcomes.filter((item) => item.status === 'fulfilled' && item.value?.kind === 'failed').length
      const stagedNow = outcomes.reduce((sum, item) => sum + (item.status === 'fulfilled' && item.value?.kind === 'ok' ? item.value.annotations ?? 0 : 0), 0)
      const remaining = await collectStaged(target)
      notify(agent, `循环合并第 ${round} 轮结束：复审暂存 ${stagedNow} 条批注，还有 ${remaining.length} 个文件有批注${failed > 0 ? `，${failed} 个复审失败` : ''}。`)
      progress(`第 ${round}/${maxRounds} 轮 · 复审暂存 ${stagedNow} 条批注`)
      if (remaining.length === 0) {
        settle({ status: 'completed', detail: `循环合并结束：共 ${round} 轮，复审没有新批注。` })
        return
      }
    }
  } catch (error) {
    log.warn('humanize: merge loop failed: %s', error)
    settle({ status: 'failed', detail: `循环合并失败：${error instanceof Error ? error.message : String(error)}` })
  } finally {
    closeJob(ctx, tracked)
  }
}

/**
 * 派发一次合并：组装消息，派生一个一次性子代理去修订文件，后台等
 * 结果再清批注。同一个 agent 同时只允许一个合并在进行。返回是否
 * 派发成功，成功时附带一个在收尾完成后结算的 Promise，结算值是
 * 收尾结果和合并后复审的 Promise 列表。
 */
async function scheduleMerge(ctx, log, state, scheduleReview, agent, staged, origin) {
  if (state.merging.has(agent.id)) {
    log.info('humanize: a merge is already running for agent %s, skipping the %s trigger', agent.id, origin)
    return { started: false }
  }
  // 审查批次进行中也不合并：合并一开始，批次里剩余文件的审查会被跳过，
  // 终态却报完成。批注保留，等审查结束后下次触发再合并。
  if (state.reviewing.has(agent.id)) {
    log.info('humanize: a review batch is running for agent %s, skipping the %s merge trigger', agent.id, origin)
    return { started: false }
  }
  state.merging.add(agent.id)
  try {
    // 记录合并前的文件内容，收尾后的复审只审合并改动的区段。读不到
    // 的文件在复审时退化为全量审查。
    for (const item of staged) {
      item.sourceBefore = await readFile(item.filePath, 'utf8').catch(() => undefined)
    }
    const text = await buildMergeMessage(staged)
    // 跟随主会话当前用的模型，修订质量直接影响成稿。
    const config = agent.session.requestHeader()?.config
    const agentOptions = config === undefined
      ? undefined
      : { provider: config.provider, model: config.model, reasoningEffort: config.reasoningEffort }
    // subagents 是 inject 声明的硬依赖，apply 之前就已就绪。
    const run = await ctx.subagents.start(MERGE_PROVIDER, {
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
    const done = run.result.then(
      (result) => settleMerge(ctx, log, state, scheduleReview, agent, staged, result.stopReason === 'completed'),
      (error) => {
        log.warn('humanize: merge subagent run failed: %s', error)
        return settleMerge(ctx, log, state, scheduleReview, agent, staged, false)
      },
    ).finally(() => run.dispose().catch(() => undefined))
    log.info('humanize: merge dispatched (%s) for %d file(s) as subagent %s', origin, staged.length, run.id)
    return { started: true, done }
  } catch (error) {
    state.merging.delete(agent.id)
    log.warn('humanize: failed to dispatch merge: %s', error)
    return { started: false }
  }
}

/**
 * 合并有了结果后收尾：成功就清掉对应暂存批注，失败保留批注等下次
 * 合并。两种结果都在主会话留一行说明，然后释放合并锁和落盘记录。
 * 收尾成功时对被合并的文件逐个复审：合并产出是新行文，修订本身可能
 * 引入新的违规表述。复审要在合并锁释放之后派发，否则会被合并锁跳过。
 */
async function settleMerge(ctx, log, state, scheduleReview, agent, staged, completed) {
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
    // 先删落盘记录再释放合并锁。反过来会在两步之间留出一个窗口：
    // reconcile 看到锁已释放而记录还在，会再挂一套收尾监听。
    await dropPending(agent.session.id)
    state.merging.delete(agent.id)
  }
  if (!completed) return { completed, reviews: [] }
  const reviews = []
  for (const item of staged) {
    const after = await readFile(item.filePath, 'utf8').catch(() => undefined)
    if (after === undefined) continue
    reviews.push(scheduleReview(agent, item.filePath, item.sourceBefore, after))
  }
  return { completed, reviews }
}

/** 在主会话留一行合并结果说明，只进记录，不触发新回合。 */
function notify(agent, text) {
  try {
    agent.session.append('user/message', createUserMessage({
      content: [{ type: 'text', text }],
      source: { kind: 'plugin:dsh-humanize', form: 'notice' },
    }), { surfaceOp: 'append' })
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
export async function reconcilePendingMerges(ctx, log, state, scheduleReview) {
  const pending = await readPending()
  let changed = false
  for (const [sessionId, record] of Object.entries(pending)) {
    try {
      const agent = ctx.agents.get(sessionId)
      if (agent === undefined) continue
      // 已有收尾在等这个合并（比如合并进行中又触发了无关的 agent/created），
      // 重复挂监听会让 settleMerge 执行两次，主会话收到重复的结果说明。
      if (state.merging.has(agent.id)) continue
      // 重载恢复的记录没有合并前快照，复审时退化为全量审查。
      const staged = record.files.map((filePath) => ({ filePath }))
      const child = ctx.agents.get(record.childId)
      if (child === undefined) {
        log.warn('humanize: merge subagent %s is gone, keeping %d staged annotation file(s)', record.childId, staged.length)
        notify(agent, '批注合并的子会话已离场，合并未完成，暂存批注保留，可以重新执行 /humanize。')
        delete pending[sessionId]
        changed = true
        continue
      }
      state.merging.add(agent.id)
      awaitMergeChild(ctx, log, state, scheduleReview, agent, child, staged)
    } catch (error) {
      log.warn('humanize: failed to reconcile pending merge for %s: %s', sessionId, error)
    }
  }
  if (changed) await writePending(pending)
}

/** 等合并子代理出结果。已经有回合结束记录的当场结算，否则挂监听等。 */
function awaitMergeChild(ctx, log, state, scheduleReview, agent, child, staged) {
  const events = child.session.snapshotEvents()
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i]
    if (event.type === 'turn/end') {
      void settleMerge(ctx, log, state, scheduleReview, agent, staged, event.data.reason?.kind === 'completed')
      return
    }
  }
  const offEnd = ctx.on('session/event', (session, event) => {
    if (session.id !== child.id || event.type !== 'turn/end') return
    cleanup()
    void settleMerge(ctx, log, state, scheduleReview, agent, staged, event.data.reason?.kind === 'completed')
  })
  // 子代理没出结果就被销毁时按失败收尾，合并锁不能一直占着。
  const offDisposed = ctx.on('agent/disposed', ({ agent: gone }) => {
    if (gone.id !== child.id) return
    cleanup()
    void settleMerge(ctx, log, state, scheduleReview, agent, staged, false)
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
      ...items.map((item) => item.content),
    ].join('\n\n'))
  }
  return `${loadPrompt('merge-header')}\n\n${sections.join('\n\n')}`
}
