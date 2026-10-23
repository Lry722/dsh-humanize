import test from 'node:test'
import assert from 'node:assert/strict'
import { humanizeFields } from '../lib/fields-info.js'

test('字段元数据来自设置字段表', () => {
  const fields = humanizeFields()
  assert.equal(fields.reviewConcurrency.default, 3)
  assert.equal(fields.reviewConcurrency.min, 1)
  assert.equal(fields.reviewConcurrency.integer, true)
  assert.equal(fields.loopMaxRounds.default, 3)
  assert.equal(fields.loopMaxRounds.max, 10)
  assert.equal(fields.reviewIntervalSeconds.integer, undefined)
})

test('字段元数据可以直接序列化成 JSON', () => {
  const fields = humanizeFields()
  assert.deepEqual(JSON.parse(JSON.stringify(fields)), fields)
})
