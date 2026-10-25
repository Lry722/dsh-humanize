/**
 * Markdown 代码围栏的识别与围栏选择。审查请求和合并请求都会用到。
 *
 * @module dsh-humanize/shared/markdown
 */

/** 开围栏：最多 3 个前导空格，后面至少 3 个反引号或波浪号，再接 info string。 */
const OPEN_FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/

/**
 * 找出代码围栏所在的行区间，起止行都算在区间内。
 *
 * 未闭合的围栏结算到全文最后一行。
 *
 * @param {string[]} lines
 * @returns {Array<{ start: number, end: number, closed: boolean, char: string, length: number }>}
 */
export function fenceSpans(lines) {
  const spans = []
  let open = null
  for (let i = 0; i < lines.length; i += 1) {
    const match = OPEN_FENCE.exec(lines[i])
    if (open === null) {
      if (match === null) continue
      // 先按未闭合结算，命中闭合行时再修正。
      open = {
        start: i,
        end: lines.length - 1,
        closed: false,
        char: match[1][0],
        length: match[1].length,
      }
      spans.push(open)
      continue
    }
    // 闭合当前围栏要同时满足三个条件：字符和开围栏相同，长度大于等于开围栏，
    // 围栏后面只有空白。其余围栏样的行一律忽略。
    if (match !== null && match[1][0] === open.char
      && match[1].length >= open.length && match[2].trim() === '') {
      open.end = i
      open.closed = true
      open = null
    }
  }
  return spans
}

/**
 * 文本里最长的连续反引号串长度，没有反引号时为 0。
 * @param {string} text
 * @returns {number}
 */
export function longestBacktickRun(text) {
  let longest = 0
  for (const match of text.matchAll(/`+/g)) longest = Math.max(longest, match[0].length)
  return longest
}

/**
 * 选一段比正文里最长反引号串更长的反引号围栏，最少 3 个。
 * @param {string} text
 * @returns {string}
 */
export function outerFence(text) {
  return '`'.repeat(Math.max(3, longestBacktickRun(text) + 1))
}
