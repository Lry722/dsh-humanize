/**
 * dsh-humanize 插件入口，负责把各部分拼起来。
 *
 * 只做三件事：读取设置、给 agent 挂上包装工具、接好审查管线和三个
 * 斜杠命令。
 *
 * @module dsh-humanize
 */
import z from '@deepseek-ai/schemastery'
import { isVolatile } from '@deepseek-ai/cosmokit'
import { wrapAgentTools } from './wrap.js'
import { createReviewPipeline } from './pipeline.js'
import { registerMerge, reconcilePendingMerges, isPendingMergeChild } from './merge.js'
import { registerJobCleanup } from './job-track.js'
import { registerReviewCommand } from './review-run.js'
import { setStorageRootResolver } from './staging.js'
import { LOOP_ROUNDS_DEFAULT, REVIEW_CONCURRENCY_DEFAULT, REVIEW_RETRIES_DEFAULT } from './defaults.js'

// 这个名字同时就是设置的命名空间。
export const name = 'dsh-humanize'

/**
 * 依赖的服务，全部就绪后插件才会启动。
 */
export const inject = ['tools', 'agents', 'commands', 'llm', 'subagents']

/** 整棵设置子树挂在这个键下面。 */
const SETTINGS_KEY = 'settings'

export const Config = z.object({
  settings: z.object({
    reviewProvider: z.string().default('').description('审查模型的提供方，留空跟随会话当前使用的模型'),
    reviewModel: z.string().default('').description('审查模型，留空跟随会话当前使用的模型'),
    reviewReasoningEffort: z.string().default('').description('审查模型的推理等级，留空则使用模型自身的默认值'),
    reviewConcurrency: z.number().default(REVIEW_CONCURRENCY_DEFAULT).description('并行批次大小，指同时在途的审查调用数。可取值 1 及以上，上限由模型提供方的速率限制决定'),
    reviewRetries: z.number().default(REVIEW_RETRIES_DEFAULT).description('重试次数，可取值 0 到 3。重试用尽后记为失败'),
    loopMaxRounds: z.number().default(LOOP_ROUNDS_DEFAULT).description('循环合并的轮次上限，可取值 1 到 10'),
    mergeOnCompaction: z.boolean().default(true).description('上下文压缩结束时自动合并暂存批注'),
    storageDir: z.string().default('').description('暂存批注和审查调用留档的保存位置。留空使用默认位置 ~/.dsh/humanize。改动后需要自己把旧目录里的内容搬到新位置'),
  // 整棵 settings 子树都标了 volatile，设置页只展示这一部分。
  }).volatile(),
})

/**
 * 读当前设置。每次使用时重新读取，设置页改动后立即生效。
 * @param {z.infer<typeof Config>} [rawConfig]
 */
function readSettings(rawConfig) {
  const node = rawConfig?.[SETTINGS_KEY]
  // 运行时这个节点是带 get() 的引用，读取时要解引用。
  const value = node === undefined ? undefined : (isVolatile(node) ? node.get() : node)
  return {
    reviewProvider: typeof value?.reviewProvider === 'string' ? value.reviewProvider : '',
    reviewModel: typeof value?.reviewModel === 'string' ? value.reviewModel : '',
    reviewReasoningEffort: typeof value?.reviewReasoningEffort === 'string' ? value.reviewReasoningEffort : '',
    reviewConcurrency: typeof value?.reviewConcurrency === 'number' ? value.reviewConcurrency : undefined,
    reviewRetries: typeof value?.reviewRetries === 'number' ? value.reviewRetries : undefined,
    loopMaxRounds: typeof value?.loopMaxRounds === 'number' ? value.loopMaxRounds : undefined,
    mergeOnCompaction: value?.mergeOnCompaction ?? true,
    storageDir: typeof value?.storageDir === 'string' ? value.storageDir : '',
  }
}

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {z.infer<typeof Config>} [rawConfig]
 */
export function apply(ctx, rawConfig) {
  const log = ctx.logger('dsh-humanize')
  // 审查调用和合并都通过这个访问器取设置。
  const config = {
    get reviewProvider() { return readSettings(rawConfig).reviewProvider },
    get reviewModel() { return readSettings(rawConfig).reviewModel },
    get reviewReasoningEffort() { return readSettings(rawConfig).reviewReasoningEffort },
    get reviewConcurrency() { return readSettings(rawConfig).reviewConcurrency },
    get reviewRetries() { return readSettings(rawConfig).reviewRetries },
    get loopMaxRounds() { return readSettings(rawConfig).loopMaxRounds },
    get mergeOnCompaction() { return readSettings(rawConfig).mergeOnCompaction },
    get storageDir() { return readSettings(rawConfig).storageDir },
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
  /** 正在做包装判断的 agent id，同一个 agent 只会包装一次。 */
  const wrapping = new Set()
  /**
   * 父会话有在途合并，或存在对应的在途合并记录时，按合并子代理处理。
   */
  const isMergeChild = async (agent) => {
    if (pipeline.state.merging.has(agent.session.header.parentSession)) return true
    // 热重载后合并锁还没恢复，这段时间靠在途合并记录来判断。
    return await isPendingMergeChild(agent.id)
  }
  const wrapAgent = async (agent) => {
    if (agentDisposers.has(agent.id) || wrapping.has(agent.id)) return
    wrapping.add(agent.id)
    try {
      // 合并子代理的写入本身就是按批注合并，跳过审查。插件只派发这一种子代理。
      if (agent.session.header.origin === 'subagent' && await isMergeChild(agent)) return
      const warn = (message, ...args) => log.warn(message, ...args)
      const disposers = wrapAgentTools(ctx, warn, agent, pipeline.scheduleReview)
      if (disposers.length > 0) agentDisposers.set(agent.id, disposers)
    } finally {
      wrapping.delete(agent.id)
    }
  }

  const merge = registerMerge(ctx, log, config, pipeline.state, pipeline.scheduleReview, pipeline.waitForReviews, pipeline.discardReviews)
  /**
   * 先完成在途合并的收尾，再接手合并运行。收尾会等子代理的回合结束，
   * 之后补做复审、安排下一轮。
   */
  const reconcileMerges = () => {
    void reconcilePendingMerges(ctx, log, pipeline.state, pipeline.scheduleReview)
      .then(() => merge.resumeRuns())
      .catch((error) => log.warn('humanize: failed to reconcile merges: %s', error))
  }

  // 新建会话、恢复会话和子代理都会发出 agent/created 通知。
  ctx.on('agent/created', ({ agent }) => {
    void wrapAgent(agent).catch((error) => {
      log.warn('humanize: failed to wrap tools for agent %s: %s', agent.id, error)
    })
    // 会话恢复晚于插件加载时，在这里补做在途合并的收尾和接手合并运行。
    reconcileMerges()
  })
  ctx.on('agent/disposed', ({ agent }) => {
    // agent 销毁时它作用域里的工具注册随之卸载，这里只清理记录。
    agentDisposers.delete(agent.id)
  })
  // 插件加载时已经有 agent 在运行，这里遍历注册表补注册。补注册从下一个
  // 请求开始生效。
  for (const agent of ctx.agents.list()) {
    void wrapAgent(agent).catch((error) => {
      log.warn('humanize: failed to wrap tools for agent %s: %s', agent.id, error)
    })
  }

  registerReviewCommand(ctx, log, config, pipeline.state, pipeline.scheduleReview, pipeline.waitForReviews)
  // 插件重载后，先补做在途合并的收尾，再接手合并运行。会话都已经在注册表
  // 里时，这一步立即生效。
  reconcileMerges()

  // 插件卸载时的收尾放在同一个清理函数里，保证顺序固定：先同步卸载包装
  // 工具，再关门停掉审查管线。
  ctx.effect(() => () => {
    for (const disposers of agentDisposers.values()) {
      for (const dispose of disposers) {
        try {
          dispose()
        } catch {
          // agent 作用域卸载时可能已经卸载过这个工具，重复卸载会抛错。
        }
      }
    }
    agentDisposers.clear()
    // 等在途审查排空后才让 fiber 结束销毁。在途审查本来就会自己跑完。
    return pipeline.shutdown()
  }, 'dsh-humanize lifecycle')
}
