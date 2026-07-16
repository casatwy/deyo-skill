import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { chmod, mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  isAutoUpdateDisabled,
  isDue,
  isVerificationClean,
  parseArguments,
  performUpdate,
  readManagedOrigin,
  resolveManagedOriginPath,
  runWithDeadline,
} from '../deyo/scripts/openclaw-auto-update.mjs'

function cleanEnvelope(fromVersion = '1.0.9', candidateVersion = '1.0.10') {
  return {
    schema: 'clawhub.skill.verify.v1',
    slug: 'deyo',
    publisherHandle: 'casatwy',
    version: candidateVersion,
    resolvedFrom: 'tag',
    tag: 'latest',
    ok: true,
    decision: 'pass',
    security: { passed: true, status: 'clean' },
    openclaw: {
      resolution: {
        source: 'installed',
        selector: 'tag',
        installedVersion: fromVersion,
      },
    },
  }
}

const scriptPath = fileURLToPath(new URL('../deyo/scripts/openclaw-auto-update.mjs', import.meta.url))

async function runScript(environment) {
  return await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [scriptPath], {
      env: environment,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const stdout = []
    const stderr = []
    child.stdout.on('data', chunk => stdout.push(chunk))
    child.stderr.on('data', chunk => stderr.push(chunk))
    child.on('error', reject)
    child.on('close', code => resolve({
      code,
      stdout: Buffer.concat(stdout).toString('utf8'),
      stderr: Buffer.concat(stderr).toString('utf8'),
    }))
  })
}

async function writeOrigin(target, version, overrides = {}) {
  await mkdir(path.dirname(target), { recursive: true })
  await writeFile(target, `${JSON.stringify({
    version: 1,
    registry: 'https://clawhub.ai',
    slug: 'deyo',
    ownerHandle: 'casatwy',
    installedVersion: version,
    installedAt: Date.parse('2026-07-16T00:00:00.000Z'),
    fingerprint: 'a'.repeat(64),
    ...overrides,
  })}\n`, { mode: 0o600 })
}

test('OpenClaw check defaults global and only accepts explicit active scope', () => {
  assert.deepEqual(parseArguments([]), { help: false, scope: 'global' })
  assert.deepEqual(parseArguments(['--scope', 'workspace']), { help: false, scope: 'workspace' })
  assert.throws(() => parseArguments(['--scope', 'user']), /Usage/)
  assert.throws(() => parseArguments(['--all']), /Usage/)
})

test('OpenClaw throttle and explicit opt-out are deterministic', () => {
  const now = Date.parse('2026-07-16T00:00:00.000Z')
  assert.equal(isDue(null, now), true)
  assert.equal(isDue({ lastAttemptAt: '2026-07-15T00:00:01.000Z' }, now), false)
  assert.equal(isDue({ lastAttemptAt: '2026-07-15T00:00:00.000Z' }, now), true)
  assert.equal(isAutoUpdateDisabled({ DEYO_OPENCLAW_AUTO_UPDATE: '0' }), true)
  assert.equal(isAutoUpdateDisabled({ DEYO_OPENCLAW_AUTO_UPDATE: 'false' }), false)
})

test('managed origin resolution follows active scope and official schema', async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'deyo-openclaw-origin-'))
  try {
    const env = { HOME: path.join(temporary, 'home'), OPENCLAW_STATE_DIR: path.join(temporary, 'state') }
    const globalPath = resolveManagedOriginPath({ scope: 'global', cwd: temporary, env })
    const workspacePath = resolveManagedOriginPath({ scope: 'workspace', cwd: temporary, env })
    assert.equal(globalPath, path.join(env.OPENCLAW_STATE_DIR, 'skills', 'deyo', '.clawhub', 'origin.json'))
    assert.equal(workspacePath, path.join(temporary, 'skills', 'deyo', '.clawhub', 'origin.json'))
    await writeOrigin(globalPath, '1.0.9')
    assert.deepEqual(await readManagedOrigin(globalPath), {
      ok: true,
      path: globalPath,
      registry: 'https://clawhub.ai',
      ownerHandle: 'casatwy',
      slug: 'deyo',
      version: '1.0.9',
      fingerprint: 'a'.repeat(64),
    })
    await writeOrigin(workspacePath, '1.0.8', { ownerHandle: undefined, owner: 'casatwy' })
    assert.deepEqual(await readManagedOrigin(workspacePath), {
      ok: false,
      reason: 'invalid_origin',
      path: workspacePath,
    })
  }
  finally {
    await rm(temporary, { recursive: true, force: true })
  }
})

test('candidate verification requires exact owner, slug, stable tag resolution, and pass-clean security', () => {
  const clean = cleanEnvelope()
  assert.equal(isVerificationClean(clean, '1.0.9'), true)
  assert.equal(isVerificationClean({ ...clean, publisherHandle: 'attacker' }, '1.0.9'), false)
  assert.equal(isVerificationClean({ ...clean, slug: '@other/deyo' }, '1.0.9'), false)
  assert.equal(isVerificationClean({ ...clean, version: 'latest' }, '1.0.9'), false)
  assert.equal(isVerificationClean({ ...clean, resolvedFrom: 'version' }, '1.0.9'), false)
  assert.equal(isVerificationClean({ ...clean, tag: 'preview' }, '1.0.9'), false)
  assert.equal(isVerificationClean({ ...clean, decision: 'review' }, '1.0.9'), false)
  assert.equal(isVerificationClean({ ...clean, security: { passed: true, status: 'pending' } }, '1.0.9'), false)
  assert.equal(isVerificationClean(cleanEnvelope('1.0.9', '1.0.8'), '1.0.9'), false)
})

test('OpenClaw update verifies latest candidate and detects change from origin metadata only', async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'deyo-openclaw-perform-'))
  try {
    const env = { HOME: temporary, OPENCLAW_STATE_DIR: path.join(temporary, 'state') }
    const originPath = resolveManagedOriginPath({ scope: 'global', cwd: temporary, env })
    await writeOrigin(originPath, '1.0.9')
    const calls = []
    const run = async (command, args, options) => {
      calls.push({ command, args, options })
      if (args[1] === 'verify') {
        return { code: 0, stdout: JSON.stringify(cleanEnvelope()), stderr: 'scanner detail must stay private' }
      }
      await writeOrigin(originPath, '1.0.10')
      return { code: 0, stdout: 'localized output is irrelevant', stderr: 'secret child output' }
    }
    const result = await performUpdate({ scope: 'global', run, now: 1_000, cwd: temporary, env })
    assert.deepEqual(result, {
      status: 'updated',
      fromVersion: '1.0.9',
      toVersion: '1.0.10',
      verifiedVersion: '1.0.10',
      reloadRequired: true,
    })
    assert.deepEqual(calls.map(call => call.args), [
      ['skills', 'verify', '@casatwy/deyo', '--tag', 'latest', '--global'],
      ['skills', 'update', '@casatwy/deyo', '--global'],
    ])
    assert.equal(calls.every(call => call.options.deadline === 21_000), true)
    assert.doesNotMatch(JSON.stringify(calls.map(call => call.args)), /--all|--force|acknowledge/)
  }
  finally {
    await rm(temporary, { recursive: true, force: true })
  }
})

test('unchanged origin continues without interpreting native command text', async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'deyo-openclaw-unchanged-'))
  try {
    const env = { HOME: temporary, OPENCLAW_STATE_DIR: path.join(temporary, 'state') }
    const originPath = resolveManagedOriginPath({ scope: 'global', cwd: temporary, env })
    await writeOrigin(originPath, '1.0.10')
    const run = async (command, args) => args[1] === 'verify'
      ? { code: 0, stdout: JSON.stringify(cleanEnvelope('1.0.10', '1.0.10')), stderr: '' }
      : { code: 0, stdout: 'Updated upgraded installed', stderr: '' }
    assert.deepEqual(await performUpdate({ scope: 'global', run, now: 0, cwd: temporary, env }), {
      status: 'up_to_date',
      fromVersion: '1.0.10',
      toVersion: '1.0.10',
      verifiedVersion: '1.0.10',
      reloadRequired: false,
    })
  }
  finally {
    await rm(temporary, { recursive: true, force: true })
  }
})

test('verification and native update failures keep the installed version usable', async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'deyo-openclaw-failure-'))
  try {
    const env = { HOME: temporary, OPENCLAW_STATE_DIR: path.join(temporary, 'state') }
    const originPath = resolveManagedOriginPath({ scope: 'global', cwd: temporary, env })
    await writeOrigin(originPath, '1.0.9')
    let calls = 0
    const verificationFailure = await performUpdate({
      scope: 'global', cwd: temporary, env, now: 0,
      run: async () => {
        calls += 1
        return { code: 0, stdout: JSON.stringify({ ...cleanEnvelope(), decision: 'review' }), stderr: '' }
      },
    })
    assert.equal(verificationFailure.status, 'verification_failed')
    assert.equal(verificationFailure.reloadRequired, false)
    assert.equal(calls, 1)

    const updateFailure = await performUpdate({
      scope: 'global', cwd: temporary, env, now: 0,
      run: async (command, args) => args[1] === 'verify'
        ? { code: 0, stdout: JSON.stringify(cleanEnvelope()), stderr: '' }
        : { code: 1, stdout: '', stderr: 'blocked by trust policy' },
    })
    assert.equal(updateFailure.status, 'update_failed')
    assert.equal(updateFailure.toVersion, '1.0.9')
    assert.equal(updateFailure.reloadRequired, false)
  }
  finally {
    await rm(temporary, { recursive: true, force: true })
  }
})

test('a nonzero update exit reloads when managed origin changed before failure', async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'deyo-openclaw-partial-failure-'))
  try {
    const env = { HOME: temporary, OPENCLAW_STATE_DIR: path.join(temporary, 'state') }
    const originPath = resolveManagedOriginPath({ scope: 'global', cwd: temporary, env })
    await writeOrigin(originPath, '1.0.9')
    const result = await performUpdate({
      scope: 'global', cwd: temporary, env, now: 0,
      run: async (command, args) => {
        if (args[1] === 'verify') {
          return { code: 0, stdout: JSON.stringify(cleanEnvelope()), stderr: '' }
        }
        await writeOrigin(originPath, '1.0.10')
        return { code: 1, stdout: '', stderr: 'failed after replacing the installed skill' }
      },
    })
    assert.deepEqual(result, {
      status: 'updated',
      fromVersion: '1.0.9',
      toVersion: '1.0.10',
      verifiedVersion: '1.0.10',
      reloadRequired: true,
    })
  }
  finally {
    await rm(temporary, { recursive: true, force: true })
  }
})

test('an indeterminate update outcome conservatively requires reload', async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'deyo-openclaw-indeterminate-'))
  try {
    const env = { HOME: temporary, OPENCLAW_STATE_DIR: path.join(temporary, 'state') }
    const originPath = resolveManagedOriginPath({ scope: 'global', cwd: temporary, env })
    await writeOrigin(originPath, '1.0.9')
    const result = await performUpdate({
      scope: 'global', cwd: temporary, env, now: 0,
      run: async (command, args) => {
        if (args[1] === 'verify') return { code: 0, stdout: JSON.stringify(cleanEnvelope()), stderr: '' }
        throw new Error('timeout after possible mutation')
      },
    })
    assert.equal(result.status, 'update_indeterminate')
    assert.equal(result.reloadRequired, true)
    assert.equal(result.toVersion, null)
  }
  finally {
    await rm(temporary, { recursive: true, force: true })
  }
})

test('OpenClaw native checks share a hard deadline', async () => {
  const startedAt = Date.now()
  await assert.rejects(runWithDeadline(
    process.execPath,
    ['-e', 'setTimeout(() => {}, 1000)'],
    { deadline: startedAt + 50, cwd: process.cwd(), env: process.env },
  ), /timed out/)
  assert.ok(Date.now() - startedAt < 500)
})

test('real check isolates child output and records private auditable state', async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'deyo-openclaw-update-'))
  try {
    const bin = path.join(temporary, 'bin')
    const cache = path.join(temporary, 'cache')
    const stateRoot = path.join(temporary, 'openclaw-state')
    const originPath = path.join(stateRoot, 'skills', 'deyo', '.clawhub', 'origin.json')
    const commandLog = path.join(temporary, 'commands.log')
    await mkdir(bin)
    await writeOrigin(originPath, '1.0.9')
    const fake = path.join(bin, 'openclaw')
    await writeFile(fake, `#!/usr/bin/env node
const fs = require('node:fs')
const args = process.argv.slice(2)
fs.appendFileSync(process.env.TEST_COMMAND_LOG, JSON.stringify(args) + '\\n')
if (args[1] === 'verify') {
  process.stdout.write(JSON.stringify(${JSON.stringify(cleanEnvelope())}))
  process.stderr.write('private verify output')
  process.exit(0)
}
const target = process.env.TEST_ORIGIN_PATH
const origin = JSON.parse(fs.readFileSync(target, 'utf8'))
origin.installedVersion = '1.0.10'
fs.writeFileSync(target, JSON.stringify(origin))
process.stdout.write('private update output')
process.stderr.write('private update error')
`)
    await chmod(fake, 0o755)
    const env = {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      XDG_CACHE_HOME: cache,
      OPENCLAW_STATE_DIR: stateRoot,
      TEST_ORIGIN_PATH: originPath,
      TEST_COMMAND_LOG: commandLog,
    }

    const first = await runScript(env)
    assert.equal(first.code, 10)
    assert.equal(first.stdout, '')
    assert.match(first.stderr, /请重新发起/)
    assert.doesNotMatch(first.stderr, /private/)
    const directory = path.join(cache, 'deyo', 'openclaw-skill-update')
    const statePath = path.join(directory, 'global.json')
    assert.equal((await stat(directory)).mode & 0o777, 0o700)
    assert.equal((await stat(statePath)).mode & 0o777, 0o600)
    const state = JSON.parse(await readFile(statePath, 'utf8'))
    assert.deepEqual({
      schema: state.schema,
      attempt: state.attempt,
      status: state.status,
      fromVersion: state.fromVersion,
      toVersion: state.toVersion,
      verifiedVersion: state.verifiedVersion,
    }, {
      schema: 2,
      attempt: 1,
      status: 'updated',
      fromVersion: '1.0.9',
      toVersion: '1.0.10',
      verifiedVersion: '1.0.10',
    })
    assert.match(state.reloadRequiredAt, /^\d{4}-\d{2}-\d{2}T/)

    const second = await runScript(env)
    assert.deepEqual(second, { code: 0, stdout: '', stderr: '' })
    const commands = (await readFile(commandLog, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
    assert.deepEqual(commands, [
      ['skills', 'verify', '@casatwy/deyo', '--tag', 'latest', '--global'],
      ['skills', 'update', '@casatwy/deyo', '--global'],
    ])
  }
  finally {
    await rm(temporary, { recursive: true, force: true })
  }
})

test('opt-out creates no cache state and starts no OpenClaw process', async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'deyo-openclaw-optout-'))
  try {
    const cache = path.join(temporary, 'cache')
    const result = await runScript({
      ...process.env,
      DEYO_OPENCLAW_AUTO_UPDATE: '0',
      XDG_CACHE_HOME: cache,
      PATH: '',
    })
    assert.deepEqual(result, { code: 0, stdout: '', stderr: '' })
    await assert.rejects(stat(cache), { code: 'ENOENT' })
  }
  finally {
    await rm(temporary, { recursive: true, force: true })
  }
})
