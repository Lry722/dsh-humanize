/**
 * 标记写入。给每个 agent 注册包装过的 write 和 edit，遮蔽同名的全局
 * 工具。包装工具保留原工具的 schema 和执行逻辑，只增加必填的
 * human_facing 参数。模型每次写文件都要声明内容是否面向人类。
 * true 表示内容要给人看，进入旁路审查。false 表示纯代码或数据。
 *
 * @module dsh-humanize/wrap
 */
import { scopeOf } from '@deepseek-ai/dsh-scope'

/** 需要包装的工具名。 */
const WRAPPED_TOOL_NAMES = ['write', 'edit']

const HUMAN_FACING_FIELD = {
  type: 'boolean',
  description: 'Required. true when the written content is meant for humans to read (documents, prose, comments) and should be style-reviewed; false for pure code or data.',
}

/**
 * 在原工具的参数 schema 上增加必填的 human_facing。原 schema 允许
 * 额外字段。这里仍然显式声明 human_facing，让模型必须提供。
 * @param {Record<string, unknown>} parameters - 原工具的 JSON Schema。
 * @returns {Record<string, unknown>}
 */
function withHumanFacing(parameters) {
  const schema = JSON.parse(JSON.stringify(parameters ?? {}))
  if (schema.type === undefined) schema.type = 'object'
  if (typeof schema.properties !== 'object' || schema.properties === null) schema.properties = {}
  schema.properties.human_facing = HUMAN_FACING_FIELD
  const required = Array.isArray(schema.required) ? [...schema.required] : []
  if (!required.includes('human_facing')) required.push('human_facing')
  schema.required = required
  return schema
}

/**
 * 为一个 agent 注册包装过的写入和编辑工具。注册走 agent.ctx，落在
 * agent 专属的作用域层上。它遮蔽同名全局工具，agent 销毁时随之卸载。
 * 单个工具注册失败只影响该工具，agent 的创建照常进行。
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx - 插件宿主上下文，用来读全局工具表。
 * @param {(message: string, ...args: unknown[]) => void} warn - 日志。
 * @param {import('@deepseek-ai/dsh-agent').Agent} agent
 * @param {(agent: import('@deepseek-ai/dsh-agent').Agent, filePath: string, before: string | undefined, after: string) => void} onHumanFacingWrite
 * before 是写入前的完整内容，新建文件时为 undefined。
 * @returns {Array<() => void>} 已注册工具的拆卸函数。
 */
export function wrapAgentTools(ctx, warn, agent, onHumanFacingWrite) {
  const disposers = []
  // write 和 edit 由 agent preset 挂在 agent 的祖先层上。全局视图里
  // 取不到它们，需要按 agent 的作用域链解析原工具定义。
  const scope = scopeOf(agent.ctx)
  for (const toolName of WRAPPED_TOOL_NAMES) {
    const original = ctx.tools.get(toolName, scope)
    if (original === undefined) continue
    const definition = {
      name: original.name,
      description: original.description,
      parameters: withHumanFacing(original.parameters),
      output: original.output,
      ...(original.timeoutMs !== undefined ? { timeoutMs: original.timeoutMs } : {}),
      ...(original.presentCall !== undefined ? { presentCall: (args) => original.presentCall(args) } : {}),
      ...(original.presentResult !== undefined ? { presentResult: (args, result) => original.presentResult(args, result) } : {}),
      ...(original.finalizeContent !== undefined ? { finalizeContent: (exec, result) => original.finalizeContent(exec, result) } : {}),
      ...(original.isConcurrencySafe !== undefined ? { isConcurrencySafe: (args) => original.isConcurrencySafe(args) } : {}),
      async execute(args, exec) {
        const humanFacing = args?.human_facing
        if (humanFacing !== true && humanFacing !== false) {
          throw new Error('human_facing is required: declare true when the content is meant for humans to read (documents, prose, comments), false for pure code or data.')
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
      warn('humanize: failed to shadow tool "%s" for agent %s: %s', toolName, agent.id, error)
    }
  }
  return disposers
}
