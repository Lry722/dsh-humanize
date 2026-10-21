/**
 * 路径输入的小工具。命令参数和保存位置共用。
 *
 * @module dsh-humanize/paths
 */
import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * 展开开头的 `~` 或 `~/`，Windows 的 `~\` 也接受。
 * @param {string} value
 * @returns {string}
 */
export function expandHome(value) {
  if (value === '~') return homedir()
  if (value.startsWith('~/') || value.startsWith('~\\')) return join(homedir(), value.slice(2))
  return value
}

/**
 * 去掉一层成对的引号。命令输入里的引号来自 shell 习惯，路径本身不需要。
 * 引号内部的字符原样保留，避免把 Windows 路径里的反斜杠当成转义。
 * @param {string} value
 * @returns {string}
 */
export function unquotePath(value) {
  if (value.length < 2) return value
  const quote = value[0]
  if ((quote === '"' || quote === "'") && value[value.length - 1] === quote) {
    return value.slice(1, -1)
  }
  return value
}
