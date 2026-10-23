/**
 * 测试共用的异步辅助函数。本文件不注册测试，只提供工具。
 */

/** 等一个事件循环轮次，让排队的异步任务推进。 */
export const tick = () => new Promise((resolve) => { setImmediate(resolve) })

/** 等一段时间，用来观察一段时间内没有发生动作。 */
export const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms) })

/** 轮询等待条件成立，超时后抛错。 */
export async function waitFor(check, timeoutMs = 3000) {
  const start = Date.now()
  while (!check()) {
    if (Date.now() - start > timeoutMs) throw new Error('timed out waiting for condition')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}
