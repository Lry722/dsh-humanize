/**
 * 计算写入后的内容中的改动区段，输入是写入前后的两份内容。
 *
 * @module dsh-humanize/diff
 */
import { structuredPatch } from 'diff'

/**
 * 返回改动区段列表，并把每段的起点和终点对齐到完整的代码围栏。
 *
 * 多处分散的改动各成一段。段与段之间未改的内容留在范围之外。
 * @param {string} before - 写入前的内容。
 * @param {string} after - 写入后的内容。
 * @param {number} [context=3] - 改动两侧保留的上下文行数。
 * @returns {Array<{ startLine: number, endLine: number }> | null} 改动区段列表，
 * 每项是写入后内容里的闭区间行号。内容没有变化时返回 null。
 */
export function changedRegions(before, after, context = 3) {
  if (before === after) return null
  const lines = after.split('\n')
  const patch = structuredPatch('before', 'after', before, after, '', '', { context })
  const regions = []
  for (const hunk of patch.hunks) {
    const from = Math.min(lines.length - 1, Math.max(0, hunk.newStart - 1))
    // 内容被删空时 hunk.newLines 为 0，保留一个空行作为审查落点。
    const to = Math.min(lines.length, from + Math.max(1, hunk.newLines))
    const aligned = alignToFences(lines, from, to)
    regions.push({ startLine: aligned.from + 1, endLine: aligned.to })
  }
  return mergeRegions(regions)
}

/**
 * 合并重叠或相邻的区段。围栏对齐可能把两段扩到一起。
 * @param {Array<{ startLine: number, endLine: number }>} regions
 * @returns {Array<{ startLine: number, endLine: number }>}
 */
function mergeRegions(regions) {
  regions.sort((a, b) => a.startLine - b.startLine)
  const merged = []
  for (const region of regions) {
    const last = merged[merged.length - 1]
    if (last !== undefined && region.startLine <= last.endLine + 1) {
      last.endLine = Math.max(last.endLine, region.endLine)
    } else {
      merged.push({ ...region })
    }
  }
  return merged
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
