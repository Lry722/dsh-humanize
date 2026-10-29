import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, symlink, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadSpecCandidates, resolveSpec } from '../../lib/spec/chain.js'

test('给了工作目录边界后在边界处停止向上查找', async () => {
  const root = await mkdtemp(join(tmpdir(), 'humanize-spec-boundary-'))
  try {
    await writeFile(join(root, 'PROSE.md'), '# Rules\n1. parent\n', 'utf8')
    await mkdir(join(root, 'sub'))
    const target = join(root, 'sub', 'a.md')
    await writeFile(target, 'x\n', 'utf8')

    const chain = await loadSpecCandidates(target, join(root, 'sub'))
    assert.equal(chain.some((entry) => entry.path === join(root, 'PROSE.md')), false)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('会话位于子目录时仍从仓库根发现项目规则', async () => {
  const root = await mkdtemp(join(tmpdir(), 'humanize-spec-project-'))
  try {
    const cwd = join(root, 'packages', 'app')
    const specs = join(root, '.agents', 'prose')
    await mkdir(join(root, '.git'), { recursive: true })
    await mkdir(cwd, { recursive: true })
    await mkdir(specs, { recursive: true })
    await writeFile(join(specs, 'base.md'), '---\ninclude: ["**/*"]\n---\n# Rules\n1. base\n')
    await writeFile(join(specs, 'single.md'), '---\ninclude: ["/packages/app/a.md"]\n---\n# Rules\n1. single\n')
    const target = join(cwd, 'a.md')
    await writeFile(target, 'x\n')

    const result = await resolveSpec(target, cwd)
    assert.deepEqual(result.map((entry) => entry.path), [
      join(specs, 'single.md'),
      join(specs, 'base.md'),
    ])
    assert.equal(result.every((entry) => entry.base === root), true)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('目标位于会话目录之外时使用目标自己的仓库规则', async () => {
  const root = await mkdtemp(join(tmpdir(), 'humanize-spec-other-repo-'))
  try {
    const session = join(root, 'session')
    const other = join(root, 'other')
    const specs = join(other, '.agents', 'prose')
    await mkdir(session, { recursive: true })
    await mkdir(join(other, '.git'), { recursive: true })
    await mkdir(specs, { recursive: true })
    await writeFile(join(specs, 'base.md'), '---\ninclude: ["**/*"]\n---\n# Rules\n1. other\n')
    const target = join(other, 'a.md')
    await writeFile(target, 'x\n')

    const result = await resolveSpec(target, session)
    assert.deepEqual(result.map((entry) => entry.path), [join(specs, 'base.md')])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('目标位于项目规则目录时同一路径只加载一次', async () => {
  const root = await mkdtemp(join(tmpdir(), 'humanize-spec-duplicate-'))
  try {
    const specs = join(root, '.agents', 'prose')
    await mkdir(join(root, '.git'), { recursive: true })
    await mkdir(specs, { recursive: true })
    const specPath = join(specs, 'PROSE.md')
    await writeFile(specPath, '---\ninclude: ["**/*"]\n---\n# Rules\n1. project\n')
    const target = join(specs, 'a.txt')
    await writeFile(target, 'x\n')

    const result = await resolveSpec(target, root)
    assert.equal(result.length, 1)
    assert.equal(result[0].path, specPath)
    assert.equal(result[0].kind, 'project')
    assert.equal(result[0].base, root)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('项目规则文件新增和删除后重新发现，base.md 遵守显式 include', async () => {
  const root = await mkdtemp(join(tmpdir(), 'humanize-spec-reload-'))
  try {
    const specs = join(root, '.agents', 'prose')
    await mkdir(join(root, '.git'), { recursive: true })
    await mkdir(specs, { recursive: true })
    await writeFile(join(specs, 'base.md'), '---\ninclude: ["/other.md"]\n---\n# Rules\n1. base\n')
    const target = join(root, 'a.md')
    await writeFile(target, 'x\n')

    assert.deepEqual((await resolveSpec(target, root)), [])
    const added = join(specs, 'single.md')
    await writeFile(added, '---\ninclude: ["/a.md"]\n---\n# Rules\n1. single\n')
    assert.deepEqual((await resolveSpec(target, root)).map((entry) => entry.path), [added])
    await rm(added)
    assert.deepEqual((await resolveSpec(target, root)), [])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('项目规则目录忽略以 .md 结尾的目录', async () => {
  const root = await mkdtemp(join(tmpdir(), 'humanize-spec-directory-entry-'))
  try {
    const specs = join(root, '.agents', 'prose')
    await mkdir(join(root, '.git'), { recursive: true })
    await mkdir(join(specs, 'directory.md'), { recursive: true })
    const specPath = join(specs, 'base.md')
    await writeFile(specPath, '# Rules\n1. base\n')
    const target = join(root, 'a.md')
    await writeFile(target, 'x\n')

    const result = await resolveSpec(target, root)
    assert.deepEqual(result.map((entry) => entry.path), [specPath])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('项目规则目录继续加载文件符号链接', { skip: process.platform === 'win32' }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'humanize-spec-symlink-'))
  try {
    const specs = join(root, '.agents', 'prose')
    await mkdir(join(root, '.git'), { recursive: true })
    await mkdir(specs, { recursive: true })
    const source = join(root, 'source.md')
    await writeFile(source, '---\ninclude: ["/a.md"]\n---\n# Rules\n1. linked\n')
    const specPath = join(specs, 'linked.md')
    await symlink(source, specPath)
    const target = join(root, 'a.md')
    await writeFile(target, 'x\n')

    const result = await resolveSpec(target, root)
    assert.deepEqual(result.map((entry) => entry.path), [specPath])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('同一路径规则覆盖后按修改时间和大小刷新解析缓存', async () => {
  const root = await mkdtemp(join(tmpdir(), 'humanize-spec-cache-'))
  try {
    await mkdir(join(root, '.git'), { recursive: true })
    const specPath = join(root, 'PROSE.md')
    const targetA = join(root, 'a.md')
    const targetB = join(root, 'b.md')
    await writeFile(targetA, 'a\n')
    await writeFile(targetB, 'b\n')
    const source = (name, rule) => `---\ninclude: ["/${name}.md"]\n---\n# Rules\n1. ${rule}\n`
    const specFrom = (result) => result.find((entry) => entry.path === specPath)
    const firstTime = new Date('2020-01-01T00:00:00Z')
    const secondTime = new Date('2021-01-01T00:00:00Z')
    const initial = source('a', 'old')
    const sameSize = source('b', 'new')
    assert.equal(initial.length, sameSize.length)

    await writeFile(specPath, initial)
    await utimes(specPath, firstTime, firstTime)
    assert.equal(specFrom(await resolveSpec(targetA, root))?.content.includes('1. old'), true)
    assert.equal(specFrom(await resolveSpec(targetB, root)), undefined)

    // 修改时间改变而文件大小相同时，文件头和正文都必须重新解析。
    await writeFile(specPath, sameSize)
    await utimes(specPath, secondTime, secondTime)
    assert.equal(specFrom(await resolveSpec(targetA, root)), undefined)
    assert.equal(specFrom(await resolveSpec(targetB, root))?.content.includes('1. new'), true)

    // 文件大小改变而修改时间相同时，正文同样必须重新解析。
    await writeFile(specPath, source('b', 'a longer rule'))
    await utimes(specPath, secondTime, secondTime)
    assert.equal(specFrom(await resolveSpec(targetB, root))?.content.includes('1. a longer rule'), true)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
