/**
 * 计算两次写入之间的改动区段。
 *
 * @module dsh-humanize/diff
 */

/**
 * 计算写入后的内容中发生改动的区段，两侧各保留若干行上下文。单个
 * 连续改动给出最小区段。分散的多处改动给出覆盖全部改动的一个大区段。
 * @param {string} before - 写入前的完整内容。
 * @param {string} after - 写入后的完整内容。
 * @param {number} [context=3] - 改动两侧保留的上下文行数。
 * @returns {{ text: string, startLine: number } | null} 改动区段和它在
 * 写入后内容中的起始行号。前后内容相同时返回 null。
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
