/**
 * 路径输入的小工具：去掉命令输入里的引号，判断路径是否落在某个目录之外。
 *
 * @module dsh-humanize/paths
 */
import { isAbsolute, relative, sep } from 'node:path'

/**
 * 去掉一层成对的引号。命令输入里的引号来自 shell 习惯，这里统一去掉。
 * 引号内部的字符原样保留，Windows 路径里的反斜杠也保持原样。
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

/**
 * 判断 target 是否落在 base 之外。同一路径和 `..foo.md` 这类名字都算在
 * base 之内。
 * @param {string} base
 * @param {string} target
 * @returns {boolean}
 */
export function isOutside(base, target) {
  const rel = relative(base, target)
  return rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)
}
