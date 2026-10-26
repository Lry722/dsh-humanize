/**
 * 这张表定义设置字段的类型、默认值与边界。Config、readSettings 和设置页都从这里取。
 *
 * 新增字段时还要在 locale/en.json 和 locale/zh.json 的 settings 下补同名字段说明。
 * Config 和 readSettings 会自动跟上。
 *
 * @module dsh-humanize/settings/schema
 */
import { createRequire } from 'node:module'
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

const require = createRequire(import.meta.url)
// 包级 locale 文件同时承载插件元数据和 Config 字段文案。
const configMessages = {
  en: require('../../locale/en.json'),
  zh: require('../../locale/zh.json'),
}

/** 整棵设置子树挂在这个键下面。 */
export const SETTINGS_KEY = 'settings'

/**
 * @typedef {object} SettingsField
 * @property {'string' | 'number' | 'boolean'} type
 * @property {string | number | boolean} default
 * @property {number} [min]
 * @property {number} [max]
 * @property {boolean} [integer]
 */

/** @type {Record<string, SettingsField>} */
export const SETTINGS_FIELDS = {
  reviewProvider: {
    type: 'string',
    default: '',
  },
  reviewModel: {
    type: 'string',
    default: '',
  },
  reviewReasoningEffort: {
    type: 'string',
    default: '',
  },
  mergeProvider: {
    type: 'string',
    default: '',
  },
  mergeModel: {
    type: 'string',
    default: '',
  },
  mergeReasoningEffort: {
    type: 'string',
    default: '',
  },
  reviewConcurrency: {
    type: 'number',
    integer: true,
    default: REVIEW_CONCURRENCY_DEFAULT,
    min: 1,
  },
  reviewRetries: {
    type: 'number',
    integer: true,
    default: REVIEW_RETRIES_DEFAULT,
    min: 0,
    max: REVIEW_RETRIES_MAX,
  },
  reviewIntervalSeconds: {
    type: 'number',
    default: REVIEW_INTERVAL_SECONDS_DEFAULT,
    min: 0,
    max: REVIEW_INTERVAL_SECONDS_MAX,
  },
  loopMaxRounds: {
    type: 'number',
    integer: true,
    default: LOOP_ROUNDS_DEFAULT,
    min: 1,
    max: LOOP_ROUNDS_MAX,
  },
  saveTurnOutputs: {
    type: 'boolean',
    default: false,
  },
  mergeOnCompaction: {
    type: 'boolean',
    default: true,
  },
  storageDir: {
    type: 'string',
    default: '',
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
  return schema.default(field.default)
}

export const Config = z.object({
  [SETTINGS_KEY]: z.object(Object.fromEntries(
    Object.entries(SETTINGS_FIELDS).map(([key, field]) => [key, fieldSchema(field)]),
  )).volatile(),
}).i18n(configMessages)

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
