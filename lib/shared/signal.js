/**
 * 把一个上游中止信号转发到一个新的 controller。
 *
 * @module dsh-humanize/shared/signal
 */

/**
 * 省略 upstream 时返回的 dispose 是空操作。
 * @param {AbortSignal} [upstream]
 * @returns {{ controller: AbortController, dispose: () => void }}
 */
export function fuseAbortSignal(upstream) {
  const controller = new AbortController()
  if (upstream === undefined) return { controller, dispose: noop }
  if (upstream.aborted) {
    controller.abort(upstream.reason)
    return { controller, dispose: noop }
  }
  const onAbort = () => controller.abort(upstream.reason)
  upstream.addEventListener('abort', onAbort, { once: true })
  // 上游一直不中止时监听器会一直挂着，用完必须调用 dispose。
  const dispose = () => upstream.removeEventListener('abort', onAbort)
  return { controller, dispose }
}

function noop() {}
