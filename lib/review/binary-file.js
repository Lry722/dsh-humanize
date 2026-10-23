/**
 * 判断文件是不是二进制文件。审查只覆盖文本内容，图片、压缩包、字体和编译产物这类
 * 文件跳过审查。
 *
 * 读不到文件时按文本处理，让后续读取照常报错。
 *
 * @module dsh-humanize/review/binary-file
 */
import { isBinaryFile as detectBinaryFile } from 'isbinaryfile'

/**
 * 文件是否按二进制处理。判断交给 isbinaryfile 包，它按文件开头的样本
 * 识别常见的二进制格式和编码。
 *
 * @param {string} filePath
 * @returns {Promise<boolean>}
 */
export async function isBinaryFile(filePath) {
  try {
    return await detectBinaryFile(filePath)
  } catch {
    // 路径不存在、指向特殊文件或权限不足时按文本处理，由后续读取报错。
    return false
  }
}
