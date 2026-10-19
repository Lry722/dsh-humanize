/**
 * 批注的解析与渲染。审查模型输出的是 JSON 批注列表，这里解析成内部
 * 结构，并渲染成暂存 markdown。解析依赖规范渲染文本里的编号映射，
 * 编号随规范编辑失效，批注只存条文。
 *
 * @module dsh-humanize/annotations
 */

/**
 * 把解析出的批注对象规范化成内部结构。用同一份规范快照把编号解析回
 * 条文。工具调用和文本 JSON 两种输出路径共用这份规范化。
 * @param {unknown} parsed - 解析出的 { annotations } 对象。
 * @param {Map<number, string>} rules - parseSpecRules 的编号到条文映射。
 * @returns {Array<{ ruleText: string | null, quote: string, problem: string, suggestion: string }>}
 */
export function normalizeAnnotations(parsed, rules) {
  const list = parsed?.annotations
  if (!Array.isArray(list)) throw new Error('review output misses the annotations array')
  return list
    .filter((item) => item !== null && typeof item === 'object')
    .map((item) => {
      const rule = typeof item.rule === 'number' ? item.rule : null
      return {
        ruleText: rule === null ? null : rules.get(rule) ?? null,
        quote: typeof item.quote === 'string' ? item.quote : '',
        problem: typeof item.problem === 'string' ? item.problem : '',
        suggestion: typeof item.suggestion === 'string' ? item.suggestion : '',
      }
    })
}

/**
 * 从审查输出中解析批注列表，容忍模型多输出的前后缀文字。模型没有走
 * 工具调用、直接输出文本 JSON 时走这条兜底路径。
 * @param {string} text - 审查模型的完整文本输出。
 * @param {Map<number, string>} rules - parseSpecRules 的编号到条文映射。
 * @returns {Array<{ ruleText: string | null, quote: string, problem: string, suggestion: string }>}
 */
export function parseAnnotations(text, rules) {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start === -1 || end <= start) throw new Error('review output contains no JSON object')
  return normalizeAnnotations(JSON.parse(text.slice(start, end + 1)), rules)
}

/**
 * 数一份暂存 markdown 里的批注条目数。条目是 renderStaging 渲染的
 * 顶格编号行，格式知识收敛在这一个模块里。暂存文件允许用户编辑，
 * 数字只做展示用。
 * @param {string} content
 * @returns {number}
 */
export function countAnnotations(content) {
  return content.match(/^\d+\. /gm)?.length ?? 0
}

/**
 * 把批注渲染成暂存 markdown。按规则条文分组，每条规则只复述一遍，
 * 下面列出违规内容。文件内容就是合并时的批注依据，用户可以直接编辑。
 * @param {string} filePath
 * @param {Array<{ ruleText: string | null, quote: string, problem: string, suggestion: string }>} annotations
 * @returns {string}
 */
export function renderStaging(filePath, annotations) {
  const lines = [
    `# ${filePath}`
  ]
  const groups = new Map()
  for (const annotation of annotations) {
    const key = annotation.ruleText ?? ''
    const group = groups.get(key) ?? []
    group.push(annotation)
    groups.set(key, group)
  }
  for (const [ruleText, list] of groups) {
    lines.push(ruleText === '' ? '## 未对应具体条目' : `## ${ruleText}`, '')
    list.forEach((annotation, index) => {
      lines.push(`${index + 1}. 「${annotation.quote}」`)
      if (annotation.problem.length > 0) lines.push(`   - 问题：${annotation.problem}`)
      if (annotation.suggestion.length > 0) lines.push(`   - 建议：${annotation.suggestion}`)
    })
    lines.push('')
  }
  return lines.join('\n')
}
