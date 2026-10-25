import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
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
    assert.deepEqual(result.chain.map((entry) => entry.path), [
      join(specs, 'base.md'),
      join(specs, 'single.md'),
    ])
    assert.equal(result.chain.every((entry) => entry.base === root), true)
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
    assert.deepEqual(result.chain.map((entry) => entry.path), [join(specs, 'base.md')])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('项目规则文件新增和删除后重新发现，base.md 没有隐式匹配', async () => {
  const root = await mkdtemp(join(tmpdir(), 'humanize-spec-reload-'))
  try {
    const specs = join(root, '.agents', 'prose')
    await mkdir(join(root, '.git'), { recursive: true })
    await mkdir(specs, { recursive: true })
    await writeFile(join(specs, 'base.md'), '---\ninclude: ["/other.md"]\n---\n# Rules\n1. base\n')
    const target = join(root, 'a.md')
    await writeFile(target, 'x\n')

    assert.deepEqual((await resolveSpec(target, root)).chain, [])
    const added = join(specs, 'single.md')
    await writeFile(added, '---\ninclude: ["/a.md"]\n---\n# Rules\n1. single\n')
    assert.deepEqual((await resolveSpec(target, root)).chain.map((entry) => entry.path), [added])
    await rm(added)
    assert.deepEqual((await resolveSpec(target, root)).chain, [])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
