import test from 'node:test'
import assert from 'node:assert/strict'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { humanizePaths } from '../lib/path-info.js'
import { setRequestRootResolver, setStorageRootResolver } from '../lib/staging.js'

test('保存位置按当前设置返回真实路径', () => {
  setStorageRootResolver(() => '~/humanize-paths-test')
  setRequestRootResolver(() => join(tmpdir(), 'humanize-paths-requests'))
  try {
    assert.deepEqual(humanizePaths(), {
      staging: join(homedir(), 'humanize-paths-test', 'annotations'),
      requests: join(tmpdir(), 'humanize-paths-requests'),
    })
  } finally {
    setStorageRootResolver(() => '')
  }
})
