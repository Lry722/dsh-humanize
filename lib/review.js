/**
 * 这个模块负责发起审查调用。把合并后的规范、完整文件和审查范围发给一次
 * 独立的模型调用，让模型对照规范逐条批注，输出结构化的批注列表。
 *
 * 审查用哪个模型由插件配置决定，可以选比主模型便宜的模型。
 *
 * 审查在后台进行。失败的调用由管线负责重试并发出告警，主任务照常推进。
 *
 * 审查结果走纯文本 JSON，请求里只带文本消息。有的接入方会往请求里补自己的
 * 工具。模型可能转去调用它们，这时响应里的批注为空，按失败处理。
 *
 * 批注的解析与暂存渲染在 annotations.js，调度的去重排队在
 * pipeline.js，本文件只负责发起调用和超时监控。
 *
 * @module dsh-humanize/review
 */
import { BlockAssembler, createUserMessage } from '@deepseek-ai/dsh-llm'
import { normalizeAnnotations, parseAnnotations } from './annotations.js'
import { sessionModelConfig } from './model.js'
import { loadPrompt } from './prompts.js'
import { fuseAbortSignal } from './signal.js'
import { writeRequest, writeResponse } from './staging.js'

/** 流空闲超过这个时间说明连接挂死。 */
const IDLE_TIMEOUT_MS = 120_000
/** 总时长超过这个时间说明模型陷入循环。 */
const TOTAL_TIMEOUT_MS = 10 * 60_000
/**
 * 响应留档里单块内容的上限。
 * 超出的部分只留下一段够诊断用的片段。
 */
const DUMP_BLOCK_MAX = 20_000

/**
 * 决定审查调用使用的模型。优先级依次是插件配置、会话最近一次请求
 * 使用的模型、agent 自身的模型设置。
 * @param {{ reviewProvider?: string, reviewModel?: string }} config
 * @param {import('@deepseek-ai/dsh-agent').Agent} agent
 * @returns {{ provider: string, model: string } | undefined}
 */
function resolveReviewTarget(config, agent) {
  if (typeof config.reviewProvider === 'string' && config.reviewProvider.length > 0
    && typeof config.reviewModel === 'string' && config.reviewModel.length > 0) {
    return { provider: config.reviewProvider, model: config.reviewModel }
  }
  const latest = sessionModelConfig(agent)
  if (latest?.provider !== undefined && latest?.model !== undefined) {
    return { provider: latest.provider, model: latest.model }
  }
  if (agent.options.provider !== undefined && agent.options.model !== undefined) {
    return { provider: agent.options.provider, model: agent.options.model }
  }
  return undefined
}

/**
 * 发起一次审查调用。
 * @param {import('@deepseek-ai/cordis').Context} ctx - 插件宿主上下文，提供 llm 服务。
 * @param {object} config - 审查使用的模型与推理等级。
 * @param {import('@deepseek-ai/dsh-agent').Agent} agent - 触发审查的 agent，用来定位模型和会话。
 * @param {string} filePath - 被审查文件的路径，用于留档和提示。
 * @param {string} content - 文件写入后的完整内容。
 * @param {{ text: string, startLine: number, endLine: number } | null} region -
 * 写入审查的改动区段及其在全文中的行号范围，null 表示全量审查。
 * @param {{ text: string, rules: Array<{ index: number, source: string, text: string }> }} spec - 合并后的规范文本和规则列表。
 * @param {string | undefined} existing - 已有的暂存批注，再次审查时基于它修改。
 * @param {AbortSignal} [signal] - 批次级中止信号，触发时立刻停掉这次调用。
 * @returns {Promise<{ annotations: Array<{ ruleText: string, quote: string, problem: string, suggestion: string }>, dropped: number }>}
 */
export async function runReview(ctx, config, agent, filePath, content, region, spec, existing, signal) {
  const target = resolveReviewTarget(config, agent)
  if (target === undefined) {
    const error = new Error('no provider/model available for review: set reviewProvider and reviewModel in the dsh-humanize entry config')
    // 标记配置类错误，管线对这类错误第一次失败就告警。
    error.humanizeConfigError = true
    throw error
  }
  const systemPrompt = loadPrompt('review-system')
  // 全文是审查的权威依据。审查范围只用来限定新增批注的位置。
  // 写入审查的范围是改动区段，全量审查的范围是全文。
  const fileSection = `## Full file under review: ${filePath}\n${content.replace(/\n+$/, '')}`
  const scopeSection = region === null
    ? '## Review scope: whole file\nAdd new annotations anywhere in the full file.'
    : `## Review scope: lines ${region.startLine}-${region.endLine}\nAdd new annotations only inside the region below.\n\n${region.text}`
  const sections = [
    `## Writing rules\n${spec.text}`,
    fileSection,
    scopeSection,
    ...(existing !== undefined ? [`## Existing annotations\nReconcile these against the full file. Return the complete updated list.\n\n${existing}`] : []),
  ]
  const rules = new Map(spec.rules.map((rule) => [rule.index, rule.text]))
  const { controller, dispose } = fuseAbortSignal(signal)
  try {
    // 批次中止和合并丢弃的信号可能在这之前已经触发，这里直接放弃这次调用。
    if (controller.signal.aborted) throw new Error('review aborted before dispatch')
    await writeRequest(filePath, [
      `# ${filePath}`,
      '',
      `> dsh-humanize 审查请求，发给 ${target.provider}/${target.model}，${new Date().toISOString()}。`,
      '',
      '## system',
      '',
      systemPrompt,
      '',
      '## user',
      '',
      sections.join('\n\n'),
      '',
    ].join('\n'))
    const outcome = await requestReview(ctx, config, agent, target, systemPrompt, sections, controller)
    if (outcome.finish.kind === 'max-tokens') {
      const responsePath = await writeResponse(filePath, renderResponse(filePath, target, outcome))
      throw new Error(`review output hit the model's own output limit and was truncated. Raw response: ${responsePath}`)
    }
    const parsed = readAnnotations(outcome.blocks, rules)
    if (parsed.annotations !== undefined) return parsed.annotations
    const responsePath = await writeResponse(filePath, renderResponse(filePath, target, outcome))
    throw new Error(`${parsed.error}. Raw response: ${responsePath}`)
  } finally {
    dispose()
  }
}

/**
 * 发起一次审查调用并收完整个流。请求里只带文本消息，模型按提示输出文本
 * JSON。
 *
 * 有的接入方会补上 bash 和 read 这类工具，模型转去调用它们时，响应里只剩
 * 工具调用。读取批注时先试工具调用的参数，参数解析失败再退回文本。
 * @returns {Promise<{ blocks: import('@deepseek-ai/dsh-llm').ContentBlock[], finish: import('@deepseek-ai/dsh-llm').FinishReason }>}
 */
async function requestReview(ctx, config, agent, target, systemPrompt, sections, controller) {
  const stream = ctx.llm.stream({
    provider: target.provider,
    model: target.model,
    // 推理等级由适配器按模型补齐。
    ...(typeof config.reviewReasoningEffort === 'string' && config.reviewReasoningEffort.length > 0
      // 传了但超出模型能力时，请求在发出前就会失败。
      ? { reasoningEffort: config.reviewReasoningEffort }
      : {}),
    messages: [createUserMessage({
      content: [{ type: 'text', text: sections.join('\n\n') }],
      // format v4 要求 source.kind 使用生产者自有标识。humanize 由
      // types.d.ts 声明。
      source: { kind: 'humanize' },
    })],
    system: systemPrompt,
    signal: controller.signal,
    sessionId: agent.session.id,
  })
  return drainStream(stream, controller)
}

/**
 * 从一次响应里读出批注。正常路径是文本 JSON。模型仍然给出工具调用时
 * 也尝试读它的参数，参数解析失败再退回文本。
 * @returns {{ annotations?: { annotations: Array<{ ruleText: string, quote: string, problem: string, suggestion: string }>, dropped: number }, error?: string }}
 */
function readAnnotations(blocks, rules) {
  const calls = blocks.filter((block) => block.type === 'tool-call')
  const call = calls.find((block) => block.name === 'submit_annotations')
  let toolError
  if (call !== undefined) {
    try {
      return { annotations: normalizeAnnotations(JSON.parse(call.arguments), rules) }
    } catch (error) {
      toolError = error instanceof Error ? error.message : String(error)
    }
  }
  const text = blocks
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('')
  try {
    return { annotations: parseAnnotations(text, rules) }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const called = calls
      .map((block) => block.name)
      .filter((name) => typeof name === 'string' && name.length > 0)
    const parts = []
    if (toolError !== undefined) parts.push(`tool call was not usable: ${toolError}`)
    parts.push(message)
    if (called.length > 0) parts.push(`model called ${called.join(', ')}`)
    return { error: parts.join('; ') }
  }
}

/** 截断一段留档内容，保留开头和截断长度。 */
function truncate(text, max) {
  if (text.length <= max) return text
  return `${text.slice(0, max)}\n\n[truncated ${text.length - max} characters]`
}

/**
 * 把一次响应渲染成留档文本，供排查使用。解析失败时写进请求目录旁边，
 * 留档里有模型返回的全部内容。
 */
function renderResponse(filePath, target, outcome) {
  const lines = [
    `# ${filePath}`,
    '',
    `> dsh-humanize 审查响应留档，发给 ${target.provider}/${target.model}，${new Date().toISOString()}，finish: ${outcome.finish.kind}。`,
    '',
  ]
  const calls = outcome.blocks.filter((block) => block.type === 'tool-call')
  if (calls.length > 0) {
    lines.push('## tool calls', '')
    for (const call of calls) {
      lines.push(`### ${call.name || '(unnamed)'}`, '', '```json', truncate(call.arguments, DUMP_BLOCK_MAX), '```', '')
    }
  }
  const text = outcome.blocks
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('')
  lines.push('## text', '', text.trim() === '' ? '(empty)' : truncate(text, DUMP_BLOCK_MAX), '')
  const reasoning = outcome.blocks
    .filter((block) => block.type === 'reasoning')
    .map((block) => block.text)
    .join('')
  if (reasoning.trim() !== '') lines.push('## reasoning', '', truncate(reasoning, DUMP_BLOCK_MAX), '')
  return lines.join('\n')
}

/**
 * 消费审查流直到结束，同时盯着空闲超时和总时长超时。被超时监控中止时
 * 抛出带原因的错误。
 * @returns {Promise<{ blocks: import('@deepseek-ai/dsh-llm').ContentBlock[], finish: import('@deepseek-ai/dsh-llm').FinishReason }>}
 */
async function drainStream(stream, controller) {
  let watchdog = null
  const deadline = setTimeout(() => {
    watchdog = `review stalled: no finish after ${TOTAL_TIMEOUT_MS / 60_000} minutes`
    controller.abort()
  }, TOTAL_TIMEOUT_MS)
  let idle = null
  const armIdle = () => {
    if (idle !== null) clearTimeout(idle)
    idle = setTimeout(() => {
      watchdog = `review stalled: no chunk for ${IDLE_TIMEOUT_MS / 1000} seconds`
      controller.abort()
    }, IDLE_TIMEOUT_MS)
  }

  const assembler = new BlockAssembler()
  const iterator = stream[Symbol.asyncIterator]()
  armIdle()
  try {
    while (true) {
      const { done, value } = await iterator.next()
      if (done) break
      assembler.push(value)
      armIdle()
    }
  } catch (error) {
    if (watchdog !== null) throw new Error(watchdog)
    throw error
  } finally {
    clearTimeout(deadline)
    if (idle !== null) clearTimeout(idle)
  }
  if (watchdog !== null) throw new Error(watchdog)
  const finish = assembler.finish
  if (finish.kind === 'error' || finish.kind === 'aborted') throw new Error(finish.failure.message)
  // max-tokens 也把内容块带回去，调用方写完响应留档再报错。
  return { blocks: assembler.blocks(), finish }
}
