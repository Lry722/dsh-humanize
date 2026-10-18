/**
 * dsh-humanize 插件入口，组合根。
 *
 * 只做三件事：读设置、给 agent 装包装工具、把审查管线和两个命令
 * （/humanize、/humanize-review）接起来。业务逻辑按职责拆到对应模块。
 *
 * 整体流程分四步，依次是标记写入、准备规范、审查、合并。
 *
 * @module dsh-humanize
 */
import z from '@deepseek-ai/schemastery'
import { wrapAgentTools } from './wrap.js'
import { createReviewPipeline } from './pipeline.js'
import { registerMerge, reconcilePendingMerges } from './merge.js'
import { registerReviewCommand } from './review-run.js'

export const name = 'dsh-humanize'

/**
 * 硬性依赖的服务。声明 inject 后，Cordis 会等服务全部就绪再执行
 * apply，避免启动时条目挂载顺序造成的空窗。
 */
export const inject = ['tools', 'agents', 'commands', 'llm', 'subagents']

/**
 * 设置节点名。整棵可编辑子树挂在这一个 volatile 节点下。
 *
 * 0.2.0 的 dsh-settings 只能靠导出 Config 声明设置。设置页只暴露标了
 * volatile 的节点，命名空间就是本条目在补丁里声明的 id dsh-humanize。
 * 运行时这个节点交给插件的是带 get() 的引用，读取时要解引用。
 */
const SETTINGS_KEY = 'settings'

/** 设置页可编辑的字段。 */
export const Config = z.object({
  settings: z.object({
    reviewProvider: z.string().default('').description('审查模型的提供方，留空跟随会话当前使用的模型'),
    reviewModel: z.string().default('').description('审查模型，留空跟随会话当前使用的模型'),
    reviewReasoningEffort: z.string().default('').description('审查模型的推理等级，留空使用模型自身的默认'),
    reviewConcurrency: z.number().default(3).description('并行批次大小：同时在途的审查调用数，最小 1，上限取决于模型提供方的速率限制'),
    reviewRetries: z.number().default(1).description('失败重试次数，范围为 0 到 3。失败的文件会插回下一批重试，超过次数则放弃'),
    mergeOnCompaction: z.boolean().default(true).description('上下文压缩结束时自动合并暂存批注'),
  }).volatile(),
})

/** settings 交给插件的是带 get() 的 volatile 引用。 */
function isVolatileRef(value) {
  return typeof value === 'object' && value !== null && typeof value.get === 'function'
}

/**
 * 读当前设置。每次使用时实时读取，设置页的改动不需要额外的监听和缓存。
 * 手改 profile patch 在组合里直接写普通对象，同样能读。
 * @param {z.infer<typeof Config>} [rawConfig]
 */
function readSettings(rawConfig) {
  const node = rawConfig?.[SETTINGS_KEY]
  const value = node === undefined ? undefined : (isVolatileRef(node) ? node.get() : node)
  return {
    reviewProvider: typeof value?.reviewProvider === 'string' ? value.reviewProvider : '',
    reviewModel: typeof value?.reviewModel === 'string' ? value.reviewModel : '',
    reviewReasoningEffort: typeof value?.reviewReasoningEffort === 'string' ? value.reviewReasoningEffort : '',
    reviewConcurrency: typeof value?.reviewConcurrency === 'number' ? value.reviewConcurrency : undefined,
    reviewRetries: typeof value?.reviewRetries === 'number' ? value.reviewRetries : undefined,
    mergeOnCompaction: value?.mergeOnCompaction ?? true,
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
    get mergeOnCompaction() { return readSettings(rawConfig).mergeOnCompaction },
  }

  // 插件自带设置页面，声明不参与 schema 自动生成。
  ctx.inject(['settings'], (sctx) => {
    sctx.effect(() => sctx.settings.configure({ auto: false }, ctx.fiber), 'dsh-humanize: settings policy')
  })

  const pipeline = createReviewPipeline(ctx, config, log)
  ctx.on('dispose', pipeline.dispose)

  /** 键是 agent id，值是包装工具的拆卸函数列表。 */
  const agentDisposers = new Map()
  const wrapAgent = (agent) => {
    if (agentDisposers.has(agent.id)) return
    // 合并子代理的写入就是按批注修订，不需要再进审查。识别依据是父会话
    // 有在途合并，插件只派生这一种子代理。
    if (agent.session.header.origin === 'subagent' && pipeline.state.merging.has(agent.session.header.parentSession)) return
    const warn = (message, ...args) => log.warn(message, ...args)
    const disposers = wrapAgentTools(ctx, warn, agent, pipeline.scheduleReview)
    if (disposers.length > 0) agentDisposers.set(agent.id, disposers)
  }

  // 新建会话、恢复会话和子代理都会发出 agent/created 通知，收到通知后
  // 注册包装工具。会话恢复晚于插件加载时，在这里补做在途合并的收尾。
  ctx.on('agent/created', ({ agent }) => {
    try {
      wrapAgent(agent)
    } catch (error) {
      log.warn('humanize: failed to wrap tools for agent %s: %s', agent.id, error)
    }
    void reconcilePendingMerges(ctx, log, pipeline.state)
  })
  // agent 销毁时它作用域里的工具注册随之卸载，这里只清理记录。
  ctx.on('agent/disposed', ({ agent }) => {
    agentDisposers.delete(agent.id)
  })
  // 插件加载时已经在运行的 agent，遍历注册表补注册，从下一个请求开始生效。
  for (const agent of ctx.agents.list()) wrapAgent(agent)

  registerMerge(ctx, config, log, pipeline.state)
  registerReviewCommand(ctx, log, config, pipeline.state, pipeline.scheduleReview)
  // 插件重载后补做在途合并的收尾，会话都已在注册表里时立即生效。
  void reconcilePendingMerges(ctx, log, pipeline.state)

  ctx.on('dispose', () => {
    for (const disposers of agentDisposers.values()) {
      for (const dispose of disposers) {
        try {
          dispose()
        } catch {
          // agent 作用域卸载时可能已经摘掉了这个工具，重复拆卸会抛错。
        }
      }
    }
    agentDisposers.clear()
  })
}
