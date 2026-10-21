/**
 * 给 client 入口打一个 chunk 版本戳。
 *
 * 宿主按入口文件的 rev 给所有 chunk 的 URL 带版本参数；只改
 * client.settings.js 或 client.progress.js 不会改变入口 rev，浏览器
 * 会继续用旧 URL。这个脚本按两个 chunk 的内容算一个短 hash，写进入口
 * 的 `// chunks:` 标记。改完 chunk 后跑一次即可。
 */
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const chunks = ['client/client.locales.js', 'client/client.settings.js', 'client/client.progress.js']
const hash = createHash('sha256')
  .update(chunks.map((file) => readFileSync(join(root, file))).join('\0'))
  .digest('hex')
  .slice(0, 8)
const entry = join(root, 'client/client.js')
const source = readFileSync(entry, 'utf8')
if (!/^\/\/ chunks: .*$/m.test(source)) throw new Error('client/client.js 缺少 "// chunks:" 标记')
writeFileSync(entry, source.replace(/^\/\/ chunks: .*$/m, `// chunks: ${hash}`))
console.log(`client chunks: ${hash}`)
