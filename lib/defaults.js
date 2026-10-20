/**
 * 审查并发数、失败重试次数和循环合并轮次上限的缺省值与上限，由各
 * 模块共用。
 *
 * 另外提供把取值限制在给定范围内的工具函数。
 *
 * @module dsh-humanize/defaults
 */

/** 审查并发数的缺省值。 */
export const REVIEW_CONCURRENCY_DEFAULT = 3
/** 失败重试次数的缺省值。 */
export const REVIEW_RETRIES_DEFAULT = 1
/** 失败重试次数的上限。 */
export const REVIEW_RETRIES_MAX = 3
/** 重试间隔的基数，第 N 次重试前等待 N 倍基数。 */
export const REVIEW_RETRY_DELAY_MS = 1000
/** 循环合并轮次上限的缺省值。 */
export const LOOP_ROUNDS_DEFAULT = 3
/** 循环合并轮次的上限。 */
export const LOOP_ROUNDS_MAX = 10

/** 把外部传入的数值收敛到调用方给定的范围。 */
export function clampInt(value, min, max, fallback) {
  // 传入的不是整数时返回 fallback，比如设置页还没填这个字段。
  if (!Number.isInteger(value)) return fallback
  // max 省略时只限制下限。
  const upper = max === undefined ? Infinity : max
  return Math.max(min, Math.min(upper, value))
}
