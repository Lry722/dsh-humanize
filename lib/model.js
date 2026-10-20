/**
 * 会话当前模型配置的读取。旁路审查和合并子代理都跟随会话最近一次
 * 请求使用的模型。
 *
 * @module dsh-humanize/model
 */

/**
 * 会话最近一次请求使用的模型配置。会话还没有请求记录时返回 undefined。
 * @param {import('@deepseek-ai/dsh-agent').Agent} agent
 * @returns {{ provider: string | undefined, model: string | undefined, reasoningEffort: string | undefined } | undefined}
 */
export function sessionModelConfig(agent) {
  const config = agent.session.requestHeader()?.config
  if (config === undefined) return undefined
  return { provider: config.provider, model: config.model, reasoningEffort: config.reasoningEffort }
}
