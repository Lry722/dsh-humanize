/**
 * PROSE.md 分层规范加载。加载时从被写文件所在的目录出发，逐级向上
 * 找。
 *
 * 规范链里全局规范排在最前面，范围越小的规范排在越后面，优先级也
 * 越高。渲染时把来源路径标注出来，交给审查模型判断。
 *
 * @module dsh-humanize/specs
 */
import { readFile, stat } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import yaml from 'js-yaml'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'

const SPEC_FILENAME = 'PROSE.md'
const ROOT_MARKER = '.git'

/** 缓存的键是路径，值是文件的修改时间、大小和内容。 */
const cache = new Map()

/**
 * 读到普通文件时返回文件内容，路径缺失或指向目录时返回 undefined。
 * @param {string} path
 * @returns {Promise<string | undefined>}
 */
async function readCached(path) {
  let st
  try {
    st = await stat(path)
  } catch (error) {
    // 碰到 ENOENT 就当成没有规范。权限等错误直接抛出。
    if (error?.code === 'ENOENT') return undefined
    throw error
  }
  if (!st.isFile()) return undefined
  const hit = cache.get(path)
  if (hit !== undefined && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.content
  const content = await readFile(path, 'utf8')
  cache.set(path, { mtimeMs: st.mtimeMs, size: st.size, content })
  return content
}

/**
 * 解析 PROSE.md 的 YAML 文件头，返回正文和 include。include 声明
 * 规范作用的文件范围。写入触发的审查和 /humanize-review 都按它过滤。
 * @param {string} content
 * @returns {{ body: string, include: string[] | undefined }}
 */
function parseSpec(content) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(content)
  if (match === null) return { body: content, include: undefined }
  let data
  try {
    data = yaml.load(match[1])
  } catch {
    data = undefined
  }
  const include = Array.isArray(data?.include)
    ? data.include.filter((item) => typeof item === 'string' && item.trim().length > 0)
    : undefined
  return { body: content.slice(match[0].length), include }
}

/**
 * 从 dir 向上找包含 .git 的项目根目录。
 * @param {string} dir
 * @returns {Promise<string | undefined>}
 */
async function findProjectRoot(dir, boundary) {
  let current = dir
  for (;;) {
    try {
      await stat(join(current, ROOT_MARKER))
      return current
    } catch (error) {
      // 碰到 ENOENT 才继续逐级向上找。权限等错误直接抛出，确保父目录
      // 确实是项目根目录。
      if (error?.code !== 'ENOENT') throw error
    }
    // 给了工作目录边界时，最多找到这里就停。
    if (boundary !== undefined && current === boundary) return boundary
    const parent = dirname(current)
    if (parent === current) return boundary
    current = parent
  }
}

/**
 * 按被写文件所在目录收集规范链，全局规范排在最前面，范围越小的
 * 规范排在越后面。
 * @param {string} filePath - 被写文件的路径。
 * @returns {Promise<Array<{ path: string, content: string, include: string[] | undefined }>>}
 */
export async function loadSpecChain(filePath, boundary) {
  const dir = dirname(resolve(filePath))
  // 被写文件在边界之外时忽略这个边界，只把被写文件所在目录当成搜索起点。
  let stop = boundary === undefined ? undefined : resolve(boundary)
  if (stop !== undefined) {
    const rel = relative(stop, dir)
    if (rel.startsWith('..') || isAbsolute(rel)) stop = dir
  }
  const chain = []
  const globalPath = dshHomePath(SPEC_FILENAME)
  const globalContent = await readCached(globalPath)
  if (globalContent !== undefined) {
    const parsed = parseSpec(globalContent)
    chain.push({ path: globalPath, content: parsed.body, include: parsed.include })
  }
  const root = await findProjectRoot(dir, stop)
  const dirs = []
  let current = dir
  for (;;) {
    dirs.unshift(current)
    if (current === root) break
    const parent = dirname(current)
    // 找不到项目根目录时，一直逐级向上找，到文件系统根为止。
    if (parent === current) break
    current = parent
  }
  for (const d of dirs) {
    const path = join(d, SPEC_FILENAME)
    const raw = await readCached(path)
    if (raw !== undefined) {
      const parsed = parseSpec(raw)
      chain.push({ path, content: parsed.body, include: parsed.include })
    }
  }
  return chain
}

/**
 * 把规范链整理成全局连续的规则列表，同时渲染成交给审查模型的文本。
 *
 * 渲染和校验共用这一份结果，模型在提示词里看到的编号就是校验时
 * 认识的编号。列表项缩进多少都参与编号，代码块里的编号原样保留。
 *
 * @param {Array<{ path: string, content: string }>} chain
 * @returns {{ text: string, rules: Array<{ index: number, source: string, text: string }> }}
 */
export function buildSpecRules(chain) {
  const rules = []
  const sections = chain.map((entry) => {
    // 统一换行，CRLF 的行尾 \r 会让编号正则认错行。
    const content = entry.content.replace(/\r\n?/g, '\n').trim()
    let fence = null
    const rendered = []
    for (const line of content.split('\n')) {
      const fenceMatch = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line)
      if (fence === null) {
        if (fenceMatch !== null) {
          // 记下围栏字符和长度，只有同字符且长度大于或等于它的行才能关闭。
          fence = { char: fenceMatch[1][0], length: fenceMatch[1].length }
          rendered.push(line)
          continue
        }
        const match = /^(\s*)(\d+)\.(\s+.*)$/.exec(line)
        if (match === null) {
          rendered.push(line)
          continue
        }
        const index = rules.length + 1
        rules.push({ index, source: entry.path, text: match[3].trim() })
        rendered.push(`${match[1]}${index}.${match[3]}`)
        continue
      }
      rendered.push(line)
      if (fenceMatch !== null && fenceMatch[1][0] === fence.char
        && fenceMatch[1].length >= fence.length && fenceMatch[2].trim() === '') {
        fence = null
      }
    }
    // 用比内容里最长反引号串更长的围栏包住，保证规范里的 ## 或闭合标签
    // 留在同一段里。
    const body = rendered.join('\n')
    const outerFence = '`'.repeat(Math.max(3, longestBacktickRun(body) + 1))
    return `Spec source: ${entry.path}\n${outerFence}\n${body}\n${outerFence}`
  })
  return { text: sections.join('\n\n'), rules }
}

/** 内容里最长的连续反引号串长度，用来选外层围栏。 */
function longestBacktickRun(value) {
  let longest = 0
  for (const match of value.matchAll(/`+/g)) longest = Math.max(longest, match[0].length)
  return longest
}

/**
 * 把规范链渲染成一段文本，交给审查模型。
 * @param {Array<{ path: string, content: string }>} chain
 * @returns {string}
 */
export function renderSpecChain(chain) {
  return buildSpecRules(chain).text
}

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
 * 把一条 include 模式编译成正则，匹配语法参考 .gitignore。
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
    if (rel.length === 0 || rel.startsWith('..') || isAbsolute(rel)) return false
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
