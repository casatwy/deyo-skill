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
  const delay = Number(process.env.MOCK_CLAWHUB_DELAY_MS || 0)
  if (delay > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delay)
  process.stdout.write((process.env.MOCK_CLAWHUB_ACCOUNT || 'casatwy') + '\\n')
  process.exit(0)
}
if (args[0] === 'inspect' && args.includes('--versions')) {
  const current = published()
  const versions = ['1.0.8', ...(current ? [current.version] : []), ...(process.env.MOCK_CLAWHUB_HIGHER === '1' ? ['1.0.10'] : [])]
  process.stdout.write(JSON.stringify({
    owner: { handle: 'casatwy' },
    skill: {
      stats: { versions: versions.length },
      tags: { latest: process.env.MOCK_CLAWHUB_LATEST || current?.version || '1.0.8' },
    },
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
  if (process.env.MOCK_CLAWHUB_NEXT_CONFLICT === requested) {
    process.stdout.write(JSON.stringify({
      skill: { tags: { latest: current?.version || '1.0.8' } },
      version: { version: requested, files: [] },
    }))
    process.exit(0)
  }
  if (!current || current.version !== requested) {
    process.stderr.write('version not found\\n')
    process.exit(1)
  }
  const files = current.files.map((file, index) => (
    process.env.MOCK_CLAWHUB_FINGERPRINT_MISMATCH === '1' && index === 0
      ? { ...file, sha256: 'f'.repeat(64) }
      : file
  ))
  process.stdout.write(JSON.stringify({
    skill: { tags: { latest: process.env.MOCK_CLAWHUB_LATEST || current.version } },
    version: { version: current.version, files },
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
  const mode = process.env.MOCK_CLAWHUB_VERIFY || 'pass'
  if (mode.startsWith('terminal')) {
    const requested = args[args.indexOf('--version') + 1]
    process.stdout.write(JSON.stringify({
      slug: 'deyo',
      publisherHandle: 'casatwy',
      version: mode === 'terminal-wrong-version' ? '9.9.9' : requested,
      resolvedFrom: 'version',
      ok: false,
      decision: 'fail',
      reasons: mode === 'terminal-extra'
        ? ['security.status_not_clean', 'security.other']
        : ['security.status_not_clean'],
      security: {
        passed: false,
        status: mode === 'terminal-unknown-status' ? 'unknown' : 'suspicious',
        verdict: mode === 'terminal-unknown-status' ? 'unknown' : 'suspicious',
        summary: 'simulated terminal security result',
        signals: { staticScan: { status: 'suspicious', scanId: 'scan-terminal-1' } },
      },
    }))
    process.exit(1)
  }
  process.stdout.write(JSON.stringify(mode === 'pending' ? {
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
  fs.appendFileSync(process.env.MOCK_NPM_LOG, JSON.stringify(args) + '\\n')
  if (process.env.MOCK_NPM_FAIL === '1') {
    process.stderr.write('simulated npm lookup failure\\n')
    process.exit(42)
  }
  process.stdout.write(JSON.stringify(process.env.MOCK_NPM_VERSION || '0.2.3'))
  process.exit(0)
}
if (command === 'pnpm') {
  const failTarget = process.env.MOCK_PNPM_FAIL_ON_TARGET
  if (failTarget) {
    const manifest = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'deyo', 'manifest.json'), 'utf8'))
    const expectedVersion = failTarget === '1' ? '1.0.9' : failTarget
    if (manifest.skillVersion === expectedVersion) {
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
  // A real release writes its target note before running this suite. Keep the
  // fixture independent from whichever release is currently being prepared,
  // otherwise that outer note collides with the fixture's simulated versions.
  await rm(path.join(repo, 'release', 'notes'), { recursive: true, force: true })
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
    MOCK_NPM_LOG: path.join(parent, 'npm.log'),
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
    abandonedDirectory: path.join(repo, '.git', 'deyo-release', 'abandoned'),
    receiptPath: path.join(repo, '.git', 'deyo-release', 'receipts', 'v1.0.9.json'),
    receiptPathFor(version) {
      return path.join(repo, '.git', 'deyo-release', 'receipts', `v${version}.json`)
    },
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

async function createTerminalSecurityRelease(fixture) {
  const result = await fixture.formal([], {
    MOCK_CONFIRM: 'publish deyo v1.0.9',
    MOCK_CLAWHUB_VERIFY: 'terminal',
    MOCK_REVIEW_TIMEOUT_MS: '0',
  })
  assert.equal(result.code, 1)
  assert.match(result.stderr, /verification rejected|security/i)
  const state = await readJson(fixture.statePath)
  assert.equal(state.phase, 'tag_pushed')
  assert.equal(state.targetVersion, '1.0.9')
  return state
}

async function createFixForwardAheadFrozenRelease(fixture) {
  const failed = await createTerminalSecurityRelease(fixture)
  const remoteBase = (await fixture.git(['rev-parse', 'origin/master'])).stdout.trim()
  const abandoned = await fixture.formal(['--fix-forward'], {
    MOCK_CONFIRM: 'fix-forward deyo v1.0.9 to v1.0.10',
    MOCK_CLAWHUB_VERIFY: 'terminal',
  })
  assert.equal(abandoned.code, 0, abandoned.stderr)

  const canonicalPath = path.join(fixture.repo, 'deyo', 'SKILL.md')
  await writeFile(canonicalPath, `${await readFile(canonicalPath, 'utf8')}\n<!-- simulated abortable fix-forward -->\n`)
  await writeFile(path.join(fixture.repo, 'release', 'next.md'), '# Abortable fix-forward\n')
  await checked(process.execPath, ['scripts/generate-providers.mjs'], { cwd: fixture.repo, env: process.env })

  const result = await fixture.formal([], {
    MOCK_CONFIRM: 'publish deyo v1.0.10',
    MOCK_PNPM_FAIL_ON_TARGET: '1.0.10',
  })
  assert.equal(result.code, 1)
  assert.match(result.stderr, /simulated provider E2E failure after freeze/)
  const frozen = await readJson(fixture.statePath)
  assert.equal(frozen.phase, 'frozen')
  assert.equal(frozen.targetVersion, '1.0.10')
  assert.equal(frozen.baseCommit, failed.releaseCommit)
  assert.equal(frozen.remoteBaseCommit, remoteBase)
  await writeFile(path.join(fixture.repo, 'tests', 'after-fix-forward-freeze.txt'), 'fixed after freeze\n')
  return { failed, frozen, remoteBase }
}

test('release dry-run computes 1.0.9 and performs zero repository writes', { timeout: 30_000 }, async () => {
  const fixture = await createFixture()
  try {
    const headBefore = (await fixture.git(['rev-parse', 'HEAD'])).stdout.trim()
    const statusBefore = (await fixture.git(['status', '--porcelain'])).stdout
    const manifestBefore = await readFile(path.join(fixture.repo, 'deyo', 'manifest.json'), 'utf8')
    const result = await fixture.cli(['--dry-run'])
    assert.equal(result.code, 0, result.stderr)
    assert.match(result.stderr, /\[release\] MODE dry-run/)
    assert.match(result.stderr, /\[release\] START Check Git release preflight/)
    assert.match(result.stderr, /\[release\] OK Run ClawHub publish dry-run/)
    assert.doesNotMatch(result.stderr, /\u001B\[/)
    const npmCommands = (await readFile(fixture.env.MOCK_NPM_LOG, 'utf8'))
      .trim().split('\n').map(line => JSON.parse(line))
    assert.deepEqual(npmCommands.at(-1), ['view', '@casatwy/deyo@^0.2.2', 'version', '--json'])
    assert.match(result.stdout, /"0\.2\.3"/)
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

test('release progress is observable before a delayed subprocess exits', { timeout: 30_000 }, async () => {
  const fixture = await createFixture()
  try {
    await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [path.join(fixture.repo, 'scripts', 'release.mjs'), '--dry-run'], {
        cwd: fixture.repo,
        env: { ...fixture.env, MOCK_CLAWHUB_DELAY_MS: '2000' },
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      let stderr = ''
      let settled = false
      const timeout = setTimeout(() => {
        if (settled) return
        settled = true
        child.kill('SIGKILL')
        reject(new Error(`Did not observe live release progress. stderr: ${stderr}`))
      }, 5000)
      child.stderr.on('data', (chunk) => {
        stderr += chunk.toString('utf8')
        if (!settled && stderr.includes('[release] RUN clawhub whoami')) {
          settled = true
          clearTimeout(timeout)
          assert.equal(child.exitCode, null)
          assert.match(stderr, /\[release\] MODE dry-run/)
          assert.match(stderr, /\[release\] START Check local release tooling and ClawHub login/)
          child.kill('SIGTERM')
          resolve()
        }
      })
      child.on('error', (error) => {
        if (settled) return
        settled = true
        clearTimeout(timeout)
        reject(error)
      })
      child.on('close', (code) => {
        if (settled) return
        settled = true
        clearTimeout(timeout)
        reject(new Error(`Release exited ${code} before live progress was observed. stderr: ${stderr}`))
      })
    })
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
    assert.match(aborted.stderr, /\[release\] MODE abort/)
    assert.match(aborted.stderr, /\[release\] OK Archive frozen release state/)
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

test('guarded abort preserves a fix-forward remote base and restarts the same target', { timeout: 90_000 }, async () => {
  const fixture = await createFixture()
  try {
    const { failed, frozen, remoteBase } = await createFixForwardAheadFrozenRelease(fixture)
    const statusBefore = (await fixture.git(['status', '--porcelain'])).stdout
    const aborted = await fixture.formal(['--abort'], { MOCK_CONFIRM: 'abort deyo v1.0.10' })
    assert.equal(aborted.code, 0, aborted.stderr)
    const audit = JSON.parse(aborted.stdout.trim().split('\n').at(-1))
    assert.equal(audit.kind, 'deyo.frozen-release-abort')
    assert.equal(audit.remoteMaster, remoteBase)
    assert.equal(audit.state.remoteBaseCommit, remoteBase)
    assert.equal(audit.state.baseCommit, failed.releaseCommit)
    assert.notEqual(audit.currentSourceSnapshot, frozen.sourceSnapshot)
    await assertMissing(fixture.statePath)
    assert.equal((await fixture.git(['status', '--porcelain'])).stdout, statusBefore)
    assert.equal((await fixture.git(['rev-parse', 'origin/master'])).stdout.trim(), remoteBase)
    assert.equal((await fixture.git(['tag', '--list', 'v1.0.10'])).stdout, '')

    const restarted = await fixture.formal([], { MOCK_CONFIRM: 'publish deyo v1.0.10' })
    assert.equal(restarted.code, 0, restarted.stderr)
    const receipt = await readJson(fixture.receiptPathFor('1.0.10'))
    assert.equal(receipt.skillVersion, '1.0.10')
    const finalHead = (await fixture.git(['rev-parse', 'HEAD'])).stdout.trim()
    assert.equal((await fixture.git(['rev-parse', 'origin/master'])).stdout.trim(), finalHead)
    assert.equal((await fixture.git(['rev-parse', 'HEAD^'])).stdout.trim(), failed.releaseCommit)
    await assertMissing(fixture.statePath)
  }
  finally {
    await fixture.cleanup()
  }
})

test('guarded abort rejects drift from a fix-forward remote base', { timeout: 60_000 }, async () => {
  const fixture = await createFixture()
  try {
    const { frozen } = await createFixForwardAheadFrozenRelease(fixture)
    await fixture.git(['push', 'origin', `${frozen.baseCommit}:refs/heads/master`])
    const aborted = await fixture.formal(['--abort'], { MOCK_CONFIRM: 'abort deyo v1.0.10' })
    assert.equal(aborted.code, 1)
    assert.match(aborted.stderr, /origin\/master no longer matches the frozen base commit/)
    assert.deepEqual(await readJson(fixture.statePath), frozen)
    await assertMissing(fixture.abortedDirectory)
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

test('terminal security fix-forward archives 1.0.9 and activates only pass-clean 1.0.10', { timeout: 60_000 }, async () => {
  const fixture = await createFixture()
  try {
    const failed = await createTerminalSecurityRelease(fixture)
    const remoteBase = (await fixture.git(['rev-parse', 'origin/master'])).stdout.trim()
    const statusBefore = (await fixture.git(['status', '--porcelain'])).stdout
    const fixedForward = await fixture.formal(['--fix-forward'], {
      MOCK_CONFIRM: 'fix-forward deyo v1.0.9 to v1.0.10',
      MOCK_CLAWHUB_VERIFY: 'terminal',
    })
    assert.equal(fixedForward.code, 0, fixedForward.stderr)
    assert.match(fixedForward.stderr, /\[release\] MODE fix-forward/)
    assert.match(fixedForward.stderr, /\[release\] OK Archive terminal fix-forward state/)
    assert.match(fixedForward.stdout, /worktree, tags, ClawHub, latest, and origin\/master will not be changed/)
    const auditResult = JSON.parse(fixedForward.stdout.trim().split('\n').at(-1))
    assert.equal(auditResult.kind, 'deyo.terminal-security-fix-forward')
    assert.equal(auditResult.nextTarget, '1.0.10')
    assert.equal(auditResult.reason, 'security.status_not_clean')
    assert.equal(auditResult.terminalSecurity.security.signals.staticScan.scanId, 'scan-terminal-1')
    assert.equal(auditResult.state.releaseCommit, failed.releaseCommit)
    await assertMissing(fixture.statePath)
    assert.equal((await fixture.git(['status', '--porcelain'])).stdout, statusBefore)
    assert.equal((await fixture.git(['rev-parse', 'origin/master'])).stdout.trim(), remoteBase)
    assert.equal((await fixture.git(['rev-parse', 'refs/tags/v1.0.9^{}'])).stdout.trim(), failed.releaseCommit)

    const auditPath = path.join(fixture.repo, auditResult.archivePath)
    const archivedStatePath = path.join(fixture.repo, auditResult.archivedStatePath)
    assert.equal((await stat(fixture.abandonedDirectory)).mode & 0o777, 0o700)
    assert.equal((await stat(path.dirname(auditPath))).mode & 0o777, 0o700)
    assert.equal((await stat(auditPath)).mode & 0o777, 0o600)
    assert.equal((await stat(archivedStatePath)).mode & 0o777, 0o600)
    assert.deepEqual((await readJson(auditPath)).state, failed)
    assert.deepEqual(await readJson(archivedStatePath), failed)

    const canonicalPath = path.join(fixture.repo, 'deyo', 'SKILL.md')
    await writeFile(canonicalPath, `${await readFile(canonicalPath, 'utf8')}\n<!-- simulated terminal-security fix -->\n`)
    await writeFile(path.join(fixture.repo, 'release', 'next.md'), '# Security fix-forward\n\n- Narrow terminal behavior.\n')
    await checked(process.execPath, ['scripts/generate-providers.mjs'], { cwd: fixture.repo, env: process.env })

    const fixed = await fixture.formal([], { MOCK_CONFIRM: 'publish deyo v1.0.10' })
    assert.equal(fixed.code, 0, fixed.stderr)
    const receipt = await readJson(fixture.receiptPathFor('1.0.10'))
    assert.equal(receipt.skillVersion, '1.0.10')
    assert.equal(receipt.minimumCliVersion, '0.2.2')
    assert.equal(receipt.clawHubProjectionKind, 'openclaw-v1')
    assert.match(receipt.clawHubProjectionTreeHash, /^[a-f0-9]{64}$/)
    assert.notEqual(receipt.clawHubProjectionTreeHash, receipt.canonicalTreeHash)
    const snapshot = path.join(fixture.env.MOCK_CLAWHUB_STATE, 'snapshot')
    await assertMissing(path.join(snapshot, 'agents'))
    const projectedSkill = await readFile(path.join(snapshot, 'SKILL.md'), 'utf8')
    assert.match(projectedSkill, /^user-invocable: true$/m)
    assert.match(projectedSkill, /^disable-model-invocation: true$/m)
    assert.doesNotMatch(projectedSkill, /--language zh\b/)
    await fixture.git(['show', 'v1.0.10:deyo/agents/openai.yaml'])
    const providerMetadata = await readJson(path.join(fixture.repo, 'providers', 'metadata.json'))
    assert.equal(providerMetadata.canonicalTreeHash, receipt.canonicalTreeHash)
    assert.equal(providerMetadata.providers.openclaw.artifactProjection, 'openclaw-v1')
    const newHead = (await fixture.git(['rev-parse', 'HEAD'])).stdout.trim()
    assert.equal((await fixture.git(['rev-parse', 'origin/master'])).stdout.trim(), newHead)
    assert.equal((await fixture.git(['rev-parse', 'HEAD^'])).stdout.trim(), failed.releaseCommit)
    assert.equal((await fixture.git(['merge-base', '--is-ancestor', remoteBase, newHead])).code, 0)
    await assertMissing(fixture.statePath)
  }
  finally {
    await fixture.cleanup()
  }
})

test('successive terminal releases preserve the original remote base and fix-forward again', { timeout: 90_000 }, async () => {
  const fixture = await createFixture()
  try {
    const failed109 = await createTerminalSecurityRelease(fixture)
    const remoteBase = (await fixture.git(['rev-parse', 'origin/master'])).stdout.trim()
    const abandoned109 = await fixture.formal(['--fix-forward'], {
      MOCK_CONFIRM: 'fix-forward deyo v1.0.9 to v1.0.10',
      MOCK_CLAWHUB_VERIFY: 'terminal',
    })
    assert.equal(abandoned109.code, 0, abandoned109.stderr)

    const canonicalPath = path.join(fixture.repo, 'deyo', 'SKILL.md')
    await writeFile(canonicalPath, `${await readFile(canonicalPath, 'utf8')}\n<!-- simulated first security fix -->\n`)
    await writeFile(path.join(fixture.repo, 'release', 'next.md'), '# First security fix-forward\n')
    await checked(process.execPath, ['scripts/generate-providers.mjs'], { cwd: fixture.repo, env: process.env })

    const failed110Result = await fixture.formal([], {
      MOCK_CONFIRM: 'publish deyo v1.0.10',
      MOCK_CLAWHUB_VERIFY: 'terminal',
      MOCK_REVIEW_TIMEOUT_MS: '0',
    })
    assert.equal(failed110Result.code, 1)
    const failed110 = await readJson(fixture.statePath)
    assert.equal(failed110.phase, 'tag_pushed')
    assert.equal(failed110.baseVersion, '1.0.9')
    assert.equal(failed110.targetVersion, '1.0.10')
    assert.equal(failed110.baseCommit, failed109.releaseCommit)
    assert.equal(failed110.remoteBaseCommit, remoteBase)
    assert.equal((await fixture.git(['rev-parse', 'origin/master'])).stdout.trim(), remoteBase)

    const abandoned110 = await fixture.formal(['--fix-forward'], {
      MOCK_CONFIRM: 'fix-forward deyo v1.0.10 to v1.0.11',
      MOCK_CLAWHUB_VERIFY: 'terminal',
    })
    assert.equal(abandoned110.code, 0, abandoned110.stderr)
    const audit110 = JSON.parse(abandoned110.stdout.trim().split('\n').at(-1))
    assert.equal(audit110.nextTarget, '1.0.11')
    assert.equal(audit110.remoteMaster, remoteBase)

    await writeFile(canonicalPath, `${await readFile(canonicalPath, 'utf8')}\n<!-- simulated second security fix -->\n`)
    await writeFile(path.join(fixture.repo, 'release', 'next.md'), '# Second security fix-forward\n')
    await checked(process.execPath, ['scripts/generate-providers.mjs'], { cwd: fixture.repo, env: process.env })

    const fixed111 = await fixture.formal([], { MOCK_CONFIRM: 'publish deyo v1.0.11' })
    assert.equal(fixed111.code, 0, fixed111.stderr)
    const receipt = await readJson(fixture.receiptPathFor('1.0.11'))
    assert.equal(receipt.skillVersion, '1.0.11')
    const finalHead = (await fixture.git(['rev-parse', 'HEAD'])).stdout.trim()
    assert.equal((await fixture.git(['rev-parse', 'origin/master'])).stdout.trim(), finalHead)
    assert.equal((await fixture.git(['rev-parse', 'HEAD^'])).stdout.trim(), failed110.releaseCommit)
    assert.equal((await fixture.git(['rev-parse', 'HEAD^^'])).stdout.trim(), failed109.releaseCommit)
    await assertMissing(fixture.statePath)
  }
  finally {
    await fixture.cleanup()
  }
})

test('terminal security fix-forward rejects unsafe state, evidence, environment, and confirmation', { timeout: 180_000 }, async (t) => {
  const scenarios = [
    { name: 'phase', expected: /tag_pushed/, mutate: async (fixture) => {
      const state = await readJson(fixture.statePath)
      state.phase = 'tagged'
      await writeFile(fixture.statePath, `${JSON.stringify(state, null, 2)}\n`)
    } },
    { name: 'receipt', expected: /success receipt/, mutate: async (fixture) => {
      await mkdir(path.dirname(fixture.receiptPath), { recursive: true })
      await writeFile(fixture.receiptPath, '{}\n')
    } },
    { name: 'head', expected: /local master/, mutate: async (fixture) => {
      await writeFile(path.join(fixture.repo, 'tests', 'head-drift.txt'), 'drift\n')
      await fixture.git(['add', '-A'])
      await fixture.git(['commit', '-m', 'head drift'])
    } },
    { name: 'remote', expected: /origin\/master/, mutate: async (fixture) => {
      const failed = await readJson(fixture.statePath)
      await fixture.git(['push', 'origin', `${failed.releaseCommit}:refs/heads/master`])
    } },
    { name: 'local-tag', expected: /Local tag/, mutate: async (fixture) => {
      await fixture.git(['tag', '-f', 'v1.0.9', 'HEAD^'])
    } },
    { name: 'remote-tag', expected: /Remote tag/, mutate: async (fixture) => {
      const failed = await readJson(fixture.statePath)
      const parent = (await fixture.git(['rev-parse', `${failed.releaseCommit}^`])).stdout.trim()
      await fixture.git(['tag', '-f', 'remote-wrong', parent])
      await fixture.git(['push', '--force', 'origin', 'refs/tags/remote-wrong:refs/tags/v1.0.9'])
    } },
    { name: 'tree', expected: /Tagged artifact tree/, mutate: async (fixture) => {
      const state = await readJson(fixture.statePath)
      state.canonicalTreeHash = 'f'.repeat(64)
      await writeFile(fixture.statePath, `${JSON.stringify(state, null, 2)}\n`)
    } },
    { name: 'state-fingerprint', expected: /frozen file fingerprint/, mutate: async (fixture) => {
      const state = await readJson(fixture.statePath)
      state.clawHubFileFingerprint = [{ path: 'SKILL.md', size: 1, sha256: 'f'.repeat(64) }]
      await writeFile(fixture.statePath, `${JSON.stringify(state, null, 2)}\n`)
    } },
    { name: 'fingerprint', expected: /different artifact fingerprint/, env: { MOCK_CLAWHUB_FINGERPRINT_MISMATCH: '1' } },
    { name: 'verdict', expected: /terminal suspicious verification failure only/, env: { MOCK_CLAWHUB_VERIFY: 'terminal-extra' } },
    { name: 'verdict-identity', expected: /exact @casatwy\/deyo@1\.0\.9/, env: { MOCK_CLAWHUB_VERIFY: 'terminal-wrong-version' } },
    { name: 'verdict-status', expected: /terminal suspicious verification/, env: { MOCK_CLAWHUB_VERIFY: 'terminal-unknown-status' } },
    { name: 'latest', expected: /latest is not/, env: { MOCK_CLAWHUB_LATEST: '1.0.8' } },
    { name: 'higher', expected: /highest version/, env: { MOCK_CLAWHUB_HIGHER: '1' } },
    { name: 'next', expected: /next patch 1\.0\.10 already exists/, env: { MOCK_CLAWHUB_NEXT_CONFLICT: '1.0.10' } },
    { name: 'confirmation', expected: /confirmation mismatch/, confirm: 'wrong' },
    { name: 'non-tty', expected: /interactive TTY/, nonTty: true },
    { name: 'ci', expected: /forbidden in CI/, env: { CI: 'true' } },
  ]
  for (const scenario of scenarios) {
    await t.test(scenario.name, async () => {
      const fixture = await createFixture()
      try {
        await createTerminalSecurityRelease(fixture)
        if (scenario.mutate) await scenario.mutate(fixture)
        const env = { MOCK_CLAWHUB_VERIFY: 'terminal', ...(scenario.env || {}) }
        const result = scenario.nonTty
          ? await fixture.cli(['--fix-forward'], env)
          : await fixture.formal(['--fix-forward'], {
              ...env,
              MOCK_CONFIRM: scenario.confirm || 'fix-forward deyo v1.0.9 to v1.0.10',
            })
        assert.equal(result.code, 1, result.stderr)
        assert.match(result.stderr, scenario.expected)
        await access(fixture.statePath)
        await assertMissing(fixture.abandonedDirectory)
      }
      finally {
        await fixture.cleanup()
      }
    })
  }
})

test('formal release rejects environment, confirmation, auth, and npm prerequisite failures before state', { timeout: 45_000 }, async (t) => {
  for (const scenario of ['non-tty', 'ci', 'confirmation', 'auth', 'npm', 'npm-old']) {
    await t.test(scenario, async () => {
      const fixture = await createFixture()
      try {
        let result
        if (scenario === 'non-tty') result = await fixture.cli([])
        else if (scenario === 'ci') result = await fixture.cli([], { CI: 'true' })
        else if (scenario === 'confirmation') result = await fixture.formal([], { MOCK_CONFIRM: 'wrong' })
        else if (scenario === 'auth') result = await fixture.cli(['--dry-run'], { MOCK_CLAWHUB_ACCOUNT: 'someone-else' })
        else if (scenario === 'npm') result = await fixture.cli(['--dry-run'], { MOCK_NPM_FAIL: '1' })
        else result = await fixture.cli(['--dry-run'], { MOCK_NPM_VERSION: '0.2.1' })
        assert.equal(result.code, 1)
        if (scenario === 'non-tty') assert.match(result.stderr, /interactive TTY/)
        if (scenario === 'ci') assert.match(result.stderr, /forbidden in CI/)
        if (scenario === 'confirmation') assert.match(result.stderr, /confirmation mismatch/)
        if (scenario === 'auth') assert.match(result.stderr, /login must be casatwy/)
        if (scenario === 'npm') {
          assert.match(result.stderr, /published @casatwy\/deyo version satisfying \^0\.2\.2 is required/)
          assert.match(result.stderr, /FAIL Verify minimum npm CLI version \([^\n]+; exit=42\)/)
          assert.match(result.stderr, /FAILURE stage=Verify minimum npm CLI version; exit=42; recovery_phase=none/)
          assert.equal(result.stderr.match(/simulated npm lookup failure/g)?.length, 1)
        }
        if (scenario === 'npm-old') {
          assert.match(result.stderr, /Published @casatwy\/deyo 0\.2\.1 does not satisfy minimum CLI 0\.2\.2/)
          assert.match(result.stderr, /FAILURE stage=Verify minimum npm CLI version; recovery_phase=none/)
        }
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
    assert.match(result.stderr, /\[release\] MODE publish/)
    assert.match(result.stderr, /\[release\] OK Write release receipt/)
    const receipt = await readJson(fixture.receiptPath)
    const archivedPath = path.join(fixture.repo, receipt.releaseNotesPath)
    const archived = await readFile(archivedPath, 'utf8')
    assert.equal(receipt.skillVersion, '1.0.9')
    assert.equal(receipt.clawHubLicense, 'MIT-0')
    assert.equal(receipt.clawHubProjectionKind, 'legacy-full')
    assert.equal(receipt.clawHubProjectionTreeHash, receipt.canonicalTreeHash)
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
    assert.match(pending.stderr, /\[release\] POLL ClawHub review:/)
    assert.match(pending.stderr, /recovery_phase=tag_pushed/)
    assert.match(pending.stderr, /next="make publish RESUME=1"/)
    assert.equal((await readJson(fixture.statePath)).phase, 'tag_pushed')
    const resumed = await fixture.formal(['--resume'], {
      MOCK_CONFIRM: 'resume deyo v1.0.9',
    })
    assert.equal(resumed.code, 0, resumed.stderr)
    assert.match(resumed.stderr, /\[release\] MODE resume/)
    assert.match(resumed.stderr, /\[release\] SKIP Prepare release workspace \(recovery phase tag_pushed\)/)
    assert.match(resumed.stderr, /\[release\] SKIP Push immutable release tag \(recovery phase tag_pushed\)/)
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
        assert.match(failed.stderr, /\[release\] FAIL (Push immutable release tag|Push verified release to master)/)
        assert.match(failed.stderr, new RegExp(`recovery_phase=${failure.phase}`))
        assert.match(failed.stderr, /exit=42/)
        assert.match(failed.stderr, /next="make publish RESUME=1"/)
        assert.equal(
          failed.stderr.match(new RegExp(`simulated ${failure.kind} push failure`, 'g'))?.length,
          1,
        )
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

test('clawhub-ready resume rejects projection evidence drift before activating master', { timeout: 30_000 }, async () => {
  const fixture = await createFixture()
  try {
    const failed = await fixture.formal([], {
      MOCK_CONFIRM: 'publish deyo v1.0.9',
      MOCK_GIT_FAIL_KIND: 'master',
    })
    assert.equal(failed.code, 1)
    const state = await readJson(fixture.statePath)
    assert.equal(state.phase, 'clawhub_ready')
    state.clawHubProjectionTreeHash = 'f'.repeat(64)
    state.clawHubFileFingerprint = [{ path: 'SKILL.md', size: 1, sha256: 'e'.repeat(64) }]
    await writeFile(fixture.statePath, `${JSON.stringify(state, null, 2)}\n`)

    const resumed = await fixture.formal(['--resume'], {
      MOCK_CONFIRM: 'resume deyo v1.0.9',
    })
    assert.equal(resumed.code, 1)
    assert.match(resumed.stderr, /projection tree hash differs/)
    assert.notEqual(
      (await fixture.git(['rev-parse', 'origin/master'])).stdout.trim(),
      state.releaseCommit,
    )
    await access(fixture.statePath)
  }
  finally {
    await fixture.cleanup()
  }
})
