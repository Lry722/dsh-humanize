/**
 * 批注暂存。批注保存为 markdown 文件，按被审查文件路径组织，用户
 * 可以自行增改。
 *
 * @module dsh-humanize/staging
 */
import { readdir, readFile, rm, stat } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'

const SUFFIX = '.humanize.md'

/** 保存位置由外部提供，每次取用时都读取当前的设置。 */
let resolveStorageRoot = () => ''

/** 传入一个返回保存位置路径的函数，之后每次取用保存位置都会调用它。 */
export function setStorageRootResolver(next) {
  resolveStorageRoot = next
}

/** humanize 数据的保存位置，默认放在用户数据目录下。 */
export function humanizeRoot() {
  // 解析函数返回空字符串时使用默认保存位置。
  const custom = resolveStorageRoot()
  return typeof custom === 'string' && custom.trim().length > 0
    ? resolve(custom.trim())
    : dshHomePath('humanize')
}

function stagingRoot() {
  return join(humanizeRoot(), 'annotations')
}

/** 把绝对路径转成相对路径段，供暂存目录和请求留档目录拼接使用。 */
function toRelative(absPath) {
  return resolve(absPath).replace(/^([A-Za-z]:)?[\\/]+/, '')
}

/**
 * 一次审查请求在请求留档目录下的路径，目录结构与被审查文件的绝对
 * 路径保持一致。
 */
function requestPathFor(filePath) {
  return join(humanizeRoot(), 'requests', ...toRelative(filePath).split(/[\\/]+/)) + '.request.md'
}

/** 写入一次审查请求的留档并返回留档路径。 */
export async function writeRequest(filePath, content) {
  const path = requestPathFor(filePath)
  await writeFileAtomic(path, content, { mode: 0o600 })
  return path
}

/**
 * 一个被审查文件对应的暂存文件路径，目录结构与被审查文件的绝对路径
 * 保持一致。
 */
export function stagingPathFor(filePath) {
  return join(stagingRoot(), ...toRelative(filePath).split(/[\\/]+/)) + SUFFIX
}

/** 从暂存文件路径还原被审查文件的绝对路径。 */
function filePathFromStaging(stagingPath) {
  const rel = stagingPath.slice(stagingRoot().length).replace(/^[\\/]+/, '')
  const body = rel.slice(0, rel.length - SUFFIX.length)
  const segments = body.split(/[\\/]+/)
  if (/^[A-Za-z]:$/.test(segments[0])) return segments.join(sep)
  return sep + segments.join(sep)
}

/** 读取被审查文件的暂存批注，缺失时返回 undefined。 */
export async function readStaging(filePath) {
  try {
    return await readFile(stagingPathFor(filePath), 'utf8')
  } catch {
    return undefined
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
 * 收集路径范围内的全部暂存批注。被审查文件已删除的暂存批注是孤儿，
 * 收集时直接清掉。
 */
export async function collectStaged(targetPath) {
  const abs = resolve(targetPath)
  const fileStaging = stagingPathFor(abs)
  // 读到了对应的暂存文件，说明这条路径是文件，只收集这一个。
  try {
    const content = await readFile(fileStaging, 'utf8')
    if (await stat(abs).catch(() => undefined) === undefined) {
      // 原文件已经被删掉，顺手清掉它留下的暂存。
      await removeStaging(abs).catch(() => undefined)
      return []
    }
    return [{ filePath: abs, stagingPath: fileStaging, content }]
  } catch {
    // 单文件形式的暂存找不到时，就把它当成目录来处理。
  }
  const results = []
  // 路径是目录时，递归收集目录下所有有批注的文件。
  await walk(join(stagingRoot(), ...toRelative(abs).split(/[\\/]+/)), results)
  const alive = []
  for (const item of results) {
    if (await stat(item.filePath).catch(() => undefined) === undefined) {
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
  } catch {
    return
  }
  for (const entry of entries) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      await walk(full, results)
    } else if (entry.isFile() && entry.name.endsWith(SUFFIX)) {
      try {
        results.push({ filePath: filePathFromStaging(full), stagingPath: full, content: await readFile(full, 'utf8') })
      } catch {
        // 暂存文件可能刚被用户删掉，跳过即可
      }
    }
  }
}
