/**
 * 审查目标的展开。审查范围先限定在受 git 管理的文件，再要求文件命中
 * 各级规范声明的 include 模式。
 *
 * @module dsh-humanize/git-files
 */
import { execFile } from 'node:child_process'
import { stat } from 'node:fs/promises'
import { basename, dirname, resolve } from 'node:path'
import { promisify } from 'node:util'
import { createSpecMatcher, declaresInclude } from './spec-match.js'
import { loadSpecChain } from './specs.js'

const execFileAsync = promisify(execFile)

/**
 * 展开待审文件，只保留 git 仓库里、并且命中规范链 include 模式的文件。
 * 目标是目录时，结果按路径排序。
 * @param {string} target
 * @param {string | undefined} boundary
 * @returns {Promise<string[]>}
 */
export async function collectTargets(target, boundary) {
  const st = await stat(target).catch(() => undefined)
  if (st === undefined) throw new Error(`路径不存在：${target}`)
  if (st.isFile()) {
    const tracked = await isGitTracked(target)
    return tracked && await includeDeclared(target, boundary) ? [target] : []
  }
  if (st.isDirectory()) {
    const tracked = await gitTrackedFiles(target)
    const results = []
    for (const file of tracked) {
      if (await includeDeclared(file, boundary)) results.push(file)
    }
    return results.sort()
  }
  return []
}

/**
 * 文件路径是否命中其规范链的 include 模式。规范链声明了 include 时
 * 按模式匹配判断，其余情况一律算命中。
 * @param {string} file
 * @param {string | undefined} boundary
 * @returns {Promise<boolean>}
 */
export async function includeDeclared(file, boundary) {
  const chain = await loadSpecChain(file, boundary)
  if (!declaresInclude(chain)) return true
  return createSpecMatcher(chain)(file)
}

/** 列出 git 仓库里某个目录下的文件。 */
async function gitTrackedFiles(dir) {
  try {
    const { stdout } = await execFileAsync('git', ['ls-files', '-z'], { cwd: dir, maxBuffer: 64 * 1024 * 1024 })
    return stdout.split('\0').filter((name) => name.length > 0).map((name) => resolve(dir, name))
  } catch (error) {
    throw gitError(dir, error)
  }
}

async function isGitTracked(file) {
  try {
    await execFileAsync('git', ['ls-files', '--error-unmatch', '--', basename(file)], { cwd: dirname(file) })
    return true
  } catch (error) {
    // --error-unmatch 对 git 没有跟踪的文件以退出码 1 失败，其余错误按环境问题处理。
    if (typeof error?.code === 'number' && error.code === 1) return false
    throw gitError(dirname(file), error)
  }
}

/** 把 git 调用失败翻译成面向用户的原因。 */
function gitError(dir, error) {
  // ENOENT 是 git 命令本身不存在，其余失败按目标不在仓库里处理。
  if (error?.code === 'ENOENT') return new Error('git 命令不可用，审查范围限于 git 仓库里的文件')
  return new Error(`目标不在 git 仓库中：${dir}`)
}
