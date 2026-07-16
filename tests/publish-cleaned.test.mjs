import assert from 'node:assert/strict'
import { lstat, mkdtemp, readFile, readdir, rm, stat, symlink } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const scriptPath = fileURLToPath(new URL('../deyo/scripts/publish-cleaned.mjs', import.meta.url))

async function runPublisher(target, content) {
  return await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [scriptPath, '--target', target], {
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    const stdout = []
    const stderr = []

    child.stdout.on('data', chunk => stdout.push(chunk))
    child.stderr.on('data', chunk => stderr.push(chunk))
    child.on('error', reject)
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(Buffer.concat(stderr).toString('utf8') || `publisher exited ${code}`))
        return
      }
      resolve(Buffer.concat(stdout).toString('utf8').trim())
    })
    child.stdin.end(content)
  })
}

test('concurrent publishers never overwrite another cleaned result', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'deyo-publish-race-'))
  try {
    const target = path.join(directory, 'result.txt')
    const contents = Array.from({ length: 12 }, (_, index) => `cleaned result ${index}\n`)
    const publishedPaths = await Promise.all(contents.map(content => runPublisher(target, content)))

    assert.equal(new Set(publishedPaths).size, contents.length)
    assert.deepEqual(
      new Set(publishedPaths.map(publishedPath => path.basename(publishedPath))),
      new Set([
        'result.txt',
        'result.cleaned.txt',
        ...Array.from({ length: 10 }, (_, index) => `result.cleaned-${index + 2}.txt`),
      ]),
    )

    const storedContents = await Promise.all(publishedPaths.map(publishedPath => readFile(publishedPath, 'utf8')))
    assert.deepEqual(new Set(storedContents), new Set(contents))
    assert.equal((await stat(publishedPaths[0])).mode & 0o777, 0o600)
    assert.equal((await readdir(directory)).some(name => name.endsWith('.tmp')), false)
  }
  finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('a dangling symlink occupies the requested name and remains untouched', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'deyo-publish-symlink-'))
  try {
    const target = path.join(directory, 'result.txt')
    await symlink(path.join(directory, 'missing-target.txt'), target)

    const publishedPath = await runPublisher(target, 'safe cleaned result\n')

    assert.equal(path.basename(publishedPath), 'result.cleaned.txt')
    assert.equal((await lstat(target)).isSymbolicLink(), true)
    await assert.rejects(readFile(target), error => error?.code === 'ENOENT')
    assert.equal(await readFile(publishedPath, 'utf8'), 'safe cleaned result\n')
  }
  finally {
    await rm(directory, { recursive: true, force: true })
  }
})
