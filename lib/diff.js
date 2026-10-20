/**
 * 计算一次写入前后的改动区段。
 *
 * @module dsh-humanize/diff
 */

/**
 * 计算写入后的内容中的改动区段。单个连续改动给出最小的改动区段。
 * 分散的多处改动则给出一个覆盖全部改动的区段。
 * @param {string} before - 写入前的内容。
 * @param {string} after - 写入后的内容。
 * @param {number} [context=3] - 改动两侧保留的上下文行数。
 * @returns {{ text: string, startLine: number } | null} 改动区段和它在
 * 写入后的内容中的起始行号。
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
  const aligned = alignToFences(newLines, from, to)
  return { text: newLines.slice(aligned.from, aligned.to).join('\n'), startLine: aligned.from + 1 }
}

/**
 * 把改动区段的边界对齐到代码围栏。边界落在代码围栏内部时，起始行和
 * 结束行都会扩展到代码围栏之外。
 */
function alignToFences(lines, from, to) {
  let fenceStart = -1
  for (let i = 0; i < to; i++) {
    if (!/^(```|~~~)/.test(lines[i].trimStart())) continue
    if (fenceStart === -1) {
      fenceStart = i
    } else {
      if (fenceStart < from && i >= from) from = fenceStart
      if (fenceStart < to && i >= to) to = i + 1
      fenceStart = -1
    }
  }
  if (fenceStart !== -1 && fenceStart < from) from = fenceStart
  return { from, to }
}
