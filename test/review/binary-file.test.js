/**
 * 二进制文件判断的单元测试。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isBinaryFile } from '../../lib/review/binary-file.js'

async function withTempFile(content) {
  const dir = await mkdtemp(join(tmpdir(), 'humanize-binary-'))
  const file = join(dir, 'sample')
  await writeFile(file, content)
  return { file, cleanup: () => rm(dir, { recursive: true, force: true }) }
}

test('纯文本文件识别为文本', async () => {
  const { file, cleanup } = await withTempFile('普通中文、English 和 123。\n')
  try {
    assert.equal(await isBinaryFile(file), false)
  } finally {
    await cleanup()
  }
})

test('图片这类带 NUL 字节的文件识别为二进制', async () => {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d])
  const { file, cleanup } = await withTempFile(png)
  try {
    assert.equal(await isBinaryFile(file), true)
  } finally {
    await cleanup()
  }
})

test('控制字符占比高的文件识别为二进制', async () => {
  const { file, cleanup } = await withTempFile(Buffer.from([0x01, 0x02, 0x03, 0x04, 0x05, 0x41, 0x42, 0x43, 0x44, 0x45]))
  try {
    assert.equal(await isBinaryFile(file), true)
  } finally {
    await cleanup()
  }
})

test('带 UTF-16 BOM 的文本识别为文本', async () => {
  const { file, cleanup } = await withTempFile(Buffer.concat([
    Buffer.from([0xff, 0xfe]),
    Buffer.from('写给人看的文档。', 'utf16le'),
  ]))
  try {
    assert.equal(await isBinaryFile(file), false)
  } finally {
    await cleanup()
  }
})

test('空文件识别为文本', async () => {
  const { file, cleanup } = await withTempFile('')
  try {
    assert.equal(await isBinaryFile(file), false)
  } finally {
    await cleanup()
  }
})

test('读取失败的文件识别为文本', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'humanize-binary-missing-'))
  try {
    assert.equal(await isBinaryFile(join(dir, 'missing.md')), false)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
