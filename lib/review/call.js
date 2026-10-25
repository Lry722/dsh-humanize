/**
 * 这个模块负责发起审查调用。把合并后的规范和完整文件发给一次独立的模型调用。
 *
 * 写入审查时用标记圈出各段改动区段，全量审查则直接说明范围是全文。让模型
 * 对照规范逐条批注，输出结构化的批注列表。
 *
 * 审查用哪个模型由插件配置决定，可以选比主模型便宜的模型。
 *
 * 审查在后台进行。失败的调用由管线负责重试并发出告警，主任务照常推进。
 *
 * @module dsh-humanize/review/call
 */
import { BlockAssembler, createUserMessage } from '@deepseek-ai/dsh-llm'
import { deadline, idleWatchdog, timeoutOf } from '@deepseek-ai/dsh-timeout'
import { normalizeAnnotations, parseAnnotations } from './annotations.js'
import { outerFence } from '../shared/markdown.js'
import { resolveModelTarget } from '../shared/model.js'
import { loadPrompt } from '../shared/prompts.js'
import { fuseAbortSignal } from '../shared/signal.js'
import { writeRequest, writeResponse } from '../shared/staging.js'
import { truncateText } from '../shared/text.js'

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
 * 发起一次审查调用。
 * @param {import('@deepseek-ai/cordis').Context} ctx - 插件宿主上下文，提供 llm 服务。
 * @param {object} config - 审查使用的模型与推理等级。
 * @param {import('@deepseek-ai/dsh-agent').Agent} agent - 触发审查的 agent，用来定位模型和会话。
 * @param {string} filePath - 被审查文件的路径，用于留档。
 * @param {string} content - 文件写入后的完整内容。
 * @param {Array<{ startLine: number, endLine: number }> | null} regions -
 * 写入审查时圈出的范围列表，null 表示全量审查。
 * @param {{ text: string, rules: Array<{ index: number, source: string, text: string }> }} spec - 合并后的规范文本和规则列表。
 * @param {string | undefined} existing - 已有的暂存批注，再次审查时基于它修改。
 * @param {AbortSignal} [signal] - 批次级中止信号，触发时立刻停掉这次调用。
 * @returns {Promise<{ annotations: Array<{ ruleText: string, quote: string, problem: string, suggestion: string }>, dropped: number }>}
 */
export async function runReview(ctx, config, agent, filePath, content, regions, spec, existing, signal) {
  const target = resolveModelTarget(config, agent, 'review', { fallbackToAgentOptions: true })
  if (target === undefined) {
    const error = new Error('no provider/model available for review: set reviewProvider and reviewModel in the dsh-humanize entry config')
    // 标记配置类错误，管线对这类错误第一次失败就告警。
    error.humanizeConfigError = true
    throw error
  }
  const systemPrompt = loadPrompt('review-system')
  // regions 为 null 表示全量审查，空列表表示没有新文本落在审查范围内。
  const lines = content.split('\n')
  const marked = regions === null || regions.length === 0 ? lines : markRegions(lines, regions)
  const scope = regions === null
    ? 'The whole file is in scope.'
    : regions.length === 0
      ? 'No new text is in scope.'
      : ''
  const fileText = marked.join('\n')
  const fence = outerFence(fileText)
  const parts = ['## Full file content under review']
  if (scope !== '') parts.push(scope)
  parts.push(`${fence}\n${fileText}\n${fence}`)
  const fileSection = parts.join('\n\n')
  const sections = [
    `## Writing rules\n${spec.text}`,
    fileSection,
    ...(existing !== undefined && existing.trim() !== ''
      ? [`## Existing annotations\nKeep every existing annotation whose quoted text still exists in the full file. Do not drop one for any other reason. Return the complete final list, including all retained existing annotations and any new ones.\n\n${existing}`]
      : []),
  ]
  const rules = new Map(spec.rules.map((rule) => [rule.index, rule.text]))
  const { controller, dispose } = fuseAbortSignal(signal)
  try {
    // 批次中止和合并丢弃的信号可能在这之前已经触发，这里直接放弃这次调用。
    if (controller.signal.aborted) throw new Error('review aborted before dispatch')
    // 请求留档只为排查问题，写入失败时审查照常进行。
    await dumpRequest(ctx, filePath, [
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
      const responsePath = await dumpResponse(ctx, filePath, renderResponse(filePath, target, outcome))
      const message = "review output hit the model's own output limit and was truncated."
      throw new Error(responsePath === undefined ? message : `${message} Raw response: ${responsePath}`)
    }
    const parsed = readAnnotations(outcome.blocks, rules)
    if (parsed.annotations !== undefined) return parsed.annotations
    // 解析不出批注时按失败处理，原始响应写到请求留档旁边，路径随错误信息一起抛出去。
    const responsePath = await dumpResponse(ctx, filePath, renderResponse(filePath, target, outcome))
    throw new Error(responsePath === undefined ? parsed.error : `${parsed.error}. Raw response: ${responsePath}`)
  } finally {
    dispose()
  }
}

/**
 * 在全文里给每段审查范围加一对标记。审查范围按行号从小到大排列，互不重叠。
 * @param {string[]} lines
 * @param {Array<{ startLine: number, endLine: number }>} regions
 * @returns {string[]}
 */
function markRegions(lines, regions) {
  const marked = []
  let cursor = 0
  for (const region of regions) {
    marked.push(...lines.slice(cursor, region.startLine - 1))
    marked.push(`<!-- dsh-humanize: review scope starts (lines ${region.startLine}-${region.endLine}) -->`)
    marked.push(...lines.slice(region.startLine - 1, region.endLine))
    marked.push('<!-- dsh-humanize: review scope ends -->')
    cursor = region.endLine
  }
  marked.push(...lines.slice(cursor))
  return marked
}

/**
 * 发起一次审查调用并收完整个流。
 * @returns {Promise<{ blocks: import('@deepseek-ai/dsh-llm').ContentBlock[], finish: import('@deepseek-ai/dsh-llm').FinishReason }>}
 */
async function requestReview(ctx, config, agent, target, systemPrompt, sections, controller) {
  // 空闲超时盯住每次读流，总时长兜住整个调用。两个计时器都汇到交给流的
  // 信号上，超时后由适配器收尾。
  const idle = idleWatchdog(controller.signal, IDLE_TIMEOUT_MS, 'HUMANIZE_REVIEW_IDLE')
  const total = deadline(idle.signal, TOTAL_TIMEOUT_MS, 'HUMANIZE_REVIEW_TOTAL')
  try {
    const stream = ctx.llm.stream({
      provider: target.provider,
      model: target.model,
      // 推理等级由适配器按模型补齐。
      ...(typeof config.reviewReasoningEffort === 'string' && config.reviewReasoningEffort.length > 0
        // 传了但超出模型能力时，请求在发出前就会失败。
        ? { reasoningEffort: config.reviewReasoningEffort }
        : {}),
      // 请求里只带文本消息，模型按提示输出纯文本 JSON。
      messages: [createUserMessage({
        content: [{ type: 'text', text: sections.join('\n\n') }],
        // format v4 要求 source.kind 使用生产者自有标识。humanize 由
        // types.d.ts 声明。
        source: { kind: 'humanize' },
      })],
      system: systemPrompt,
      signal: total.signal,
      sessionId: agent.session.id,
    })
    return await drainStream(stream, idle, total)
  } finally {
    idle[Symbol.dispose]()
    total[Symbol.dispose]()
  }
}

/**
 * 从一次响应里读出批注。
 * @returns {{ annotations?: { annotations: Array<{ ruleText: string, quote: string, problem: string, suggestion: string }>, dropped: number }, error?: string }}
 */
function readAnnotations(blocks, rules) {
  const calls = blocks.filter((block) => block.type === 'tool-call')
  const call = calls.find((block) => block.name === 'submit_annotations')
  let toolError
  // 有的接入方会补上 bash 和 read 这类工具，模型转去调用它们时响应里没有
  // 批注，按失败处理。模型调用 submit_annotations 时先试它的参数。
  if (call !== undefined) {
    try {
      return { annotations: normalizeAnnotations(JSON.parse(call.arguments), rules) }
    } catch (error) {
      toolError = error instanceof Error ? error.message : String(error)
    }
  }
  // 正常路径是文本 JSON。工具调用的参数解析失败时，也退回这里读文本。
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

/**
 * 把一次响应渲染成留档文本，供排查使用。留档里保留模型返回的内容，
 * 超出上限的部分会截断。
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
      lines.push(`### ${call.name || '(unnamed)'}`, '', '```json', truncateText(call.arguments, DUMP_BLOCK_MAX), '```', '')
    }
  }
  const text = outcome.blocks
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('')
  lines.push('## text', '', text.trim() === '' ? '(empty)' : truncateText(text, DUMP_BLOCK_MAX), '')
  const reasoning = outcome.blocks
    .filter((block) => block.type === 'reasoning')
    .map((block) => block.text)
    .join('')
  if (reasoning.trim() !== '') lines.push('## reasoning', '', truncateText(reasoning, DUMP_BLOCK_MAX), '')
  return lines.join('\n')
}

/**
 * 写请求留档。写入失败时只告警，审查照常进行。
 * @returns {Promise<void>}
 */
async function dumpRequest(ctx, filePath, content) {
  try {
    await writeRequest(filePath, content)
  } catch (error) {
    warnDumpFailure(ctx, 'request', filePath, error)
  }
}

/**
 * 写响应留档，文件放在请求留档旁边。写失败时返回 undefined，
 * 调用方照常抛出审查本身的错误。
 * @returns {Promise<string | undefined>}
 */
async function dumpResponse(ctx, filePath, content) {
  try {
    return await writeResponse(filePath, content)
  } catch (error) {
    warnDumpFailure(ctx, 'response', filePath, error)
    return undefined
  }
}

/** 留档失败只记一条警告。测试里的上下文可以没有日志服务。 */
function warnDumpFailure(ctx, kind, filePath, error) {
  try {
    const message = error instanceof Error ? error.message : String(error)
    ctx.logger?.('dsh-humanize')?.warn('humanize: failed to write review %s dump for %s: %s', kind, filePath, message)
  } catch {
    // 日志本身出错时，审查照常进行。
  }
}

/**
 * 消费审查流直到结束。空闲超时由看门狗盯着每次读流，总时长由 deadline
 * 兜底，超时时按停顿报错。其余失败按流自己的 finish 原因报错。
 * @param {AsyncIterable<import('@deepseek-ai/dsh-llm').StreamChunk>} stream
 * @param {import('@deepseek-ai/dsh-timeout').IdleWatchdog} idle
 * @param {import('@deepseek-ai/dsh-timeout').Deadline} total
 * @returns {Promise<{ blocks: import('@deepseek-ai/dsh-llm').ContentBlock[], finish: import('@deepseek-ai/dsh-llm').FinishReason }>}
 */
async function drainStream(stream, idle, total) {
  const assembler = new BlockAssembler()
  const iterator = stream[Symbol.asyncIterator]()
  try {
    while (true) {
      const { done, value } = await idle.next(iterator)
      if (done) break
      assembler.push(value)
    }
  } catch (error) {
    // 超时中止时适配器通常抛出取消类错误，按超时信号翻译成停顿说明。
    throw stallError(idle, total) ?? error
  }
  const finish = assembler.finish
  if (finish.kind === 'error' || finish.kind === 'aborted') {
    // 流以普通失败收尾时也要先确认超时，免得把超时报成提供方错误。
    throw stallError(idle, total) ?? new Error(finish.failure.message)
  }
  // max-tokens 也把内容块带回去，调用方写完响应留档再报错。
  return { blocks: assembler.blocks(), finish }
}

/**
 * 把超时信号翻译成给用户看的停顿错误，没有超时时返回 undefined。空闲
 * 超时先检查，两个计时器都触发时报告最近一次读流卡住。
 * @param {import('@deepseek-ai/dsh-timeout').IdleWatchdog} idle
 * @param {import('@deepseek-ai/dsh-timeout').Deadline} total
 * @returns {Error | undefined}
 */
function stallError(idle, total) {
  if (timeoutOf(idle.signal, 'HUMANIZE_REVIEW_IDLE') !== undefined) {
    return new Error(`review stalled: no chunk for ${IDLE_TIMEOUT_MS / 1000} seconds`)
  }
  if (timeoutOf(total.signal, 'HUMANIZE_REVIEW_TOTAL') !== undefined) {
    return new Error(`review stalled: no finish after ${TOTAL_TIMEOUT_MS / 60_000} minutes`)
  }
  return undefined
}
