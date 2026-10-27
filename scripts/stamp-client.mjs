/**
 * 给 client 入口打一个 chunk 版本戳。
 *
 * 宿主按入口文件的 rev 给所有 chunk 的 URL 带版本参数。只修改某个
 * chunk 时，入口 rev 保持旧值，浏览器仍会请求旧 URL。
 *
 * 这个脚本把 locales、settings、progress 和 turn-output chunk 的内容算成
 * 一个短 hash，写进入口的 `// chunks:` 标记。改完 chunk 后跑一次即可。
 */
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const chunks = [
  'client/client.locales.js',
  'client/client.settings.js',
  'client/client.progress.js',
  'client/client.turn-output.js',
]
// 版本戳只按文本内容计算。计算前会先把 dev/master worktree 的 CRLF 行尾统一成 LF。
const contents = chunks.map((file) => readFileSync(join(root, file), 'utf8').replace(/\r\n/g, '\n'))
const hash = createHash('sha256').update(contents.join('\0')).digest('hex').slice(0, 8)
const entry = join(root, 'client/client.js')
const source = readFileSync(entry, 'utf8')
if (!/^\/\/ chunks: .*$/m.test(source)) throw new Error('client/client.js 缺少 "// chunks:" 标记')
writeFileSync(entry, source.replace(/^\/\/ chunks: .*$/m, `// chunks: ${hash}`))
console.log(`client chunks: ${hash}`)
