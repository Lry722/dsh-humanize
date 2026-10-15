/**
 * 旁路审查。把合并后的规范和文件内容发给一次独立的模型调用，
 * 让模型对照规范逐条批注，输出结构化的审查结果。审查用哪个模型由
 * 插件配置决定，可以选比主模型便宜的模型。审查在后台进行，失败只
 * 记录日志，不影响主任务。
 *
 * @module dsh-humanize/review
 */
import { BlockAssembler, createUserMessage } from '@deepseek-ai/dsh-llm'

const SYSTEM_PROMPT = `你是行文规范审查员。用户会给你一份写作规范（来自各级 PROSE.md，范围越小的规则优先级越高）和一个文件的内容。逐条对照规范，检查文件内容中面向人类阅读的文字，找出不符合规范的表达。

输出且仅输出一个 JSON 对象，不要输出其他文字，不要使用代码围栏：
{"annotations": [{"rule": 2, "quote": "原文片段", "problem": "问题说明", "suggestion": "修改建议"}]}

要求：
- rule 是被违反的规范条目编号，以规范文本中的编号为准；无法对应具体条目时填 null。
- quote 必须是文件中的原文，尽量短。
- 没有问题时输出 {"annotations": []}。
- 如果用户提供了已有批注，在其基础上更新：保留仍然成立的，删除已解决的，合并重复的，补充新发现的，输出更新后的完整批注列表。`

const DEFAULT_MAX_TOKENS = 4096

/**
 * 决定审查调用用哪个模型：插件配置优先，其次是会话最近一次请求
 * 使用的模型，最后是 agent 自身的模型设置。
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
 * @param {string} specText - 合并后的规范文本。
 * @param {string | undefined} existing - 已有的暂存批注，再次审查时基于它修改。
 * @returns {Promise<{ annotations: Array<{ rule: number | null, quote: string, problem: string, suggestion: string }>, target: { provider: string, model: string } }>}
 */
export async function runReview(ctx, config, agent, filePath, content, specText, existing) {
  const target = resolveReviewTarget(config, agent)
  if (target === undefined) {
    throw new Error('no provider/model available for review: set reviewProvider and reviewModel in the dsh-humanize entry config')
  }
  const sections = [
    `## 写作规范\n${specText}`,
    ...(existing !== undefined ? [`## 已有批注（在其基础上更新，输出更新后的完整批注列表）\n${existing}`] : []),
    `## 被审查文件：${filePath}\n${content}`,
  ]
  const assembler = new BlockAssembler()
  const stream = ctx.llm.stream({
    provider: target.provider,
    model: target.model,
    messages: [createUserMessage({
      content: [{ type: 'text', text: sections.join('\n\n') }],
      source: { kind: 'plugin', plugin: 'dsh-humanize' },
    })],
    system: SYSTEM_PROMPT,
    maxTokens: config.reviewMaxTokens ?? DEFAULT_MAX_TOKENS,
    sessionId: agent.session.id,
  })
  for await (const chunk of stream) assembler.push(chunk)
  const finish = assembler.finish
  if (finish.kind === 'error' || finish.kind === 'aborted') throw new Error(finish.failure.message)
  const text = assembler.blocks()
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('')
  return { annotations: parseAnnotations(text), target }
}

/** 从审查输出中解析批注列表，容忍模型多输出的前后缀文字。 */
function parseAnnotations(text) {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start === -1 || end <= start) throw new Error('review output contains no JSON object')
  const parsed = JSON.parse(text.slice(start, end + 1))
  const list = parsed?.annotations
  if (!Array.isArray(list)) throw new Error('review output misses the annotations array')
  return list
    .filter((item) => item !== null && typeof item === 'object')
    .map((item) => ({
      rule: typeof item.rule === 'number' ? item.rule : null,
      quote: typeof item.quote === 'string' ? item.quote : '',
      problem: typeof item.problem === 'string' ? item.problem : '',
      suggestion: typeof item.suggestion === 'string' ? item.suggestion : '',
    }))
}

/**
 * 把批注渲染成暂存 markdown。文件内容就是合并时的批注依据，
 * 用户可以直接编辑。
 * @param {string} filePath
 * @param {Array<{ rule: number | null, quote: string, problem: string, suggestion: string }>} annotations
 * @param {{ provider: string, model: string }} target
 * @returns {string}
 */
export function renderStaging(filePath, annotations, target) {
  const lines = [
    `# ${filePath}`,
    '',
    `> dsh-humanize 旁路批注，由 ${target.provider}/${target.model} 于 ${new Date().toISOString()} 生成。可直接编辑本文件，合并时以本文件内容为准。`,
    '',
  ]
  annotations.forEach((annotation, index) => {
    const rule = annotation.rule === null ? '' : `[规范 ${annotation.rule}] `
    lines.push(`${index + 1}. ${rule}「${annotation.quote}」`)
    if (annotation.problem.length > 0) lines.push(`   - 问题：${annotation.problem}`)
    if (annotation.suggestion.length > 0) lines.push(`   - 建议：${annotation.suggestion}`)
  })
  return lines.join('\n') + '\n'
}
