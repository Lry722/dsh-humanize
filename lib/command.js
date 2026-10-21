/**
 * 斜杠命令共用的辅助函数。
 *
 * @module dsh-humanize/command
 */
import { resolve } from 'node:path'
import { expandHome, unquotePath } from './paths.js'

/**
 * 解析命令的路径参数。
 * @param {import('@deepseek-ai/dsh-agent').Agent} agent
 * @param {string} rawInput - 命令后面跟的路径，留空时用会话的工作目录。
 * @returns {string}
 */
export function resolveCommandTarget(agent, rawInput) {
  const cwd = agent.session.header.cwd ?? process.cwd()
  const raw = rawInput.trim()
  if (raw.length === 0) return cwd
  // 命令只有一条路径参数，空格是路径的一部分。引号只在整体包住时去掉。
  const path = unquotePath(raw)
  return path.length === 0 ? cwd : resolve(cwd, expandHome(path))
}
