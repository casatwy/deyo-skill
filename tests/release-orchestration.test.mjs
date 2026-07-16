import assert from 'node:assert/strict'
import { constants as fsConstants } from 'node:fs'
import { spawn } from 'node:child_process'
import {
  access,
  chmod,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { sha256 } from '../scripts/release-core.mjs'

const sourceRoot = fileURLToPath(new URL('..', import.meta.url))

async function run(command, args, options = {}) {
  return await new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const stdout = []
    const stderr = []
    child.stdout.on('data', chunk => stdout.push(Buffer.from(chunk)))
    child.stderr.on('data', chunk => stderr.push(Buffer.from(chunk)))
    child.on('error', rejectPromise)
    child.on('close', code => resolvePromise({
      code,
      stdout: Buffer.concat(stdout).toString('utf8'),
      stderr: Buffer.concat(stderr).toString('utf8'),
    }))
  })
}

async function findExecutable(name) {
  for (const directory of (process.env.PATH || '').split(path.delimiter)) {
    if (!directory) continue
    const candidate = path.resolve(directory, name)
    try {
      await access(candidate, fsConstants.X_OK)
      return candidate
    }
    catch {}
  }
  throw new Error(`Missing test dependency: ${name}`)
}

async function checked(command, args, options) {
  const result = await run(command, args, options)
  assert.equal(result.code, 0, `${command} ${args.join(' ')}\n${result.stderr}`)
  return result
}

async function writeExecutable(target, content) {
  await writeFile(target, content, 'utf8')
  await chmod(target, 0o755)
}

const fakeGit = `#!/usr/bin/env node
const fs = require('node:fs')
const { spawnSync } = require('node:child_process')
const args = process.argv.slice(2)
fs.appendFileSync(process.env.MOCK_GIT_LOG, JSON.stringify(args) + '\\n')
if (args.join(' ') === 'remote get-url origin') {
  process.stdout.write('git@github.com:casatwy/deyo-skill.git\\n')
  process.exit(0)
}
const failKind = process.env.MOCK_GIT_FAIL_KIND || ''
const isTagPush = args[0] === 'push' && args.some(value => value.includes('refs/tags/'))
const isMasterPush = args[0] === 'push' && args.some(value => value.includes('refs/heads/master'))
const shouldFail = (failKind === 'tag' && isTagPush) || (failKind === 'master' && isMasterPush)
if (shouldFail && !fs.existsSync(process.env.MOCK_GIT_FAIL_MARKER)) {
  fs.writeFileSync(process.env.MOCK_GIT_FAIL_MARKER, failKind)
  process.stderr.write('simulated ' + failKind + ' push failure\\n')
  process.exit(42)
}
const result = spawnSync(process.env.REAL_GIT, args, {
  cwd: process.cwd(),
  env: process.env,
  stdio: 'inherit',
})
if (result.error) throw result.error
process.exit(result.status == null ? 1 : result.status)
`

const fakeClawHub = `#!/usr/bin/env node
const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')
const args = process.argv.slice(2)
const stateRoot = process.env.MOCK_CLAWHUB_STATE
const statePath = path.join(stateRoot, 'published.json')
const snapshotPath = path.join(stateRoot, 'snapshot')
fs.mkdirSync(stateRoot, { recursive: true })
fs.appendFileSync(path.join(stateRoot, 'commands.log'), JSON.stringify(args) + '\\n')

function fingerprint(root, directory = root) {
  const entries = []
  for (const name of fs.readdirSync(directory).sort()) {
    const absolute = path.join(directory, name)
    const relative = path.relative(root, absolute).split(path.sep).join('/')
    const stats = fs.lstatSync(absolute)
    if (stats.isDirectory()) entries.push(...fingerprint(root, absolute))
    else if (stats.isFile()) {
      const content = fs.readFileSync(absolute)
      entries.push({
        path: relative,
        size: content.length,
        sha256: crypto.createHash('sha256').update(content).digest('hex'),
      })
    }
  }
  return entries.sort((left, right) => left.path.localeCompare(right.path, 'en'))
}

function published() {
  return fs.existsSync(statePath) ? JSON.parse(fs.readFileSync(statePath, 'utf8')) : null
}

if (args[0] === '--cli-version') {
  process.stdout.write('0.23.1\\n')
  process.exit(0)
}
if (args[0] === 'whoami') {
  process.stdout.write((process.env.MOCK_CLAWHUB_ACCOUNT || 'casatwy') + '\\n')
  process.exit(0)
}
if (args[0] === 'inspect' && args.includes('--versions')) {
  const current = published()
  const versions = ['1.0.8', ...(current ? [current.version] : [])]
  process.stdout.write(JSON.stringify({
    owner: { handle: 'casatwy' },
    skill: { stats: { versions: versions.length }, tags: { latest: current?.version || '1.0.8' } },
    versions: versions.map(version => ({ version })),
  }))
  process.exit(0)
}
if (args[0] === 'inspect' && args.includes('--version')) {
  const current = published()
  const requested = args[args.indexOf('--version') + 1]
  if (process.env.MOCK_CLAWHUB_EXACT_TARGET === requested) {
    process.stdout.write(JSON.stringify({
      skill: { tags: { latest: '1.0.8' } },
      version: { version: requested, files: [] },
    }))
    process.exit(0)
  }
  if (!current || current.version !== requested) {
    process.stderr.write('version not found\\n')
    process.exit(1)
  }
  process.stdout.write(JSON.stringify({
    skill: { tags: { latest: current.version } },
    version: { version: current.version, files: current.files },
  }))
  process.exit(0)
}
if (args[0] === 'publish') {
  const sourceCommitIndex = args.indexOf('--source-commit')
  if (args.includes('--source-repo') && (sourceCommitIndex < 0 || !/^[a-f0-9]{40}$/.test(args[sourceCommitIndex + 1] || ''))) {
    process.stderr.write('--source-repo and --source-commit must be provided together\\n')
    process.exit(1)
  }
  if (args.includes('--dry-run')) {
    process.stdout.write(JSON.stringify({ ok: true, dryRun: true }))
    process.exit(0)
  }
  const stage = args[1]
  const version = args[args.indexOf('--version') + 1]
  fs.rmSync(snapshotPath, { recursive: true, force: true })
  fs.cpSync(stage, snapshotPath, { recursive: true, dereference: false })
  const value = { version, files: fingerprint(stage) }
  fs.writeFileSync(statePath, JSON.stringify(value))
  const ambiguityMarker = path.join(stateRoot, 'ambiguous-once')
  if (process.env.MOCK_CLAWHUB_AMBIGUOUS === '1' && !fs.existsSync(ambiguityMarker)) {
    fs.writeFileSync(ambiguityMarker, '1')
    process.stderr.write('simulated ambiguous network failure\\n')
    process.exit(7)
  }
  process.stdout.write(JSON.stringify({ ok: true, version }))
  process.exit(0)
}
if (args[0] === 'skill' && args[1] === 'verify') {
  const pending = process.env.MOCK_CLAWHUB_VERIFY === 'pending'
  process.stdout.write(JSON.stringify(pending ? {
    ok: true,
    decision: 'review',
    security: { passed: false, status: 'pending' },
  } : {
    ok: true,
    decision: 'pass',
    security: { passed: true, status: 'clean' },
  }))
  process.exit(0)
}
if (args.includes('install') && args.includes('--workdir')) {
  const workdir = args[args.indexOf('--workdir') + 1]
  const directory = args[args.indexOf('--dir') + 1]
  const target = path.join(workdir, directory, 'deyo')
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.cpSync(snapshotPath, target, { recursive: true, dereference: false })
  fs.mkdirSync(path.join(target, '.clawhub'), { recursive: true })
  fs.writeFileSync(path.join(target, '.clawhub', 'origin.json'), '{}')
  process.exit(0)
}
process.stderr.write('unexpected clawhub command: ' + args.join(' ') + '\\n')
process.exit(2)
`

const fakeGitHubTools = `#!/usr/bin/env node
const fs = require('node:fs')
const path = require('node:path')
const command = path.basename(process.argv[1])
const args = process.argv.slice(2)
if (command === 'npm' && args[0] === 'view') {
  process.stdout.write(JSON.stringify('0.2.0'))
  process.exit(0)
}
if (command === 'pnpm') {
  if (process.env.MOCK_PNPM_FAIL_ON_TARGET === '1') {
    const manifest = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'deyo', 'manifest.json'), 'utf8'))
    if (manifest.skillVersion === '1.0.9') {
      process.stderr.write('simulated provider E2E failure after freeze\\n')
      process.exit(42)
    }
  }
  process.exit(0)
}
if (command === 'claude') process.exit(0)
process.stderr.write('unexpected fake tool: ' + command + ' ' + args.join(' ') + '\\n')
process.exit(2)
`

const importedRunner = `#!/usr/bin/env node
import process from 'node:process'
import { main } from '../scripts/release.mjs'

const runtime = {
  interactive: true,
  environment: process.env,
  confirm: async (expected) => {
    if (process.env.MOCK_CONFIRM !== expected) {
      throw new Error('simulated confirmation mismatch: expected ' + expected)
    }
  },
}
if (process.env.MOCK_REVIEW_TIMEOUT_MS) {
  runtime.reviewTimeoutMs = Number(process.env.MOCK_REVIEW_TIMEOUT_MS)
  runtime.reviewPollMs = 1
  runtime.sleep = async () => {}
}
try {
  const receipt = await main(process.argv.slice(2), runtime)
  if (receipt) process.stdout.write(JSON.stringify(receipt) + '\\n')
}
catch (error) {
  process.stderr.write((error instanceof Error ? error.message : String(error)) + '\\n')
  process.exitCode = 1
}
`

async function createFixture() {
  const temporaryRoot = await realpath(os.tmpdir())
  const parent = await mkdtemp(path.join(temporaryRoot, 'deyo-release-e2e-'))
  const repo = path.join(parent, 'skill')
  const remote = path.join(parent, 'remote.git')
  const bin = path.join(parent, 'bin')
  const mockState = path.join(parent, 'clawhub-state')
  const realGit = await findExecutable('git')
  await cp(sourceRoot, repo, {
    recursive: true,
    dereference: false,
    preserveTimestamps: false,
    filter(source) {
      const relative = path.relative(sourceRoot, source)
      const topLevel = relative.split(path.sep)[0]
      return !['.git', 'node_modules'].includes(topLevel)
    },
  })
  await mkdir(bin, { recursive: true })
  await writeExecutable(path.join(bin, 'git'), fakeGit)
  for (const command of ['npm', 'pnpm', 'claude']) {
    await writeExecutable(path.join(bin, command), fakeGitHubTools)
  }
  await mkdir(path.join(repo, 'node_modules', '.bin'), { recursive: true })
  await writeExecutable(path.join(repo, 'node_modules', '.bin', 'clawhub'), fakeClawHub)
  await symlink(path.join(sourceRoot, 'node_modules', 'yaml'), path.join(repo, 'node_modules', 'yaml'))
  await writeFile(path.join(repo, 'tests', '__release-runner.mjs'), importedRunner, 'utf8')

  const manifestPath = path.join(repo, 'deyo', 'manifest.json')
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  manifest.skillVersion = '1.0.8'
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
  await rm(path.join(repo, 'release', 'notes', 'v1.0.9.md'), { force: true })
  await checked(process.execPath, ['scripts/generate-providers.mjs'], { cwd: repo, env: process.env })

  const setupEnv = { ...process.env }
  await checked(realGit, ['init', '-b', 'master'], { cwd: repo, env: setupEnv })
  await checked(realGit, ['config', 'user.name', 'Deyo Release Test'], { cwd: repo, env: setupEnv })
  await checked(realGit, ['config', 'user.email', 'release-test@example.invalid'], { cwd: repo, env: setupEnv })
  await checked(realGit, ['config', 'commit.gpgsign', 'false'], { cwd: repo, env: setupEnv })
  await checked(realGit, ['config', 'tag.gpgsign', 'false'], { cwd: repo, env: setupEnv })
  await checked(realGit, ['add', '-A'], { cwd: repo, env: setupEnv })
  await checked(realGit, ['commit', '-m', 'base'], { cwd: repo, env: setupEnv })
  await checked(realGit, ['init', '--bare', remote], { cwd: parent, env: setupEnv })
  await checked(realGit, ['remote', 'add', 'origin', remote], { cwd: repo, env: setupEnv })
  await checked(realGit, ['push', '-u', 'origin', 'master'], { cwd: repo, env: setupEnv })

  const env = {
    ...process.env,
    PATH: `${bin}${path.delimiter}${process.env.PATH || ''}`,
    REAL_GIT: realGit,
    MOCK_GIT_LOG: path.join(parent, 'git.log'),
    MOCK_GIT_FAIL_MARKER: path.join(parent, 'git-failed-once'),
    MOCK_CLAWHUB_STATE: mockState,
    HOME: path.join(parent, 'home'),
  }
  for (const key of ['CI', 'GITHUB_ACTIONS', 'BUILDKITE', 'JENKINS_URL', 'TF_BUILD']) delete env[key]

  return {
    parent,
    repo,
    remote,
    realGit,
    env,
    statePath: path.join(repo, '.git', 'deyo-release', 'state.json'),
    abortedDirectory: path.join(repo, '.git', 'deyo-release', 'aborted'),
    receiptPath: path.join(repo, '.git', 'deyo-release', 'receipts', 'v1.0.9.json'),
    async cli(args, extraEnv = {}) {
      return await run(process.execPath, [path.join(repo, 'scripts', 'release.mjs'), ...args], {
        cwd: repo,
        env: { ...env, ...extraEnv },
      })
    },
    async formal(args, extraEnv = {}) {
      return await run(process.execPath, [path.join(repo, 'tests', '__release-runner.mjs'), ...args], {
        cwd: repo,
        env: { ...env, ...extraEnv },
      })
    },
    async git(args) {
      return await checked(realGit, args, { cwd: repo, env })
    },
    async cleanup() {
      await rm(parent, { recursive: true, force: true })
    },
  }
}

async function readJson(target) {
  return JSON.parse(await readFile(target, 'utf8'))
}

async function assertMissing(target) {
  await assert.rejects(access(target), error => error?.code === 'ENOENT')
}

async function writeFrozenState(fixture, overrides = {}) {
  const releaseNotes = await readFile(path.join(fixture.repo, 'release', 'next.md'), 'utf8')
  const baseCommit = (await fixture.git(['rev-parse', 'HEAD'])).stdout.trim()
  const state = {
    schema: 1,
    phase: 'frozen',
    baseVersion: '1.0.8',
    targetVersion: '1.0.9',
    baseCommit,
    sourceSnapshot: 'a'.repeat(64),
    releaseNotes,
    releaseNotesHash: sha256(releaseNotes),
    frozenAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  }
  await mkdir(path.dirname(fixture.statePath), { recursive: true, mode: 0o700 })
  await chmod(path.dirname(fixture.statePath), 0o700)
  await writeFile(fixture.statePath, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 })
  await chmod(fixture.statePath, 0o600)
  return state
}

async function createPartiallyPreparedFrozenRelease(fixture) {
  const result = await fixture.formal([], {
    MOCK_CONFIRM: 'publish deyo v1.0.9',
    MOCK_PNPM_FAIL_ON_TARGET: '1',
  })
  assert.equal(result.code, 1)
  assert.match(result.stderr, /simulated provider E2E failure after freeze/)
  const frozen = await readJson(fixture.statePath)
  assert.equal(frozen.phase, 'frozen')
  assert.equal(JSON.parse(await readFile(path.join(fixture.repo, 'deyo', 'manifest.json'), 'utf8')).skillVersion, '1.0.9')
  await access(path.join(fixture.repo, 'release', 'notes', 'v1.0.9.md'))
  await writeFile(path.join(fixture.repo, 'tests', 'after-freeze-source-change.txt'), 'fixed after freeze\n')
  return frozen
}

test('release dry-run computes 1.0.9 and performs zero repository writes', { timeout: 30_000 }, async () => {
  const fixture = await createFixture()
  try {
    const headBefore = (await fixture.git(['rev-parse', 'HEAD'])).stdout.trim()
    const statusBefore = (await fixture.git(['status', '--porcelain'])).stdout
    const manifestBefore = await readFile(path.join(fixture.repo, 'deyo', 'manifest.json'), 'utf8')
    const result = await fixture.cli(['--dry-run'])
    assert.equal(result.code, 0, result.stderr)
    assert.match(result.stdout, /1\.0\.8 -> 1\.0\.9/)
    assert.match(result.stdout, /No files, state, commits, tags, pushes, or publications/)
    assert.equal((await fixture.git(['rev-parse', 'HEAD'])).stdout.trim(), headBefore)
    assert.equal((await fixture.git(['status', '--porcelain'])).stdout, statusBefore)
    assert.equal(await readFile(path.join(fixture.repo, 'deyo', 'manifest.json'), 'utf8'), manifestBefore)
    assert.equal((await fixture.git(['tag', '--list'])).stdout, '')
    await assertMissing(fixture.statePath)
    await assertMissing(path.join(fixture.env.MOCK_CLAWHUB_STATE, 'published.json'))
  }
  finally {
    await fixture.cleanup()
  }
})

test('guarded abort archives a source-mismatched partial freeze and normal publish reuses 1.0.9', { timeout: 45_000 }, async () => {
  const fixture = await createFixture()
  try {
    const frozen = await createPartiallyPreparedFrozenRelease(fixture)
    const statusBefore = (await fixture.git(['status', '--porcelain'])).stdout
    const aborted = await fixture.formal(['--abort'], { MOCK_CONFIRM: 'abort deyo v1.0.9' })
    assert.equal(aborted.code, 0, aborted.stderr)
    assert.match(aborted.stdout, /no worktree or remote refs will be changed/)
    const receipt = JSON.parse(aborted.stdout.trim().split('\n').at(-1))
    assert.equal(receipt.kind, 'deyo.frozen-release-abort')
    assert.equal(receipt.reason, 'maintainer_requested_safe_restart')
    assert.notEqual(receipt.currentSourceSnapshot, frozen.sourceSnapshot)
    await assertMissing(fixture.statePath)
    assert.equal((await fixture.git(['status', '--porcelain'])).stdout, statusBefore)
    assert.equal((await fixture.git(['tag', '--list', 'v1.0.9'])).stdout, '')
    await assertMissing(path.join(fixture.env.MOCK_CLAWHUB_STATE, 'published.json'))

    const archive = await readJson(path.join(fixture.repo, receipt.archivePath))
    const archivedState = await readJson(path.join(fixture.repo, receipt.archivedStatePath))
    assert.deepEqual(archive.state, frozen)
    assert.deepEqual(archivedState, frozen)
    assert.equal(archive.currentSourceSnapshot, receipt.currentSourceSnapshot)
    assert.match(archive.abortedAt, /^\d{4}-\d{2}-\d{2}T/)
    assert.equal((await stat(fixture.abortedDirectory)).mode & 0o777, 0o700)
    assert.equal((await stat(path.dirname(path.join(fixture.repo, receipt.archivePath)))).mode & 0o777, 0o700)
    assert.equal((await stat(path.join(fixture.repo, receipt.archivePath))).mode & 0o777, 0o600)
    assert.equal((await stat(path.join(fixture.repo, receipt.archivedStatePath))).mode & 0o777, 0o600)

    const restarted = await fixture.formal([], { MOCK_CONFIRM: 'publish deyo v1.0.9' })
    assert.equal(restarted.code, 0, restarted.stderr)
    assert.match(restarted.stdout, /1\.0\.8 -> 1\.0\.9/)
    assert.equal((await readJson(fixture.receiptPath)).skillVersion, '1.0.9')
    await assertMissing(fixture.statePath)
  }
  finally {
    await fixture.cleanup()
  }
})

test('guarded abort rejects phase, tag, exact-version, Git drift, confirmation, non-TTY, and CI conflicts', { timeout: 90_000 }, async (t) => {
  const scenarios = [
    { name: 'phase', expected: /Only a frozen release/, state: { phase: 'prepared', canonicalTreeHash: 'c'.repeat(64) } },
    { name: 'post-field', expected: /post-frozen state/, state: { canonicalTreeHash: 'c'.repeat(64) } },
    { name: 'local-tag', expected: /local tag v1\.0\.9 exists/ },
    { name: 'remote-tag', expected: /remote tag v1\.0\.9 exists/ },
    { name: 'exact', expected: /exact version 1\.0\.9 exists/ },
    { name: 'head', expected: /local master no longer matches/ },
    { name: 'remote', expected: /origin\/master no longer matches/ },
    { name: 'confirmation', expected: /confirmation mismatch/ },
    { name: 'non-tty', expected: /interactive TTY/ },
    { name: 'ci', expected: /forbidden in CI/ },
  ]
  for (const scenario of scenarios) {
    await t.test(scenario.name, async () => {
      const fixture = await createFixture()
      try {
        const state = await writeFrozenState(fixture, scenario.state)
        if (scenario.name === 'local-tag') await fixture.git(['tag', 'v1.0.9'])
        if (scenario.name === 'remote-tag') {
          await fixture.git(['tag', 'v1.0.9'])
          await fixture.git(['push', 'origin', 'refs/tags/v1.0.9:refs/tags/v1.0.9'])
          await fixture.git(['tag', '-d', 'v1.0.9'])
        }
        if (scenario.name === 'head' || scenario.name === 'remote') {
          await writeFile(path.join(fixture.repo, 'tests', `${scenario.name}-drift.txt`), 'drift\n')
          await fixture.git(['add', '-A'])
          await fixture.git(['commit', '-m', `${scenario.name} drift`])
          if (scenario.name === 'remote') {
            await fixture.git(['push', 'origin', 'HEAD:refs/heads/master'])
            await fixture.git(['reset', '--hard', state.baseCommit])
          }
        }

        let result
        if (scenario.name === 'non-tty') result = await fixture.cli(['--abort'])
        else {
          result = await fixture.formal(['--abort'], {
            MOCK_CONFIRM: scenario.name === 'confirmation' ? 'wrong' : 'abort deyo v1.0.9',
            ...(scenario.name === 'ci' ? { CI: 'true' } : {}),
            ...(scenario.name === 'exact' ? { MOCK_CLAWHUB_EXACT_TARGET: '1.0.9' } : {}),
          })
        }
        assert.equal(result.code, 1, result.stderr)
        assert.match(result.stderr, scenario.expected)
        await access(fixture.statePath)
        await assertMissing(fixture.abortedDirectory)
      }
      finally {
        await fixture.cleanup()
      }
    })
  }
})

test('formal release rejects non-TTY, CI, confirmation mismatch, and ClawHub auth before state', { timeout: 40_000 }, async (t) => {
  for (const scenario of ['non-tty', 'ci', 'confirmation', 'auth']) {
    await t.test(scenario, async () => {
      const fixture = await createFixture()
      try {
        let result
        if (scenario === 'non-tty') result = await fixture.cli([])
        else if (scenario === 'ci') result = await fixture.cli([], { CI: 'true' })
        else if (scenario === 'confirmation') result = await fixture.formal([], { MOCK_CONFIRM: 'wrong' })
        else result = await fixture.cli(['--dry-run'], { MOCK_CLAWHUB_ACCOUNT: 'someone-else' })
        assert.equal(result.code, 1)
        if (scenario === 'non-tty') assert.match(result.stderr, /interactive TTY/)
        if (scenario === 'ci') assert.match(result.stderr, /forbidden in CI/)
        if (scenario === 'confirmation') assert.match(result.stderr, /confirmation mismatch/)
        if (scenario === 'auth') assert.match(result.stderr, /login must be casatwy/)
        await assertMissing(fixture.statePath)
        assert.equal((await fixture.git(['tag', '--list'])).stdout, '')
      }
      finally {
        await fixture.cleanup()
      }
    })
  }
})

test('ambiguous ClawHub publish is reconciled and receipt records exact notes and MIT-0', { timeout: 30_000 }, async () => {
  const fixture = await createFixture()
  try {
    const result = await fixture.formal([], {
      MOCK_CONFIRM: 'publish deyo v1.0.9',
      MOCK_CLAWHUB_AMBIGUOUS: '1',
    })
    assert.equal(result.code, 0, result.stderr)
    const receipt = await readJson(fixture.receiptPath)
    const archivedPath = path.join(fixture.repo, receipt.releaseNotesPath)
    const archived = await readFile(archivedPath, 'utf8')
    assert.equal(receipt.skillVersion, '1.0.9')
    assert.equal(receipt.clawHubLicense, 'MIT-0')
    assert.equal(receipt.releaseNotesPath, 'release/notes/v1.0.9.md')
    assert.equal(receipt.releaseNotes, archived)
    assert.equal(receipt.releaseNotesHash, (await import('../scripts/release-core.mjs')).sha256(archived))
    await assertMissing(fixture.statePath)
    assert.equal((await fixture.git(['tag', '--list', 'v1.0.9'])).stdout.trim(), 'v1.0.9')
    assert.equal(
      (await fixture.git(['rev-parse', 'HEAD'])).stdout.trim(),
      (await fixture.git(['rev-parse', 'origin/master'])).stdout.trim(),
    )
  }
  finally {
    await fixture.cleanup()
  }
})

test('pending review preserves one version and RESUME completes without republishing', { timeout: 30_000 }, async () => {
  const fixture = await createFixture()
  try {
    const pending = await fixture.formal([], {
      MOCK_CONFIRM: 'publish deyo v1.0.9',
      MOCK_CLAWHUB_VERIFY: 'pending',
      MOCK_REVIEW_TIMEOUT_MS: '0',
    })
    assert.equal(pending.code, 1)
    assert.match(pending.stderr, /Resume the same version/)
    assert.equal((await readJson(fixture.statePath)).phase, 'tag_pushed')
    const resumed = await fixture.formal(['--resume'], {
      MOCK_CONFIRM: 'resume deyo v1.0.9',
    })
    assert.equal(resumed.code, 0, resumed.stderr)
    const commands = (await readFile(path.join(fixture.env.MOCK_CLAWHUB_STATE, 'commands.log'), 'utf8'))
      .trim().split('\n').map(line => JSON.parse(line))
    assert.equal(commands.filter(args => args[0] === 'publish' && !args.includes('--dry-run')).length, 1)
    assert.equal((await readJson(fixture.receiptPath)).skillVersion, '1.0.9')
  }
  finally {
    await fixture.cleanup()
  }
})

test('tag and master push failures retain phase and resume the same release', { timeout: 60_000 }, async (t) => {
  for (const failure of [
    { kind: 'tag', phase: 'tagged' },
    { kind: 'master', phase: 'clawhub_ready' },
  ]) {
    await t.test(failure.kind, async () => {
      const fixture = await createFixture()
      try {
        const failed = await fixture.formal([], {
          MOCK_CONFIRM: 'publish deyo v1.0.9',
          MOCK_GIT_FAIL_KIND: failure.kind,
        })
        assert.equal(failed.code, 1)
        assert.equal((await readJson(fixture.statePath)).phase, failure.phase)
        const resumed = await fixture.formal(['--resume'], {
          MOCK_CONFIRM: 'resume deyo v1.0.9',
        })
        assert.equal(resumed.code, 0, resumed.stderr)
        assert.equal((await readJson(fixture.receiptPath)).skillVersion, '1.0.9')
        await assertMissing(fixture.statePath)
      }
      finally {
        await fixture.cleanup()
      }
    })
  }
})
