/**
 * dsh-humanize 插件入口，组合根。
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
import { registerReviewCommand } from './review-run.js'
import { setStorageRootResolver } from './staging.js'
import { LOOP_ROUNDS_DEFAULT, REVIEW_CONCURRENCY_DEFAULT, REVIEW_RETRIES_DEFAULT } from './defaults.js'

export const name = 'dsh-humanize'

/**
 * 硬性依赖的服务。声明 inject 后，Cordis 会等服务全部就绪再执行
 * apply，启动只看服务是否就绪。
 */
export const inject = ['tools', 'agents', 'commands', 'llm', 'subagents']

/**
 * 设置子树的键。整棵设置子树挂在这一个节点下，命名空间是本条目
 * 在补丁里声明的 id dsh-humanize。
 *
 * 设置靠导出 Config 声明，设置页只暴露标了 volatile 的节点。
 */
const SETTINGS_KEY = 'settings'

/** 设置页能改的字段。 */
export const Config = z.object({
  settings: z.object({
    reviewProvider: z.string().default('').description('审查模型的提供方，留空跟随会话当前使用的模型'),
    reviewModel: z.string().default('').description('审查模型，留空跟随会话当前使用的模型'),
    reviewReasoningEffort: z.string().default('').description('审查模型的推理等级，留空使用模型自身的默认'),
    reviewConcurrency: z.number().default(REVIEW_CONCURRENCY_DEFAULT).description('并行批次大小，指同时在途的审查调用数。取值从 1 起，上限由模型提供方的速率限制决定'),
    reviewRetries: z.number().default(REVIEW_RETRIES_DEFAULT).description('失败重试次数，范围为 0 到 3。失败后自动重试，超过次数记为失败'),
    loopMaxRounds: z.number().default(LOOP_ROUNDS_DEFAULT).description('循环合并的轮次上限，范围为 1 到 10'),
    mergeOnCompaction: z.boolean().default(true).description('上下文压缩结束时自动合并暂存批注'),
    storageDir: z.string().default('').description('暂存批注和审查调用留档的保存位置，留空使用默认位置 ~/.dsh/humanize。改动后需要自己把旧目录里的内容搬到新位置'),
  }).volatile(),
})

/**
 * 读当前设置。每次使用时实时读取，设置页改动后马上生效。
 * 手改 profile patch 在组合里直接写普通对象，读取时同样能拿到设置值。
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
  // 访问器每次使用时读取，审查调用和合并都能拿到设置页的最新改动。
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

  // 暂存和留档的保存位置跟随设置页的 storageDir，实时生效。
  setStorageRootResolver(() => config.storageDir)

  // 插件自带设置页面，这里声明后 schema 自动生成会跳过它。
  ctx.inject(['settings'], (sctx) => {
    sctx.effect(() => sctx.settings.configure({ auto: false }, ctx.fiber), 'dsh-humanize: settings policy')
  })

  const pipeline = createReviewPipeline(ctx, config, log)

  /** 键是 agent id，值是包装工具的拆卸函数列表。 */
  const agentDisposers = new Map()
  /** 正在判定并包装的 agent id，同一 agent 只会包装一次。 */
  const wrapping = new Set()
  /** 父会话有在途合并，或存在对应的在途合并记录，都算合并子代理。 */
  const isMergeChild = async (agent) => {
    // 合并锁覆盖父会话有在途合并的情况。
    if (pipeline.state.merging.has(agent.session.header.parentSession)) return true
    // 在途合并记录覆盖热重载后合并锁还没恢复的窗口。
    return await isPendingMergeChild(agent.id)
  }
  const wrapAgent = async (agent) => {
    if (agentDisposers.has(agent.id) || wrapping.has(agent.id)) return
    wrapping.add(agent.id)
    try {
      // 合并子代理的写入本身就是按批注修订，跳过审查。插件只派发这一种子代理。
      if (agent.session.header.origin === 'subagent' && await isMergeChild(agent)) return
      const warn = (message, ...args) => log.warn(message, ...args)
      const disposers = wrapAgentTools(ctx, warn, agent, pipeline.scheduleReview)
      if (disposers.length > 0) agentDisposers.set(agent.id, disposers)
    } finally {
      wrapping.delete(agent.id)
    }
  }

  // 新建会话、恢复会话和子代理都会发出 agent/created 通知。
  ctx.on('agent/created', ({ agent }) => {
    void wrapAgent(agent).catch((error) => {
      log.warn('humanize: failed to wrap tools for agent %s: %s', agent.id, error)
    })
    // 会话恢复晚于插件加载时，在这里补做在途合并的收尾。
    void reconcilePendingMerges(ctx, log, pipeline.state, pipeline.scheduleReview)
  })
  ctx.on('agent/disposed', ({ agent }) => {
    // agent 销毁时它作用域里的工具注册随之拆卸，这里只清理记录。
    agentDisposers.delete(agent.id)
  })
  // 插件加载时已经在运行的 agent，遍历注册表补注册，从下一个请求开始生效。
  for (const agent of ctx.agents.list()) {
    void wrapAgent(agent).catch((error) => {
      log.warn('humanize: failed to wrap tools for agent %s: %s', agent.id, error)
    })
  }

  registerMerge(ctx, log, config, pipeline.state, pipeline.scheduleReview, pipeline.waitForReviews, pipeline.discardReviews)
  registerReviewCommand(ctx, log, config, pipeline.state, pipeline.scheduleReview, pipeline.waitForReviews)
  // 插件重载后补做在途合并的收尾，会话都已在注册表里时立即生效。
  void reconcilePendingMerges(ctx, log, pipeline.state, pipeline.scheduleReview)

  // 插件卸载时把包装过的工具一并拆掉。
  ctx.effect(() => () => {
    for (const disposers of agentDisposers.values()) {
      for (const dispose of disposers) {
        try {
          dispose()
        } catch {
          // agent 作用域卸载时可能已经拆卸过这个工具，重复拆卸会抛错。
        }
      }
    }
    agentDisposers.clear()
  })
}
