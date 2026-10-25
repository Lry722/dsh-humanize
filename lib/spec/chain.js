/**
 * PROSE 规范的发现、筛选与渲染。
 *
 * 候选来源包括用户规则、项目的 .agents/prose/*.md 和祖先目录的
 * PROSE.md。每份规则独立匹配目标文件，再按 priority 和来源层级合并。
 * base.md 只是普通文件名，没有额外的匹配或排序逻辑。
 *
 * 规范用一级标题 # Rules 分块，只有这个章节里的编号行是规则，其他章节
 * 作为补充说明原样进入上下文。include 与 review 的匹配在 match.js。
 *
 * @module dsh-humanize/spec/chain
 */
import { readFile, readdir, stat } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import yaml from 'js-yaml'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import { fenceSpans, outerFence } from '../shared/markdown.js'
import { isOutside } from '../shared/paths.js'
import { createIncludeMatcher, createReviewMatcher } from './match.js'

const SPEC_FILENAME = 'PROSE.md'
const PROJECT_SPEC_DIR = join('.agents', 'prose')
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

/** 读取文件头里的字符串列表，其他类型按未声明处理。 */
function patternList(value) {
  return Array.isArray(value)
    ? value.filter((item) => typeof item === 'string' && item.trim().length > 0)
    : undefined
}

/**
 * 解析规范的 YAML 文件头。
 * @param {string} content
 * @param {string} path - 规范文件路径，用在解析错误的说明里。
 */
function parseSpec(content, path) {
  const empty = { include: undefined, review: undefined, priority: 0, inherit: true }
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(content)
  if (match === null) return { ...empty, body: content }
  let data
  try {
    data = yaml.load(match[1])
  } catch (error) {
    const parseError = new Error(`规范的 YAML 文件头无法解析：${path}`, { cause: error })
    parseError.humanizeSpecError = true
    throw parseError
  }
  const include = patternList(data?.include)
  const priority = typeof data?.priority === 'number' && Number.isFinite(data.priority)
    ? data.priority
    : 0
  const inherit = data?.inherit !== false
  let review
  if (data?.review !== null && typeof data?.review === 'object' && !Array.isArray(data.review)) {
    const reviewInclude = patternList(data.review.include)
    const reviewExclude = patternList(data.review.exclude)
    if (reviewInclude !== undefined || reviewExclude !== undefined) {
      review = { include: reviewInclude, exclude: reviewExclude }
    }
  }
  return { body: content.slice(match[0].length), include, review, priority, inherit }
}

/** 读取一份规范并附上发现位置决定的匹配基准。 */
async function readSpec(path, attributes) {
  const raw = await readCached(path)
  if (raw === undefined) return undefined
  const { body, ...metadata } = parseSpec(raw, path)
  return { path, content: body, ...metadata, ...attributes }
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
    const parent = dirname(current)
    if (parent === current) return boundary
    current = parent
  }
}

/** 读取项目目录下的全部命名规则集。目录清单每次重读，便于发现增删。 */
async function loadProjectSpecs(root) {
  const directory = join(root, PROJECT_SPEC_DIR)
  let entries
  try {
    entries = await readdir(directory, { withFileTypes: true })
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return []
    throw error
  }
  const specs = []
  const names = entries
    .filter((entry) => (entry.isFile() || entry.isSymbolicLink()) && entry.name.endsWith('.md'))
    .map((entry) => entry.name)
    .sort()
  for (const name of names) {
    const spec = await readSpec(join(directory, name), {
      kind: 'project',
      base: root,
      scope: root,
      depth: 0,
    })
    if (spec !== undefined) specs.push(spec)
  }
  return specs
}

/**
 * 收集用户规则、项目命名规则和祖先目录规则。这里只发现候选来源，
 * 是否适用于目标文件由 resolveSpecChain 判断。
 * @param {string} filePath - 目标文件路径。
 * @param {string} [boundary] - 非仓库目标的目录搜索边界。
 */
export async function loadSpecCandidates(filePath, boundary) {
  const dir = dirname(resolve(filePath))
  let stop = boundary === undefined ? undefined : resolve(boundary)
  if (stop !== undefined && isOutside(stop, dir)) stop = dir
  const chain = []
  const globalPath = dshHomePath(SPEC_FILENAME)
  const global = await readSpec(globalPath, {
    kind: 'user',
    base: dirname(globalPath),
    scope: null,
    depth: 0,
  })
  if (global !== undefined) chain.push(global)

  // 仓库根可以位于会话工作目录之上，项目规则仍以真实仓库根为准。
  const root = await findProjectRoot(dir, stop)
  if (root !== undefined) chain.push(...await loadProjectSpecs(root))
  const dirs = []
  let current = dir
  for (;;) {
    dirs.unshift(current)
    if (current === root) break
    const parent = dirname(current)
    if (parent === current) break
    current = parent
  }
  for (let depth = 0; depth < dirs.length; depth += 1) {
    const directory = dirs[depth]
    const spec = await readSpec(join(directory, SPEC_FILENAME), {
      kind: 'directory',
      base: directory,
      scope: directory,
      depth,
    })
    if (spec !== undefined) chain.push(spec)
  }
  // 规则目录本身也是目标的祖先目录时，同一路径可能被发现两次。
  // 保留先发现的来源，避免重复编号，并沿用项目或用户来源的匹配基准。
  const seen = new Set()
  return chain.filter((entry) => {
    const key = resolve(entry.path)
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

/** 优先级相同时，按用户、项目、目录从浅到深的顺序合并。 */
function compareSpecs(a, b) {
  const aPriority = Number.isFinite(a.priority) ? a.priority : 0
  const bPriority = Number.isFinite(b.priority) ? b.priority : 0
  if (aPriority !== bPriority) return aPriority - bPriority
  const ranks = { user: 0, project: 1, directory: 2 }
  const rankDifference = (ranks[a.kind] ?? 1) - (ranks[b.kind] ?? 1)
  if (rankDifference !== 0) return rankDifference
  const depthDifference = (a.depth ?? 0) - (b.depth ?? 0)
  if (depthDifference !== 0) return depthDifference
  return a.path < b.path ? -1 : a.path > b.path ? 1 : 0
}

/**
 * 逐份筛选规则，再按优先级合并。inherit: false 清除此前已经命中的规则。
 * review 独立于规则筛选，决定目标是否允许进入审查。
 */
export function resolveSpecChain(candidates, filePath) {
  const ordered = [...candidates].sort(compareSpecs)
  const chain = []
  for (const entry of ordered) {
    if (!createIncludeMatcher(entry)(filePath)) continue
    if (entry.inherit === false) chain.length = 0
    chain.push(entry)
  }
  return { chain, review: createReviewMatcher(ordered)(filePath) }
}

/** 发现并解析一个目标文件的规范。 */
export async function resolveSpec(filePath, boundary) {
  return resolveSpecChain(await loadSpecCandidates(filePath, boundary), resolve(filePath))
}

/** 取一级标题的文字。不是一级标题时返回 undefined，空标题返回空串。 */
function h1Text(line) {
  const match = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?[ \t]*$/.exec(line)
  if (match === null || match[1].length !== 1) return undefined
  // 结尾的 # 序列是可选闭合记号，不算标题文字。
  return (match[2] ?? '').replace(/[ \t]+#+[ \t]*$/, '').trim()
}

/**
 * 把正文拆成行，并标出每行是否在代码围栏里。围栏的开始行和结束行都算
 * 在围栏内，未闭合的围栏一直标到全文最后一行。
 * @param {string} content
 * @returns {{ lines: string[], fenced: boolean[] }}
 */
function markFencedLines(content) {
  const lines = content.split('\n')
  const fenced = new Array(lines.length).fill(false)
  for (const span of fenceSpans(lines)) fenced.fill(true, span.start, span.end + 1)
  return { lines, fenced }
}

/**
 * 把规范链整理成全局连续的规则列表，同时渲染成交给模型的文本。
 *
 * 渲染和校验共用这一份结果，模型在提示词里看到的编号就是校验时
 * 认识的编号。列表项缩进多少都参与编号，代码块里的编号原样保留。
 *
 * 规范用一级标题 # Rules 分块，只有这个章节里的编号行算规则，
 * 其余一级标题下的内容原样保留，作为理解规则的补充说明。每个来源都
 * 必须包含 # Rules，缺少时抛出 humanizeSpecError。
 *
 * @param {Array<{ path: string, content: string }>} chain
 * @returns {{ text: string, rules: Array<{ index: number, source: string, text: string }> }}
 */
export function buildSpecRules(chain) {
  const rules = []
  const sections = chain.map((entry) => {
    // 统一换行，CRLF 的行尾 \r 会让编号正则认错行。
    const content = entry.content.replace(/\r\n?/g, '\n').trim()
    const { lines, fenced } = markFencedLines(content)
    let inRules = false
    let hasRules = false
    const rendered = []
    /** 待编号的规则行，记录它在 rendered 里的位置和缩进。 */
    const candidates = []
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i]
      if (!fenced[i]) {
        const heading = h1Text(line)
        if (heading !== undefined) {
          inRules = heading === 'Rules'
          if (inRules) hasRules = true
        }
      }
      const match = !fenced[i] && inRules
        ? /^(\s*)(\d+)\.(\s+.*)$/.exec(line)
        : null
      if (match === null) {
        rendered.push(line)
        continue
      }
      candidates.push({ position: rendered.length, indent: match[1], rest: match[3] })
      rendered.push(line)
    }
    if (!hasRules) {
      const error = new Error(`PROSE.md 缺少一级标题 # Rules：${entry.path}`)
      error.humanizeSpecError = true
      throw error
    }
    for (const candidate of candidates) {
      const index = rules.length + 1
      rules.push({ index, source: entry.path, text: candidate.rest.trim() })
      rendered[candidate.position] = `${candidate.indent}${index}.${candidate.rest}`
    }
    // 用比内容里最长反引号串更长的围栏包住，保证规范里的 ## 或闭合标签
    // 留在同一段里。
    const body = rendered.join('\n')
    const fence = outerFence(body)
    return `Spec source: ${entry.path}\n${fence}\n${body}\n${fence}`
  })
  return { text: sections.join('\n\n'), rules }
}

/**
 * 把规范链渲染成一段文本，交给合并模型。
 * @param {Array<{ path: string, content: string }>} chain
 * @returns {string}
 */
export function renderSpecChain(chain) {
  return buildSpecRules(chain).text
}
