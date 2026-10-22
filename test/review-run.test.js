import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { includeDeclared } from '../lib/git-files.js'
import { registerReviewCommand, splitReviewArgs } from '../lib/review-run.js'

const execFileAsync = promisify(execFile)

async function makeProject(specContent) {
  const dir = await mkdtemp(join(tmpdir(), 'humanize-review-run-'))
  // 规范链查找停在 .git 这一层，只读到本项目的 PROSE.md。
  await mkdir(join(dir, '.git'))
  if (specContent !== undefined) await writeFile(join(dir, 'PROSE.md'), specContent, 'utf8')
  return dir
}

test('规范链没有 include 声明时所有文件都视为命中', async () => {
  const withSpec = await makeProject('1. 平铺直叙。\n')
  const withoutSpec = await makeProject(undefined)
  try {
    assert.equal(await includeDeclared(join(withSpec, 'a.md')), true)
    assert.equal(await includeDeclared(join(withSpec, 'docs', 'b.js')), true)
    assert.equal(await includeDeclared(join(withoutSpec, 'a.md')), true)
  } finally {
    await rm(withSpec, { recursive: true, force: true })
    await rm(withoutSpec, { recursive: true, force: true })
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

test('--changed 可以从路径前后摘出，路径里的空格保留', () => {
  assert.deepEqual(splitReviewArgs('--changed docs/a b.md'), { changed: true, pathInput: 'docs/a b.md' })
  assert.deepEqual(splitReviewArgs('docs/a b.md --changed'), { changed: true, pathInput: 'docs/a b.md' })
  assert.deepEqual(splitReviewArgs('docs/a --changed b.md'), { changed: true, pathInput: 'docs/a b.md' })
  assert.deepEqual(splitReviewArgs('--changed'), { changed: true, pathInput: '' })
  assert.deepEqual(splitReviewArgs('docs/a b.md'), { changed: false, pathInput: 'docs/a b.md' })
})

test('命令把 --changed 的 HEAD 内容传给审查管线', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'humanize-review-command-'))
  try {
    await execFileAsync('git', ['init', '-q'], { cwd: dir })
    await writeFile(join(dir, 'PROSE.md'), '1. 平铺直叙。\n')
    await writeFile(join(dir, 'doc.md'), '旧内容\n')
    await execFileAsync('git', ['add', '.'], { cwd: dir })
    await execFileAsync('git', [
      '-c', 'user.email=test@example.com',
      '-c', 'user.name=test',
      'commit', '-qm', 'init',
    ], { cwd: dir })
    await writeFile(join(dir, 'doc.md'), '新内容\n')

    const commands = new Map()
    const ctx = {
      get: () => undefined,
      commands: { register(definition) { commands.set(definition.name, definition) } },
    }
    const state = {
      reviewing: new Set(),
      merging: new Set(),
      running: new Set(),
      reviewBatchAbort: new Map(),
      mergeRun: null,
    }
    const calls = []
    registerReviewCommand(ctx, { info() {}, warn() {} }, {}, state, async (...args) => {
      calls.push(args)
      return { kind: 'ok', annotations: 0 }
    }, async () => {})
    const agent = { id: 'agent-1', session: { id: 'session-1', header: { cwd: dir } } }

    const result = commands.get('humanize-review').handler({ agent, rawInput: '--changed' })
    assert.equal(result.kind, 'success')
    assert.equal(result.text, '已派发增量审查。')
    for (let attempt = 0; attempt < 200 && state.reviewing.size > 0; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
    assert.equal(calls.length, 1)
    assert.equal(calls[0][1], join(dir, 'doc.md'))
    assert.equal(calls[0][2], '旧内容\n')
    assert.equal(calls[0][3], '新内容\n')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
