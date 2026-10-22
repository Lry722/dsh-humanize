/**
 * 二进制文件判断。审查面向可读文本，图片、压缩包、字体和编译产物不
 * 进入审查。
 *
 * 检测交给 isbinaryfile 包。读不到文件时按文本处理，让后续读取照常
 * 报失败。
 *
 * @module dsh-humanize/binary-file
 */
import { isBinaryFile as detectBinaryFile } from 'isbinaryfile'

/**
 * 文件是否按二进制处理。
 *
 * @param {string} filePath
 * @returns {Promise<boolean>}
 */
export async function isBinaryFile(filePath) {
  try {
    return await detectBinaryFile(filePath)
  } catch {
    // 文件不存在、路径不是普通文件或没有读取权限时不下二进制结论。
    return false
  }
}
