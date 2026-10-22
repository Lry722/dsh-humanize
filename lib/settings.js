/**
 * 设置字段表。Config、readSettings 和设置页的默认值和边界都从这里取。
 *
 * 新增一个设置项时只改这张表。Config 和运行时读取会自动跟上。
 *
 * @module dsh-humanize/settings
 */
import z from '@deepseek-ai/schemastery'
import { isVolatile } from '@deepseek-ai/cosmokit'
import {
  LOOP_ROUNDS_DEFAULT,
  LOOP_ROUNDS_MAX,
  REVIEW_CONCURRENCY_DEFAULT,
  REVIEW_RETRIES_DEFAULT,
  REVIEW_RETRIES_MAX,
} from './defaults.js'

/** 整棵设置子树挂在这个键下面。 */
export const SETTINGS_KEY = 'settings'

/**
 * @typedef {object} SettingsField
 * @property {'string' | 'number' | 'boolean'} type
 * @property {string | number | boolean} default
 * @property {number} [min]
 * @property {number} [max]
 * @property {string} description
 */

/** @type {Record<string, SettingsField>} */
export const SETTINGS_FIELDS = {
  reviewProvider: {
    type: 'string',
    default: '',
    description: '审查所用模型的提供方，留空时跟随会话当前使用的模型',
  },
  reviewModel: {
    type: 'string',
    default: '',
    description: '审查所用模型，留空时跟随会话当前使用的模型',
  },
  reviewReasoningEffort: {
    type: 'string',
    default: '',
    description: '审查模型的推理等级，留空时使用模型自身的默认值',
  },
  mergeProvider: {
    type: 'string',
    default: '',
    description: '合并子代理所用模型的提供方，留空时跟随会话当前使用的模型',
  },
  mergeModel: {
    type: 'string',
    default: '',
    description: '合并子代理所用模型，留空时跟随会话当前使用的模型',
  },
  mergeReasoningEffort: {
    type: 'string',
    default: '',
    description: '合并子代理的推理等级，留空时跟随会话当前使用的推理等级',
  },
  reviewConcurrency: {
    type: 'number',
    default: REVIEW_CONCURRENCY_DEFAULT,
    min: 1,
    description: '审查并发数，指同时进行的审查调用上限。所有审查调用共用。上限由模型提供方的速率限制决定',
  },
  reviewRetries: {
    type: 'number',
    default: REVIEW_RETRIES_DEFAULT,
    min: 0,
    max: REVIEW_RETRIES_MAX,
    description: '重试次数，可取值 0 到 3。重试用尽后记为失败',
  },
  loopMaxRounds: {
    type: 'number',
    default: LOOP_ROUNDS_DEFAULT,
    min: 1,
    max: LOOP_ROUNDS_MAX,
    description: '循环合并的轮次上限，可取值 1 到 10',
  },
  mergeOnCompaction: {
    type: 'boolean',
    default: true,
    description: '上下文压缩结束时自动合并暂存批注',
  },
  storageDir: {
    type: 'string',
    default: '',
    description: '暂存批注的保存位置。留空时使用默认位置 ~/.dsh/humanize。相对路径按进程工作目录解析',
  },
}

/** 按字段表构造一个 schemastery 字段。 */
function fieldSchema(field) {
  let schema
  if (field.type === 'number') schema = z.number()
  else if (field.type === 'boolean') schema = z.boolean()
  else schema = z.string()
  if (field.min !== undefined) schema = schema.min(field.min)
  if (field.max !== undefined) schema = schema.max(field.max)
  return schema.default(field.default).description(field.description)
}

export const Config = z.object({
  [SETTINGS_KEY]: z.object(Object.fromEntries(
    Object.entries(SETTINGS_FIELDS).map(([key, field]) => [key, fieldSchema(field)]),
  )).volatile(),
})

/**
 * 读当前设置。每次使用时重新读取，设置页改动后立即生效。
 * @param {z.infer<typeof Config>} [rawConfig]
 */
export function readSettings(rawConfig) {
  const node = rawConfig?.[SETTINGS_KEY]
  // 运行时这个节点是带 get() 的引用，读取时要解引用。
  const value = node === undefined ? undefined : (isVolatile(node) ? node.get() : node)
  const settings = {}
  for (const [key, field] of Object.entries(SETTINGS_FIELDS)) {
    const raw = value?.[key]
    settings[key] = typeof raw === field.type ? raw : field.default
  }
  return settings
}
