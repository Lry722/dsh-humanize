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
export const MERGE_LABEL = 'humanize 行文润色'
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
  if (query === undefined) throw new Error('重置润色子代理历史需要 sessionQuery 服务。')
  const head = await query.readEvent({
    sessionId: session.id,
    seq: nodes[0],
    before: 0,
    after: 0,
  }, options.signal)
  if (!sameNodes(nodes, session.surface.nodes)) {
    throw new Error('润色子代理的历史在重置前发生变化，请重试。')
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

/** 把 AgentLoop 的结束原因映射成现有合并流程使用的结果状态。 */
function turnStopReason(kind) {
  if (kind === 'completed') return 'completed'
  if (kind === 'max-tokens') return 'max-tokens'
  if (kind === 'aborted' || kind === 'interrupted') return 'aborted'
  if (kind === 'blocked') return 'refusal'
  return 'error'
}

/** 监听当前子代理最近一轮的结束原因和错误明细。 */
function watchRun(ctx, childId) {
  let failure
  let stopReason
  const begin = () => {
    failure = undefined
    stopReason = undefined
  }
  const stop = ctx.on('session/event', (session, event) => {
    if (session.id !== childId) return
    if (event.type === 'turn/start') {
      begin()
      return
    }
    if (event.type !== 'turn/end') return
    const reason = event.data?.reason
    stopReason = turnStopReason(reason?.kind)
    failure = undefined
    if (reason?.kind !== 'error') return
    const detail = reason.error?.message ?? reason.error?.name
    if (typeof detail === 'string' && detail.trim().length > 0) failure = detail.trim()
  })
  let stopped = false
  return {
    begin,
    get stopReason() { return stopReason },
    get failure() { return failure },
    stop() {
      if (stopped) return
      stopped = true
      stop()
    },
  }
}

/** 精确句柄只销毁一次。正常收尾与异常取消共用同一个所有权。 */
function singleDispose(dispose) {
  let pending
  return () => pending ??= Promise.resolve().then(dispose)
}

/** 给一轮运行补上统一的监听清理和精确句柄销毁能力。 */
function makeRun(childId, result, reused, watcher, stopRouting, disposeAgent) {
  let disposed = false
  const close = async () => {
    if (disposed) return
    disposed = true
    stopRouting()
    watcher.stop()
    await disposeAgent()
  }
  return {
    childId,
    result,
    reused,
    get failure() { return watcher.failure },
    dispose: close,
    cancel: close,
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
  const depth = Math.max(parent.session.header?.delegationDepth ?? 0, parent.options?.subagentDepth ?? 0) + 1
  if (!Number.isSafeInteger(depth)) throw new RangeError('润色子代理的委派深度超出安全范围。')
  return { ...resolved, subagentDepth: depth }
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

/** 恢复固定合并 preset 和委派权限提示，与父会话的动态 preset 保持独立。 */
async function setupResumedMerge(childCtx) {
  const presets = childCtx.get('agentPresets')
  if (presets === undefined) throw new Error('恢复润色子代理需要 agentPresets 服务。')
  await presets.mount(childCtx, MERGE_PRESET)
  childCtx.systemPrompt.context({
    name: 'subagent:delegation',
    order: childCtx.systemPrompt.getContextOrder('SUBAGENT_DELEGATION'),
    text: 'You are a delegated subagent: your permission scope was fixed when you were started and cannot be '
      + 'widened from inside this session — operations that require approval are rejected automatically. '
      + 'When the task needs access beyond that scope, do not retry the denied operation; state the '
      + 'limitation in your reply so the delegating agent can handle it.',
  })
}

/** 保持 sendMessage 原来的 relay 格式，但只把请求发给子代理本身。 */
function mergeRelayMessage(parent, text) {
  return createUserMessage({
    content: [
      { type: 'text', text: `Agent ${parent.id} sent a message: ` },
      { type: 'text', text },
    ],
    source: { kind: 'agent-message', form: 'relay', senderSessionId: parent.id },
  })
}

/** 直接恢复同一子会话，由调用方持有结果和销毁权，避免父会话结算通知。 */
async function resumeMergeChild(ctx, agent, childId, text, agentOptions, signal) {
  const watcher = watchRun(ctx, childId)
  const stopRouting = watchRouting(ctx, childId, agentOptions)
  let stopCreated = () => {}
  let resetReady = false
  let handle
  try {
    stopCreated = ctx.on('agent/created', async ({ agent: created }) => {
      if (created.session.id !== childId) return
      await resetMergeSurface(ctx, created.session, { signal })
      resetReady = true
    })
    if (ctx.agents.get(childId) !== undefined) {
      throw new Error('上一次润色子代理还在运行，等它结束后再派发。')
    }
    handle = await ctx.agents.resume({
      resumeSessionId: childId,
      parentAgent: agent,
      agentOptions,
      signal,
      setup: setupResumedMerge,
    })
    if (!resetReady) throw new Error('润色子代理恢复时未能重置历史，请重试。')
    stopCreated()
    stopCreated = () => {}
    const child = handle.agent
    const disposeHandle = singleDispose(() => handle.dispose())
    watcher.begin()
    child.steer(mergeRelayMessage(agent, text))
    const result = (async () => {
      try {
        await child.whenIdle()
        if (watcher.stopReason === undefined) throw new Error('润色子代理结束时没有本轮结束事件。')
        return { output: [], stopReason: watcher.stopReason }
      } finally {
        await disposeHandle()
      }
    })()
    void result.catch(() => undefined)
    return makeRun(childId, result, true, watcher, stopRouting, disposeHandle)
  } catch (error) {
    stopCreated()
    stopRouting()
    watcher.stop()
    if (handle !== undefined) await handle.dispose().catch(() => undefined)
    throw error
  }
}

/**
 * 派发一轮合并。首次使用 activation.result，续用使用精确 AgentHandle 的
 * whenIdle。两种运行都返回统一的 childId、result、failure、dispose 和 cancel。
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
  const watcher = watchRun(ctx, activation.childId)
  return makeRun(
    activation.childId,
    activation.result,
    false,
    watcher,
    () => {},
    singleDispose(() => activation.dispose()),
  )
}
