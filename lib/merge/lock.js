/**
 * 合并锁与合并子代理的身份判定。
 *
 * 合并锁按插件实例生效，跨 agent 和会话共用一把，避免两个会话同时修改
 * 同一批暂存和文件。锁里的文件路径用于挡住这些文件上的并发审查。
 *
 * 锁只存在内存里。插件重载后锁已经没了，派发前靠还活着的合并子代理让路。
 *
 * @module dsh-humanize/merge/lock
 */

/** 本包 cordis.patch.yml 的 preset-humanize-merge 行声明了这个 preset id。 */
export const MERGE_PRESET = 'humanize-merge'

/** 合并锁被占用时提示用户的消息。 */
export const MERGE_BUSY = '已有批注合并正在进行，等它结束后再派发。'

/**
 * 这个 agent 或全局合并锁是否已经有合并占用。
 * @param {ReturnType<import('../review/pipeline.js').createReviewPipeline>['state']} state
 * @param {string} agentId
 * @returns {boolean}
 */
export function isMergeBusy(state, agentId) {
  if (state.running.has(agentId) || state.merging.has(agentId)) return true
  return state.mergeRun !== null && state.mergeRun !== undefined
}

/**
 * 取得全局合并锁。生效范围见模块说明。
 * @param {ReturnType<import('../review/pipeline.js').createReviewPipeline>['state']} state
 * @param {import('@deepseek-ai/dsh-agent').Agent} agent
 * @param {string | null} target
 * @param {Array<{ filePath: string }>} [staged]
 * @returns {boolean}
 */
export function acquireMergeRun(state, agent, target, staged = []) {
  if (state.mergeRun !== null && state.mergeRun !== undefined) return false
  state.mergeRun = {
    agentId: agent.id,
    target,
    files: new Set(staged.map((item) => item.filePath)),
  }
  return true
}

/** 只清掉自己持有的合并锁。 */
export function releaseMergeRun(state, agentId) {
  if (state.mergeRun?.agentId === agentId) state.mergeRun = null
}

/** 把本轮涉及的文件加进合并锁，这些文件上的并发审查让路。 */
export function addMergeFiles(state, agentId, staged) {
  if (state.mergeRun?.agentId !== agentId) return
  for (const item of staged) state.mergeRun.files.add(item.filePath)
}

/** 合并子代理结束后释放这些文件。复审要在这之后才能安排。 */
export function clearMergeFiles(state, agentId) {
  if (state.mergeRun?.agentId === agentId) state.mergeRun.files.clear()
}

/**
 * 一个 agent 是不是合并子代理。会话头里的 preset 是持久字段，插件
 * 重载之后仍然读得到。
 * @param {import('@deepseek-ai/dsh-agent').Agent} agent
 * @returns {boolean}
 */
export function isMergeAgent(agent) {
  return agent.session.header.agentPreset === MERGE_PRESET
}

/**
 * 这个会话有没有还活着的合并子代理。插件重载后内存里的合并锁已经
 * 丢了，派发前靠这个检查让路。
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {import('@deepseek-ai/dsh-agent').Agent} agent
 * @returns {boolean}
 */
export function hasLiveMergeChild(ctx, agent) {
  return ctx.agents.list().some((candidate) => candidate.session.header.parentSession === agent.session.id
    && isMergeAgent(candidate))
}
