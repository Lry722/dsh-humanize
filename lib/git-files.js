/**
 * 审查目标的展开。审查范围先限定在受 git 管理的文件，再要求文件命中
 * 各级规范声明的 include 模式。
 *
 * 默认模式审查目标范围内全部受 git 管理的文件。增量模式只审查相对 HEAD
 * 有改动的文件，以及未被 git 忽略的新文件。
 *
 * @module dsh-humanize/git-files
 */
import { execFile } from 'node:child_process'
import { readFile, stat } from 'node:fs/promises'
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
 * @property {string} [after] - 审查用的内容快照。提交模式使用；其余模式由审查管线读工作区。
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
 * 收集一次提交引入的改动文件。
 *
 * 只返回工作区内容仍与提交一致的文件。这样审查读到的工作区内容就是提交
 * 快照，批注按现有文件路径暂存时不会覆盖当前版本的批注。工作区已经前进
 * 或文件被改过的，放进 skipped，由调用方在任务说明里报告。
 *
 * @param {string} target
 * @param {string | undefined} boundary
 * @param {string} commit - 提交 ID 或引用，交给 git 解析。
 * @returns {Promise<{ targets: ReviewTarget[], skipped: Array<{ filePath: string, reason: string }> }>}
 */
export async function collectCommitTargets(target, boundary, commit) {
  const st = await stat(target).catch(() => undefined)
  if (st === undefined) throw new Error(`路径不存在：${target}`)
  const abs = resolve(target)
  const cwd = st.isDirectory() ? abs : dirname(abs)
  const root = await gitRoot(cwd)
  const rel = relative(root, abs)
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error(`目标不在 git 仓库中：${cwd}`)
  }
  const pathspec = rel === '' ? '.' : toPosix(rel)
  const sha = await resolveCommit(root, commit)
  const parent = await parentCommit(root, sha)
  const changes = await commitChanges(root, sha, parent, pathspec)
  const targets = []
  const skipped = []
  for (const change of changes) {
    const file = resolve(root, change.path)
    if (!await includeDeclared(file, boundary)) continue
    if (change.binary) {
      skipped.push({ filePath: file, reason: '二进制文件' })
      continue
    }
    const committed = await commitContent(root, sha, change.path)
    if (committed === undefined) {
      skipped.push({ filePath: file, reason: '提交内容读取失败的文件' })
      continue
    }
    const working = await readFile(file, 'utf8').catch(() => undefined)
    if (working === undefined) {
      skipped.push({ filePath: file, reason: '工作区不存在的文件' })
      continue
    }
    if (!sameText(working, committed)) {
      skipped.push({ filePath: file, reason: '工作区内容与提交不一致的文件' })
      continue
    }
    const before = parent === undefined ? undefined : await commitContent(root, parent, change.path)
    // 用工作区内容作为审查快照，行尾会和提交里的 LF 不同，但和随后
    // reviewNow 读到的内容一致，不会因为 CRLF 被当成过期内容丢弃。
    targets.push({ filePath: file, after: working, ...(before !== undefined ? { before } : {}) })
  }
  targets.sort(compareTargets)
  return { targets, skipped }
}

/**
 * 把提交 ID 解析成完整的提交哈希。解析失败时给出面向用户的原因。
 * @param {string} root
 * @param {string} name
 * @returns {Promise<string>}
 */
async function resolveCommit(root, name) {
  if (typeof name !== 'string' || name.trim() === '' || name.startsWith('-')) {
    throw new Error(`提交不存在：${name}`)
  }
  try {
    const { stdout } = await execFileAsync('git', ['rev-parse', '--verify', `${name}^{commit}`], { cwd: root })
    return stdout.trim()
  } catch (error) {
    if (error?.code === 'ENOENT') throw new Error('git 命令不可用，审查范围限于 git 仓库里的文件')
    throw new Error(`提交不存在：${name}`)
  }
}

/** 取提交的第一父提交。根提交没有父提交，返回 undefined。 */
async function parentCommit(root, sha) {
  try {
    const { stdout } = await execFileAsync('git', ['rev-parse', '--verify', `${sha}^`], { cwd: root })
    return stdout.trim()
  } catch {
    return undefined
  }
}

/**
 * 列出提交相对父提交新增或修改的文件。根提交按全部文件新增处理。
 * 二进制文件带 binary 标记返回，由调用方决定跳过。
 * @returns {Promise<Array<{ path: string, binary: boolean }>>}
 */
async function commitChanges(root, sha, parent, pathspec) {
  const args = parent === undefined
    ? ['diff-tree', '--no-commit-id', '--root', '-r', '--numstat', '-z', sha, '--', pathspec]
    : ['diff', '--numstat', '-z', '--no-renames', '--diff-filter=AM', parent, sha, '--', pathspec]
  return parseNumstat(await gitOutput(args, { cwd: root }))
}

/** 解析 git --numstat -z 的输出。路径可能含制表符，按前两个制表符切。 */
function parseNumstat(stdout) {
  const changes = []
  for (const entry of stdout.split('\0')) {
    if (entry.length === 0) continue
    const first = entry.indexOf('\t')
    const second = entry.indexOf('\t', first + 1)
    if (first < 0 || second < 0) continue
    const added = entry.slice(0, first)
    const deleted = entry.slice(first + 1, second)
    const path = entry.slice(second + 1)
    if (path.length === 0) continue
    changes.push({ path, binary: added === '-' && deleted === '-' })
  }
  return changes
}

/** 读提交里的文件内容。读不到时返回 undefined。 */
async function commitContent(root, rev, name) {
  try {
    const { stdout } = await execFileAsync('git', ['show', `${rev}:${name}`], { cwd: root, maxBuffer: MAX_BUFFER })
    return stdout
  } catch {
    return undefined
  }
}

/** 比较工作区内容和提交内容。只忽略 CRLF 差异。 */
function sameText(left, right) {
  return left.replace(/\r\n/g, '\n') === right.replace(/\r\n/g, '\n')
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
