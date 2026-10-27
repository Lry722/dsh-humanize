/**
 * 合并子代理的复用、逐轮结果回收与模型历史重置。
 *
 * 每个父会话复用目录里最新一个合并子代理。续用时，新消息进入模型前，
 * 把旧占位消息和上一轮对话替换成同一条固定占位消息。原始事件仍保留在
 * 日志里，但后续 deriveMessages 不再包含它们，因此跨轮输入不会积累。
 *
 * @module dsh-humanize/merge/child
 */
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { MERGE_PRESET } from './lock.js'

const MERGE_PROVIDER = 'spawn'
export const MERGE_LABEL = 'humanize 批注合并'
export const MERGE_RESET_TEXT = 'Previous merge turns are intentionally omitted.'

/** 两个 surface 节点序列是否仍然一致。 */
function sameNodes(left, right) {
  return left.length === right.length && left.every((seq, index) => seq === right[index])
}

/**
 * 找出父会话最新一个可继续的合并子代理。目录是持久状态，因此插件重载后
 * 也能续用，不依赖本插件实例里的 Map。
 */
async function findMergeChild(ctx, agent, signal) {
  const entries = await ctx.subagents.listChildren(agent.session.id, signal)
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index]
    if (entry.mode === 'continuable' && entry.label === MERGE_LABEL) return entry.id
  }
  return undefined
}

/**
 * 把当前对话 surface 替换成一条固定占位消息，保留受保护的系统头节点。
 * 返回是否实际执行了替换。读取头节点后 surface 若发生变化，则拒绝写入，
 * 让本次派发失败，避免在不确定的历史边界上裁剪。
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {import('@deepseek-ai/dsh-agent').Agent['session']} session
 * @param {{ signal?: AbortSignal }} [options]
 */
export async function resetMergeSurface(ctx, session, options = {}) {
  const nodes = [...session.surface.nodes]
  if (nodes.length === 0) return false
  const query = ctx.sessionQuery ?? ctx.get('sessionQuery')
  if (query === undefined) throw new Error('重置合并子代理历史需要 sessionQuery 服务。')
  const head = await query.readEvent({
    sessionId: session.id,
    seq: nodes[0],
    before: 0,
    after: 0,
  }, options.signal)
  if (!sameNodes(nodes, session.surface.nodes)) {
    throw new Error('合并子代理的历史在重置前发生变化，请重试。')
  }
  const offset = head.target.type === 'system/message' ? 1 : 0
  if (offset === nodes.length) return false
  const shadowedSeqs = nodes.slice(offset)
  session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: MERGE_RESET_TEXT }],
    source: { kind: 'humanize' },
  }), {
    surfaceOp: {
      op: 'replace',
      startSeq: shadowedSeqs[0],
      endSeq: shadowedSeqs[shadowedSeqs.length - 1],
    },
    sourceEventSeqs: shadowedSeqs,
  })
  return true
}

/** 监听一轮子代理的错误明细。续用轮次按本次恢复 epoch 的 runId 回收结果。 */
function watchRun(ctx, childId, includeResult) {
  let failure
  let runId
  let settleResult
  const result = new Promise((resolve) => { settleResult = resolve })
  const disposers = [ctx.on('session/event', (session, event) => {
    if (session.id !== childId || event.type !== 'turn/end') return
    const reason = event.data?.reason
    if (reason?.kind !== 'error') return
    const detail = reason.error?.message ?? reason.error?.name
    if (typeof detail === 'string' && detail.trim().length > 0) failure = detail.trim()
  })]
  if (includeResult) {
    disposers.push(ctx.on('subagent/start', (info) => {
      if (info.id !== childId) return
      // 同一持久子代理可能有多个恢复 epoch。只认本次 start 后的 runId，
      // 并清掉上一个 epoch 可能刚送达的错误明细。
      runId = info.runId
      failure = undefined
    }))
    disposers.push(ctx.on('subagent/end', (info) => {
      if (info.id !== childId || runId === undefined || info.runId !== runId) return
      settleResult({
        output: info.lastAssistantMessage ?? [],
        stopReason: info.stopReason,
      })
    }))
  }
  let stopped = false
  return {
    result,
    get runId() { return runId },
    get failure() { return failure },
    stop() {
      if (stopped) return
      stopped = true
      for (const dispose of disposers) dispose()
    },
  }
}

/** 给一轮运行补上与首次 activation 相同的收尾能力，并单独提供异常取消。 */
function makeRun(ctx, agent, childId, result, reused, watcher, activation, stopRouting) {
  let disposed = false
  const close = async (cancel) => {
    if (disposed) return
    disposed = true
    stopRouting()
    watcher.stop()
    if (activation !== undefined) {
      await activation.dispose()
    } else if (cancel) {
      // 续用的正常结束已由 subagent/end 完成 teardown，只需清理监听。
      // 只有本轮仍在运行、但后续接线失败时才取消驻留实例。
      await ctx.subagents.drainChildren(agent, [childId])
    }
  }
  return {
    childId,
    result,
    reused,
    get failure() { return watcher.failure },
    dispose: () => close(false),
    cancel: () => close(true),
  }
}

/** 按 DSH 首次创建的继承规则，计算续用轮次应使用的模型选项。 */
function continuedAgentOptions(parent, requested) {
  const created = parent.options ?? {}
  const requestConfig = parent.session.requestHeader?.()?.config
  const { provider: createdProvider, model: createdModel, reasoningEffort: createdEffort, ...createdRest } = created
  const inherited = requestConfig === undefined
    ? { ...created }
    : {
        ...createdRest,
        provider: requestConfig.provider,
        model: requestConfig.model,
        ...requestConfig.reasoningEffort !== undefined
          ? { reasoningEffort: requestConfig.reasoningEffort }
          : {},
      }
  const resolved = {
    ...inherited.provider !== undefined ? { provider: inherited.provider } : {},
    ...inherited.model !== undefined ? { model: inherited.model } : {},
    ...inherited.reasoningEffort !== undefined ? { reasoningEffort: inherited.reasoningEffort } : {},
    ...inherited.maxTokens !== undefined ? { maxTokens: inherited.maxTokens } : {},
    ...requested,
  }
  if ((resolved.provider !== inherited.provider || resolved.model !== inherited.model)
    && requested?.reasoningEffort === undefined) {
    delete resolved.reasoningEffort
  }
  return resolved
}

/** 续用时应用本轮模型设置，并清除上一轮不再继承的选项。 */
function watchRouting(ctx, childId, agentOptions) {
  return ctx.on('agent/request', async ({ agent }, next) => {
    if (agent.session.id !== childId) return next()
    const current = await next()
    const { reasoningEffort: _previousEffort, maxTokens: _previousMaxTokens, ...rest } = current
    return {
      ...rest,
      ...agentOptions.provider !== undefined ? { provider: agentOptions.provider } : {},
      ...agentOptions.model !== undefined ? { model: agentOptions.model } : {},
      ...agentOptions.reasoningEffort !== undefined
        ? { reasoningEffort: agentOptions.reasoningEffort }
        : {},
      ...agentOptions.maxTokens !== undefined ? { maxTokens: agentOptions.maxTokens } : {},
    }
  })
}

/** 在恢复后的首个请求前重置历史，再发送本轮动态请求。 */
async function resumeMergeChild(ctx, agent, childId, text, agentOptions, signal) {
  const watcher = watchRun(ctx, childId, true)
  const stopRouting = watchRouting(ctx, childId, agentOptions)
  let stopCreated = () => {}
  let resetReady = false
  let admitted = false
  try {
    stopCreated = ctx.on('agent/created', async ({ agent: created }) => {
      if (created.session.id !== childId) return
      await resetMergeSurface(ctx, created.session, { signal })
      resetReady = true
    })
    // 驻留实例没有新的 subagent/start，无法安全区分本轮与旧 epoch 的
    // end。正常结束后的续用都走冷恢复；仍在驻留就按忙处理。
    if (ctx.agents.get(childId) !== undefined) {
      throw new Error('上一次批注合并的子代理还在运行，等它结束后再派发。')
    }
    await ctx.subagents.sendMessage(agent, childId, [{ type: 'text', text }], { signal })
    admitted = true
    if (!resetReady) throw new Error('合并子代理恢复时未能重置历史，请重试。')
    if (watcher.runId === undefined) throw new Error('合并子代理恢复时未能建立新的运行周期，请重试。')
    stopCreated()
    stopCreated = () => {}
    return makeRun(ctx, agent, childId, watcher.result, true, watcher, undefined, stopRouting)
  } catch (error) {
    stopCreated()
    stopRouting()
    watcher.stop()
    if (admitted) {
      try {
        await ctx.subagents.drainChildren(agent, [childId])
      } catch {
        // 这里只清理已经 admitted 的本轮实例，发送前的失败交给 DSH 回滚。
      }
    }
    throw error
  }
}

/**
 * 派发一轮合并。首次使用 activation.result，续用使用 subagent/end。两种运行
 * 都返回统一的 childId、result、failure、dispose 和 cancel 供现有合并收尾使用。
 */
export async function dispatchMergeChild(ctx, agent, text, agentOptions) {
  const signal = new AbortController().signal
  const existingChildId = await findMergeChild(ctx, agent, signal)
  if (existingChildId !== undefined) {
    return resumeMergeChild(ctx, agent, existingChildId, text, continuedAgentOptions(agent, agentOptions), signal)
  }
  const activation = await ctx.subagents.startActivation({
    provider: MERGE_PROVIDER,
    label: MERGE_LABEL,
    request: {
      parent: agent,
      ...agentOptions !== undefined ? { agentOptions } : {},
      prompt: [{ type: 'text', text }],
      agentPreset: MERGE_PRESET,
    },
    signal,
    delivery: 'caller',
  })
  const watcher = watchRun(ctx, activation.childId, false)
  return makeRun(ctx, agent, activation.childId, activation.result, false, watcher, activation, () => {})
}
