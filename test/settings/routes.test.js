import test from 'node:test'
import assert from 'node:assert/strict'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { humanizePaths } from '../../lib/settings/routes.js'
import { requestRoot, setRequestRootResolver, setStorageRootResolver } from '../../lib/shared/staging.js'
import { setTurnOutputRootResolver } from '../../lib/output/turns.js'

test('保存位置按当前设置返回真实路径', () => {
  const previousRequestRoot = requestRoot()
  setStorageRootResolver(() => '~/humanize-paths-test')
  setRequestRootResolver(() => join(tmpdir(), 'humanize-paths-root', 'requests'))
  setTurnOutputRootResolver(() => join(tmpdir(), 'humanize-paths-root', 'output'))
  try {
    assert.deepEqual(humanizePaths(), {
      staging: join(homedir(), 'humanize-paths-test', 'annotations'),
      history: join(tmpdir(), 'humanize-paths-root', 'history'),
      requests: join(tmpdir(), 'humanize-paths-root', 'requests'),
      output: join(tmpdir(), 'humanize-paths-root', 'output'),
    })
  } finally {
    setStorageRootResolver(() => '')
    setRequestRootResolver(() => previousRequestRoot)
    setTurnOutputRootResolver()
  }
})
