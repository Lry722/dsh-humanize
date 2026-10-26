/**
 * 测试共用的异步辅助函数。这个文件只提供工具。
 */

/** 等一个事件循环轮次，让排队的异步任务推进。 */
export const tick = () => new Promise((resolve) => { setImmediate(resolve) })

/** 在测试中插入一段延时，给异步任务留出推进的时间。 */
export const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms) })

/** 轮询等待条件成立，超时后抛错。 */
export async function waitFor(check, timeoutMs = 3000) {
  const start = Date.now()
  while (!check()) {
    if (Date.now() - start > timeoutMs) throw new Error('timed out waiting for condition')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}
