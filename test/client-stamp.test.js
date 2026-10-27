/**
 * client 入口版本戳的测试。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
// chunk 内容变化后必须重新运行生成版本戳的脚本，否则浏览器会继续用带旧版本参数的 chunk URL。
const chunks = [
  'client/client.locales.js',
  'client/client.settings.js',
  'client/client.progress.js',
  'client/client.turn-output.js',
]

test('入口文件的版本戳与 chunk 内容一致', async () => {
  const contents = await Promise.all(chunks.map((file) => readFile(join(root, file))))
  // 与 scripts/stamp-client.mjs 的算法保持一致。
  const hash = createHash('sha256').update(contents.join('\0')).digest('hex').slice(0, 8)
  const entry = await readFile(join(root, 'client/client.js'), 'utf8')
  const marker = /^\/\/ chunks: ([0-9a-f]{8})$/m.exec(entry)
  assert.ok(marker, 'client/client.js 缺少 "// chunks:" 标记，请运行 npm run stamp:client')
  assert.equal(
    marker[1],
    hash,
    `client/client.js 的版本戳已过期（记录 ${marker[1]}，实际 ${hash}），请运行 npm run stamp:client`,
  )
})
