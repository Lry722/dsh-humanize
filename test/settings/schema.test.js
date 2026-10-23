import test from 'node:test'
import assert from 'node:assert/strict'
import { Config, readSettings, SETTINGS_FIELDS } from '../../lib/settings/schema.js'

test('缺省设置由字段表补齐', () => {
  const settings = readSettings(undefined)
  assert.equal(settings.reviewConcurrency, 3)
  assert.equal(settings.reviewRetries, 1)
  assert.equal(settings.reviewIntervalSeconds, 60)
  assert.equal(settings.loopMaxRounds, 3)
  assert.equal(settings.mergeOnCompaction, true)
  assert.equal(settings.storageDir, '')
})

test('显式设置覆盖缺省值', () => {
  const settings = readSettings({ settings: { reviewRetries: 2, reviewIntervalSeconds: 5, loopMaxRounds: 5 } })
  assert.equal(settings.reviewRetries, 2)
  assert.equal(settings.reviewIntervalSeconds, 5)
  assert.equal(settings.loopMaxRounds, 5)
})

test('数值字段带边界，超出范围的配置在激活时被拒绝', () => {
  assert.equal(SETTINGS_FIELDS.reviewConcurrency.min, 1)
  assert.equal(SETTINGS_FIELDS.reviewRetries.min, 0)
  assert.equal(SETTINGS_FIELDS.reviewRetries.max, 3)
  assert.equal(SETTINGS_FIELDS.reviewIntervalSeconds.min, 0)
  assert.equal(SETTINGS_FIELDS.reviewIntervalSeconds.max, 3600)
  assert.equal(SETTINGS_FIELDS.loopMaxRounds.max, 10)
  assert.throws(() => Config({ settings: { reviewRetries: 9 } }), /reviewRetries/)
  assert.throws(() => Config({ settings: { reviewIntervalSeconds: -1 } }), /reviewIntervalSeconds/)
  assert.throws(() => Config({ settings: { loopMaxRounds: 0 } }), /loopMaxRounds/)
})

test('整数字段拒绝小数，reviewIntervalSeconds 仍允许小数', () => {
  assert.equal(SETTINGS_FIELDS.reviewConcurrency.integer, true)
  assert.equal(SETTINGS_FIELDS.reviewRetries.integer, true)
  assert.equal(SETTINGS_FIELDS.loopMaxRounds.integer, true)
  assert.equal(SETTINGS_FIELDS.reviewIntervalSeconds.integer, undefined)
  assert.throws(() => Config({ settings: { reviewConcurrency: 1.5 } }), /reviewConcurrency/)
  assert.throws(() => Config({ settings: { reviewRetries: 0.5 } }), /reviewRetries/)
  assert.throws(() => Config({ settings: { loopMaxRounds: 1.5 } }), /loopMaxRounds/)
  assert.doesNotThrow(() => Config({
    settings: { reviewConcurrency: 2, reviewRetries: 2, loopMaxRounds: 5, reviewIntervalSeconds: 1.5 },
  }))
})
