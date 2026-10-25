/**
 * 给 client 入口打一个 chunk 版本戳。
 *
 * 宿主按入口文件的 rev 给所有 chunk 的 URL 带版本参数。只动
 * client.settings.js 或 client.progress.js 时，入口 rev 保持旧值，浏览器
 * 仍会请求旧 URL。这个脚本把 client.locales.js、client.settings.js 和
 * client.progress.js 三个 chunk 的内容算成一个短 hash，写进入口的
 * `// chunks:` 标记。改完 chunk 后跑一次即可。
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
