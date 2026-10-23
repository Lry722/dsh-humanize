/**
 * 计算写入后的内容中的改动区段，输入是写入前后的两份内容。
 *
 * @module dsh-humanize/diff
 */
import { structuredPatch } from 'diff'
import { fenceSpans } from './markdown.js'

/**
 * 返回改动区段列表，并把每段的起点和终点对齐到完整的代码围栏。
 *
 * 多处分散的改动各成一个改动区段。改动区段之间未改的内容留在范围之外。
 * @param {string} before - 写入前的内容。
 * @param {string} after - 写入后的内容。
 * @param {number} [context=3] - 改动两侧保留的上下文行数。
 * @returns {Array<{ startLine: number, endLine: number }> | null} 改动区段列表，
 * 每项是写入后内容里的闭区间行号。内容没有变化时返回 null。
 */
export function changedRegions(before, after, context = 3) {
  // git 里的旧内容用 LF，工作区可能是 CRLF。统一行尾后再比较，免得把
  // 每一行都当成改动。行号按 \n 切分，CRLF 和 LF 得到相同的行号。
  const previous = before.replace(/\r\n/g, '\n')
  const next = after.replace(/\r\n/g, '\n')
  if (previous === next) return null
  const lines = next.split('\n')
  const patch = structuredPatch('before', 'after', previous, next, '', '', { context })
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
  for (const span of fenceSpans(lines)) {
    // 起点在围栏中间时扩到围栏起始行，让开围栏那几行也落在审查范围里。
    if (span.start < from && span.end >= from) from = span.start
    // 终点落在已闭合围栏内部时，把终点挪到围栏结束行的下一行。未闭合
    // 围栏不扩展终点，保持改动区段只覆盖实际改到的内容。
    if (span.closed && span.start < to && span.end >= to) to = span.end + 1
  }
  return { from, to }
}
