import test from 'node:test'
import assert from 'node:assert/strict'
import { readSettings, SETTINGS_FIELDS } from '../lib/settings.js'

test('缺省设置由字段表补齐', () => {
  const settings = readSettings(undefined)
  assert.equal(settings.reviewConcurrency, 3)
  assert.equal(settings.reviewRetries, 1)
  assert.equal(settings.loopMaxRounds, 3)
  assert.equal(settings.mergeOnCompaction, true)
  assert.equal(settings.storageDir, '')
})

test('显式设置覆盖缺省值', () => {
  const settings = readSettings({ settings: { reviewRetries: 2, loopMaxRounds: 5 } })
  assert.equal(settings.reviewRetries, 2)
  assert.equal(settings.loopMaxRounds, 5)
})

test('数值字段在字段表里带边界', () => {
  assert.equal(SETTINGS_FIELDS.reviewConcurrency.min, 1)
  assert.equal(SETTINGS_FIELDS.reviewRetries.min, 0)
  assert.equal(SETTINGS_FIELDS.reviewRetries.max, 3)
  assert.equal(SETTINGS_FIELDS.loopMaxRounds.max, 10)
})

test('超出范围的数值在配置激活时被拒绝', async () => {
  const { Config } = await import('../lib/settings.js')
  assert.throws(() => Config({ settings: { reviewRetries: 9 } }), /reviewRetries/)
  assert.throws(() => Config({ settings: { loopMaxRounds: 0 } }), /loopMaxRounds/)
})
