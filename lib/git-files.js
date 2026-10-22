/**
 * 审查目标的展开。审查范围先限定在受 git 管理的文件，再要求文件命中
 * 各级规范声明的 include 模式。
 *
 * 默认模式审查目标范围内全部受 git 管理的文件。增量模式只审查相对 HEAD
 * 有改动的文件。最近提交模式按最近 N 个提交涉及的文件做全文重审。
 *
 * @module dsh-humanize/git-files
 */
import { execFile } from 'node:child_process'
import { stat } from 'node:fs/promises'
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import { promisify } from 'node:util'
import { createSpecMatcher, declaresInclude } from './spec-match.js'
import { loadSpecChain } from './specs.js'

const execFileAsync = promisify(execFile)
const MAX_BUFFER = 64 * 1024 * 1024

/**
 * 一个待审查文件。增量模式会带上改动前的内容，供审查管线圈出改动区段。
 * @typedef {object} ReviewTarget
 * @property {string} filePath
 * @property {string} [before] - 改动前的内容。全量审查和新文件没有这一项。
 */

/**
 * 展开待审文件，只保留 git 仓库里、并且命中规范链 include 模式的文件。
 * 目标是目录时，结果按路径排序。
 *
 * @param {string} target
 * @param {string | undefined} boundary
 * @param {{ changed?: boolean }} [options] - changed 为 true 时只收集相对 HEAD 的改动。
 * @returns {Promise<ReviewTarget[]>}
 */
export async function collectTargets(target, boundary, options = {}) {
  const st = await stat(target).catch(() => undefined)
  if (st === undefined) throw new Error(`路径不存在：${target}`)
  if (options.changed === true) return collectChangedTargets(target, st, boundary)
  if (st.isFile()) {
    const tracked = await isGitTracked(target)
    return tracked && await includeDeclared(target, boundary) ? [{ filePath: target }] : []
  }
  if (st.isDirectory()) {
    const tracked = await gitTrackedFiles(target)
    const results = []
    for (const file of tracked) {
      if (await includeDeclared(file, boundary)) results.push({ filePath: file })
    }
    return results.sort(compareTargets)
  }
  return []
}

/** 按路径排序。 */
function compareTargets(a, b) {
  if (a.filePath === b.filePath) return 0
  return a.filePath < b.filePath ? -1 : 1
}

/**
 * 收集相对 HEAD 有改动的文件。改动范围包括工作区修改、暂存但未提交的
 * 修改，以及未被 git 忽略的新文件。删除的文件没有可审查的内容，直接跳过。
 *
 * @param {string} target
 * @param {import('node:fs').Stats} st
 * @param {string | undefined} boundary
 * @returns {Promise<ReviewTarget[]>}
 */
async function collectChangedTargets(target, st, boundary) {
  const abs = resolve(target)
  const cwd = st.isDirectory() ? abs : dirname(abs)
  const root = await gitRoot(cwd)
  const rel = relative(root, abs)
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error(`目标不在 git 仓库中：${cwd}`)
  }
  const pathspec = rel === '' ? '.' : toPosix(rel)
  const names = await changedPaths(root, pathspec)
  const results = []
  for (const name of names) {
    const file = resolve(root, name)
    // 子模块和删除的文件在这里没有可读内容。
    const fileStat = await stat(file).catch(() => undefined)
    if (fileStat?.isFile() !== true) continue
    if (!await includeDeclared(file, boundary)) continue
    const before = await headContent(root, name)
    results.push({ filePath: file, ...(before !== undefined ? { before } : {}) })
  }
  return results.sort(compareTargets)
}

/**
 * 收集最近 N 个提交涉及的文件，交给审查管线按当前工作区内容全文重审。
 *
 * 提交只用来确定文件范围，不用于历史上的内容快照。范围取最近 N 个提交
 * 涉及的文件；提交数少于 N 个时退化为 HEAD 里的全部文件。当前工作区
 * 不存在的文件跳过。
 *
 * @param {string} target
 * @param {string | undefined} boundary
 * @param {number} count - 最近提交数，正整数。
 * @returns {Promise<{ targets: ReviewTarget[], skipped: Array<{ filePath: string, reason: string }> }>}
 */
export async function collectRecentTargets(target, boundary, count) {
  if (!Number.isInteger(count) || count < 1) throw new Error('--recent 需要一个正整数')
  const st = await stat(target).catch(() => undefined)
  if (st === undefined) throw new Error(`路径不存在：${target}`)
  const abs = resolve(target)
  const cwd = st.isDirectory() ? abs : dirname(abs)
  const root = await gitRoot(cwd)
  const rel = relative(root, abs)
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error(`目标不在 git 仓库中：${cwd}`)
  }
  if (!await hasHead(root)) throw new Error('仓库还没有提交，无法按最近提交审查')
  const pathspec = rel === '' ? '.' : toPosix(rel)
  const names = await recentPaths(root, count, pathspec)
  const targets = []
  const skipped = []
  for (const name of [...new Set(names)]) {
    const file = resolve(root, name)
    const fileStat = await stat(file).catch(() => undefined)
    if (fileStat === undefined) {
      skipped.push({ filePath: file, reason: '工作区缺失的文件' })
      continue
    }
    if (!fileStat.isFile()) {
      skipped.push({ filePath: file, reason: '非普通文件' })
      continue
    }
    if (!await includeDeclared(file, boundary)) continue
    targets.push({ filePath: file })
  }
  targets.sort(compareTargets)
  return { targets, skipped }
}

/**
 * 列出最近 N 个提交涉及的文件。范围起点存在时，取该起点到 HEAD 的改动；
 * 提交数不够 N 个时，取 HEAD 里的全部文件。
 *
 * @param {string} root
 * @param {number} count
 * @param {string} pathspec
 * @returns {Promise<string[]>}
 */
async function recentPaths(root, count, pathspec) {
  if (await hasAncestor(root, count)) {
    const stdout = await gitOutput([
      'diff', '--name-only', '-z', '--diff-filter=AM', '--no-renames',
      `HEAD~${count}`, 'HEAD', '--', pathspec,
    ], { cwd: root })
    return stdout.split('\0').filter((name) => name.length > 0)
  }
  const stdout = await gitOutput(['ls-tree', '-r', '-z', '--name-only', 'HEAD', '--', pathspec], { cwd: root })
  return stdout.split('\0').filter((name) => name.length > 0)
}

/** 最近 N 个提交的范围起点是否存在。 */
async function hasAncestor(root, count) {
  try {
    await execFileAsync('git', ['rev-parse', '--verify', '--quiet', `HEAD~${count}`], { cwd: root })
    return true
  } catch {
    return false
  }
}

/**
 * 列出相对 HEAD 有改动的文件，加上未跟踪且未被忽略的文件。仓库还没有
 * 第一个提交时，全部受管文件都算改动。
 *
 * @param {string} root - 仓库根目录。
 * @param {string} pathspec - 相对仓库根目录的路径范围。
 * @returns {Promise<string[]>} 相对仓库根目录的路径。
 */
async function changedPaths(root, pathspec) {
  const names = []
  if (await hasHead(root)) {
    const stdout = await gitOutput(['diff', '--name-only', '-z', 'HEAD', '--', pathspec], { cwd: root })
    names.push(...stdout.split('\0').filter((name) => name.length > 0))
  } else {
    const stdout = await gitOutput(['ls-files', '-z', '--', pathspec], { cwd: root })
    names.push(...stdout.split('\0').filter((name) => name.length > 0))
  }
  const untracked = await gitOutput(['ls-files', '--others', '--exclude-standard', '-z', '--', pathspec], { cwd: root })
  names.push(...untracked.split('\0').filter((name) => name.length > 0))
  return [...new Set(names)]
}

/** 仓库有没有第一个提交。没有时所有受管文件都按改动处理。 */
async function hasHead(root) {
  try {
    await execFileAsync('git', ['rev-parse', '--verify', '--quiet', 'HEAD'], { cwd: root })
    return true
  } catch {
    return false
  }
}

/** 读一个文件在 HEAD 里的内容。文件不在 HEAD 里时返回 undefined。 */
async function headContent(root, name) {
  try {
    const { stdout } = await execFileAsync('git', ['show', `HEAD:${name}`], { cwd: root, maxBuffer: MAX_BUFFER })
    return stdout
  } catch {
    return undefined
  }
}

/** 执行一条 git 命令并返回 stdout。失败时翻译成面向用户的原因。 */
async function gitOutput(args, options) {
  try {
    const { stdout } = await execFileAsync('git', args, { ...options, maxBuffer: MAX_BUFFER })
    return stdout
  } catch (error) {
    throw gitError(options.cwd, error)
  }
}

/** 找目录所属的 git 仓库根目录。 */
async function gitRoot(cwd) {
  const stdout = await gitOutput(['rev-parse', '--show-toplevel'], { cwd })
  return stdout.trim()
}

/** git 路径统一用斜杠。 */
function toPosix(value) {
  return value.split(sep).join('/')
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
  const stdout = await gitOutput(['ls-files', '-z'], { cwd: dir })
  return stdout.split('\0').filter((name) => name.length > 0).map((name) => resolve(dir, name))
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
