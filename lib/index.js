/**
 * dsh-humanize 插件入口，负责把各部分拼起来。
 *
 * 只做三件事：读取设置、给 agent 挂上包装工具、接好审查管线和三个
 * 斜杠命令。
 *
 * @module dsh-humanize
 */
import { registerHumanFacingPrompt, wrapAgentTools } from './wrap.js'
import { createReviewPipeline } from './review/pipeline.js'
import { isMergeAgent, registerMerge } from './merge/command.js'
import { registerFieldsInfo, registerPathInfo } from './settings/routes.js'
import { registerJobCleanup } from './shared/job-track.js'
import { registerModelTest } from './settings/model-test.js'
import { registerReviewCommand } from './review/command.js'
import { setStorageRootResolver } from './shared/staging.js'
import { Config, SETTINGS_FIELDS, readSettings } from './settings/schema.js'

// 这个名字同时就是设置的命名空间。
export const name = 'dsh-humanize'

/**
 * 依赖的服务，全部就绪后插件才会启动。
 */
export const inject = ['tools', 'agents', 'commands', 'llm', 'subagents']

export { Config }

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {Parameters<typeof Config>[0]} [rawConfig]
 */
export function apply(ctx, rawConfig) {
  const log = ctx.logger('dsh-humanize')
  // 审查调用和合并都通过这个访问器取设置。
  // 设置访问器由字段表生成，增删字段只需改表。
  const config = {}
  for (const key of Object.keys(SETTINGS_FIELDS)) {
    Object.defineProperty(config, key, {
      get: () => readSettings(rawConfig)[key],
      enumerable: true,
    })
  }

  // 保存位置由回调按需读取。
  setStorageRootResolver(() => config.storageDir)

  ctx.inject(['settings'], (sctx) => {
    // 该配置项由插件自行声明并写入配置，设置页跳过它。
    sctx.effect(() => sctx.settings.configure({ auto: false }, ctx.fiber), 'dsh-humanize: settings policy')
  })

  const pipeline = createReviewPipeline(ctx, config, log)

  // 插件加载时注册一次，回合开始时摘除已结算的任务行。
  registerJobCleanup(ctx, log)

  /** 键是 agent id，值是包装工具的卸载函数列表。 */
  const agentDisposers = new Map()
  /** 包装过程中的重挂抑制计数。包装自己也会触发 tools/change。 */
  let rewriting = 0
  /**
   * 插件是否已进入卸载流程。
   *
   * 卸载时逐个调用工具的卸载函数，每次卸载都会同步发出 tools/change。
   * 此时重挂会先把 agent 从 agentDisposers 里删掉再塞回去。
   * 迭代器随后重新访问这个条目，卸载循环永远走不完，事件循环被同步占死。
   */
  let disposed = false
  /**
   * 给一个 agent 挂上包装工具。合并子代理的写入本身就是按批注合并，
   * 跳过审查。
   */
  const wrapAgent = (agent) => {
    if (disposed || agentDisposers.has(agent.id)) return
    rewriting += 1
    try {
      if (agent.session.header.origin === 'subagent' && isMergeAgent(agent)) return
      const warn = (message, ...args) => log.warn(message, ...args)
      const disposers = wrapAgentTools(ctx, warn, agent, pipeline.scheduleWriteReview)
      if (disposers.length > 0) agentDisposers.set(agent.id, disposers)
    } catch (error) {
      log.warn('humanize: failed to wrap tools for agent %s: %s', agent.id, error)
    } finally {
      rewriting -= 1
    }
  }
  /**
   * 工具定义被重新注册时，先卸掉旧包装再按新的定义重挂。取到的
   * original 可能已经过期，重挂之后才能拿到当前的定义。
   */
  const rewrapAgent = (agent) => {
    if (disposed) return
    const previous = agentDisposers.get(agent.id)
    if (previous === undefined) return
    rewriting += 1
    try {
      for (const dispose of previous) {
        try {
          dispose()
        } catch {
          // agent 作用域卸载时可能已经卸载过这个工具。
        }
      }
      agentDisposers.delete(agent.id)
      wrapAgent(agent)
    } finally {
      rewriting -= 1
    }
  }

  registerMerge(ctx, log, config, pipeline.state, pipeline.scheduleReview, pipeline.waitForReviews, pipeline.discardReviews)

  // 新建会话、恢复会话和子代理都会发出 agent/created 通知。
  ctx.on('agent/created', ({ agent }) => {
    wrapAgent(agent)
  })
  ctx.on('agent/disposed', ({ agent }) => {
    // agent 销毁时它作用域里的工具注册随之卸载，这里只清理记录。
    agentDisposers.delete(agent.id)
  })
  // 预设重挂或别的插件重注册工具之后，包装里的 original 会过期。
  ctx.on('tools/change', () => {
    // 卸载自己的包装工具时也会同步走到这里，此时不重挂。
    if (disposed || rewriting > 0) return
    for (const agent of ctx.agents.list()) {
      // 没有条目的 agent 可能是创建时工具还没挂上，这里补挂一次包装工具。
      if (agentDisposers.has(agent.id)) rewrapAgent(agent)
      else wrapAgent(agent)
    }
  })
  // 插件加载时已经在运行的 agent 也要挂上包装工具，补挂从下一个请求开始生效。
  for (const agent of ctx.agents.list()) wrapAgent(agent)

  registerReviewCommand(ctx, log, config, pipeline.state, pipeline.scheduleReview, pipeline.waitForReviews)
  registerModelTest(ctx)
  registerPathInfo(ctx)
  registerFieldsInfo(ctx)
  registerHumanFacingPrompt(ctx)

  // 插件卸载时的收尾放在同一个清理函数里，保证顺序固定。
  ctx.effect(() => () => {
    // 先把 disposed 置为 true，这一步要在第一次调用工具的卸载函数之前完成。
    // 卸载期间重挂的后果见 disposed 的说明。
    disposed = true
    // disposed 已阻止卸载期间重新注册，这里先取快照再清空记录。
    const pending = [...agentDisposers.values()]
    agentDisposers.clear()
    for (const disposers of pending) {
      for (const dispose of disposers) {
        try {
          dispose()
        } catch {
          // agent 作用域卸载时可能已经卸载过这个工具，重复卸载会抛错。
        }
      }
    }
    // 等在途审查排空后才让 fiber 结束销毁。在途审查本来就会自己跑完。
    return pipeline.shutdown()
  }, 'dsh-humanize lifecycle')
}
