import test from 'node:test'
import assert from 'node:assert/strict'
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  collectStaged,
  humanizeRoot,
  setRequestRootResolver,
  setStorageRootResolver,
  stagingPathFor,
  writeRequest,
  writeStaging,
} from '../../lib/shared/staging.js'

test('storageDir 里的 ~ 会展开成用户目录', () => {
  setStorageRootResolver(() => '~/humanize-test')
  try {
    assert.equal(humanizeRoot(), join(homedir(), 'humanize-test'))
  } finally {
    setStorageRootResolver(() => '')
  }
})

test('审查请求留档写到指定的临时目录', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'humanize-requests-'))
  setRequestRootResolver(() => dir)
  try {
    const path = await writeRequest('/proj/docs/a.md', 'request body')
    assert.ok(path.startsWith(dir))
    assert.equal(await readFile(path, 'utf8'), 'request body')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('暂存文件不可读时 collectStaged 抛出错误，不把它当成空目录', {
  skip: process.platform === 'win32' || process.getuid?.() === 0,
}, async () => {
  const storage = await mkdtemp(join(tmpdir(), 'humanize-staging-perm-'))
  setStorageRootResolver(() => storage)
  const project = join(storage, 'project')
  const file = join(project, 'doc.md')
  try {
    await mkdir(project, { recursive: true })
    await writeFile(file, 'x\n')
    await writeStaging(file, `1. "x"\n`)
    await chmod(stagingPathFor(file), 0o000)
    await assert.rejects(collectStaged(file), (error) => error?.code === 'EACCES' || error?.code === 'EPERM')
  } finally {
    // 恢复权限，否则清理目录会失败。
    await chmod(stagingPathFor(file), 0o600).catch(() => undefined)
    await rm(storage, { recursive: true, force: true })
  }
})

test('新建的暂存目录权限为 0o700', {
  // Windows 不按 POSIX 权限位处理目录；umask 拿掉属主位时目录也得不到 0o700。
  skip: process.platform === 'win32' || (process.umask() & 0o700) !== 0,
}, async () => {
  const storage = await mkdtemp(join(tmpdir(), 'humanize-staging-mode-'))
  setStorageRootResolver(() => storage)
  try {
    await writeStaging(join(storage, 'project', 'doc.md'), `1. "x"\n`)
    assert.equal((await stat(join(storage, 'annotations'))).mode & 0o777, 0o700)
  } finally {
    setStorageRootResolver(() => '')
    await rm(storage, { recursive: true, force: true })
  }
})
