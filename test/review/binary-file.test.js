/**
 * 二进制文件判断的单元测试。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isBinaryFile } from '../../lib/review/binary-file.js'

test('读取失败的文件识别为文本', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'humanize-binary-missing-'))
  try {
    assert.equal(await isBinaryFile(join(dir, 'missing.md')), false)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
