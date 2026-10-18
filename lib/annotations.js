/**
 * 批注的解析与渲染。审查模型输出的是 JSON 批注列表，这里解析成内部
 * 结构，并渲染成暂存 markdown。解析依赖规范渲染文本里的编号映射，
 * 编号随规范编辑失效，批注只存条文。
 *
 * @module dsh-humanize/annotations
 */

/**
 * 从审查输出中解析批注列表，容忍模型多输出的前后缀文字。模型输出
 * 的是规范快照里的编号，编号随规范编辑失效，这里用同一份快照把
 * 编号解析回条文，批注只存条文。
 * @param {string} text - 审查模型的完整文本输出。
 * @param {Map<number, string>} rules - parseSpecRules 的编号到条文映射。
 * @returns {Array<{ ruleText: string | null, quote: string, problem: string, suggestion: string }>}
 */
export function parseAnnotations(text, rules) {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start === -1 || end <= start) throw new Error('review output contains no JSON object')
  const parsed = JSON.parse(text.slice(start, end + 1))
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
 * 把批注渲染成暂存 markdown。按规则条文分组，每条规则只复述一遍，
 * 下面列出违规内容。文件内容就是合并时的批注依据，用户可以直接编辑。
 * @param {string} filePath
 * @param {Array<{ ruleText: string | null, quote: string, problem: string, suggestion: string }>} annotations
 * @returns {string}
 */
export function renderStaging(filePath, annotations) {
  const lines = [
    `# ${filePath}`,
    '',
    `> 行文批注，生成于 ${new Date().toISOString().slice(0, 19)}Z。可直接编辑本文件，合并时以本文件内容为准。`,
    '',
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
