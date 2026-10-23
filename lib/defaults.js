/**
 * 审查并发数、失败重试次数、循环合并轮次三者的缺省值与上限，由各
 * 模块共用。
 *
 * 另外提供工具函数，把取值限制在给定范围内。
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
/** 循环合并轮次的缺省值。 */
export const LOOP_ROUNDS_DEFAULT = 3
/** 循环合并轮次的上限。 */
export const LOOP_ROUNDS_MAX = 10

export function clampInt(value, min, max, fallback) {
  // 设置页还没填这个字段时，传进来的值可能是 undefined，也可能是其他非整数。
  if (!Number.isInteger(value)) return fallback
  const upper = max === undefined ? Infinity : max
  return Math.max(min, Math.min(upper, value))
}
