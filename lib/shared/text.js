/**
 * 文本压缩的小工具。批注、任务说明和审查请求都会用到。
 *
 * @module dsh-humanize/shared/text
 */

/**
 * 把字符串压成单行。非字符串返回空串。
 * @param {unknown} value
 * @returns {string}
 */
export function oneLine(value) {
  if (typeof value !== 'string') return ''
  return value.replace(/\s+/g, ' ').trim()
}

/**
 * 把任意值压成单行，并限制在 max 个字符内。省略号计入字数。
 * @param {unknown} value
 * @param {number} max
 * @returns {string}
 */
export function clampLine(value, max) {
  const text = String(value).replace(/\s+/g, ' ').trim()
  if (text.length <= max) return text
  return `${text.slice(0, max - 1)}…`
}

/**
 * 截断文本并附上省略说明。max 是保留的字符数。
 * @param {string} text
 * @param {number} max
 * @returns {string}
 */
export function truncateText(text, max) {
  if (text.length <= max) return text
  return `${text.slice(0, max)}\n\n[truncated ${text.length - max} characters]`
}
