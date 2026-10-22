/**
 * 批注的解析与渲染。审查模型的输出是 JSON 批注列表，这里规范化成
 * 内部结构，并渲染成暂存 markdown。
 *
 * @module dsh-humanize/annotations
 */

/**
 * 把解析出的批注对象规范化成内部结构，并填入规则条文。
 *
 * 规则编号对不上的条目会被丢弃。丢弃条数一并返回，调用方据此判断
 * 这次审查是否产出了有效批注。
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
      // 规范快照改动之后，旧的编号会错位，所以批注里填入规则条文。
      ruleText: rules.get(item.rule),
      quote: typeof item.quote === 'string' ? item.quote : '',
      problem: typeof item.problem === 'string' ? item.problem : '',
      suggestion: typeof item.suggestion === 'string' ? item.suggestion : '',
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
 * 统计暂存 markdown 里的批注条数。批注是 renderStaging 渲染出来的
 * 编号行。
 * @param {string} content
 * @returns {number}
 */
export function countAnnotations(content) {
  return content.match(/^\d+\. /gm)?.length ?? 0
}

/**
 * 把批注渲染成暂存 markdown。按规则条文分组，每条规则条文只复述一遍，
 * 下面逐条列出批注。
 * @param {string} filePath
 * @param {Array<{ ruleText: string, quote: string, problem: string, suggestion: string }>} annotations
 * @returns {string}
 */
export function renderStaging(filePath, annotations) {
  const lines = [
    `# ${filePath}`
  ]
  const groups = new Map()
  for (const annotation of annotations) {
    const group = groups.get(annotation.ruleText) ?? []
    group.push(annotation)
    groups.set(annotation.ruleText, group)
  }
  for (const [ruleText, list] of groups) {
    lines.push(`## ${ruleText}`, '')
    list.forEach((annotation, index) => {
      lines.push(`${index + 1}. "${annotation.quote}"`)
      if (annotation.problem.length > 0) lines.push(`   - Problem: ${annotation.problem}`)
      if (annotation.suggestion.length > 0) lines.push(`   - Suggestion: ${annotation.suggestion}`)
    })
    lines.push('')
  }
  return lines.join('\n')
}
