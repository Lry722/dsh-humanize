/**
 * 这个模块负责读取提示词资源。提示词放在包根的 prompts/ 目录下，
 * 调用时按照传入的名字读取对应的提示词文件。
 *
 * @module dsh-humanize/prompts
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const PROMPTS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'prompts')

/**
 * 读取一个提示词文件的内容。每次调用都读文件，编辑提示词后保存即生效。
 * @param {string} name - 提示词文件名，不带 .md 后缀。
 * @returns {string} 提示词文件的文本内容。
 */
export function loadPrompt(name) {
  return readFileSync(join(PROMPTS_DIR, `${name}.md`), 'utf8').replace(/\s+$/, '')
}
