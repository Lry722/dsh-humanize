/**
 * 斜杠命令共用的辅助函数。
 *
 * @module dsh-humanize/command
 */
import { resolve } from 'node:path'

/**
 * 解析命令的路径参数。
 * @param {import('@deepseek-ai/dsh-agent').Agent} agent
 * @param {string} rawInput - 命令后面跟的路径，留空时用会话的工作目录。
 * @returns {string}
 */
export function resolveCommandTarget(agent, rawInput) {
  const cwd = agent.session.header.cwd ?? process.cwd()
  return rawInput.trim().length > 0 ? resolve(cwd, rawInput.trim()) : cwd
}
