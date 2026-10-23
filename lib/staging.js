/**
 * 批注暂存。批注保存为 markdown 文件，按被审查文件路径组织，用户
 * 可以自己增加或修改内容。
 *
 * @module dsh-humanize/staging
 */
import { randomUUID } from 'node:crypto'
import { readdir, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, parse, resolve, sep } from 'node:path'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import { expandHome } from './paths.js'

const SUFFIX = '.humanize.md'

/** 保存位置由外部提供，每次取用时都读取当前的设置。 */
let resolveStorageRoot = () => ''
/** 审查请求留档的位置。默认放系统临时目录，与用户数据目录分开。 */
let resolveRequestRoot = () => join(tmpdir(), `dsh-humanize-${process.getuid?.() ?? 'user'}`, 'requests')

/** 传入一个返回保存位置路径的函数，之后每次取用保存位置都会调用它。 */
export function setStorageRootResolver(next) {
  resolveStorageRoot = next
}

/** 传入一个返回请求留档目录的函数，主要供测试隔离使用。 */
export function setRequestRootResolver(next) {
  resolveRequestRoot = next
}

/** 审查请求留档的目录，每次取用时重新读取。 */
export function requestRoot() {
  return resolveRequestRoot()
}

/** 合并请求临时文件放在请求留档目录同级的 merge 目录。 */
function mergeRoot() {
  return join(dirname(requestRoot()), 'merge')
}

/** 把一次合并请求写到临时文件，返回路径。合并子代理自己分段读取。 */
export async function writeMergeRequest(content) {
  const path = join(mergeRoot(), `${randomUUID()}.merge.md`)
  await writeFileAtomic(path, content, { mode: 0o600, dirMode: 0o700 })
  return path
}

export async function removeMergeRequest(path) {
  await rm(path, { force: true })
}

/** humanize 数据的保存位置，默认放在用户数据目录下。 */
export function humanizeRoot() {
  // 解析函数返回空字符串时使用默认保存位置。相对路径按进程工作目录解析。
  const custom = resolveStorageRoot()
  return typeof custom === 'string' && custom.trim().length > 0
    ? resolve(expandHome(custom.trim()))
    : dshHomePath('humanize')
}

/** 暂存批注的目录。 */
export function stagingRoot() {
  return join(humanizeRoot(), 'annotations')
}

/** 把绝对路径转成相对路径段，供暂存目录和请求留档目录拼接使用。 */
function toRelative(absPath) {
  const abs = resolve(absPath)
  const root = parse(abs).root
  const rest = abs.slice(root.length).split(/[\\/]+/).filter((segment) => segment.length > 0)
  // Windows 盘符单独占一段，避免 C:\a 和 D:\a 落到同一个目录。
  if (/^[A-Za-z]:[\\/]?$/.test(root)) rest.unshift(root[0].toUpperCase())
  // UNC 路径保留服务器和共享名，编码成 _unc/server/share/...。
  else if (root.startsWith('\\\\')) rest.unshift('_unc', ...root.slice(2).split(/[\\/]+/).filter(Boolean))
  return rest.join('/')
}

/**
 * 返回一次审查请求对应的留档文件路径，目录按被审查文件的绝对路径组织。
 */
function requestPathFor(filePath) {
  return join(resolveRequestRoot(), ...toRelative(filePath).split(/[\\/]+/)) + '.request.md'
}

/** 把一次审查请求的内容写入留档文件。 */
export async function writeRequest(filePath, content) {
  const path = requestPathFor(filePath)
  await writeFileAtomic(path, content, { mode: 0o600, dirMode: 0o700 })
  return path
}

/**
 * 返回一次审查响应留档的路径，和被审查文件一一对应。
 */
function responsePathFor(filePath) {
  return join(resolveRequestRoot(), ...toRelative(filePath).split(/[\\/]+/)) + '.response.md'
}

/**
 * 把审查模型的原始响应写到请求留档旁边。审查结果解析失败时调用，
 * 用户可以直接打开看模型到底说了什么。
 * @returns {Promise<string>} 留档文件的路径。
 */
export async function writeResponse(filePath, content) {
  const path = responsePathFor(filePath)
  await writeFileAtomic(path, content, { mode: 0o600, dirMode: 0o700 })
  return path
}

/**
 * 返回被审查文件对应的暂存文件路径，目录按被审查文件的绝对路径组织。
 */
export function stagingPathFor(filePath) {
  return join(stagingRoot(), ...toRelative(filePath).split(/[\\/]+/)) + SUFFIX
}

/** 从暂存文件路径还原被审查文件的绝对路径。 */
function filePathFromStaging(stagingPath) {
  const rel = stagingPath.slice(stagingRoot().length).replace(/^[\\/]+/, '')
  const body = rel.slice(0, rel.length - SUFFIX.length)
  const segments = body.split(/[\\/]+/)
  if (process.platform === 'win32') {
    // toRelative 把盘符编码成首段单字母，UNC 路径编码成 _unc/服务器/共享名。
    if (segments[0] === '_unc') return `\\\\${segments.slice(1).join(sep)}`
    if (/^[A-Za-z]$/.test(segments[0])) return `${segments[0].toUpperCase()}:${sep}${segments.slice(1).join(sep)}`
  }
  return sep + segments.join(sep)
}

/** 读取被审查文件的暂存批注，缺失时返回 undefined。 */
export async function readStaging(filePath) {
  try {
    return await readFile(stagingPathFor(filePath), 'utf8')
  } catch (error) {
    // 仅在暂存文件确实不存在时返回 undefined。权限、句柄耗尽之类的错误
    // 直接抛出，免得调用方以为没有旧批注，覆盖掉用户手改的内容。
    if (error?.code === 'ENOENT') return undefined
    throw error
  }
}

/** 写入暂存批注并返回暂存文件路径。需要时会自动创建目录。 */
export async function writeStaging(filePath, content) {
  const path = stagingPathFor(filePath)
  await writeFileAtomic(path, content, { mode: 0o600 })
  return path
}

/** 删除一个文件的暂存批注。文件已经删掉时也按成功处理。 */
export async function removeStaging(filePath) {
  await rm(stagingPathFor(filePath), { force: true })
}

/**
 * 读取文件状态。只有 ENOENT 视为不存在。其他错误按存在处理，避免
 * 网络盘或权限抖动时把仍然有效的暂存当成孤儿删掉。
 * @param {string} path
 */
async function statOrPresent(path) {
  try {
    return await stat(path)
  } catch (error) {
    if (error?.code === 'ENOENT') return undefined
    return { unknown: true }
  }
}

/**
 * 收集路径范围内的全部暂存批注。被审查文件已删除的暂存批注是孤儿，
 * 收集时直接清掉。
 */
export async function collectStaged(targetPath) {
  const abs = resolve(targetPath)
  const fileStaging = stagingPathFor(abs)
  // 读到了对应的暂存文件，说明这条路径是文件，只收集这一个。
  try {
    const content = await readFile(fileStaging, 'utf8')
    if (await statOrPresent(abs) === undefined) {
      // 原文件没了，暂存已经没有可合并的对象，顺手清掉。
      await removeStaging(abs).catch(() => undefined)
      return []
    }
    return [{ filePath: abs, stagingPath: fileStaging, content }]
  } catch (error) {
    // 只有暂存文件确实不存在时才按目录处理。权限、句柄耗尽等错误
    // 直接抛出，避免把仍然存在的批注当成空目录。
    if (error?.code !== 'ENOENT' && error?.code !== 'EISDIR') throw error
  }
  const results = []
  // 路径是目录时，递归收集目录下所有有批注的文件。
  await walk(join(stagingRoot(), ...toRelative(abs).split(/[\\/]+/)), results)
  const alive = []
  for (const item of results) {
    if (await statOrPresent(item.filePath) === undefined) {
      await removeStaging(item.filePath).catch(() => undefined)
      continue
    }
    alive.push(item)
  }
  alive.sort((a, b) => (a.filePath < b.filePath ? -1 : 1))
  return alive
}

async function walk(dir, results) {
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch (error) {
    // 暂存目录不存在时没有可收集的内容，其余错误向上抛。
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return
    throw error
  }
  for (const entry of entries) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      await walk(full, results)
    } else if (entry.isFile() && entry.name.endsWith(SUFFIX)) {
      try {
        results.push({ filePath: filePathFromStaging(full), stagingPath: full, content: await readFile(full, 'utf8') })
      } catch (error) {
        // 暂存文件可能刚被用户删掉，跳过即可。读取失败的其他错误照常向上抛。
        if (error?.code !== 'ENOENT') throw error
      }
    }
  }
}
