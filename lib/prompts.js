/**
 * 这个模块负责提供提示词。调用方拿到的是提示词文件里的文本。
 *
 * @module dsh-humanize/prompts
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const PROMPTS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'prompts')

/**
 * 按提示词文件名读取对应的文件内容。
 * @param {string} name - 提示词文件名，不带 .md 后缀。
 * @returns {string}
 */
export function loadPrompt(name) {
  return readFileSync(join(PROMPTS_DIR, `${name}.md`), 'utf8').replace(/\s+$/, '')
}
