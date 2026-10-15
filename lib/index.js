/**
 * dsh-humanize 插件入口。
 *
 * 整体流程分四步：标记写入（包装 write/edit，增加 human_facing 参数）、
 * 准备规范（按被写文件目录分层加载 PROSE.md）、旁路审查（独立模型
 * 调用逐条批注）、延迟合并（/humanize 命令或上下文压缩时触发）。
 *
 * @module dsh-humanize
 */
import z from '@deepseek-ai/schemastery'
import { wrapAgentTools } from './wrap.js'
import { loadSpecChain, renderSpecChain } from './specs.js'
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
 * 插件配置，在 cordis.yml 的 dsh-humanize 条目上填写。
 * reviewProvider/reviewModel 决定审查用哪个模型，可以选比主模型便宜
 * 的模型；缺省时跟随会话当前使用的模型。
 */
export const Config = z.object({
  reviewProvider: z.string(),
  reviewModel: z.string(),
  reviewMaxTokens: z.number(),
  mergeOnCompaction: z.boolean(),
})

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {z.infer<typeof Config>} [rawConfig]
 */
export function apply(ctx, rawConfig) {
  const log = ctx.logger('dsh-humanize')
  const config = {
    reviewProvider: rawConfig?.reviewProvider,
    reviewModel: rawConfig?.reviewModel,
    reviewMaxTokens: rawConfig?.reviewMaxTokens,
    mergeOnCompaction: rawConfig?.mergeOnCompaction ?? true,
  }
  const tools = ctx.tools
  const agents = ctx.agents

  const state = {
    /** 正在合并的 agent id；合并期间的写入不再触发审查。 */
    merging: new Set(),
    /** 正在执行 /humanize-review 批次的 agent id。 */
    reviewing: new Set(),
    /** 每个文件的审查串行队列，filePath -> Promise。 */
    reviewQueues: new Map(),
  }
  /** agent id -> 包装工具的拆卸函数列表。 */
  const agentDisposers = new Map()

  const scheduleReview = (agent, filePath, content) => {
    if (state.merging.has(agent.id)) return Promise.resolve({ kind: 'skipped' })
    const previous = state.reviewQueues.get(filePath) ?? Promise.resolve()
    const next = previous.then(() => reviewNow(agent, filePath, content)).catch((error) => {
      log.warn('humanize: review failed for %s: %s', filePath, error)
      return { kind: 'failed' }
    })
    state.reviewQueues.set(filePath, next)
    void next.finally(() => {
      if (state.reviewQueues.get(filePath) === next) state.reviewQueues.delete(filePath)
    })
    return next
  }

  const reviewNow = async (agent, filePath, content) => {
    const chain = await loadSpecChain(filePath)
    if (chain.length === 0) return { kind: 'no-spec' }
    const existing = await readStaging(filePath)
    const { annotations, target } = await runReview(ctx, config, agent, filePath, content, renderSpecChain(chain), existing)
    if (annotations.length === 0) {
      await removeStaging(filePath)
      log.info('humanize: %s passed review, staging cleared', filePath)
    } else {
      await writeStaging(filePath, renderStaging(filePath, annotations, target))
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
          // 单边拆卸，忽略重复或失效的拆卸
        }
      }
    }
    agentDisposers.clear()
  })
}
