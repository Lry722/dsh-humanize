/**
 * 读取会话当前使用的模型配置。审查调用和合并子代理都跟随会话最近一次
 * 请求使用的模型。
 *
 * @module dsh-humanize/model
 */

/**
 * 取出会话最近一次请求头里的提供方、模型和推理等级。
 * @param {import('@deepseek-ai/dsh-agent').Agent} agent
 * @returns {{ provider: string | undefined, model: string | undefined, reasoningEffort: string | undefined } | undefined}
 */
export function sessionModelConfig(agent) {
  const config = agent.session.requestHeader()?.config
  if (config === undefined) return undefined
  return { provider: config.provider, model: config.model, reasoningEffort: config.reasoningEffort }
}

/**
 * 取非空字符串，其余情况返回 undefined。
 * @param {unknown} value
 * @returns {string | undefined}
 */
function nonEmpty(value) {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/**
 * 决定合并子代理使用的模型选项。提供方和模型依次取插件配置、会话最近
 * 一次请求使用的模型。推理等级单独覆盖，留空时跟随会话当前的推理等级。
 * @param {{ mergeProvider?: string, mergeModel?: string, mergeReasoningEffort?: string }} [config]
 * @param {import('@deepseek-ai/dsh-agent').Agent} agent
 * @returns {{ provider: string | undefined, model: string | undefined, reasoningEffort?: string } | undefined}
 */
export function mergeAgentOptions(config, agent) {
  const latest = sessionModelConfig(agent)
  const provider = nonEmpty(config?.mergeProvider) ?? latest?.provider
  const model = nonEmpty(config?.mergeModel) ?? latest?.model
  if (provider === undefined || model === undefined) return latest
  const reasoningEffort = nonEmpty(config?.mergeReasoningEffort) ?? latest?.reasoningEffort
  return { provider, model, ...(reasoningEffort !== undefined ? { reasoningEffort } : {}) }
}
