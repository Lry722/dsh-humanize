/**
 * 本模块给 agent 的写入工具加一层包装，让每次写入都带上
 * human_facing 声明。
 *
 * human_facing 声明表示内容是否面向人类。
 *
 * 模型写入文件前必须带上它。true 表示内容给人读，false 表示内容只是
 * 代码或数据。
 *
 * 声明为 true 的写入会额外触发一次后台审查。
 *
 * @module dsh-humanize/wrap
 */
import { scopeOf } from '@deepseek-ai/dsh-scope'
import { loadPrompt } from './prompts.js'

const WRAPPED_TOOL_NAMES = ['write', 'edit']

/**
 * human_facing 参数的描述，来自 prompts/human-facing-field.md。每次注册
 * 包装工具时重新读取，编辑资源文件后对新会话即时生效。
 */
function humanFacingField() {
  return {
    type: 'boolean',
    description: loadPrompt('human-facing-field'),
  }
}

/**
 * 在原工具的参数 schema 上追加必填的 human_facing，原 schema 的其他
 * 字段与额外字段一并保留。
 * @param {Record<string, unknown>} parameters - 原工具的 JSON Schema。
 * @returns {Record<string, unknown>}
 */
function withHumanFacing(parameters) {
  const schema = JSON.parse(JSON.stringify(parameters ?? {}))
  if (schema.type === undefined) schema.type = 'object'
  if (typeof schema.properties !== 'object' || schema.properties === null) schema.properties = {}
  schema.properties.human_facing = humanFacingField()
  const required = Array.isArray(schema.required) ? [...schema.required] : []
  if (!required.includes('human_facing')) required.push('human_facing')
  schema.required = required
  return schema
}

/**
 * 为一个 agent 注册包装过的 write 和 edit 工具，遮蔽同名的全局工具。
 * 审查在后台进行，调用方在写入后直接返回。
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx - 插件宿主上下文，用来按作用域解析工具定义。
 * @param {(message: string, ...args: unknown[]) => void} warn - 写警告日志用的回调。
 * @param {import('@deepseek-ai/dsh-agent').Agent} agent
 * @param {(agent: import('@deepseek-ai/dsh-agent').Agent, filePath: string, before: string | undefined, after: string) => Promise<unknown>} onHumanFacingWrite - 声明为 true 的写入完成后调用。
 * before 是写入前的完整内容，新建文件时为 undefined。
 * @returns {Array<() => void>} 已注册工具的拆卸函数。
 */
export function wrapAgentTools(ctx, warn, agent, onHumanFacingWrite) {
  const disposers = []
  // write 和 edit 由 agent preset 挂在作用域链的上层，注册落在
  // agent 专属的作用域层上。
  const scope = scopeOf(agent.ctx)
  for (const toolName of WRAPPED_TOOL_NAMES) {
    // 同名工具在全局也有一份，带上 scope 才能沿作用域链取到 agent
    // preset 的定义。
    const original = ctx.tools.get(toolName, scope)
    if (original === undefined) continue
    const definition = {
      // 全量继承原工具定义，平台以后给工具定义加字段会自动带上。
      ...original,
      parameters: withHumanFacing(original.parameters),
      async execute(args, exec) {
        const humanFacing = args?.human_facing
        if (humanFacing !== true && humanFacing !== false) {
          throw new Error('human_facing is required. Use true for content meant for humans to read, and false for pure code or data.')
        }
        const rest = { ...args }
        delete rest.human_facing
        const value = await original.execute(rest, exec)
        if (humanFacing && value !== null && typeof value === 'object'
          && typeof value.path === 'string' && typeof value.after === 'string') {
          const before = typeof value.before === 'string' ? value.before : undefined
          onHumanFacingWrite(exec.agent ?? agent, value.path, before, value.after)
        }
        return value
      },
    }
    try {
      disposers.push(agent.ctx.tools.register(definition))
    } catch (error) {
      // 注册失败时记录警告，继续注册其余工具。
      warn('humanize: failed to shadow tool "%s" for agent %s: %s', toolName, agent.id, error)
    }
  }
  return disposers
}
