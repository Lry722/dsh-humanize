/**
 * 这张表定义设置字段。Config、readSettings 和设置页的默认值与边界都从这里取。
 *
 * 新增一个设置字段时只改这张表。Config 和 readSettings 会自动跟上。
 *
 * @module dsh-humanize/settings/schema
 */
import z from '@deepseek-ai/schemastery'
import { isVolatile } from '@deepseek-ai/cosmokit'
import {
  LOOP_ROUNDS_DEFAULT,
  LOOP_ROUNDS_MAX,
  REVIEW_CONCURRENCY_DEFAULT,
  REVIEW_INTERVAL_SECONDS_DEFAULT,
  REVIEW_INTERVAL_SECONDS_MAX,
  REVIEW_RETRIES_DEFAULT,
  REVIEW_RETRIES_MAX,
} from '../shared/defaults.js'

/** 整棵设置子树挂在这个键下面。 */
export const SETTINGS_KEY = 'settings'

/**
 * @typedef {object} SettingsField
 * @property {'string' | 'number' | 'boolean'} type
 * @property {string | number | boolean} default
 * @property {number} [min]
 * @property {number} [max]
 * @property {boolean} [integer]
 * @property {{ en: string, zh: string }} description
 */

/** @type {Record<string, SettingsField>} */
export const SETTINGS_FIELDS = {
  reviewProvider: {
    type: 'string',
    default: '',
    description: {
      en: 'Review model provider. Leave empty to follow the model currently used by the session.',
      zh: '审查所用模型的提供方，留空时跟随会话当前使用的模型',
    },
  },
  reviewModel: {
    type: 'string',
    default: '',
    description: {
      en: 'Review model. Leave empty to follow the model currently used by the session.',
      zh: '审查所用模型，留空时跟随会话当前使用的模型',
    },
  },
  reviewReasoningEffort: {
    type: 'string',
    default: '',
    description: {
      en: "Reasoning effort for the review model. Leave empty to use the model's own default.",
      zh: '审查模型的推理等级，留空时使用模型自身的默认值',
    },
  },
  mergeProvider: {
    type: 'string',
    default: '',
    description: {
      en: 'Model provider for merge subagents. Leave empty to follow the model currently used by the session.',
      zh: '合并子代理所用模型的提供方，留空时跟随会话当前使用的模型',
    },
  },
  mergeModel: {
    type: 'string',
    default: '',
    description: {
      en: 'Model for merge subagents. Leave empty to follow the model currently used by the session.',
      zh: '合并子代理所用模型，留空时跟随会话当前使用的模型',
    },
  },
  mergeReasoningEffort: {
    type: 'string',
    default: '',
    description: {
      en: 'Reasoning effort for merge subagents. Leave empty to follow the reasoning effort currently used by the session.',
      zh: '合并子代理的推理等级，留空时跟随会话当前使用的推理等级',
    },
  },
  reviewConcurrency: {
    type: 'number',
    integer: true,
    default: REVIEW_CONCURRENCY_DEFAULT,
    min: 1,
    description: {
      en: "Maximum number of concurrent review calls. All review calls share this limit. Choose a value appropriate for the model provider's rate limits.",
      zh: '审查并发数，指同时进行的审查调用上限。所有审查调用共用这个上限。具体数值由模型提供方的速率限制决定',
    },
  },
  reviewRetries: {
    type: 'number',
    integer: true,
    default: REVIEW_RETRIES_DEFAULT,
    min: 0,
    max: REVIEW_RETRIES_MAX,
    description: {
      en: 'Number of retries. A review is marked as failed after all retries are exhausted.',
      zh: '重试次数。重试用尽后记为失败',
    },
  },
  reviewIntervalSeconds: {
    type: 'number',
    default: REVIEW_INTERVAL_SECONDS_DEFAULT,
    min: 0,
    max: REVIEW_INTERVAL_SECONDS_MAX,
    description: {
      en: 'Minimum interval between reviews, counted from the end of the previous review. Writes arriving during the interval are combined into the next review.',
      zh: '两次审查之间的最小间隔，从上一次审查结束开始计时。间隔内到达的写入合并到下一次审查',
    },
  },
  loopMaxRounds: {
    type: 'number',
    integer: true,
    default: LOOP_ROUNDS_DEFAULT,
    min: 1,
    max: LOOP_ROUNDS_MAX,
    description: {
      en: 'Maximum number of rounds in a merge loop.',
      zh: '循环合并的轮次上限',
    },
  },
  mergeOnCompaction: {
    type: 'boolean',
    default: true,
    description: {
      en: 'Automatically merge staged annotations when context compaction finishes.',
      zh: '上下文压缩结束时自动合并暂存批注',
    },
  },
  storageDir: {
    type: 'string',
    default: '',
    description: {
      en: 'Where staged annotations are stored. Leave empty to use the default location ~/.dsh/humanize. Relative paths are resolved against the process working directory.',
      zh: '暂存批注的保存位置。留空时使用默认位置 ~/.dsh/humanize。相对路径按进程工作目录解析',
    },
  },
}

/** 按字段表构造一个 schemastery 字段。 */
function fieldSchema(field) {
  let schema
  if (field.type === 'number') schema = field.integer === true ? z.natural() : z.number()
  else if (field.type === 'boolean') schema = z.boolean()
  else schema = z.string()
  if (field.min !== undefined) schema = schema.min(field.min)
  if (field.max !== undefined) schema = schema.max(field.max)
  // 英文同时作为普通 JSON Schema 和未知语言的回退，完整字典供本地化消费者选择。
  return schema.default(field.default).description(field.description.en).i18n(field.description)
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
  const value = isVolatile(node) ? node.get() : node
  const settings = {}
  for (const [key, field] of Object.entries(SETTINGS_FIELDS)) {
    const raw = value?.[key]
    settings[key] = typeof raw === field.type ? raw : field.default
  }
  return settings
}
