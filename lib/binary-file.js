/**
 * 二进制文件判断。审查面向可读文本，图片、压缩包、字体和编译产物不
 * 进入审查。
 *
 * 判断只看文件开头的样本。带文本 BOM 的按文本处理，出现 NUL 字节的
 * 按二进制处理，控制字符占比超过一成的也按二进制处理。读不到文件时
 * 按文本处理，让后续读取照常报失败。
 *
 * @module dsh-humanize/binary-file
 */
import { open } from 'node:fs/promises'

/** 采样大小。常见的二进制格式在开头几个字节里就能认出来。 */
const SAMPLE_BYTES = 512
/** 控制字符占比超过这个百分比就按二进制处理。 */
const CONTROL_RATIO_PERCENT = 10

/**
 * 文件是否按二进制处理。
 *
 * @param {string} filePath
 * @returns {Promise<boolean>}
 */
export async function isBinaryFile(filePath) {
  let handle
  try {
    handle = await open(filePath, 'r')
  } catch {
    // 文件不存在或没有读取权限时不下二进制结论，交给后续读取报错。
    return false
  }
  try {
    const sample = Buffer.alloc(SAMPLE_BYTES)
    const { bytesRead } = await handle.read(sample, 0, SAMPLE_BYTES, 0)
    return isBinarySample(sample.subarray(0, bytesRead))
  } finally {
    await handle.close()
  }
}

/**
 * 带文本 BOM 的文件按文本处理，UTF-16 和 UTF-32 的正文里也有 NUL 字节。
 *
 * @param {Buffer} bytes
 * @returns {boolean}
 */
function hasTextBom(bytes) {
  return (
    (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) // UTF-8
    || (bytes[0] === 0xfe && bytes[1] === 0xff) // UTF-16 BE
    || (bytes[0] === 0xff && bytes[1] === 0xfe) // UTF-16 LE，也覆盖 UTF-32 LE
    || (bytes[0] === 0x00 && bytes[1] === 0x00 && bytes[2] === 0xfe && bytes[3] === 0xff) // UTF-32 BE
  )
}

/**
 * @param {Buffer} bytes
 * @returns {boolean}
 */
function isBinarySample(bytes) {
  if (bytes.length === 0) return false
  if (hasTextBom(bytes)) return false
  let controls = 0
  for (const byte of bytes) {
    if (byte === 0) return true
    // 制表、换行、换页、回车和 ESC 在文本里常见，其余 C0 控制字符算可疑。
    if (byte < 0x20 && byte !== 0x09 && byte !== 0x0a && byte !== 0x0c && byte !== 0x0d && byte !== 0x1b) {
      controls += 1
    }
  }
  return controls * 100 > bytes.length * CONTROL_RATIO_PERCENT
}
