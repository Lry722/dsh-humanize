import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadSpecChain } from '../lib/specs.js'

test('给了工作目录边界后在边界处停止向上查找', async () => {
  const root = await mkdtemp(join(tmpdir(), 'humanize-spec-boundary-'))
  try {
    await writeFile(join(root, 'PROSE.md'), '# Rules\n1. parent\n', 'utf8')
    await mkdir(join(root, 'sub'))
    const target = join(root, 'sub', 'a.md')
    await writeFile(target, 'x\n', 'utf8')

    const chain = await loadSpecChain(target, join(root, 'sub'))
    assert.equal(chain.some((entry) => entry.path === join(root, 'PROSE.md')), false)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
