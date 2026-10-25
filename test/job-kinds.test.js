/**
 * 任务 kind 的一致性测试。宿主端在 lib/shared/job-track.js 里定义，
 * 浏览器端在 client/client.progress.js 里另写一份字面量，两边靠这里对齐。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { JOB_KINDS } from '../lib/shared/job-track.js'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

test('客户端筛选的任务 kind 与宿主端一致', async () => {
  const source = await readFile(join(root, 'client/client.progress.js'), 'utf8')
  const object = /const KIND = \{([^}]*)\}/.exec(source)
  assert.ok(object, 'client/client.progress.js 缺少 KIND 常量')
  const clientKinds = [...object[1].matchAll(/'([^']+)'/g)].map((match) => match[1])
  assert.deepEqual(clientKinds, [...JOB_KINDS], '客户端与宿主端的任务 kind 已漂移')
})
