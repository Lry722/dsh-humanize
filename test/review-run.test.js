import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { includeDeclared } from '../lib/review-run.js'

async function makeProject(specContent) {
  const dir = await mkdtemp(join(tmpdir(), 'humanize-review-run-'))
  // 规范链查找停在 .git 这一层，只读到本项目的 PROSE.md。
  await mkdir(join(dir, '.git'))
  if (specContent !== undefined) await writeFile(join(dir, 'PROSE.md'), specContent, 'utf8')
  return dir
}

test('规范链没有 include 声明时所有文件都视为命中', async () => {
  const dir = await makeProject('1. 平铺直叙。\n')
  try {
    assert.equal(await includeDeclared(join(dir, 'a.md')), true)
    assert.equal(await includeDeclared(join(dir, 'docs', 'b.js')), true)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('规范链有 include 声明时按模式过滤', async () => {
  const dir = await makeProject('---\ninclude:\n  - \'*.md\'\n---\n\n1. 平铺直叙。\n')
  try {
    assert.equal(await includeDeclared(join(dir, 'a.md')), true)
    assert.equal(await includeDeclared(join(dir, 'a.js')), false)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('规范链没有规范时所有文件都视为命中', async () => {
  const dir = await makeProject(undefined)
  try {
    assert.equal(await includeDeclared(join(dir, 'a.md')), true)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
