import test from 'node:test'
import assert from 'node:assert/strict'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { humanizeFields, humanizePaths } from '../../lib/settings/routes.js'
import { SETTINGS_FIELDS } from '../../lib/settings/schema.js'
import { requestRoot, setRequestRootResolver, setStorageRootResolver } from '../../lib/shared/staging.js'
import { setTurnOutputRootResolver } from '../../lib/output/turns.js'

test('字段元数据向设置页投影默认值和边界', () => {
  const fields = humanizeFields()
  const concurrency = SETTINGS_FIELDS.reviewConcurrency
  assert.deepEqual(fields.reviewConcurrency, {
    type: concurrency.type,
    default: concurrency.default,
    min: concurrency.min,
    integer: true,
  })
  assert.equal(fields.loopMaxRounds.max, SETTINGS_FIELDS.loopMaxRounds.max)
  assert.equal(fields.reviewIntervalSeconds.integer, undefined)
})

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
