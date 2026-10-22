/**
 * 并发闸门。限制同一时间进入的调用数，等待时可以中止。
 *
 * 上限可以传函数，每次放行时重新读取，设置页改完立即生效。
 *
 * @module dsh-humanize/semaphore
 */

/**
 * 创建一个并发闸门。
 * @param {number | (() => number)} limit - 同时允许进入的调用数，小于 1 时按 1 处理。
 * @returns {{ acquire: (signal?: AbortSignal) => Promise<() => void> }}
 */
export function createSemaphore(limit) {
  let active = 0
  const waiters = []

  function max() {
    const value = typeof limit === 'function' ? limit() : limit
    return Number.isFinite(value) && value >= 1 ? Math.floor(value) : 1
  }

  function release() {
    active = Math.max(0, active - 1)
    pump()
  }

  function pump() {
    while (active < max() && waiters.length > 0) {
      const waiter = waiters.shift()
      // 放行之后，中止信号不再影响这个等待项。
      if (waiter.signal !== undefined) waiter.signal.removeEventListener('abort', waiter.onAbort)
      active += 1
      waiter.resolve(release)
    }
  }

  function acquire(signal) {
    if (signal?.aborted === true) return Promise.reject(abortError())
    // 上限刚被调大时，先把已经在等的调用放进来。
    pump()
    if (active < max()) {
      active += 1
      return Promise.resolve(release)
    }
    return new Promise((resolve, reject) => {
      const waiter = { resolve, reject, signal, onAbort: undefined }
      if (signal !== undefined) {
        waiter.onAbort = () => {
          const index = waiters.indexOf(waiter)
          if (index >= 0) waiters.splice(index, 1)
          reject(abortError())
        }
        signal.addEventListener('abort', waiter.onAbort, { once: true })
      }
      waiters.push(waiter)
    })
  }

  return { acquire }
}

/** 等待闸门时被中止的错误。 */
function abortError() {
  const error = new Error('review aborted while waiting for a review slot')
  error.name = 'AbortError'
  return error
}
