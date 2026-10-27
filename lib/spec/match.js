/**
 * PROSE 规范的模式匹配。
 *
 * 模式语法参考 .gitignore。include 筛选规则的适用范围，同一组模式按
 * 声明顺序套用，最后一次命中生效。
 *
 * @module dsh-humanize/spec/match
 */
import { basename, dirname, relative, sep } from 'node:path'
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
 * 把一条 glob 模式编译成正则，模式语法参考 .gitignore。
 * @param {string} base - 当前规则的匹配基准目录。
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
 * @param {string | null} scope - 用户规则为 null，其余规则有目录边界。
 * @returns {boolean}
 */
function patternHits(pattern, filePath, scope) {
  if (pattern.anchored) {
    // 锚定模式以当前规则的匹配基准为起点。比较的是整条相对路径。
    const rel = relative(pattern.base, filePath)
    // 锚定匹配只处理 base 内部的子路径。以 .. 开头的文件名仍算在 base
    // 里面。
    if (rel.length === 0 || isOutside(pattern.base, filePath)) return false
    return pattern.regex.test(rel.split(sep).join('/'))
  }
  // 有边界的目录模式只处理隐式范围内的路径。base 自身和祖先目录都跳过。
  // 用户规则作用于整条路径，仍可以匹配目标路径里的任意目录段。
  if (pattern.dirOnly) {
    const path = scope === null ? filePath : relative(scope, filePath)
    return pattern.regex.test(path.split(sep).join('/'))
  }
  // 不带目录的文件模式按 .gitignore 的约定只认文件名。
  return pattern.regex.test(basename(filePath))
}

/** 取规则的匹配基准和隐式范围。用户规则的 scope 为 null。 */
function matchContext(entry) {
  const base = entry.base ?? dirname(entry.path)
  return { base, scope: entry.scope === undefined ? base : entry.scope }
}

/** 把一组模式编译到规则的匹配基准上。 */
function compilePatterns(entry, rawPatterns) {
  const { base } = matchContext(entry)
  const patterns = []
  for (const raw of rawPatterns ?? []) {
    const pattern = compilePattern(base, raw)
    if (pattern === undefined) continue
    patterns.push(pattern)
  }
  return patterns
}

/** 模式只在规则的隐式范围内生效。 */
function inScope(scope, filePath) {
  return scope === null || !isOutside(scope, filePath)
}

/**
 * 编译单份规则的 include。省略 include 时，规则作用于整个隐式范围。
 * @param {{ path: string, base?: string, scope?: string | null, include?: string[] }} entry
 * @returns {(filePath: string) => boolean}
 */
export function createIncludeMatcher(entry) {
  const { scope } = matchContext(entry)
  const patterns = compilePatterns(entry, entry.include)
  return (filePath) => {
    if (!inScope(scope, filePath)) return false
    if (entry.include === undefined) return true
    let included = false
    for (const pattern of patterns) {
      if (patternHits(pattern, filePath, scope)) included = !pattern.negated
    }
    return included
  }
}
