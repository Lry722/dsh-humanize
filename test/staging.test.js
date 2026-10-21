import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  humanizeRoot,
  setRequestRootResolver,
  setStorageRootResolver,
  writeRequest,
} from '../lib/staging.js'

test('storageDir 里的 ~ 会展开成用户目录', () => {
  setStorageRootResolver(() => '~/humanize-test')
  try {
    assert.equal(humanizeRoot(), join(homedir(), 'humanize-test'))
  } finally {
    setStorageRootResolver(() => '')
  }
})

test('审查请求留档写到指定的临时目录', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'humanize-requests-'))
  setRequestRootResolver(() => dir)
  try {
    const path = await writeRequest('/proj/docs/a.md', 'request body')
    assert.ok(path.startsWith(dir))
    assert.equal(await readFile(path, 'utf8'), 'request body')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
