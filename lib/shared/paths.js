/**
 * 路径相关的小工具。
 *
 * 一类职责是处理命令输入：去掉其中的引号，解析斜杠命令的路径参数，
 * 并展开开头的 ~。另一类职责是判断路径是否落在某个目录之外。
 *
 * @module dsh-humanize/shared/paths
 */
import { isAbsolute, relative, resolve, sep } from 'node:path'
import { expandHomePath } from '@deepseek-ai/dsh-home-paths'

/**
 * 去掉一层成对的引号。命令输入里的引号来自 shell 习惯。
 * @param {string} value
 * @returns {string}
 */
export function unquotePath(value) {
  if (value.length < 2) return value
  const quote = value[0]
  if ((quote === '"' || quote === "'") && value[value.length - 1] === quote) {
    // 引号内部的字符原样保留，Windows 路径里的反斜杠也保持原样。
    return value.slice(1, -1)
  }
  return value
}

/**
 * 判断 target 是否落在 base 之外。
 * @param {string} base
 * @param {string} target
 * @returns {boolean}
 */
export function isOutside(base, target) {
  const rel = relative(base, target)
  // 同一路径和 `..foo.md` 这类名字都算在 base 之内。
  return rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)
}

/**
 * 解析命令的路径参数。
 * @param {import('@deepseek-ai/dsh-agent').Agent} agent
 * @param {string} rawInput - 命令后面跟的路径，留空时用会话的工作目录。
 * @returns {string}
 */
export function resolveCommandTarget(agent, rawInput) {
  const cwd = agent.session.header.cwd ?? process.cwd()
  const raw = rawInput.trim()
  if (raw.length === 0) return cwd
  // 命令只有一条路径参数，空格是路径的一部分。引号只在整体包住时去掉。
  const path = unquotePath(raw)
  return path.length === 0 ? cwd : resolve(cwd, expandHomePath(path))
}
