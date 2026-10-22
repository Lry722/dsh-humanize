/**
 * 审查目标展开的测试。重点验证增量模式只收集改动文件，并且带上 HEAD
 * 里的旧内容。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { collectTargets } from '../lib/git-files.js'

const execFileAsync = promisify(execFile)

async function makeRepo() {
  const dir = await mkdtemp(join(tmpdir(), 'humanize-git-files-'))
  await execFileAsync('git', ['init', '-q'], { cwd: dir })
  return dir
}

async function commitAll(dir) {
  await execFileAsync('git', ['add', '-A'], { cwd: dir })
  await execFileAsync('git', [
    '-c', 'user.email=test@example.com',
    '-c', 'user.name=test',
    'commit', '-qm', 'init',
  ], { cwd: dir })
}

const paths = (targets) => targets.map((target) => target.filePath)

test('增量模式收集修改和未跟踪文件，跳过未改动和忽略文件，并带上旧内容', async () => {
  const dir = await makeRepo()
  try {
    await writeFile(join(dir, 'PROSE.md'), '1. 平铺直叙。\n')
    await writeFile(join(dir, '.gitignore'), 'ignored.md\n')
    await writeFile(join(dir, 'changed.md'), 'old\n')
    await writeFile(join(dir, 'staged.md'), 'old staged\n')
    await writeFile(join(dir, 'same.md'), 'same\n')
    await commitAll(dir)

    await writeFile(join(dir, 'changed.md'), 'new\n')
    await writeFile(join(dir, 'staged.md'), 'new staged\n')
    await execFileAsync('git', ['add', 'staged.md'], { cwd: dir })
    await writeFile(join(dir, 'new.md'), 'new file\n')
    await writeFile(join(dir, 'ignored.md'), 'ignored\n')

    const targets = await collectTargets(dir, dir, { changed: true })
    assert.deepEqual(paths(targets).sort(), [
      join(dir, 'changed.md'),
      join(dir, 'new.md'),
      join(dir, 'staged.md'),
    ].sort())
    assert.equal(targets.find((target) => target.filePath.endsWith('changed.md')).before, 'old\n')
    assert.equal(targets.find((target) => target.filePath.endsWith('staged.md')).before, 'old staged\n')
    assert.equal(targets.find((target) => target.filePath.endsWith('new.md')).before, undefined)

    // 全量模式仍然返回所有受管文件，并且不带旧内容。
    const all = await collectTargets(dir, dir)
    assert.deepEqual(paths(all).sort(), [
      join(dir, '.gitignore'),
      join(dir, 'PROSE.md'),
      join(dir, 'changed.md'),
      join(dir, 'staged.md'),
      join(dir, 'same.md'),
    ].sort())
    assert.equal(all.every((target) => target.before === undefined), true)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('增量模式遵守 include 范围和命令路径', async () => {
  const dir = await makeRepo()
  try {
    await mkdir(join(dir, 'docs'))
    await writeFile(join(dir, 'PROSE.md'), '---\ninclude:\n  - \'*.md\'\n---\n\n1. 平铺直叙。\n')
    await writeFile(join(dir, 'docs', 'a.md'), 'old a\n')
    await writeFile(join(dir, 'docs', 'b.js'), 'old b\n')
    await writeFile(join(dir, 'other.md'), 'old other\n')
    await commitAll(dir)

    await writeFile(join(dir, 'docs', 'a.md'), 'new a\n')
    await writeFile(join(dir, 'docs', 'b.js'), 'new b\n')
    await writeFile(join(dir, 'other.md'), 'new other\n')

    const docs = await collectTargets(join(dir, 'docs'), dir, { changed: true })
    assert.deepEqual(paths(docs), [join(dir, 'docs', 'a.md')])

    const one = await collectTargets(join(dir, 'other.md'), dir, { changed: true })
    assert.deepEqual(paths(one), [join(dir, 'other.md')])
    assert.equal(one[0].before, 'old other\n')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('仓库还没有提交时，受管文件和未跟踪文件都按改动处理', async () => {
  const dir = await makeRepo()
  try {
    await writeFile(join(dir, 'PROSE.md'), '1. 平铺直叙。\n')
    await writeFile(join(dir, 'staged.md'), 'staged\n')
    await execFileAsync('git', ['add', 'PROSE.md', 'staged.md'], { cwd: dir })
    await writeFile(join(dir, 'untracked.md'), 'untracked\n')

    const targets = await collectTargets(dir, dir, { changed: true })
    assert.deepEqual(paths(targets).sort(), [
      join(dir, 'PROSE.md'),
      join(dir, 'staged.md'),
      join(dir, 'untracked.md'),
    ].sort())
    assert.equal(targets.every((target) => target.before === undefined), true)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('没有改动时增量模式返回空列表', async () => {
  const dir = await makeRepo()
  try {
    await writeFile(join(dir, 'PROSE.md'), '1. 平铺直叙。\n')
    await writeFile(join(dir, 'a.md'), '正文\n')
    await commitAll(dir)
    assert.deepEqual(await collectTargets(dir, dir, { changed: true }), [])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
