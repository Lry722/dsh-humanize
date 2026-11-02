/**
 * 批注的解析与渲染。审查模型的输出是 JSON 批注列表，这里规范化成
 * 内部结构，并渲染成暂存 markdown。
 *
 * @module dsh-humanize/review/annotations
 */
import { oneLine } from '../shared/text.js'

/**
 * 把解析出的批注对象规范化成内部结构，并填入规则条文。
 *
 * 编号只用于校验当次模型输出和查找条文，批注结构里只保留规则条文。规则编号
 * 对不上的条目会被丢弃。丢弃条数一并返回，调用方据此判断这次审查是否产出了
 * 有效批注。
 *
 * @param {unknown} parsed - 解析出的批注对象。
 * @param {Map<number, string>} rules - 规则编号到规则条文的映射。
 * @returns {{ annotations: Array<{ ruleText: string, quote: string, problem: string, suggestion: string }>, dropped: number }}
 */
export function normalizeAnnotations(parsed, rules) {
  const list = parsed?.annotations
  if (!Array.isArray(list)) throw new Error('review output misses the annotations array')
  const annotations = []
  let dropped = 0
  for (const item of list) {
    if (item === null || typeof item !== 'object'
      || typeof item.rule !== 'number' || !rules.has(item.rule)) {
      dropped += 1
      continue
    }
    annotations.push({
      ruleText: oneLine(rules.get(item.rule)),
      quote: oneLine(item.quote),
      problem: oneLine(item.problem),
      suggestion: oneLine(item.suggestion),
    })
  }
  return { annotations, dropped }
}

/**
 * 从审查模型的文本输出中解析批注列表。输出里的 JSON 前后带了些文字
 * 时也能解析。
 * @param {string} text - 审查模型的完整文本输出。
 * @param {Map<number, string>} rules - 规则编号到规则条文的映射。
 * @returns {{ annotations: Array<{ ruleText: string, quote: string, problem: string, suggestion: string }>, dropped: number }}
 */
export function parseAnnotations(text, rules) {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start === -1 || end <= start) throw new Error('review output contains no JSON object')
  return normalizeAnnotations(JSON.parse(text.slice(start, end + 1)), rules)
}

/**
 * 统计暂存 markdown 里的批注条数。只统计规则标题下面的顶层编号行，
 * 跳过正文里恰好以数字开头的行。
 * @param {string} content
 * @returns {number}
 */
export function countAnnotations(content) {
  let inRule = false
  let count = 0
  for (const line of content.split('\n')) {
    if (/^##\s/.test(line)) {
      inRule = true
    } else if (inRule && /^\d+\.\s+\S/.test(line)) {
      count += 1
    }
  }
  return count
}

/**
 * 按规则条文把已有暂存分派给审查分片。每个分组只进入第一个匹配规则的
 * 分片，避免多个分片各自保留一次。无法匹配当前规则的正文标记为孤立内容，
 * 调用方可以在成功替换暂存前提醒用户。
 *
 * 这里只识别暂存的二级标题，不解析单条批注。引用原文是否仍存在仍由收到
 * 该分组的审查模型判断，保持单次审查和分片审查的保留语义一致。
 *
 * @param {string | undefined} existing
 * @param {Array<{ index: number, text: string }>} rules - 完整规范链里的规则。
 * @returns {{ byRule: Map<number, string>, orphaned: boolean }}
 */
export function partitionExistingAnnotations(existing, rules) {
  const byRule = new Map()
  let orphaned = false
  if (existing === undefined || existing.trim() === '') return { byRule, orphaned }

  const ruleByText = new Map()
  for (const rule of rules) {
    const text = oneLine(rule.text)
    if (!ruleByText.has(text)) ruleByText.set(text, rule.index)
  }

  const sections = []
  let current = { heading: undefined, lines: [] }
  for (const line of existing.split('\n')) {
    const heading = /^##[ \t]+(.*)$/.exec(line)
    if (heading !== null) {
      sections.push(current)
      current = { heading: oneLine(heading[1]), lines: [line] }
    } else {
      current.lines.push(line)
    }
  }
  sections.push(current)

  for (const section of sections) {
    if (!section.lines.some((line) => line.trim() !== '')) continue
    const index = ruleByText.get(section.heading)
    const body = section.lines.join('\n')
    if (index === undefined) {
      orphaned = true
      continue
    }
    const previous = byRule.get(index)
    byRule.set(index, previous === undefined ? body : `${previous}\n\n${body}`)
  }
  return { byRule, orphaned }
}

/**
 * 把批注渲染成暂存 markdown。按完整规则条文分组，每条规则只复述一遍，
 * 下面逐条列出批注。暂存里省略全局编号，复审时按规则条文匹配。
 *
 * 审查针对单个文件，暂存内容省略文件名。需要展示文件名的调用方自己补。
 * @param {Array<{ ruleText: string, quote: string, problem: string, suggestion: string }>} annotations
 * @returns {string}
 */
export function renderStaging(annotations) {
  const lines = []
  const groups = new Map()
  for (const annotation of annotations) {
    const ruleText = oneLine(annotation.ruleText)
    const group = groups.get(ruleText) ?? { ruleText, list: [] }
    group.list.push(annotation)
    groups.set(ruleText, group)
  }
  for (const group of groups.values()) {
    lines.push(`## ${group.ruleText}`.trimEnd(), '')
    group.list.forEach((annotation, index) => {
      lines.push(`${index + 1}. "${oneLine(annotation.quote)}"`)
      const problem = oneLine(annotation.problem)
      const suggestion = oneLine(annotation.suggestion)
      if (problem.length > 0) lines.push(`   - Problem: ${problem}`)
      if (suggestion.length > 0) lines.push(`   - Suggestion: ${suggestion}`)
    })
    lines.push('')
  }
  return lines.join('\n')
}
