/**
 * 批注暂存。审查结果暂存为 markdown 文件，放在用户数据目录下
 * （~/.dsh/humanize/annotations/），镜像被审查文件的绝对路径，
 * 支持用户自行增改。
 *
 * @module dsh-humanize/staging
 */
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve, sep } from 'node:path'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'

const SUFFIX = '.humanize.md'

function stagingRoot() {
  return dshHomePath('humanize', 'annotations')
}

/** 把绝对路径去掉根前缀，变成可拼进暂存目录的相对段。 */
function toRelative(absPath) {
  return resolve(absPath).replace(/^([A-Za-z]:)?[\\/]+/, '')
}

/**
 * 一次审查调用的请求留档路径。镜像被审查文件的路径，每个文件只保留
 * 最近一次请求。
 * @param {string} filePath
 * @returns {string}
 */
export function requestPathFor(filePath) {
  return join(dshHomePath('humanize', 'requests'), ...toRelative(filePath).split(/[\\/]+/)) + '.request.md'
}

/**
 * 留档一次审查请求的完整内容，返回留档路径。
 * @param {string} filePath
 * @param {string} content
 * @returns {Promise<string>}
 */
export async function writeRequest(filePath, content) {
  const path = requestPathFor(filePath)
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, content, 'utf8')
  return path
}

/**
 * 一个被审查文件对应的暂存文件路径。
 * @param {string} filePath
 * @returns {string}
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

/**
 * 读一个文件的暂存批注。不存在时返回 undefined。
 * @param {string} filePath
 * @returns {Promise<string | undefined>}
 */
export async function readStaging(filePath) {
  try {
    return await readFile(stagingPathFor(filePath), 'utf8')
  } catch {
    return undefined
  }
}

/**
 * 覆写一个文件的暂存批注，返回暂存文件路径。
 * @param {string} filePath
 * @param {string} content
 * @returns {Promise<string>}
 */
export async function writeStaging(filePath, content) {
  const path = stagingPathFor(filePath)
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, content, 'utf8')
  return path
}

/**
 * 删除一个文件的暂存批注。不存在时静默成功。
 * @param {string} filePath
 */
export async function removeStaging(filePath) {
  await rm(stagingPathFor(filePath), { force: true })
}

/**
 * 收集一个路径范围内的全部暂存批注。路径是文件时只收集这一个文件
 * （不论文件本身是否还在，只看有没有对应暂存）；是目录时递归收集
 * 目录下所有有批注的文件。
 * @param {string} targetPath - 文件或目录的绝对路径。
 * @returns {Promise<Array<{ filePath: string, stagingPath: string, content: string }>>}
 */
export async function collectStaged(targetPath) {
  const abs = resolve(targetPath)
  const fileStaging = stagingPathFor(abs)
  try {
    const content = await readFile(fileStaging, 'utf8')
    return [{ filePath: abs, stagingPath: fileStaging, content }]
  } catch {
    // 没有单个文件的暂存，按目录处理
  }
  const results = []
  await walk(join(stagingRoot(), ...toRelative(abs).split(/[\\/]+/)), results)
  results.sort((a, b) => (a.filePath < b.filePath ? -1 : 1))
  return results
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
