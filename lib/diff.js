/**
 * 计算写入后的内容中的改动区段，输入是写入前后的两份内容。
 *
 * @module dsh-humanize/diff
 */

/**
 * 返回改动区段，并把边界对齐到完整的代码围栏。
 *
 * 只有一处连续的改动时，改动区段刚好包住这一处改动。分散的多处改动时，
 * 改动区段覆盖全部改动。
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
 * 把改动区段的边界对齐到代码围栏。这里的起点和终点都是行下标，返回的
 * 改动区段从起点行开始，到终点行的前一行结束。边界落在代码围栏内部时，
 * 起点往前挪到围栏开头，终点往后挪到围栏结束行的下一行。
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
