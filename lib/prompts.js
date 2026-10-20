/**
 * 这个模块负责读取提示词文件。提示词放在包根目录下的 prompts/ 目录里，
 * 调用时按传入的名字读取。
 *
 * @module dsh-humanize/prompts
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const PROMPTS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'prompts')

/**
 * @param {string} name - 提示词文件名，不带 .md 后缀。
 * @returns {string}
 */
export function loadPrompt(name) {
  return readFileSync(join(PROMPTS_DIR, `${name}.md`), 'utf8').replace(/\s+$/, '')
}
