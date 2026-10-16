/**
 * 旁路审查。把合并后的规范和文件内容发给一次独立的模型调用，
 * 让模型对照规范逐条批注，输出结构化的批注列表。审查用哪个模型由
 * 插件配置决定，可以选比主模型便宜的模型。审查在后台进行，失败只
 * 记录日志，不影响主任务。
 *
 * @module dsh-humanize/review
 */
import { BlockAssembler, createUserMessage } from '@deepseek-ai/dsh-llm'
import { parseSpecRules } from './specs.js'
import { writeRequest } from './staging.js'

const SYSTEM_PROMPT = `你是行文规范审查员。写作规范来自各级 PROSE.md，范围越小的规则优先级越高。用户会给你一份写作规范和一个文件的内容。逐条对照规范，检查文件内容中面向人类阅读的文字，找出不符合规范的表达。

输出且仅输出一个 JSON 对象，不要输出其他文字，不要使用代码围栏：
{"annotations": [{"rule": 2, "quote": "原文片段", "problem": "问题说明", "suggestion": "修改建议"}]}

要求：
- rule 是被违反的规范条目编号，以规范文本中的编号为准。无法对应具体条目时填 null。
- quote 必须是被审查内容中的原文，尽量短。
- 没有问题时输出 {"annotations": []}。
- 如果被审查内容只是文件的改动片段，只批注片段里的文字。已有批注涉及片段之外的内容时无法核实，保留原样。
- 如果用户提供了已有批注，在其基础上更新，输出更新后的完整批注列表。更新时保留仍然成立的批注，删除已解决的批注，合并重复的批注，补充新发现的批注。`

/**
 * 审查调用不设输出上限。异步调用不涉及等待体验，模型自身的输出上限
 * 就是天然边界，预设一个低于模型上限的值只会让大文件审查在 JSON 截断
 * 时整次作废。真正的失控防护是看门狗。流空闲超过 IDLE_TIMEOUT_MS 说明
 * 连接挂死，总时长超过 TOTAL_TIMEOUT_MS 说明模型失控循环。两种情况都
 * 中止调用。
 */
const IDLE_TIMEOUT_MS = 120_000
const TOTAL_TIMEOUT_MS = 10 * 60_000

/**
 * 决定审查调用使用的模型，依次取插件配置、会话最近一次请求使用的
 * 模型、agent 自身的模型设置。
 * @param {{ reviewProvider?: string, reviewModel?: string }} config
 * @param {import('@deepseek-ai/dsh-agent').Agent} agent
 * @returns {{ provider: string, model: string } | undefined}
 */
export function resolveReviewTarget(config, agent) {
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
 * @param {object} config - 插件配置。
 * @param {import('@deepseek-ai/dsh-agent').Agent} agent - 触发审查的 agent，用来定位模型和会话。
 * @param {string} filePath - 被审查文件的路径。
 * @param {string} content - 文件写入后的完整内容。
 * @param {{ text: string, startLine: number } | null} region - 本次改动的
 * 区段，null 表示审查全文。
 * @param {string} specText - 合并后的规范文本。
 * @param {string | undefined} existing - 已有的暂存批注，再次审查时基于它修改。
 * @param {Set<AbortController>} pending - 在途审查的中止句柄，插件卸载时统一中止。
 * @param {AbortSignal} [signal] - 批次级取消；中止时立刻停掉这次调用。
 * @returns {Promise<{ annotations: Array<{ ruleText: string | null, quote: string, problem: string, suggestion: string }>, target: { provider: string, model: string } }>}
 */
export async function runReview(ctx, config, agent, filePath, content, region, specText, existing, pending, signal) {
  const target = resolveReviewTarget(config, agent)
  if (target === undefined) {
    throw new Error('no provider/model available for review: set reviewProvider and reviewModel in the dsh-humanize entry config')
  }
  const contentSection = region === null
    ? `## 被审查文件：${filePath}\n${content}`
    : `## 被审查文件的本次改动：${filePath}（片段从第 ${region.startLine} 行开始，包含改动两侧各三行上下文）\n${region.text}`
  const sections = [
    `## 写作规范\n${specText}`,
    ...(existing !== undefined ? [`## 已有批注\n在其基础上更新，输出更新后的完整批注列表。\n${existing}`] : []),
    contentSection,
  ]
  // 留档完整请求，排查审查行为时可以直接查看。
  await writeRequest(filePath, [
    `# ${filePath}`,
    '',
    `> dsh-humanize 审查请求，发给 ${target.provider}/${target.model}，${new Date().toISOString()}。`,
    '',
    '## system',
    '',
    SYSTEM_PROMPT,
    '',
    '## user',
    '',
    sections.join('\n\n'),
    '',
  ].join('\n'))
  const assembler = new BlockAssembler()
  const controller = new AbortController()
  pending.add(controller)
  // 批次取消时立刻中止这次调用。signal 已经中止时直接落到已中止状态，
  // 后面的 stream 会立刻失败，不再发出请求。
  const onBatchAbort = () => controller.abort()
  if (signal !== undefined) {
    if (signal.aborted) controller.abort()
    else signal.addEventListener('abort', onBatchAbort, { once: true })
  }
  const stream = ctx.llm.stream({
    provider: target.provider,
    model: target.model,
    // 推理等级由适配器按模型定义。填入模型不支持的等级会在发起前报错。
    ...(typeof config.reviewReasoningEffort === 'string' && config.reviewReasoningEffort.length > 0
      ? { reasoningEffort: config.reviewReasoningEffort }
      : {}),
    messages: [createUserMessage({
      content: [{ type: 'text', text: sections.join('\n\n') }],
      source: { kind: 'plugin', plugin: 'dsh-humanize' },
    })],
    system: SYSTEM_PROMPT,
    signal: controller.signal,
    sessionId: agent.session.id,
  })

  // 看门狗。记录触发原因，被中止时抛出带原因的可读错误。
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
    pending.delete(controller)
    signal?.removeEventListener('abort', onBatchAbort)
  }
  if (watchdog !== null) throw new Error(watchdog)
  const finish = assembler.finish
  if (finish.kind === 'error' || finish.kind === 'aborted') throw new Error(finish.failure.message)
  if (finish.kind === 'max-tokens') throw new Error('review output hit the model\'s own output limit and was truncated')
  const text = assembler.blocks()
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('')
  return { annotations: parseAnnotations(text, parseSpecRules(specText)), target }
}

/**
 * 从审查输出中解析批注列表，容忍模型多输出的前后缀文字。模型输出
 * 的是规范快照里的编号，编号随规范编辑失效，这里用同一份快照把
 * 编号解析回条文，批注只存条文。
 */
function parseAnnotations(text, rules) {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start === -1 || end <= start) throw new Error('review output contains no JSON object')
  const parsed = JSON.parse(text.slice(start, end + 1))
  const list = parsed?.annotations
  if (!Array.isArray(list)) throw new Error('review output misses the annotations array')
  return list
    .filter((item) => item !== null && typeof item === 'object')
    .map((item) => {
      const rule = typeof item.rule === 'number' ? item.rule : null
      return {
        ruleText: rule === null ? null : rules.get(rule) ?? null,
        quote: typeof item.quote === 'string' ? item.quote : '',
        problem: typeof item.problem === 'string' ? item.problem : '',
        suggestion: typeof item.suggestion === 'string' ? item.suggestion : '',
      }
    })
}

/**
 * 把批注渲染成暂存 markdown。按规则条文分组，每条规则只复述一遍，
 * 下面列出违规内容。文件内容就是合并时的批注依据，用户可以直接编辑。
 * @param {string} filePath
 * @param {Array<{ ruleText: string | null, quote: string, problem: string, suggestion: string }>} annotations
 * @returns {string}
 */
export function renderStaging(filePath, annotations) {
  const lines = [
    `# ${filePath}`,
    '',
    `> 行文批注，生成于 ${new Date().toISOString().slice(0, 19)}Z。可直接编辑本文件，合并时以本文件内容为准。`,
    '',
  ]
  const groups = new Map()
  for (const annotation of annotations) {
    const key = annotation.ruleText ?? ''
    const group = groups.get(key) ?? []
    group.push(annotation)
    groups.set(key, group)
  }
  for (const [ruleText, list] of groups) {
    lines.push(ruleText === '' ? '## 未对应具体条目' : `## ${ruleText}`, '')
    list.forEach((annotation, index) => {
      lines.push(`${index + 1}. 「${annotation.quote}」`)
      if (annotation.problem.length > 0) lines.push(`   - 问题：${annotation.problem}`)
      if (annotation.suggestion.length > 0) lines.push(`   - 建议：${annotation.suggestion}`)
    })
    lines.push('')
  }
  return lines.join('\n')
}
