/**
 * PROSE.md 分层规范加载，加载基准为被写文件所在目录。
 *
 * 合并顺序为用户全局规范 ~/.dsh/PROSE.md、项目根目录，再逐级向下到
 * 文件所在目录。范围越小的规范条目优先级越高，渲染时把来源路径标注出来
 * 交给审查模型判断。
 *
 * PROSE.md 支持 YAML 文件头，用 include 声明当前目录支持审查的文件。
 * /humanize-review 审查目录时按它过滤。各级的声明按范围从小到大排列，
 * 后面的命中覆盖前面的结果。匹配语法参考 .gitignore，见 compilePattern。
 *
 * @module dsh-humanize/specs
 */
import { readFile, stat } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import yaml from 'js-yaml'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'

const SPEC_FILENAME = 'PROSE.md'
const ROOT_MARKER = '.git'

/** 缓存键为路径，值为修改时间、大小和内容。 */
const cache = new Map()

/**
 * 文件不存在或不是普通文件时返回 undefined。
 * @param {string} path
 * @returns {Promise<string | undefined>}
 */
async function readCached(path) {
  let st
  try {
    st = await stat(path)
  } catch {
    return undefined
  }
  if (!st.isFile()) return undefined
  const hit = cache.get(path)
  if (hit !== undefined && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.content
  const content = await readFile(path, 'utf8')
  cache.set(path, { mtimeMs: st.mtimeMs, size: st.size, content })
  return content
}

/**
 * 解析 PROSE.md 的 YAML 文件头，返回正文和 include。
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
 * 从 dir 向上找含 .git 的项目根目录。
 * @param {string} dir
 * @returns {Promise<string | undefined>}
 */
async function findProjectRoot(dir) {
  let current = dir
  for (;;) {
    try {
      await stat(join(current, ROOT_MARKER))
      return current
    } catch {
      // 继续向上
    }
    const parent = dirname(current)
    if (parent === current) return undefined
    current = parent
  }
}

/**
 * 按被写文件所在目录收集规范链，全局在前，范围越小的越靠后。
 * @param {string} filePath - 被写文件的路径。
 * @returns {Promise<Array<{ path: string, content: string, include: string[] | undefined }>>}
 */
export async function loadSpecChain(filePath) {
  const dir = dirname(resolve(filePath))
  const chain = []
  const globalPath = dshHomePath(SPEC_FILENAME)
  const globalContent = await readCached(globalPath)
  if (globalContent !== undefined) {
    const parsed = parseSpec(globalContent)
    chain.push({ path: globalPath, content: parsed.body, include: parsed.include })
  }
  const root = await findProjectRoot(dir)
  const dirs = []
  let current = dir
  for (;;) {
    dirs.unshift(current)
    if (current === root) break
    const parent = dirname(current)
    // 没有项目根目录时一直向上到文件系统根。
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
 * 把规范链渲染成一段文本，交给审查模型。每个来源内部的列表序号
 * 重排成全局连续编号，下层的序号接在上层后面，渲染文本里每个编号
 * 唯一对应一条规范条目。
 * @param {Array<{ path: string, content: string }>} chain
 * @returns {string}
 */
export function renderSpecChain(chain) {
  let next = 1
  return chain
    .map((entry) => {
      const lines = entry.content.trim().split('\n').map((line) => {
        const match = /^(\s*)(\d+)\.(\s+.*)$/.exec(line)
        if (match === null) return line
        const renumbered = `${match[1]}${next}.${match[3]}`
        next += 1
        return renumbered
      })
      return `规范来源：${entry.path}\n${lines.join('\n')}`
    })
    .join('\n\n')
}

/**
 * 解析渲染文本里的编号到规范条目的映射。
 * @param {string} specText - renderSpecChain 的输出。
 * @returns {Map<number, string>}
 */
export function parseSpecRules(specText) {
  const rules = new Map()
  for (const line of specText.split('\n')) {
    const match = /^(\d+)\.\s+(.*)$/.exec(line)
    if (match !== null) rules.set(Number(match[1]), match[2])
  }
  return rules
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
          // **/ 跨目录匹配任意层级。
          out += '(?:[^/]+/)*'
          i += 3
        } else {
          // ** 跨目录。
          out += '[^]*'
          i += 2
        }
      } else {
        // * 不跨目录。
        out += '[^/]*'
        i += 1
      }
    } else if (ch === '?') {
      // ? 不跨目录。
      out += '[^/]'
      i += 1
    } else if (ch === '[') {
      // [...] 是字符组。
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
 * 编译一条 include 模式。锚定的模式对基准目录的相对路径做整体匹配，
 * 非锚定的文件模式只匹配文件名，非锚定的目录模式匹配路径里任意一段。
 * @param {string} base - 声明该模式的 PROSE.md 所在目录。
 * @param {string} raw - 模式原文。
 * @returns {{ negated: boolean, anchored: boolean, dirOnly: boolean, base: string, regex: RegExp } | undefined}
 */
function compilePattern(base, raw) {
  let pattern = raw.trim()
  if (pattern.length === 0) return undefined
  let negated = false
  // ! 前缀取反。
  if (pattern.startsWith('!')) {
    negated = true
    pattern = pattern.slice(1)
  }
  // 结尾 / 是目录模式，匹配该目录下所有文件。
  const dirOnly = pattern.endsWith('/')
  if (dirOnly) pattern = pattern.slice(0, -1)
  const leadingSlash = pattern.startsWith('/')
  if (leadingSlash) pattern = pattern.slice(1)
  if (pattern.length === 0) return undefined
  // 开头或中间含 / 的模式按声明文件所在目录锚定，其余匹配任意层级。
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
 * 一条编译后的模式是否命中文件。
 * @param {{ anchored: boolean, dirOnly: boolean, base: string, regex: RegExp }} pattern
 * @param {string} filePath
 * @returns {boolean}
 */
function patternHits(pattern, filePath) {
  if (pattern.anchored) {
    const rel = relative(pattern.base, filePath)
    if (rel.length === 0 || rel.startsWith('..') || isAbsolute(rel)) return false
    return pattern.regex.test(rel)
  }
  if (pattern.dirOnly) return pattern.regex.test(filePath)
  return pattern.regex.test(basename(filePath))
}

/**
 * 把规范链的 include 声明编译成一个判定函数。模式按范围从小到大
 * 排列，依次套用，最后一次命中的结果生效，! 前缀的命中表示排除。
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
