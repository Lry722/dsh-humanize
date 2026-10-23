/**
 * 这个模块负责提供提示词。调用方拿到的是提示词文件里的文本。
 *
 * @module dsh-humanize/shared/prompts
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// 本模块位于 lib/shared，向上两级才是包根目录下的 prompts。
const PROMPTS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'prompts')

/**
 * 按提示词文件名读取对应的文件内容。
 * @param {string} name - 提示词文件名，省略 .md 后缀，由函数补全。
 * @param {Record<string, unknown>} [values] - 可选的占位符取值，用来替换文本里的 {{name}}。
 * @returns {string}
 */
export function loadPrompt(name, values) {
  const text = readFileSync(join(PROMPTS_DIR, `${name}.md`), 'utf8').replace(/\s+$/, '')
  if (values === undefined) return text
  return text.replace(/\{\{(\w+)\}\}/g, (_, key) => {
    if (!(key in values)) throw new Error(`prompt ${name} is missing a value for ${key}`)
    return String(values[key])
  })
}
