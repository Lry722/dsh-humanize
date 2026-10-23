/**
 * PROSE.md 的 include 模式匹配。
 *
 * 模式语法参考 .gitignore。各级规范声明的模式按范围从小到大依次套用，
 * 最后一次命中的结果生效。
 *
 * @module dsh-humanize/spec/match
 */
import { basename, dirname, relative } from 'node:path'
import { isOutside } from '../shared/paths.js'

/**
 * 把 glob 模式翻译成正则源码。
 * @param {string} pattern
 * @returns {string}
 */
function globSource(pattern) {
  let out = ''
  let i = 0
  while (i < pattern.length) {
    const ch = pattern[i]
    if (ch === '*') {
      if (pattern[i + 1] === '*') {
        if (pattern[i + 2] === '/') {
          // 双星号后面接斜杠时匹配零到多层目录。
          out += '(?:[^/]+/)*'
          i += 3
        } else {
          // 双星号后面接其他字符时，匹配内容可以跨目录层级。
          out += '[^]*'
          i += 2
        }
      } else {
        // 单星号匹配同一层目录里的名字。
        out += '[^/]*'
        i += 1
      }
    } else if (ch === '?') {
      // 问号匹配同一层目录里的一个字符。
      out += '[^/]'
      i += 1
    } else if (ch === '[') {
      // 方括号里列出一个字符范围，开头写叹号表示取反。
      const end = pattern.indexOf(']', i + 1)
      if (end > i + 1) {
        let cls = pattern.slice(i + 1, end)
        if (cls.startsWith('!')) cls = `^${cls.slice(1)}`
        out += `[${cls.replace(/\\/g, '\\\\')}]`
        i = end + 1
      } else {
        out += '\\['
        i += 1
      }
    } else {
      // 其余字符按字面量转义。
      out += ch.replace(/[.+^${}()|\\]/g, '\\$&')
      i += 1
    }
  }
  return out
}

/**
 * 把一条 include 模式编译成正则，模式语法参考 .gitignore。
 * @param {string} base - 声明该模式的 PROSE.md 所在目录。
 * @param {string} raw - 模式原文。
 * @returns {{ negated: boolean, anchored: boolean, dirOnly: boolean, base: string, regex: RegExp } | undefined}
 */
function compilePattern(base, raw) {
  let pattern = raw.trim()
  if (pattern.length === 0) return undefined
  let negated = false
  if (pattern.startsWith('!')) {
    negated = true
    pattern = pattern.slice(1)
  }
  // 结尾 / 是目录模式，匹配该目录下的文件。
  const dirOnly = pattern.endsWith('/')
  if (dirOnly) pattern = pattern.slice(0, -1)
  const leadingSlash = pattern.startsWith('/')
  if (leadingSlash) pattern = pattern.slice(1)
  if (pattern.length === 0) return undefined
  // 开头或中间含 / 的模式算锚定模式。
  const anchored = leadingSlash || pattern.includes('/')
  const body = globSource(pattern)
  let regex
  if (anchored) {
    regex = new RegExp(dirOnly ? `^${body}/` : `^${body}$`)
  } else {
    regex = new RegExp(dirOnly ? `(?:^|/)${body}/` : `^${body}$`)
  }
  return { negated, anchored, dirOnly, base, regex }
}

/**
 * 判断编译后的模式是否命中文件。
 * @param {{ anchored: boolean, dirOnly: boolean, base: string, regex: RegExp }} pattern
 * @param {string} filePath
 * @returns {boolean}
 */
function patternHits(pattern, filePath) {
  if (pattern.anchored) {
    // 锚定模式以声明它的 PROSE.md 所在目录为起点。比较的是整条相对路径。
    const rel = relative(pattern.base, filePath)
    // 同一路径和 base 之外的路径都不参与锚定匹配。以 .. 开头的文件名仍
    // 算在 base 里面。
    if (rel.length === 0 || isOutside(pattern.base, filePath)) return false
    return pattern.regex.test(rel)
  }
  // 非锚定的模式在任意层级上匹配。
  // 目录模式看路径里的任意一段目录。
  if (pattern.dirOnly) return pattern.regex.test(filePath)
  // 不带目录的文件模式按 .gitignore 的约定只认文件名。
  return pattern.regex.test(basename(filePath))
}

/**
 * 判断规范链里有没有 include 声明。各级规范都省略 include 声明时，
 * 规范作用于所有文件。
 * @param {Array<{ include: string[] | undefined }>} chain
 * @returns {boolean}
 */
export function declaresInclude(chain) {
  return chain.some((entry) => entry.include !== undefined)
}

/**
 * 把规范链的 include 声明编译成一个判定函数，按顺序逐条命中，
 * 后面的命中覆盖前面的命中。
 * @param {Array<{ path: string, include: string[] | undefined }>} chain
 * @returns {(filePath: string) => boolean}
 */
export function createSpecMatcher(chain) {
  const patterns = []
  for (const entry of chain) {
    if (entry.include === undefined) continue
    const base = dirname(entry.path)
    for (const raw of entry.include) {
      const pattern = compilePattern(base, raw)
      if (pattern !== undefined) patterns.push(pattern)
    }
  }
  return (filePath) => {
    let included = false
    for (const pattern of patterns) {
      if (patternHits(pattern, filePath)) included = !pattern.negated
    }
    return included
  }
}
