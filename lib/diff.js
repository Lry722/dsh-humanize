/**
 * 计算写入后的内容中的改动区段，输入是写入前后的两份内容。
 *
 * @module dsh-humanize/diff
 */

/**
 * 返回改动区段，并把起点和终点对齐到完整的代码围栏。
 *
 * 只有一处连续的改动时，改动区段刚好包住这一处改动。分散的多处改动时，
 * 改动区段覆盖全部改动。
 * @param {string} before - 写入前的内容。
 * @param {string} after - 写入后的内容。
 * @param {number} [context=3] - 改动两侧保留的上下文行数。
 * @returns {{ text: string, startLine: number } | null} 改动区段，以及它在
 * 写入后的内容里的起始行号。
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
 * 把改动区段的起点和终点对齐到完整的代码围栏，让审查看到整段围栏内容。
 *
 * 只改到围栏里的一行时，起点和终点也会扩到围栏之外。
 */
function alignToFences(lines, from, to) {
  let open = null
  for (let i = 0; i < lines.length; i++) {
    const match = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(lines[i])
    if (match === null) continue
    if (open === null) {
      open = { char: match[1][0], length: match[1].length, start: i }
      continue
    }
    // 只有字符相同，长度大于或等于起始围栏的长度，并且信息为空的行才能关闭。
    if (match[1][0] !== open.char || match[1].length < open.length || match[2].trim() !== '') continue
    // 起点落在围栏内部时，把起点挪到围栏的起始行。
    if (open.start < from && i >= from) from = open.start
    // 终点落在围栏内部时，把终点挪到围栏结束行的下一行。
    if (open.start < to && i >= to) to = i + 1
    open = null
  }
  if (open !== null && open.start < from) from = open.start
  return { from, to }
}
