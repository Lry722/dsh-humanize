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
 * 规则编号对不上的条目会被丢弃。丢弃条数一并返回，调用方据此判断
 * 这次审查是否产出了有效批注。
 *
 * @param {unknown} parsed - 解析出的批注对象。
 * @param {Map<number, string>} rules - 规则编号到规则条文的映射。
 * @returns {{ annotations: Array<{ rule: number, ruleText: string, quote: string, problem: string, suggestion: string }>, dropped: number }}
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
      // 编号和条文都留着。编号写进暂存标题作提示，复审时以条文为准。
      rule: item.rule,
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
 * @returns {{ annotations: Array<{ rule: number, ruleText: string, quote: string, problem: string, suggestion: string }>, dropped: number }}
 */
export function parseAnnotations(text, rules) {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start === -1 || end <= start) throw new Error('review output contains no JSON object')
  return normalizeAnnotations(JSON.parse(text.slice(start, end + 1)), rules)
}

/**
 * 统计暂存 markdown 里的批注条数。只统计规则标题下面的顶层编号行，
 * 不把正文里恰好以数字开头的行算进来。
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
 * 把批注渲染成暂存 markdown。按规则分组，每条规则只复述一遍，下面逐条
 * 列出批注。规则标题带编号作提示，复审时以规则条文为准。
 *
 * 审查针对单个文件，暂存内容不写文件名。需要展示文件名的调用方自己补。
 * @param {Array<{ rule?: number, ruleText: string, quote: string, problem: string, suggestion: string }>} annotations
 * @returns {string}
 */
export function renderStaging(annotations) {
  const lines = []
  const groups = new Map()
  for (const annotation of annotations) {
    const rule = Number.isInteger(annotation.rule) ? annotation.rule : undefined
    const ruleText = oneLine(annotation.ruleText)
    // 同一条文可能来自不同编号，编号也要参与分组。
    const key = `${rule ?? ''}\u0000${ruleText}`
    const group = groups.get(key) ?? { rule, ruleText, list: [] }
    group.list.push(annotation)
    groups.set(key, group)
  }
  for (const group of groups.values()) {
    const heading = group.rule === undefined ? `## ${group.ruleText}` : `## Rule ${group.rule}: ${group.ruleText}`
    lines.push(heading.trimEnd(), '')
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
