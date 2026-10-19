/**
 * 斜杠命令的公共辅助。
 *
 * @module dsh-humanize/command
 */
import { resolve } from 'node:path'

/**
 * 解析命令的路径参数。留空时用会话工作目录。
 * @param {import('@deepseek-ai/dsh-agent').Agent} agent
 * @param {string} rawInput
 * @returns {string}
 */
export function resolveCommandTarget(agent, rawInput) {
  const cwd = agent.session.header.cwd ?? process.cwd()
  return rawInput.trim().length > 0 ? resolve(cwd, rawInput.trim()) : cwd
}
