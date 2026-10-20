/**
 * 延迟合并。行文批注先暂存到文件里，称为暂存批注。
 *
 * 合并有三个触发时机。用户输入 /humanize 命令时按命令指定的范围
 * 合并。用户输入 /humanize-loop 命令时循环执行合并和复审，直到收敛。
 * 上下文压缩结束时按会话工作目录合并暂存批注。
 *
 * 合并在独立的子代理里执行。子代理出结果后，插件清掉对应暂存批注，
 * 在主会话留一行结果说明。
 *
 * 合并收尾后再对被合并的文件逐个复审，修订引入的新违规会作为新
 * 批注回到暂存。
 *
 * @module dsh-humanize/merge
 */
import { readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { withFileLock, writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { countAnnotations } from './annotations.js'
import { resolveCommandTarget } from './command.js'
import { LOOP_ROUNDS_DEFAULT, LOOP_ROUNDS_MAX } from './defaults.js'
import { closeJob, openJob } from './job-track.js'
import { sessionModelConfig } from './model.js'
import { loadPrompt } from './prompts.js'
import { loadSpecChain, renderSpecChain } from './specs.js'
import { collectStaged, humanizeRoot, removeStaging } from './staging.js'

/**
 * 合并子代理使用的提供方。子代理跑在全新上下文里，只带本次合并
 * 需要的内容，避免按全价重放历史。
 */
const MERGE_PROVIDER = 'spawn'

/** 合并子代理的 preset id，声明在本包 cordis.patch.yml 的 preset-humanize-merge 行。 */
const MERGE_PRESET = 'humanize-merge'

/** 在途合并记录的落盘路径。 */
function pendingPath() {
  return join(humanizeRoot(), 'merge-pending.json')
}

/** 读在途合并记录，文件缺失或损坏时当作没有记录。 */
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
  // 进程在写入中途挂掉时，文件内容是替换前或替换后的某一份。
  await writeFileAtomic(pendingPath(), JSON.stringify(map), { mode: 0o600 })
}

async function dropPending(sessionId) {
  // 读改写整体进文件锁，两个触发时机的收尾不会互相覆盖。
  // 返回是否真的摘除了在途合并记录，settleMerge 用它判定自己是不是重复的收尾。
  return await withFileLock(pendingPath(), async () => {
    const map = await readPending()
    if (!(sessionId in map)) return false
    delete map[sessionId]
    await writePending(map)
    return true
  })
}

/**
 * 一个子代理是不是在途合并派发的合并子代理。这里只查落盘的在途合并
 * 记录，热重载后内存里的合并锁已随上下文拆掉，这份记录仍然有效。
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
 * @param {{ merging: Set<string>, reviewing: Set<string>, reviewBatchAbort: Map<string, AbortController> }} state - 插件共享状态。
 * @param {(agent: import('@deepseek-ai/dsh-agent').Agent, filePath: string, before: string | undefined, after: string) => Promise<unknown>} scheduleReview - 合并收尾后复审被合并的文件。
 * @param {(filePaths: string[]) => Promise<void>} waitForReviews - 循环合并等复审落地用。
 * @param {(agentId: string) => void} discardReviews - 合并派发时丢弃在途和排队的复审。
 */
export function registerMerge(ctx, log, config, state, scheduleReview, waitForReviews, discardReviews) {
  ctx.commands.register({
    name: 'humanize',
    description: '合并 dsh-humanize 暂存的行文批注。参数为文件或目录路径，留空表示当前工作目录。',
    input: { hint: '文件或目录路径，可留空' },
    handler: async ({ agent, rawInput }) => {
      // 重复派发直接返回错误，当前这次合并照常进行。
      if (state.merging.has(agent.id)) return { kind: 'error', text: '已有批注合并在进行，等它结束后再派发。' }
      const target = resolveCommandTarget(agent, rawInput)
      const staged = await collectStaged(target)
      if (staged.length === 0) return { kind: 'error', text: `没有暂存的批注。` }
      const dispatch = await scheduleMerge(ctx, log, state, scheduleReview, discardReviews, agent, staged, 'command')
      if (!dispatch.started) return { kind: 'error', text: `批注合并派发失败：${dispatch.error ?? '未知原因'}` }
      return { kind: 'success', text: `已派发批注合并任务，涉及 ${staged.length} 个文件。` }
    },
  })
  ctx.commands.register({
    name: 'humanize-loop',
    description: '循环执行批注合并与复审，直到复审没有新批注或达到轮次上限。参数为文件或目录路径。',
    input: { hint: '文件或目录路径，可留空' },
    handler: async ({ agent, rawInput }) => {
      // 重复派发直接返回错误，当前这轮循环照常推进。
      if (state.merging.has(agent.id)) return { kind: 'error', text: '已有批注合并在进行，等它结束后再派发。' }
      const target = resolveCommandTarget(agent, rawInput)
      const staged = await collectStaged(target)
      if (staged.length === 0) return { kind: 'error', text: `没有暂存的批注。` }
      void runMergeLoop(ctx, log, config, state, scheduleReview, discardReviews, waitForReviews, agent, target)
      return { kind: 'success', text: `已派发循环合并任务。` }
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
      return scheduleMerge(ctx, log, state, scheduleReview, discardReviews, agent, staged, 'compaction')
    }, (error) => log.warn('humanize: failed to collect staged annotations after compaction: %s', error))
  })
}

/** 统计一批暂存批注的条目数，供进度行展示。 */
function countStagedAnnotations(staged) {
  let count = 0
  for (const item of staged) count += countAnnotations(item.content)
  return count
}

/**
 * /humanize-loop 的执行体。合并产出是新行文，修订本身可能引入新的
 * 违规表述，所以每轮在合并收尾后等复审落地。复审还有新批注就继续
 * 合并，没有新批注或达到轮次上限时结束。
 *
 * 轮次上限来自设置页，按轮读取。
 *
 * 进度走 jobs 通道，进度行的 轮次/上限 前缀给客户端画进度条。
 */
async function runMergeLoop(ctx, log, config, state, scheduleReview, discardReviews, waitForReviews, agent, target) {
  const sessionId = agent.session.id
  let cancelled = false
  // jobs 服务和 controller 服务都就绪时展示进度。缺任意一个时退化为
  // 后台循环，每轮结果仍会在主会话留一行说明。
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
    // 设置页改动下一轮生效。
    for (let round = 1; ; round += 1) {
      const configured = config.loopMaxRounds
      const maxRounds = Math.max(1, Math.min(typeof configured === 'number' ? configured : LOOP_ROUNDS_DEFAULT, LOOP_ROUNDS_MAX))
      if (round > maxRounds) {
        settle({ status: 'completed', detail: `已完成 ${maxRounds} 轮，达到轮次上限，仍有批注未收敛。` })
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
      progress(`第 ${round}/${maxRounds} 轮，合并 ${staged.length} 个文件，共 ${countStagedAnnotations(staged)} 条批注`)
      const dispatch = await scheduleMerge(ctx, log, state, scheduleReview, discardReviews, agent, staged, `loop round ${round}`)
      if (!dispatch.started) {
        settle({ status: 'failed', detail: `批注合并派发失败：${dispatch.error ?? '未知原因'}` })
        return
      }
      const outcome = await dispatch.done
      if (!outcome.completed) {
        settle({ status: 'failed', detail: `第 ${round} 轮合并未完成，暂存批注保留，可以重新执行 /humanize-loop。` })
        return
      }
      progress(`第 ${round}/${maxRounds} 轮，复审进行中`)
      const outcomes = await Promise.allSettled(outcome.reviews)
      // 复审期间文件又被改时会补排复审，等队列排空再判定剩余批注。
      await waitForReviews(staged.map((item) => item.filePath))
      const failed = outcomes.filter((item) => item.status === 'fulfilled' && item.value?.kind === 'failed').length
      const stagedNow = outcomes.reduce((sum, item) => sum + (item.status === 'fulfilled' && item.value?.kind === 'ok' ? item.value.annotations ?? 0 : 0), 0)
      const remaining = await collectStaged(target)
      notify(agent, `循环合并第 ${round} 轮结束：复审暂存 ${stagedNow} 条批注，还有 ${remaining.length} 个文件有批注${failed > 0 ? `，${failed} 个复审失败` : ''}。`)
      progress(`第 ${round}/${maxRounds} 轮，复审暂存 ${stagedNow} 条批注`)
      if (remaining.length === 0) {
        settle({ status: 'completed', detail: `循环合并结束：共 ${round} 轮，复审没有新批注。` })
        return
      }
    }
  } catch (error) {
    log.warn('humanize: merge loop failed: %s', error)
    settle({ status: 'failed', detail: `循环合并失败：${error instanceof Error ? error.message : String(error)}` })
  } finally {
    closeJob(ctx, log, tracked)
  }
}

/**
 * 派发一次合并：组装消息，派发一个一次性子代理去修订文件，后台等
 * 结果再清批注。
 *
 * 同一个 agent 同时只允许一个合并在进行。
 *
 * 返回是否派发成功。成功时附带一个在收尾完成后结算的 Promise，
 * 结算值是收尾结果和合并后复审的 Promise 列表。
 */
async function scheduleMerge(ctx, log, state, scheduleReview, discardReviews, agent, staged, origin) {
  if (state.merging.has(agent.id)) {
    log.info('humanize: a merge is already running for agent %s, skipping the %s trigger', agent.id, origin)
    return { started: false }
  }
  state.merging.add(agent.id)
  try {
    // 记录合并前的文件内容。收尾后的复审只审合并改动的区段。读不到
    // 的文件在复审时改为全量审查。
    for (const item of staged) {
      item.sourceBefore = await readFile(item.filePath, 'utf8').catch(() => undefined)
    }
    const text = await buildMergeMessage(staged)
    // 跟随主会话当前用的模型，修订和主会话用同一套模型。
    const agentOptions = sessionModelConfig(agent)
    const activation = await ctx.subagents.startActivation({
      provider: MERGE_PROVIDER,
      label: 'humanize 批注合并',
      request: {
        prompt: [{ type: 'text', text }],
        parent: agent,
        // preset 是 cordis.patch.yml 里声明的 humanize-merge，合并用到
        // 的工具是读文件、改文件和检索目录。
        agentPreset: MERGE_PRESET,
        ...(agentOptions !== undefined ? { agentOptions } : {}),
      },
      // 子代理跑完后由插件收尾，重载后按在途合并记录补做。
      signal: new AbortController().signal,
      // 结果只回给插件，由插件自己清批注和留说明。
      delivery: 'caller',
    })
    // 派发之后这些复审结果都会过期，先让它们停下。
    state.reviewBatchAbort.get(agent.id)?.abort('merge started')
    discardReviews(agent.id)
    // 等结果前落盘，插件中途热重载后也能补做收尾。先按主
    // 会话 id 落盘子代理和文件清单。
    await withFileLock(pendingPath(), async () => {
      const pending = await readPending()
      pending[agent.session.id] = { childId: activation.childId, files: staged.map((item) => item.filePath) }
      await writePending(pending)
    })
    const done = activation.result.then(
      (result) => settleMerge(ctx, log, state, scheduleReview, agent, staged, result.stopReason === 'completed'),
      (error) => {
        log.warn('humanize: merge subagent run failed: %s', error)
        return settleMerge(ctx, log, state, scheduleReview, agent, staged, false)
      },
    ).finally(() => activation.dispose().catch(() => undefined))
    log.info('humanize: merge dispatched (%s) for %d file(s) as subagent %s', origin, staged.length, activation.childId)
    return { started: true, done }
  } catch (error) {
    state.merging.delete(agent.id)
    const message = error instanceof Error ? error.message : String(error)
    log.warn('humanize: failed to dispatch merge: %s', message)
    // web 宿主看不到运行日志，把原因带回给命令和任务的终态说明。
    return { started: false, error: message }
  }
}

/**
 * 合并有结果后收尾，清批注、留结果说明、释放合并锁。
 *
 * 热重载后，旧实例的结果回调和按在途合并记录补挂的监听会同时等着
 * 收尾。收尾以摘下在途合并记录为准，摘到的一方继续做通知和复审，
 * 另一方直接退出。通知和复审只做一次。
 */
async function settleMerge(ctx, log, state, scheduleReview, agent, staged, completed) {
  // 先摘在途合并记录再释放合并锁。反过来会在两步之间留出一个窗口：
  // reconcile 看到锁已释放而记录还在，会再挂一套收尾监听。
  let owned = false
  try {
    owned = await dropPending(agent.session.id)
  } finally {
    state.merging.delete(agent.id)
  }
  if (!owned) {
    log.info('humanize: merge for session %s was already settled, skipping', agent.session.id)
    return { completed, reviews: [] }
  }
  if (completed) {
    // 成功就清掉对应暂存批注，失败则保留等下次合并。
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
  if (!completed) return { completed, reviews: [] }
  // 复审要在合并锁释放之后派发，否则会被合并锁跳过。合并产出是新
  // 行文，修订本身可能引入新的违规表述。
  const reviews = []
  for (const item of staged) {
    const after = await readFile(item.filePath, 'utf8').catch(() => undefined)
    if (after === undefined) continue
    reviews.push(scheduleReview(agent, item.filePath, item.sourceBefore, after))
  }
  return { completed, reviews }
}

/** 在主会话里留一行合并结果说明。 */
function notify(agent, text) {
  try {
    agent.session.append('user/message', createUserMessage({
      content: [{ type: 'text', text }],
      source: { kind: 'plugin:dsh-humanize', form: 'notice' },
    }), { surfaceOp: 'append' })
  } catch {
    // 主会话已销毁时结果说明无处安放，批注状态保持原样。
  }
}

/**
 * 插件加载时按子代理的现状补做收尾。等合并结果的监听器住在内存里，
 * 插件热重载会把监听器连同上下文一起拆掉，在途合并因此落盘成一份
 * 记录。
 *
 * 子代理还在跑就等它回合结束。已经出过结果就直接收尾。子代理离场
 * 就放弃收尾，批注保留给下次合并。重载窗口里主会话的 agent 可能
 * 还没恢复，记录留到 agent/created 时再收尾。
 */
export async function reconcilePendingMerges(ctx, log, state, scheduleReview) {
  const pending = await readPending()
  for (const [sessionId, record] of Object.entries(pending)) {
    try {
      const agent = ctx.agents.get(sessionId)
      if (agent === undefined) continue
      // 已有收尾在等这个合并时跳过。合并进行中又触发无关的
      // agent/created 就会走到这里。settleMerge 以在途合并记录幂等，重复
      // 挂监听只是多一次空跑，但还是会惊动合并锁，这里仍然跳过。
      if (state.merging.has(agent.id)) continue
      // 重载恢复的记录没有合并前快照，复审时退化为全量审查。
      const staged = record.files.map((filePath) => ({ filePath }))
      const child = ctx.agents.get(record.childId)
      if (child === undefined) {
        log.warn('humanize: merge subagent %s is gone, keeping %d staged annotation file(s)', record.childId, staged.length)
        notify(agent, '批注合并的子代理已离场，合并未完成，暂存批注保留，可以重新执行 /humanize。')
        // 记录删除走文件锁，和另一个实例的收尾不会互相覆盖。
        await withFileLock(pendingPath(), async () => {
          const map = await readPending()
          delete map[sessionId]
          await writePending(map)
        })
        continue
      }
      state.merging.add(agent.id)
      awaitMergeChild(ctx, log, state, scheduleReview, agent, child, staged)
    } catch (error) {
      log.warn('humanize: failed to reconcile pending merge for %s: %s', sessionId, error)
    }
  }
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
  // 子代理中途被销毁时按失败收尾，及时释放合并锁。
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
    const spec = chain.length > 0 ? renderSpecChain(chain) : 'No PROSE.md found; follow the annotations.'
    const group = groups.get(spec) ?? []
    group.push(item)
    groups.set(spec, group)
  }
  const sections = []
  for (const [spec, items] of groups) {
    sections.push([
      `## Rules\n${spec}`,
      ...items.map((item) => item.content),
    ].join('\n\n'))
  }
  return `${loadPrompt('merge-header')}\n\n${sections.join('\n\n')}`
}
