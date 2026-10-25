/**
 * 本模块给 agent 的写入工具加一层包装，让每次写入都带上
 * human_facing 字段。
 *
 * human_facing 字段表示内容是否面向人类。
 *
 * 模型写入文件前必须带上它。true 表示内容给人读，false 表示内容只是
 * 代码或数据。
 *
 * 字段为 true 的写入会额外触发一次后台审查。
 *
 * @module dsh-humanize/wrap
 */
import { scopeOf } from '@deepseek-ai/dsh-scope'
import { loadPrompt } from './shared/prompts.js'

const WRAPPED_TOOL_NAMES = ['write', 'edit']

/**
 * human_facing 字段的描述，来自 prompts/human-facing-field.md。
 * 每次注册包装工具时重新读取。改完资源文件后，对新会话即时生效。
 */
function humanFacingField() {
  return {
    type: 'boolean',
    description: `Required. ${loadPrompt('human-facing-field')}`,
  }
}

/**
 * 在原工具的 JSON Schema 上追加一个必填的 human_facing 字段。
 * @param {Record<string, unknown>} parameters - 原工具的 JSON Schema。
 * @returns {Record<string, unknown>} 新的 JSON Schema，原工具的 JSON Schema 保持原样。
 */
function withHumanFacing(parameters) {
  const schema = structuredClone(parameters ?? {})
  if (schema.type === undefined) schema.type = 'object'
  if (typeof schema.properties !== 'object' || schema.properties === null) schema.properties = {}
  schema.properties.human_facing = humanFacingField()
  const required = Array.isArray(schema.required) ? [...schema.required] : []
  if (!required.includes('human_facing')) required.push('human_facing')
  schema.required = required
  return schema
}

/**
 * human_facing 为 true 的写入完成后调用。
 *
 * @callback OnHumanFacingWrite
 * @param {import('@deepseek-ai/dsh-agent').Agent} agent - 触发写入的 agent。
 * @param {string} filePath - 被写入文件的路径。
 * @param {string | undefined} before - 写入前的完整内容。新建文件时为 undefined。
 * @param {string} after - 写入后的完整内容。
 * @returns {Promise<unknown>}
 */

/**
 * 为一个 agent 注册包装过的 write 和 edit 工具，覆盖同名的全局工具。
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx - 插件宿主上下文，用来按作用域解析工具定义。
 * @param {(message: string, ...args: unknown[]) => void} warn - 负责写警告日志的回调，工具注册出错时会被调用。
 * @param {import('@deepseek-ai/dsh-agent').Agent} agent
 * @param {OnHumanFacingWrite} onHumanFacingWrite - 写入完成后的回调。
 * @returns {Array<() => void>} 已注册工具对应的卸载函数列表。
 */
export function wrapAgentTools(ctx, warn, agent, onHumanFacingWrite) {
  const disposers = []
  /** 已经提示过缺少 human_facing 字段的工具。 */
  const warnedMissing = new Set()
  // write 和 edit 由 agent preset 挂在作用域链的上层。
  const scope = scopeOf(agent.ctx)
  for (const toolName of WRAPPED_TOOL_NAMES) {
    // 同名工具在全局也有一份，带上 scope 才能沿作用域链取到 agent
    // preset 的定义。
    const original = ctx.tools.get(toolName, scope)
    if (original === undefined) continue
    const definition = {
      ...original,
      parameters: withHumanFacing(original.parameters),
      async execute(args, exec) {
        const humanFacing = args?.human_facing
        // 程序化调用可能缺少这个字段。按代码或数据处理，只提示一次。
        if (humanFacing !== true && humanFacing !== false && !warnedMissing.has(toolName)) {
          warnedMissing.add(toolName)
          warn('humanize: %s was called without human_facing for agent %s; treating it as code or data', toolName, agent.id)
        }
        const rest = { ...args }
        delete rest.human_facing
        const value = await original.execute(rest, exec)
        if (humanFacing === true && value !== null && typeof value === 'object'
          && typeof value.path === 'string' && typeof value.after === 'string') {
          const before = typeof value.before === 'string' ? value.before : undefined
          // 审查在后台进行。
          onHumanFacingWrite(exec.agent ?? agent, value.path, before, value.after)
        }
        return value
      },
    }
    try {
      disposers.push(agent.ctx.tools.register(definition))
    } catch (error) {
      warn('humanize: failed to shadow tool "%s" for agent %s: %s', toolName, agent.id, error)
    }
  }
  return disposers
}

/**
 * 把 human_facing 约定写进系统提示。参数描述只在工具定义里，模型规划
 * 写入时容易漏看。
 * @param {import('@deepseek-ai/cordis').Context} ctx
 */
export function registerHumanFacingPrompt(ctx) {
  ctx.inject(['systemPrompt'], (sctx) => {
    sctx.systemPrompt.section({
      name: 'tool:humanize-write',
      order: sctx.systemPrompt.getSectionOrder('TOOL_WRITE'),
      text: () => `The write and edit tools take a required human_facing field. ${loadPrompt('human-facing-field')}`,
    })
  })
}
