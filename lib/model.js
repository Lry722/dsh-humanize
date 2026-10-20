/**
 * 会话当前模型配置的读取。旁路审查和合并子代理都跟随会话最近一次
 * 请求使用的模型。
 *
 * @module dsh-humanize/model
 */

/**
 * 取出会话最近一次请求头里的 provider、model 和 reasoningEffort，供旁路
 * 审查和合并子代理复用。
 * @param {import('@deepseek-ai/dsh-agent').Agent} agent
 * @returns {{ provider: string | undefined, model: string | undefined, reasoningEffort: string | undefined } | undefined}
 */
export function sessionModelConfig(agent) {
  const config = agent.session.requestHeader()?.config
  if (config === undefined) return undefined
  return { provider: config.provider, model: config.model, reasoningEffort: config.reasoningEffort }
}
