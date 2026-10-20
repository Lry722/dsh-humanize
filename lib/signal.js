/**
 * 中止信号融合。审查管线和审查调用各自有一摊转发上游信号的样板，
 * 这里收敛成一份。
 *
 * @module dsh-humanize/signal
 */

/**
 * 建一个跟随上游中止的 controller。上游已中止时立即中止并带上原因。
 * 上游缺省时退化为一个普通 controller，dispose 是空操作。
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
  // 监听器挂在上游信号上，用完后要摘掉，否则会活到上游信号消亡。
  return { controller, dispose: () => upstream.removeEventListener('abort', onAbort) }
}

function noop() {}
