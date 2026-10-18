/**
 * 提示词资源加载。提示词放在包根的 prompts/ 目录下，按名读取，
 * 每次调用都重新读文件：编辑 prompts/ 里的资源后，下一次审查或合并
 * 直接使用新内容，不需要重启会话。
 *
 * @module dsh-humanize/prompts
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const PROMPTS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'prompts')

/**
 * 读一份提示词资源，去掉末尾空白，保持与原内联模板字面量一致。
 * @param {string} name - prompts/ 下的文件名，不含 .md 后缀。
 * @returns {string}
 */
export function loadPrompt(name) {
  return readFileSync(join(PROMPTS_DIR, `${name}.md`), 'utf8').replace(/\s+$/, '')
}
