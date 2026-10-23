/**
 * 合并子代理的派发与收尾。
 *
 * 子代理出结果后，成功就清空对应暂存批注，失败保留。独立触发的合并
 * 在收尾时自己安排复审，运行编排的合并把待复审清单交回运行。
 *
 * @module dsh-humanize/merge-agent
 */
import { readFile } from 'node:fs/promises'
import { boundContextSummary, createUserMessage } from '@deepseek-ai/dsh-llm'
import { mergeAgentOptions } from './model.js'
import { loadPrompt } from './prompts.js'
import { loadSpecChain, renderSpecChain } from './specs.js'
import { readStaging, removeMergeRequest, removeStaging, writeMergeRequest } from './staging.js'
import { MERGE_BUSY, MERGE_PRESET, acquireMergeRun, clearMergeFiles, hasLiveMergeChild, releaseMergeRun } from './merge-lock.js'

/**
 * 合并子代理使用的提供方。子代理从空上下文起步，只带本次合并需要的
 * 内容，省得把整段对话历史重新读一遍。
 */
const MERGE_PROVIDER = 'spawn'

/**
 * 子代理结束原因的文字说明。优先用 provider 给的 diagnostic，其次用
 * 从子代理 turn/end 事件里拿到的错误，最后才按 stopReason 给一句概括。
 * @param {{ stopReason: string, diagnostic?: string }} result
 * @param {string | undefined} fallback
 */
function stopReasonText(result, fallback) {
  const diagnostic = typeof result.diagnostic === 'string' ? result.diagnostic.trim() : ''
  if (diagnostic.length > 0) return diagnostic
  if (typeof fallback === 'string' && fallback.trim().length > 0) return fallback
  const labels = { error: '子代理出错', aborted: '子代理被中止', cancelled: '子代理被取消' }
  return labels[result.stopReason] ?? `子代理以 ${String(result.stopReason)} 结束`
}

/** 把失败原因压成一行并截断，避免任务行和说明被超长错误淹没。 */
function trimReason(text, max = 400) {
  const oneLine = String(text).replace(/\s+/g, ' ').trim()
  const clipped = oneLine.length <= max ? oneLine : `${oneLine.slice(0, max - 1)}…`
  return clipped.replace(/。$/, '')
}

/**
 * 派发一次合并，交给一个一次性子代理按批注改文件。收到结果后再清掉暂存
 * 批注。
 *
 * 插件把规范和批注写进一个临时请求文件，合并子代理自己分段读取，临时
 * 文件在子代理结束后删除。
 *
 * 返回是否派发成功。成功时会附带一个 Promise，它在收尾完成后结算。结算值
 * 里有复审要用的文件清单，调用方从结果里拿。
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {{ info: Function, warn: Function }} log
 * @param {{ mergeProvider?: string, mergeModel?: string, mergeReasoningEffort?: string }} config
 * @param {ReturnType<import('./pipeline.js').createReviewPipeline>['state']} state
 * @param {(agent: import('@deepseek-ai/dsh-agent').Agent, filePath: string, before: string | undefined, after: string) => Promise<unknown>} scheduleReview
 * @param {(agentId: string, filePaths?: string[]) => void} discardReviews
 * @param {import('@deepseek-ai/dsh-agent').Agent} agent
 * @param {Array<{ filePath: string, content: string, sourceBefore?: string }>} staged
 * @param {string} origin
 * @param {{ managed?: boolean }} [options]
 */
export async function scheduleMerge(ctx, log, config, state, scheduleReview, discardReviews, agent, staged, origin, options = {}) {
  const managed = options.managed === true
  if (state.disposed) {
    // 重载期间派发出去的子代理会失去收尾，这里拒绝新的派发。
    return { started: false, disposed: true, error: '插件已重载' }
  }
  // 压缩和手动命令都在运行之外触发。同一个 agent 同时只允许一个合并在进行，
  // 已有合并在跑就跳过这次派发。全局锁再挡住其他会话。
  if (!managed && state.running.has(agent.id)) {
    log.info('humanize: a merge run is running for agent %s, skipping the %s trigger', agent.id, origin)
    return { started: false, busy: true, error: '已有批注合并正在进行，等它结束后再派发。' }
  }
  if (state.merging.has(agent.id)) {
    log.info('humanize: a merge is already running for agent %s, skipping the %s trigger', agent.id, origin)
    return { started: false, busy: true, error: '已有批注合并正在进行，等它结束后再派发。' }
  }
  // 合并锁只存在内存里。插件重载后锁已经没了，这时靠还活着的合并子代理
  // 挡住新的派发。
  if (hasLiveMergeChild(ctx, agent)) {
    log.info('humanize: a merge subagent is still running for session %s, skipping the %s trigger', agent.session.id, origin)
    return { started: false, busy: true, error: '上一次批注合并的子代理还在运行，等它结束后再派发。' }
  }
  // 运行编排的合并已经持有锁。压缩这类单独派发在这里取得锁。
  if (managed) {
    if (state.mergeRun?.agentId !== agent.id) {
      return { started: false, busy: true, error: MERGE_BUSY }
    }
  } else if (!acquireMergeRun(state, agent, null, staged)) {
    log.info('humanize: another merge run holds the lock, skipping the %s trigger', origin)
    return { started: false, busy: true, error: MERGE_BUSY }
  }
  state.merging.add(agent.id)
  let requestPath
  let activation
  let stopWatching = () => {}
  try {
    // 记录合并前的文件内容。收尾后的复审只审合并改动的区段。读不到的
    // 文件在复审时改为全量复审。
    for (const item of staged) {
      item.sourceBefore = await readFile(item.filePath, 'utf8').catch(() => undefined)
    }
    // 把完整请求写到临时文件，合并子代理用文件工具自己分段读。
    requestPath = await writeMergeRequest(await buildMergeMessage(staged, agent.session.header.cwd))
    const text = loadPrompt('merge-request', { requestPath })
    // 模型可以单独配置，留空时跟随主会话当前用的模型。
    const agentOptions = mergeAgentOptions(config, agent)
    activation = await ctx.subagents.startActivation({
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
      // 子代理跑完后由插件收尾。
      signal: new AbortController().signal,
      // 结果只回给插件，由插件自己清掉暂存批注并留下结果说明。
      delivery: 'caller',
    })
    // 子代理的结束原因不一定进 result.diagnostic。直接听它的 turn/end，
    // 把 provider 的原始错误留下来，例如配额、模型下线。
    let childFailure
    stopWatching = ctx.on('session/event', (session, event) => {
      if (session.id !== activation.childId || event.type !== 'turn/end') return
      const message = event.data?.reason?.error?.message
      if (typeof message === 'string' && message.trim().length > 0) childFailure = message
    })
    // 派发之后这些复审结果都会过期，先让它们停下。其他 agent 在这些
    // 文件上的在途审查也要停，否则会在合并期间写暂存。
    state.reviewBatchAbort.get(agent.id)?.abort('merge started')
    discardReviews(agent.id, staged.map((item) => item.filePath))
    const done = activation.result.then(
      (result) => {
        const completed = result.stopReason === 'completed'
        const reason = completed ? undefined : stopReasonText(result, childFailure)
        if (!completed) {
          log.warn('humanize: merge subagent %s ended with %s: %s', activation.childId, result.stopReason, reason)
        }
        // 子代理已经不写文件了，先释放这些文件，随后安排的复审才不会被锁挡住。
        clearMergeFiles(state, agent.id)
        return settleMerge(log, state, scheduleReview, agent, staged, completed, { managed, reason })
      },
      (error) => {
        const message = childFailure ?? (error instanceof Error ? error.message : String(error))
        log.warn('humanize: merge subagent run failed: %s', message)
        clearMergeFiles(state, agent.id)
        return settleMerge(log, state, scheduleReview, agent, staged, false, { managed, reason: message })
      },
    ).finally(async () => {
      stopWatching()
      await activation.dispose().catch(() => undefined)
      if (requestPath !== undefined) await removeMergeRequest(requestPath).catch(() => undefined)
      // 独立触发的合并到这里结束，释放全局锁。运行编排的锁由 runMergeRounds 释放。
      if (!managed) releaseMergeRun(state, agent.id)
    })
    log.info('humanize: merge dispatched (%s) for %d file(s) as subagent %s', origin, staged.length, activation.childId)
    return { started: true, done }
  } catch (error) {
    stopWatching()
    state.merging.delete(agent.id)
    clearMergeFiles(state, agent.id)
    if (!managed) releaseMergeRun(state, agent.id)
    // 子代理可能已经建立，只是后续接线上出错。不能把它留在后台。
    if (activation !== undefined) await activation.dispose().catch(() => undefined)
    if (requestPath !== undefined) await removeMergeRequest(requestPath).catch(() => undefined)
    const message = error instanceof Error ? error.message : String(error)
    log.warn('humanize: failed to dispatch merge: %s', message)
    // web 宿主的用户只看得到终态说明，这里把原因一并带回给命令和任务。
    return { started: false, error: message }
  }
}

/**
 * 合并有结果后收尾，清空暂存批注、留下结果说明、释放这次合并的标记。
 *
 * 成功时清掉暂存批注，失败时保留，等用户重新执行命令。
 *
 * @returns {Promise<{ completed: boolean, reviewInputs: Array<{ filePath: string, before: string | undefined }>, error?: string }>}
 */
async function settleMerge(log, state, scheduleReview, agent, staged, completed, options = {}) {
  const managed = options.managed === true
  // 失败原因来自子代理的 diagnostic 或派发错误，压成一行再放进说明和任务行。
  const reason = typeof options.reason === 'string' ? trimReason(options.reason) : ''
  try {
    // 成功就清暂存批注，失败则保留等下次合并。
    if (completed) {
      for (const item of staged) {
        try {
          // 合并期间可能又跑了一次复审并写入新批注。暂存内容不再是
          // 合并前的快照时保留新内容，别按旧快照删掉。
          const current = await readStaging(item.filePath)
          if (current !== undefined && current !== item.content) continue
          await removeStaging(item.filePath)
        } catch (error) {
          log.warn('humanize: failed to clear staging for %s: %s', item.filePath, error)
        }
      }
    }
  } finally {
    state.merging.delete(agent.id)
  }
  if (completed) {
    // 说明里逐个列出文件。正文保留完整清单。折叠行只放一句概括，避免被
    // 120 字符的 notice 摘要上限截断。
    notify(agent, `已按暂存批注修订 ${staged.map((item) => item.filePath).join('、')}。`,
      `已按暂存批注修订 ${staged.length} 个文件。`)
    log.info('humanize: merge settled, cleared %d staged annotation file(s)', staged.length)
  } else {
    // 失败时把子代理给的原因带到主会话。用户不用打开子代理会话也能知道
    // 是配额、超时还是别的错误。
    const detail = reason.length > 0
      ? `批注合并未完成：${reason}。暂存批注保留，可以重新执行 /humanize。`
      : '批注合并未完成，暂存批注保留，可以重新执行 /humanize。'
    notify(agent, detail, '批注合并未完成，暂存批注保留。')
    log.warn('humanize: merge did not complete (%s), %d staged annotation file(s) kept', reason || 'no reason', staged.length)
  }
  if (!completed) return { completed, reviewInputs: [], error: reason.length > 0 ? reason : undefined }
  // 合并产出是新行文，合并本身可能引入新的违规表述。由运行编排的
  // 合并把清单交给运行自己排。独立触发的合并没有运行，仍然在这里直接
  // 排复审。
  const reviewInputs = []
  for (const item of staged) {
    const after = await readFile(item.filePath, 'utf8').catch(() => undefined)
    if (after === undefined) continue
    reviewInputs.push({ filePath: item.filePath, before: item.sourceBefore })
    if (!managed) void scheduleReview(agent, item.filePath, item.sourceBefore, after)
  }
  return { completed, reviewInputs }
}

/**
 * 在主会话里留一条合并结果说明。走 agent.inject，模型在下一步看到它，
 * 会话记录里的来源是 humanize。
 *
 * summary 是会话里折叠行显示的一句话。正文可以很长，摘要必须保持简短，
 * 否则会被 notice 的摘要上限截断。
 */
export function notify(agent, text, summary = text) {
  try {
    agent.inject(createUserMessage({
      content: [{ type: 'text', text }],
      source: { kind: 'humanize', form: 'notice', summary: boundContextSummary(summary) },
    }))
  } catch {
    // 主会话已销毁时结果说明无处安放，批注状态保持原样。
  }
}

/** 组装发给合并子代理的消息：规范按内容分组，只贴一次，下面按文件列出批注。 */
async function buildMergeMessage(staged, boundary) {
  /** @type {Map<string, Array<{ filePath: string, content: string }>>} */
  const groups = new Map()
  for (const item of staged) {
    const chain = await loadSpecChain(item.filePath, boundary)
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
