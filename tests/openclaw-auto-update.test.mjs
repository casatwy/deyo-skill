import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { chmod, mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  isDue,
  isVerificationClean,
  parseArguments,
  performUpdate,
  runWithDeadline,
  updateSucceeded,
} from '../deyo/scripts/openclaw-auto-update.mjs'

const cleanEnvelope = {
  schema: 'clawhub.skill.verify.v1',
  ok: true,
  decision: 'pass',
  security: { passed: true, status: 'clean' },
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

test('OpenClaw check defaults global and only accepts explicit active scope', () => {
  assert.deepEqual(parseArguments([]), { help: false, scope: 'global' })
  assert.deepEqual(parseArguments(['--scope', 'workspace']), { help: false, scope: 'workspace' })
  assert.throws(() => parseArguments(['--scope', 'user']), /Usage/)
  assert.throws(() => parseArguments(['--all']), /Usage/)
})

test('OpenClaw throttle uses lastAttemptAt and a full 24-hour interval', () => {
  const now = Date.parse('2026-07-16T00:00:00.000Z')
  assert.equal(isDue(null, now), true)
  assert.equal(isDue({ lastAttemptAt: '2026-07-15T00:00:01.000Z' }, now), false)
  assert.equal(isDue({ lastAttemptAt: '2026-07-15T00:00:00.000Z' }, now), true)
})

test('security verification must be explicitly pass and clean', () => {
  assert.equal(isVerificationClean(cleanEnvelope), true)
  assert.equal(isVerificationClean({ ...cleanEnvelope, decision: 'review' }), false)
  assert.equal(isVerificationClean({ ...cleanEnvelope, security: { passed: true, status: 'pending' } }), false)
})

test('OpenClaw update uses owner-qualified native commands without bypass flags', async () => {
  const calls = []
  const run = async (command, args, options) => {
    calls.push({ command, args, options })
    if (args[1] === 'verify') return { code: 0, stdout: JSON.stringify(cleanEnvelope), stderr: '' }
    return { code: 0, stdout: 'Updated @casatwy/deyo\n', stderr: '' }
  }
  const result = await performUpdate({ scope: 'global', run, now: 1_000, cwd: '/tmp', env: {} })
  assert.deepEqual(result, { status: 'updated' })
  assert.deepEqual(calls.map(call => call.args), [
    ['skills', 'verify', '@casatwy/deyo', '--global'],
    ['skills', 'update', '@casatwy/deyo', '--global'],
  ])
  assert.equal(calls.every(call => call.options.deadline === 21_000), true)
  assert.equal(calls.flatMap(call => call.args).includes('--force'), false)
  assert.equal(calls.flatMap(call => call.args).includes('--all'), false)
})

test('verification failure never runs update and does not block existing skill', async () => {
  let calls = 0
  const run = async () => {
    calls += 1
    return { code: 0, stdout: JSON.stringify({ ...cleanEnvelope, decision: 'review' }), stderr: '' }
  }
  assert.deepEqual(await performUpdate({ scope: 'workspace', run, now: 0 }), { status: 'verification_failed' })
  assert.equal(calls, 1)
})

test('update output distinguishes current and changed installs', () => {
  assert.equal(updateSucceeded('Already up-to-date'), false)
  assert.equal(updateSucceeded('No updates available'), false)
  assert.equal(updateSucceeded('Updated @casatwy/deyo'), true)
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

test('real check isolates child output and creates private throttle state', async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'deyo-openclaw-update-'))
  try {
    const bin = path.join(temporary, 'bin')
    const cache = path.join(temporary, 'cache')
    await mkdir(bin)
    const fake = path.join(bin, 'openclaw')
    await writeFile(fake, `#!/bin/sh
if [ "$2" = "verify" ]; then
  printf '%s\\n' '${JSON.stringify(cleanEnvelope)}'
else
  printf '%s\\n' 'Updated @casatwy/deyo'
fi
`)
    await chmod(fake, 0o755)
    const env = {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      XDG_CACHE_HOME: cache,
    }

    const first = await runScript(env)
    assert.equal(first.code, 10)
    assert.equal(first.stdout, '')
    assert.match(first.stderr, /请重新发起/)
    const directory = path.join(cache, 'deyo', 'openclaw-skill-update')
    const statePath = path.join(directory, 'global.json')
    assert.equal((await stat(directory)).mode & 0o777, 0o700)
    assert.equal((await stat(statePath)).mode & 0o777, 0o600)
    assert.equal(JSON.parse(await readFile(statePath, 'utf8')).lastStatus, 'updated')

    const second = await runScript(env)
    assert.deepEqual(second, { code: 0, stdout: '', stderr: '' })
  }
  finally {
    await rm(temporary, { recursive: true, force: true })
  }
})
