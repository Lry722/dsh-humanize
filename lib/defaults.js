/**
 * 审查并发、失败重试和循环合并轮次的缺省值与边界。Config schema 和各
 * 使用处共用这一份，改默认值时不用多处同步。浏览器端设置卡片是独立的
 * chunk，无法引用宿主代码，改这里的数字要同步 client.settings.js 里
 * 对应的兜底值。
 *
 * @module dsh-humanize/defaults
 */

/** 并行批次大小的缺省值。 */
export const REVIEW_CONCURRENCY_DEFAULT = 3
/** 失败文件的重试轮数缺省值与上限。 */
export const REVIEW_RETRIES_DEFAULT = 1
export const REVIEW_RETRIES_MAX = 3
/** 循环合并轮次上限的缺省值与硬上限。 */
export const LOOP_ROUNDS_DEFAULT = 3
export const LOOP_ROUNDS_MAX = 10
