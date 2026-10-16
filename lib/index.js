/**
 * dsh-humanize 插件入口。
 *
 * 整体流程分四步，依次是标记写入、准备规范、旁路审查、延迟合并。
 *
 * @module dsh-humanize
 */
import z from '@deepseek-ai/schemastery'
import { wrapAgentTools } from './wrap.js'
import { loadSpecChain, renderSpecChain } from './specs.js'
import { changedRegion } from './diff.js'
import { readStaging, removeStaging, writeStaging } from './staging.js'
import { renderStaging, runReview } from './review.js'
import { registerMerge } from './merge.js'
import { registerReviewCommand } from './review-run.js'

export const name = 'dsh-humanize'

/**
 * 硬性依赖的服务。声明 inject 后，Cordis 会等服务全部就绪再执行
 * apply，避免启动时条目挂载顺序造成的空窗。
 */
export const inject = ['tools', 'agents', 'commands', 'llm']

/**
 * 设置节点名。整棵可编辑子树挂在这一个 volatile 节点下。
 *
 * 0.2.0 的 dsh-settings 没有命令式的 register(ns, schema)：插件靠导出
 * Config 声明设置，设置页只暴露标了 volatile 的节点，命名空间就是本条目
 * 在补丁里声明的 id（dsh-humanize）。运行时这个节点交给插件的是一个带
 * get() 的引用，不是普通值，读取时要解引用。
 */
const SETTINGS_KEY = 'settings'

/**
 * 可编辑设置。缺省时跟随会话当前使用的模型，也可以换成更便宜的模型。
 * reviewReasoningEffort 指定审查模型的推理等级，缺省时跟随模型自身的默认。
 */
export const Config = z.object({
  settings: z.object({
    reviewProvider: z.string().default('').description('审查模型的提供方，留空跟随会话当前使用的模型'),
    reviewModel: z.string().default('').description('审查模型，留空跟随会话当前使用的模型'),
    reviewReasoningEffort: z.string().default('').description('审查模型的推理等级，留空使用模型自身的默认'),
    mergeOnCompaction: z.boolean().default(true).description('上下文压缩结束时自动合并暂存批注'),
  }).volatile(),
})

/** settings 交给插件的是 volatile 引用，而不是普通对象。 */
function isVolatileRef(value) {
  return typeof value === 'object' && value !== null && typeof value.get === 'function'
}

/**
 * 读当前设置。每次使用时实时读取，设置页的改动不需要额外的监听和缓存。
 * 组合里直接写普通对象（手改 profile patch）时同样能读。
 * @param {z.infer<typeof Config>} [rawConfig]
 */
function readSettings(rawConfig) {
  const node = rawConfig?.[SETTINGS_KEY]
  const value = node === undefined ? undefined : (isVolatileRef(node) ? node.get() : node)
  return {
    reviewProvider: typeof value?.reviewProvider === 'string' ? value.reviewProvider : '',
    reviewModel: typeof value?.reviewModel === 'string' ? value.reviewModel : '',
    reviewReasoningEffort: typeof value?.reviewReasoningEffort === 'string' ? value.reviewReasoningEffort : '',
    mergeOnCompaction: value?.mergeOnCompaction ?? true,
  }
}

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {z.infer<typeof Config>} [rawConfig]
 */
export function apply(ctx, rawConfig) {
  const log = ctx.logger('dsh-humanize')
  // 访问器而不是快照：审查调用和合并都是使用时读，volatile 引用会跟着
  // 设置页的改动更新。
  const config = {
    get reviewProvider() { return readSettings(rawConfig).reviewProvider },
    get reviewModel() { return readSettings(rawConfig).reviewModel },
    get reviewReasoningEffort() { return readSettings(rawConfig).reviewReasoningEffort },
    get mergeOnCompaction() { return readSettings(rawConfig).mergeOnCompaction },
  }

  // 插件自带设置页面，声明不参与 schema 自动生成。
  ctx.inject(['settings'], (sctx) => {
    sctx.effect(() => sctx.settings.configure({ auto: false }, ctx.fiber), 'dsh-humanize: settings policy')
  })

  const tools = ctx.tools
  const agents = ctx.agents

  const state = {
    /** 正在合并的 agent id。合并期间的写入不再触发审查。 */
    merging: new Set(),
    /** 正在执行 /humanize-review 批次的 agent id。 */
    reviewing: new Set(),
    /** 每个文件的审查串行队列，键是 filePath，值是 Promise。 */
    reviewQueues: new Map(),
  }
  /** 键是 agent id，值是包装工具的拆卸函数列表。 */
  const agentDisposers = new Map()
  /** 在途审查调用的中止句柄，插件卸载时统一中止。 */
  const pendingReviews = new Set()
  ctx.on('dispose', () => {
    for (const controller of pendingReviews) controller.abort()
    pendingReviews.clear()
  })

  const scheduleReview = (agent, filePath, before, after) => {
    if (state.merging.has(agent.id)) return Promise.resolve({ kind: 'skipped' })
    const previous = state.reviewQueues.get(filePath) ?? Promise.resolve()
    const next = previous.then(() => reviewNow(agent, filePath, before, after)).catch((error) => {
      log.warn('humanize: review failed for %s: %s', filePath, error)
      return { kind: 'failed' }
    })
    state.reviewQueues.set(filePath, next)
    void next.finally(() => {
      if (state.reviewQueues.get(filePath) === next) state.reviewQueues.delete(filePath)
    })
    return next
  }

  const reviewNow = async (agent, filePath, before, after) => {
    const chain = await loadSpecChain(filePath)
    if (chain.length === 0) return { kind: 'no-spec' }
    // before 为 undefined 表示新建文件或全量审查，审查全文。否则只
    // 审查本次改动的区段。
    const region = before === undefined ? null : changedRegion(before, after)
    if (before !== undefined && region === null) return { kind: 'unchanged' }
    const existing = await readStaging(filePath)
    const { annotations } = await runReview(ctx, config, agent, filePath, after, region, renderSpecChain(chain), existing, pendingReviews)
    if (annotations.length === 0) {
      await removeStaging(filePath)
      log.info('humanize: %s passed review, staging cleared', filePath)
    } else {
      await writeStaging(filePath, renderStaging(filePath, annotations))
      log.info('humanize: %d annotation(s) staged for %s', annotations.length, filePath)
    }
    return { kind: 'ok', annotations: annotations.length }
  }

  const wrapAgent = (agent) => {
    if (agentDisposers.has(agent.id)) return
    const warn = (message, ...args) => log.warn(message, ...args)
    const disposers = wrapAgentTools(ctx, warn, agent, scheduleReview)
    if (disposers.length > 0) agentDisposers.set(agent.id, disposers)
  }

  // 新建会话、恢复会话和子代理最终都走同一个发布序列，都会发出
  // agent/created 通知。收到通知后注册包装工具。
  ctx.on('agent/created', ({ agent }) => {
    try {
      wrapAgent(agent)
    } catch (error) {
      log.warn('humanize: failed to wrap tools for agent %s: %s', agent.id, error)
    }
  })
  // agent 销毁时它作用域里的工具注册随之卸载，这里只清理记录。
  ctx.on('agent/disposed', ({ agent }) => {
    agentDisposers.delete(agent.id)
  })
  // 插件加载时已经在运行的 agent，遍历注册表补注册，从下一个请求开始生效。
  for (const agent of agents.list()) wrapAgent(agent)

  registerMerge(ctx, config, log, state)
  registerReviewCommand(ctx, log, state, scheduleReview)

  // 插件卸载时摘掉所有还活着的包装工具。
  ctx.on('dispose', () => {
    for (const disposers of agentDisposers.values()) {
      for (const dispose of disposers) {
        try {
          dispose()
        } catch {
          // 单个工具拆卸失败时忽略错误
        }
      }
    }
    agentDisposers.clear()
  })
}
