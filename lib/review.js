/**
 * 旁路审查调用。把合并后的规范和文件内容发给一次独立的模型调用，
 * 让模型对照规范逐条批注，输出结构化的批注列表。
 *
 * 审查用哪个模型由插件配置决定，可以选比主模型便宜的模型。
 *
 * 审查在后台进行，失败由管线重试和告警，主任务照常进行。
 *
 * 批注的解析与暂存渲染在 annotations.js，调度的去重排队在
 * pipeline.js，本文件只负责发起调用和看门狗。
 *
 * @module dsh-humanize/review
 */
import { BlockAssembler, createUserMessage } from '@deepseek-ai/dsh-llm'
import { loadPrompt } from './prompts.js'
import { parseSpecRules } from './specs.js'
import { normalizeAnnotations, parseAnnotations } from './annotations.js'
import { writeRequest } from './staging.js'

/** 流空闲超过这个时间说明连接挂死。 */
const IDLE_TIMEOUT_MS = 120_000
/** 总时长超过这个时间说明模型失控循环。 */
const TOTAL_TIMEOUT_MS = 10 * 60_000

/**
 * 审查结果通过工具调用提交，参数结构由 schema 约束，不再靠提示词口头
 * 约定输出 JSON。模型没有调用工具、直接输出文本 JSON 时按旧格式兜底
 * 解析。
 */
const SUBMIT_ANNOTATIONS_TOOL = {
  name: 'submit_annotations',
  description: '提交审查批注。对照规范逐条检查完成后，不要输出任何内容，通过本工具一次性提交全部批注。',
  parameters: {
    type: 'object',
    properties: {
      annotations: {
        type: 'array',
        description: '批注列表，没有问题时为空列表。',
        items: {
          type: 'object',
          properties: {
            rule: {
              type: ['number'],
              description: '被违反的规范条目编号，以规范文本中的编号为准。',
            },
            quote: { type: 'string', description: '大致描述片段内容，尽量短。' },
            problem: { type: 'string', description: '说明片段内容具体有什么问题。' },
            suggestion: { type: 'string', description: '修改建议。' },
          },
          required: ['rule', 'quote', 'problem', 'suggestion'],
          additionalProperties: false,
        },
      },
    },
    required: ['annotations'],
    additionalProperties: false,
  },
}

/**
 * 决定审查调用使用的模型，依次取插件配置、会话最近一次请求使用的
 * 模型、agent 自身的模型设置。
 * @param {{ reviewProvider?: string, reviewModel?: string }} config
 * @param {import('@deepseek-ai/dsh-agent').Agent} agent
 * @returns {{ provider: string, model: string } | undefined}
 */
function resolveReviewTarget(config, agent) {
  if (typeof config.reviewProvider === 'string' && config.reviewProvider.length > 0
    && typeof config.reviewModel === 'string' && config.reviewModel.length > 0) {
    return { provider: config.reviewProvider, model: config.reviewModel }
  }
  const latest = agent.session.requestHeader()?.config
  if (latest !== undefined && latest.provider !== undefined && latest.model !== undefined) {
    return { provider: latest.provider, model: latest.model }
  }
  if (agent.options.provider !== undefined && agent.options.model !== undefined) {
    return { provider: agent.options.provider, model: agent.options.model }
  }
  return undefined
}

/**
 * 发起一次旁路审查调用。
 * @param {import('@deepseek-ai/cordis').Context} ctx - 插件宿主上下文，提供 llm 服务。
 * @param {object} config - 审查使用的模型与推理等级。
 * @param {import('@deepseek-ai/dsh-agent').Agent} agent - 触发审查的 agent，用来定位模型和会话。
 * @param {string} filePath - 被审查文件的路径，用于留档和提示。
 * @param {string} content - 文件写入后的完整内容。
 * @param {{ text: string, startLine: number } | null} region - 本次改动的
 * 区段，null 表示审查全文。
 * @param {string} specText - 合并后的规范文本。
 * @param {string | undefined} existing - 已有的暂存批注，再次审查时基于它修改。
 * @param {AbortSignal} [signal] - 批次级中止信号，触发时立刻停掉这次调用。
 * @returns {Promise<{ annotations: Array<{ ruleText: string | null, quote: string, problem: string, suggestion: string }> }>}
 */
export async function runReview(ctx, config, agent, filePath, content, region, specText, existing, signal) {
  const target = resolveReviewTarget(config, agent)
  if (target === undefined) {
    // humanizeConfigError 标记配置类错误，管线对这类错误第一次失败就告警。
    const error = new Error('no provider/model available for review: set reviewProvider and reviewModel in the dsh-humanize entry config')
    error.humanizeConfigError = true
    throw error
  }
  const systemPrompt = loadPrompt('review-system')
  const contentSection = region === null
    ? `## 被审查文件：${filePath}\n${content}`
    : `## 被审查文件的 diff 片段：${filePath}\n${region.text}`
  const sections = [
    `## 写作规范\n${specText}`,
    ...(existing !== undefined ? [`## 已有批注\n在其基础上更新，移除过时的内容，提交更新后的完整批注列表。\n${existing}`] : []),
    contentSection,
  ]
  const controller = new AbortController()
  // 批次中止信号触发时立刻停掉这次调用。
  const onBatchAbort = () => controller.abort()
  const listening = signal !== undefined && !signal.aborted
  if (signal !== undefined) {
    if (signal.aborted) controller.abort()
    else signal.addEventListener('abort', onBatchAbort, { once: true })
  }
  try {
    // 批次已中止时不留档也不发请求，避免留下一份从没发出过的请求留档。
    if (controller.signal.aborted) throw new Error('review aborted before dispatch')
    // 留档完整请求，排查审查行为时可以直接查看。
    await writeRequest(filePath, [
      `# ${filePath}`,
      '',
      `> dsh-humanize 审查请求，发给 ${target.provider}/${target.model}，${new Date().toISOString()}。`,
      '',
      '## system',
      '',
      systemPrompt,
      '',
      '## tools',
      '',
      '```json',
      JSON.stringify(SUBMIT_ANNOTATIONS_TOOL, null, 2),
      '```',
      '',
      '## user',
      '',
      sections.join('\n\n'),
      '',
    ].join('\n'))
    // 审查调用不设输出上限。异步调用不涉及等待体验，模型自身的输出上限
    // 就是边界。
    const stream = ctx.llm.stream({
      provider: target.provider,
      model: target.model,
      // 推理等级由适配器按模型定义。填入模型不支持的等级会在发起前报错。
      ...(typeof config.reviewReasoningEffort === 'string' && config.reviewReasoningEffort.length > 0
        ? { reasoningEffort: config.reviewReasoningEffort }
        : {}),
      messages: [createUserMessage({
        content: [{ type: 'text', text: sections.join('\n\n') }],
        // format v4 要求 source.kind 是生产者自有标识，禁止 retired 的
        // { kind: 'plugin', plugin } 包装，未收录插件写成 plugin:<name>。
        source: { kind: 'plugin:dsh-humanize' },
      })],
      system: systemPrompt,
      tools: [SUBMIT_ANNOTATIONS_TOOL],
      signal: controller.signal,
      sessionId: agent.session.id,
    })
    const blocks = await drainStream(stream, controller)
    const rules = parseSpecRules(specText)
    // 首选工具调用结果；模型不支持或拒绝调用工具时兜底解析文本 JSON。
    const call = blocks.find((block) => block.type === 'tool-call' && block.name === SUBMIT_ANNOTATIONS_TOOL.name)
    if (call !== undefined) {
      try {
        return { annotations: normalizeAnnotations(JSON.parse(call.arguments), rules) }
      } catch {
        // 工具参数不是合法 JSON 时按没有工具调用处理，走文本兜底。
      }
    }
    const text = blocks
      .filter((block) => block.type === 'text')
      .map((block) => block.text)
      .join('')
    return { annotations: parseAnnotations(text, rules) }
  } finally {
    // 监听器挂在批次信号上，不摘除会活到整个批次结束。
    if (listening) signal.removeEventListener('abort', onBatchAbort)
  }
}

/**
 * 消费审查流直到结束，带空闲和总时长双看门狗。被看门狗中止时抛出
 * 带原因的错误。
 * @returns {Promise<import('@deepseek-ai/dsh-llm').ContentBlock[]>} 组装好的全部内容块。
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
  if (finish.kind === 'max-tokens') throw new Error('review output hit the model\'s own output limit and was truncated')
  return assembler.blocks()
}
