/**
 * 审查并发、失败重试和循环合并轮次的缺省值与边界，外加各模块共用的
 * 取值夹取。Config schema 和各使用处共用这一份，改默认值时不用多处
 * 同步。浏览器端设置卡片是独立的 chunk，无法引用宿主代码，改这里的
 * 数字要同步 client.settings.js 里对应的兜底值。
 *
 * @module dsh-humanize/defaults
 */

/** 并行批次大小的缺省值。 */
export const REVIEW_CONCURRENCY_DEFAULT = 3
/** 失败重试次数的缺省值与上限。 */
export const REVIEW_RETRIES_DEFAULT = 1
export const REVIEW_RETRIES_MAX = 3
/** 重试间隔的基数，第 N 次重试前等 N 倍基数。 */
export const REVIEW_RETRY_DELAY_MS = 1000
/** 循环合并轮次上限的缺省值与硬上限。 */
export const LOOP_ROUNDS_DEFAULT = 3
export const LOOP_ROUNDS_MAX = 10

/**
 * 取一个落在范围内的整数，缺省或非法时用 fallback。max 缺省时视为不设
 * 上限，实际并发由待审文件数兜住。
 */
export function clampInt(value, min, max, fallback) {
  if (!Number.isInteger(value)) return fallback
  const upper = max === undefined ? Infinity : max
  return Math.max(min, Math.min(upper, value))
}
