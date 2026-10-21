/**
 * 中止信号转发。把一个上游中止信号转发到一个新的 controller。
 *
 * @module dsh-humanize/signal
 */

/**
 * 转发上游中止信号到一个新的 controller。上游已中止时立即中止并带上原因。
 * 省略 upstream 时直接返回新建的 controller，dispose 是空操作。
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
  // 上游信号结束后就不再需要这个监听器。
  const dispose = () => upstream.removeEventListener('abort', onAbort)
  return { controller, dispose }
}

function noop() {}
