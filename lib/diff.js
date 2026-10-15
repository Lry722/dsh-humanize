/**
 * 计算两次写入之间的改动区域。审查只需要看本次改动的部分，
 * 不用把整个文件发给审查模型。
 *
 * @module dsh-humanize/diff
 */

/**
 * 找出新内容中发生改动的区段，两侧各带若干行上下文。用公共前后缀
 * 裁剪，单个连续改动给出最小区段，分散的多处改动给出覆盖全部改动
 * 的一个大区段。
 * @param {string} before - 写入前的完整内容。
 * @param {string} after - 写入后的完整内容。
 * @param {number} [context=3] - 改动两侧保留的上下文行数。
 * @returns {{ text: string, startLine: number } | null} 改动区段和它在
 * 新内容中的起始行号。内容没有变化时返回 null。
 */
export function changedRegion(before, after, context = 3) {
  if (before === after) return null
  const oldLines = before.split('\n')
  const newLines = after.split('\n')
  const shared = Math.min(oldLines.length, newLines.length)
  let start = 0
  while (start < shared && oldLines[start] === newLines[start]) start++
  let endOld = oldLines.length
  let endNew = newLines.length
  while (endOld > start && endNew > start && oldLines[endOld - 1] === newLines[endNew - 1]) {
    endOld--
    endNew--
  }
  const from = Math.max(0, start - context)
  const to = Math.min(newLines.length, endNew + context)
  return { text: newLines.slice(from, to).join('\n'), startLine: from + 1 }
}
