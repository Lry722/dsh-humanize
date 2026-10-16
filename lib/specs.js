/**
 * PROSE.md 分层规范加载。照搬 dsh-agent-instructions 的分层思路，
 * 加载基准为被写文件所在目录。
 *
 * 合并顺序为用户全局规范 ~/.dsh/PROSE.md、项目根目录，再逐级向下到
 * 文件所在目录。范围越小的规则优先级越高，渲染时把来源路径标注出来
 * 交给审查模型判断。
 *
 * PROSE.md 支持 YAML 文件头，用 extensions 声明当前目录支持审查的文件
 * 后缀名，/humanize-review 审查目录时按它展开。各级的声明取并集。
 *
 * @module dsh-humanize/specs
 */
import { readFile, stat } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import yaml from 'js-yaml'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'

const SPEC_FILENAME = 'PROSE.md'
const ROOT_MARKER = '.git'

/** 缓存键为路径，值为修改时间、大小和内容。文件没有改动时直接复用。 */
const cache = new Map()

/**
 * 读一个规范文件，带 mtime 缓存。文件不存在或不是普通文件时返回 undefined。
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
 * 解析 PROSE.md 的文件头。文件头是可选的 YAML 块，extensions 字段声明
 * 当前目录支持审查的文件后缀名。返回去掉文件头后的正文和声明的后缀名。
 * @param {string} content
 * @returns {{ body: string, extensions: string[] | undefined }}
 */
export function parseSpec(content) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(content)
  if (match === null) return { body: content, extensions: undefined }
  let data
  try {
    data = yaml.load(match[1])
  } catch {
    data = undefined
  }
  const extensions = Array.isArray(data?.extensions)
    ? data.extensions.filter((item) => typeof item === 'string' && item.startsWith('.'))
    : undefined
  return { body: content.slice(match[0].length), extensions }
}

/**
 * 从 dir 向上找含 .git 的项目根目录。找不到返回 undefined。
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
 * @returns {Promise<Array<{ path: string, content: string, extensions: string[] | undefined }>>}
 */
export async function loadSpecChain(filePath) {
  const dir = dirname(resolve(filePath))
  const chain = []
  const globalPath = dshHomePath(SPEC_FILENAME)
  const globalContent = await readCached(globalPath)
  if (globalContent !== undefined) {
    const parsed = parseSpec(globalContent)
    chain.push({ path: globalPath, content: parsed.body, extensions: parsed.extensions })
  }
  const root = await findProjectRoot(dir)
  const dirs = []
  let current = dir
  for (;;) {
    dirs.unshift(current)
    if (current === root) break
    const parent = dirname(current)
    // 没找到项目根目录时一路走到文件系统根，和目录展开的语义保持一致。
    if (parent === current) break
    current = parent
  }
  for (const d of dirs) {
    const path = join(d, SPEC_FILENAME)
    const raw = await readCached(path)
    if (raw !== undefined) {
      const parsed = parseSpec(raw)
      chain.push({ path, content: parsed.body, extensions: parsed.extensions })
    }
  }
  return chain
}

/**
 * 把规范链渲染成一段文本，交给审查模型。每个来源内部的列表序号
 * 重排成全局连续编号，下层的序号接在上层后面，快照里每个编号
 * 唯一对应一条规则。
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
 * 从渲染后的规范文本里解析编号到条文的映射。渲染文本就是发给审查
 * 模型的快照，编号在快照里唯一，批注里的编号以它为准。
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
 * 一个文件按规范链计算出的可审查后缀名，各级声明取并集。
 * @param {Array<{ extensions: string[] | undefined }>} chain
 * @returns {string[]}
 */
export function chainExtensions(chain) {
  const all = []
  for (const entry of chain) {
    if (entry.extensions !== undefined) all.push(...entry.extensions)
  }
  return [...new Set(all)]
}
