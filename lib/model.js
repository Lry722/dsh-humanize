/**
 * 读取会话最近一次请求使用的模型配置。
 *
 * @module dsh-humanize/model
 */

/**
 * 读取会话请求头里最近一次请求使用的模型配置。
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
 * 决定合并子代理使用的模型选项。提供方和模型必须成对配置，缺一个就整对
 * 跟随会话最近一次请求使用的模型。推理等级单独覆盖，留空时跟随会话当前
 * 的推理等级。
 * @param {{ mergeProvider?: string, mergeModel?: string, mergeReasoningEffort?: string }} [config]
 * @param {import('@deepseek-ai/dsh-agent').Agent} agent
 * @returns {{ provider: string, model: string, reasoningEffort?: string } | undefined}
 */
export function mergeAgentOptions(config, agent) {
  const latest = sessionModelConfig(agent)
  const provider = nonEmpty(config?.mergeProvider)
  const model = nonEmpty(config?.mergeModel)
  // provider 和 model 必须成对生效。只填一个时不能和会话模型拼在一起，
  // 否则可能把请求发给一个不认识该模型的提供方。
  const configured = provider !== undefined && model !== undefined
    ? { provider, model }
    : undefined
  const target = configured ?? latest
  if (target?.provider === undefined || target?.model === undefined) return undefined
  const reasoningEffort = nonEmpty(config?.mergeReasoningEffort) ?? latest?.reasoningEffort
  return { provider: target.provider, model: target.model, ...(reasoningEffort !== undefined ? { reasoningEffort } : {}) }
}
