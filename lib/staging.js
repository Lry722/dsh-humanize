/**
 * 批注暂存。批注保存为 markdown 文件，按被审查文件路径组织，
 * 用户可以自行增改。储存根可通过设置页的 storageDir 修改，
 * 默认在用户数据目录下。
 *
 * @module dsh-humanize/staging
 */
import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join, resolve, sep } from 'node:path'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'

const SUFFIX = '.humanize.md'

/** 储存位置解析器，插件加载时注入，设置页改动实时生效。 */
let resolveStorageRoot = () => ''

/** 设置储存位置解析器。返回空字符串表示使用默认位置。 */
export function setStorageRootResolver(resolveRoot) {
  resolveStorageRoot = resolveRoot
}

/** humanize 数据的储存根。 */
export function humanizeRoot() {
  const custom = resolveStorageRoot()
  return typeof custom === 'string' && custom.trim().length > 0
    ? resolve(custom.trim())
    : dshHomePath('humanize')
}

function stagingRoot() {
  return join(humanizeRoot(), 'annotations')
}

/** 把绝对路径去掉根前缀，变成可拼进暂存目录的相对段。 */
function toRelative(absPath) {
  return resolve(absPath).replace(/^([A-Za-z]:)?[\\/]+/, '')
}

/**
 * 一次审查调用的请求留档路径。镜像被审查文件的路径，每个文件只保留
 * 最近一次请求。
 */
function requestPathFor(filePath) {
  return join(humanizeRoot(), 'requests', ...toRelative(filePath).split(/[\\/]+/)) + '.request.md'
}

/** 留档一次审查请求的完整内容。 */
export async function writeRequest(filePath, content) {
  const path = requestPathFor(filePath)
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, content, 'utf8')
  return path
}

/**
 * 一个被审查文件对应的暂存文件路径。暂存文件放在储存根的
 * annotations/ 下，路径镜像被审查文件的绝对路径。
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

/** 读被审查文件的暂存批注。不存在时返回 undefined。 */
export async function readStaging(filePath) {
  try {
    return await readFile(stagingPathFor(filePath), 'utf8')
  } catch {
    return undefined
  }
}

/** 创建缺失目录后覆写暂存批注，并返回暂存文件路径。 */
export async function writeStaging(filePath, content) {
  const path = stagingPathFor(filePath)
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, content, 'utf8')
  return path
}

/** 删除一个文件的暂存批注。不存在时静默成功。 */
export async function removeStaging(filePath) {
  await rm(stagingPathFor(filePath), { force: true })
}

/**
 * 收集路径范围内的全部暂存批注。源文件已删除的暂存是孤儿，
 * 收集时清掉，不参与合并。
 */
export async function collectStaged(targetPath) {
  const abs = resolve(targetPath)
  const fileStaging = stagingPathFor(abs)
  // 路径是文件时只收集这一个文件，判断依据是是否存在对应的暂存文件。
  try {
    const content = await readFile(fileStaging, 'utf8')
    if (await stat(abs).catch(() => undefined) === undefined) {
      await removeStaging(abs).catch(() => undefined)
      return []
    }
    return [{ filePath: abs, stagingPath: fileStaging, content }]
  } catch {
    // 没有单个文件的暂存，按目录处理
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
        // 读取失败的暂存文件跳过
      }
    }
  }
}
