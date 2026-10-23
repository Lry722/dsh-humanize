/**
 * 读取模型目标配置。审查调用和合并子代理共用这套取值顺序。
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
 * 决定一次模型调用使用的提供方和模型。取值顺序是插件配置、
 * 会话最近一次请求使用的模型、agent 自身的模型设置。
 * @param {Record<string, unknown> | undefined} config - 插件配置，按 prefix 读取成对字段。
 * @param {import('@deepseek-ai/dsh-agent').Agent} agent
 * @param {string} prefix - 配置项前缀，读取 `${prefix}Provider` 和 `${prefix}Model`。
 * @param {{ fallbackToAgentOptions?: boolean }} [options]
 * @returns {{ provider: string, model: string } | undefined}
 */
export function resolveModelTarget(config, agent, prefix, options = {}) {
  // 提供方和模型必须成对取用：配置里只填一个时，不和会话或 agent 的值拼在
  // 一起，否则可能把请求发给一个不认识该模型的提供方。
  const provider = nonEmpty(config?.[`${prefix}Provider`])
  const model = nonEmpty(config?.[`${prefix}Model`])
  if (provider !== undefined && model !== undefined) return { provider, model }
  const latest = sessionModelConfig(agent)
  if (latest?.provider !== undefined && latest?.model !== undefined) {
    return { provider: latest.provider, model: latest.model }
  }
  // agent 自身的设置只在调用方显式要求时兜底。
  if (options.fallbackToAgentOptions === true
    && agent.options?.provider !== undefined
    && agent.options?.model !== undefined) {
    return { provider: agent.options.provider, model: agent.options.model }
  }
  return undefined
}

/**
 * 决定合并子代理使用的模型选项。
 * @param {{ mergeProvider?: string, mergeModel?: string, mergeReasoningEffort?: string }} [config]
 * @param {import('@deepseek-ai/dsh-agent').Agent} agent
 * @returns {{ provider: string, model: string, reasoningEffort?: string } | undefined}
 */
export function mergeAgentOptions(config, agent) {
  // 提供方和模型交给 resolveModelTarget 成对取用，配置留空时依次跟随会话模型
  // 和 agent 自身的模型设置。
  const target = resolveModelTarget(config, agent, 'merge', { fallbackToAgentOptions: true })
  if (target === undefined) return undefined
  const latest = sessionModelConfig(agent)
  // 推理等级单独覆盖，留空时跟随会话当前的推理等级，即使模型来自插件配置。
  const reasoningEffort = nonEmpty(config?.mergeReasoningEffort) ?? latest?.reasoningEffort
  return {
    provider: target.provider,
    model: target.model,
    ...(reasoningEffort !== undefined ? { reasoningEffort } : {}),
  }
}
