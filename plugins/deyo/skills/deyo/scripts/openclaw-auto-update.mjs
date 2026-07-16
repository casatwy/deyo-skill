#!/usr/bin/env node

import { spawn } from 'node:child_process'
import { constants } from 'node:fs'
import { chmod, lstat, mkdir, open, readFile, rename, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'

const DAY_MS = 24 * 60 * 60 * 1000
const TIMEOUT_MS = 20_000
const OWNER = 'casatwy'
const SLUG = 'deyo'
const REGISTRY = 'https://clawhub.ai'
const OWNER_QUALIFIED_SKILL = `@${OWNER}/${SLUG}`
const UPDATED_EXIT_CODE = 10
const STABLE_SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/

export function parseArguments(argv) {
  if (argv.includes('--help')) return { help: true, scope: 'global' }
  if (argv.length === 0) return { help: false, scope: 'global' }
  if (argv.length === 2 && argv[0] === '--scope' && ['global', 'workspace'].includes(argv[1])) {
    return { help: false, scope: argv[1] }
  }
  throw new Error('Usage: openclaw-auto-update.mjs [--scope global|workspace]')
}

export function isDue(state, now = Date.now()) {
  const lastAttempt = Date.parse(state?.lastAttemptAt ?? '')
  return !Number.isFinite(lastAttempt) || now - lastAttempt >= DAY_MS
}

export function isAutoUpdateDisabled(environment = process.env) {
  return environment.DEYO_OPENCLAW_AUTO_UPDATE === '0'
}

function normalizeOwner(value) {
  return typeof value === 'string' ? value.trim().replace(/^@/, '').toLowerCase() : ''
}

function normalizeSlug(value) {
  if (typeof value !== 'string') return ''
  return value.trim().replace(/^@casatwy\//i, '').toLowerCase()
}

function compareSemver(left, right) {
  if (!STABLE_SEMVER.test(left) || !STABLE_SEMVER.test(right)) return null
  const a = left.split('.').map(Number)
  const b = right.split('.').map(Number)
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index] - b[index]
  }
  return 0
}

export function isVerificationClean(envelope, expectedInstalledVersion = null) {
  const candidateVersion = envelope?.version
  const installedVersion = envelope?.openclaw?.resolution?.installedVersion
  return envelope?.schema === 'clawhub.skill.verify.v1'
    && normalizeOwner(envelope?.publisherHandle) === OWNER
    && normalizeSlug(envelope?.slug) === SLUG
    && typeof candidateVersion === 'string'
    && STABLE_SEMVER.test(candidateVersion)
    && envelope?.resolvedFrom === 'tag'
    && envelope?.tag === 'latest'
    && envelope?.openclaw?.resolution?.source === 'installed'
    && envelope?.openclaw?.resolution?.selector === 'tag'
    && (!expectedInstalledVersion || installedVersion === expectedInstalledVersion)
    && (!expectedInstalledVersion || compareSemver(candidateVersion, expectedInstalledVersion) >= 0)
    && envelope?.ok === true
    && envelope?.decision === 'pass'
    && envelope?.security?.passed === true
    && envelope?.security?.status === 'clean'
}

function cacheDirectory(environment = process.env) {
  const cacheRoot = environment.XDG_CACHE_HOME || path.join(environment.HOME || os.homedir(), '.cache')
  return path.join(cacheRoot, 'deyo', 'openclaw-skill-update')
}

export function resolveManagedOriginPath({ scope, cwd = process.cwd(), env = process.env }) {
  if (scope === 'workspace') {
    return path.resolve(cwd, 'skills', SLUG, '.clawhub', 'origin.json')
  }
  const home = env.HOME || os.homedir()
  const stateDirectory = env.OPENCLAW_STATE_DIR
    ? path.resolve(env.OPENCLAW_STATE_DIR)
    : path.join(path.resolve(env.OPENCLAW_HOME || home), '.openclaw')
  return path.join(stateDirectory, 'skills', SLUG, '.clawhub', 'origin.json')
}

export async function readManagedOrigin(originPath) {
  try {
    const stats = await lstat(originPath)
    if (!stats.isFile() || stats.isSymbolicLink()) return { ok: false, reason: 'unsafe_origin', path: originPath }
    const raw = JSON.parse(await readFile(originPath, 'utf8'))
    const ownerHandle = normalizeOwner(raw?.ownerHandle)
    const slug = normalizeSlug(raw?.slug)
    const version = raw?.installedVersion
    const fingerprint = raw?.fingerprint
    const registry = typeof raw?.registry === 'string' ? raw.registry.replace(/\/+$/, '') : ''
    if (
      raw?.version !== 1
      || registry !== REGISTRY
      || ownerHandle !== OWNER
      || slug !== SLUG
      || typeof version !== 'string'
      || !STABLE_SEMVER.test(version)
      || !Number.isFinite(raw?.installedAt)
      || !/^[a-f0-9]{64}$/.test(fingerprint ?? '')
    ) {
      return { ok: false, reason: 'invalid_origin', path: originPath }
    }
    return { ok: true, path: originPath, registry, ownerHandle, slug, version, fingerprint }
  }
  catch (error) {
    return {
      ok: false,
      reason: error?.code === 'ENOENT' ? 'missing_origin' : 'unreadable_origin',
      path: originPath,
    }
  }
}

async function readState(statePath) {
  try {
    return JSON.parse(await readFile(statePath, 'utf8'))
  }
  catch (error) {
    if (error?.code === 'ENOENT') return null
    throw error
  }
}

async function writePrivateJson(target, value) {
  const temporary = `${target}.${process.pid}.tmp`
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: 'wx' })
  await chmod(temporary, 0o600)
  await rename(temporary, target)
  await chmod(target, 0o600)
}

async function acquireLock(lockPath) {
  try {
    const handle = await open(lockPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600)
    await handle.writeFile(`${process.pid}\n`)
    await handle.sync()
    return handle
  }
  catch (error) {
    if (error?.code === 'EEXIST') return null
    throw error
  }
}

export async function runWithDeadline(command, args, options = {}) {
  const remainingMs = options.deadline - Date.now()
  if (remainingMs <= 0) throw new Error('OpenClaw update check timed out')
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const stdout = []
    const stderr = []
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGKILL')
    }, remainingMs)
    child.stdout.on('data', chunk => stdout.push(chunk))
    child.stderr.on('data', chunk => stderr.push(chunk))
    child.on('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.on('close', (code, signal) => {
      clearTimeout(timer)
      const result = {
        code,
        signal,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
      }
      if (timedOut) reject(new Error('OpenClaw update check timed out'))
      else resolve(result)
    })
  })
}

export async function performUpdate({
  scope,
  run = runWithDeadline,
  now = Date.now(),
  cwd = process.cwd(),
  env = process.env,
  beforeOrigin = null,
}) {
  const deadline = now + TIMEOUT_MS
  const scopeArgs = scope === 'global' ? ['--global'] : []
  const originPath = resolveManagedOriginPath({ scope, cwd, env })
  const before = beforeOrigin ?? await readManagedOrigin(originPath)
  if (!before.ok) {
    return { status: 'origin_unavailable', fromVersion: null, toVersion: null, verifiedVersion: null, reloadRequired: false }
  }

  let verification
  try {
    verification = await run('openclaw', [
      'skills', 'verify', OWNER_QUALIFIED_SKILL, '--tag', 'latest', ...scopeArgs,
    ], { deadline, cwd, env })
  }
  catch {
    return {
      status: 'verification_failed',
      fromVersion: before.version,
      toVersion: before.version,
      verifiedVersion: null,
      reloadRequired: false,
    }
  }
  if (verification.code !== 0) {
    return {
      status: 'verification_failed',
      fromVersion: before.version,
      toVersion: before.version,
      verifiedVersion: null,
      reloadRequired: false,
    }
  }

  let envelope
  try {
    envelope = JSON.parse(verification.stdout)
  }
  catch {
    return {
      status: 'verification_failed',
      fromVersion: before.version,
      toVersion: before.version,
      verifiedVersion: null,
      reloadRequired: false,
    }
  }
  const verifiedVersion = typeof envelope?.version === 'string' && STABLE_SEMVER.test(envelope.version)
    ? envelope.version
    : null
  if (!isVerificationClean(envelope, before.version)) {
    return {
      status: 'verification_failed',
      fromVersion: before.version,
      toVersion: before.version,
      verifiedVersion,
      reloadRequired: false,
    }
  }

  let update
  try {
    update = await run('openclaw', ['skills', 'update', OWNER_QUALIFIED_SKILL, ...scopeArgs], {
      deadline,
      cwd,
      env,
    })
  }
  catch {
    return {
      status: 'update_indeterminate',
      fromVersion: before.version,
      toVersion: null,
      verifiedVersion,
      reloadRequired: true,
    }
  }
  const after = await readManagedOrigin(originPath)
  if (!after.ok) {
    return {
      status: 'update_indeterminate',
      fromVersion: before.version,
      toVersion: null,
      verifiedVersion,
      reloadRequired: true,
    }
  }
  const artifactUnchanged = after.version === before.version && after.fingerprint === before.fingerprint
  if (update.code !== 0 && artifactUnchanged) {
    return {
      status: 'update_failed',
      fromVersion: before.version,
      toVersion: after.version,
      verifiedVersion,
      reloadRequired: false,
    }
  }
  if (artifactUnchanged) {
    return {
      status: after.version === verifiedVersion ? 'up_to_date' : 'unchanged',
      fromVersion: before.version,
      toVersion: after.version,
      verifiedVersion,
      reloadRequired: false,
    }
  }
  return {
    status: after.version === verifiedVersion ? 'updated' : 'updated_unexpected',
    fromVersion: before.version,
    toVersion: after.version,
    verifiedVersion,
    reloadRequired: true,
  }
}

export async function main(argv = process.argv.slice(2), environment = process.env) {
  const options = parseArguments(argv)
  if (options.help) {
    process.stderr.write('Usage: openclaw-auto-update.mjs [--scope global|workspace]\n')
    return 0
  }
  if (isAutoUpdateDisabled(environment)) return 0

  process.umask(0o077)
  const directory = cacheDirectory(environment)
  await mkdir(directory, { recursive: true, mode: 0o700 })
  await chmod(directory, 0o700)
  const statePath = path.join(directory, `${options.scope}.json`)
  const lockPath = path.join(directory, `${options.scope}.lock`)
  const initialState = await readState(statePath)
  if (!isDue(initialState)) return 0

  const lock = await acquireLock(lockPath)
  if (!lock) return 0
  try {
    const lockedState = await readState(statePath)
    if (!isDue(lockedState)) return 0
    const attemptedAt = new Date().toISOString()
    const attempt = Number.isSafeInteger(lockedState?.attempt) && lockedState.attempt >= 0
      ? lockedState.attempt + 1
      : 1
    const originPath = resolveManagedOriginPath({ scope: options.scope, cwd: process.cwd(), env: environment })
    const beforeOrigin = await readManagedOrigin(originPath)
    await writePrivateJson(statePath, {
      schema: 2,
      lastAttemptAt: attemptedAt,
      attempt,
      status: 'attempting',
      fromVersion: beforeOrigin.ok ? beforeOrigin.version : null,
      toVersion: beforeOrigin.ok ? beforeOrigin.version : null,
    })

    let result
    try {
      result = await performUpdate({
        scope: options.scope,
        cwd: process.cwd(),
        env: environment,
        beforeOrigin,
      })
    }
    catch {
      result = {
        status: 'indeterminate',
        fromVersion: beforeOrigin.ok ? beforeOrigin.version : null,
        toVersion: null,
        verifiedVersion: null,
        reloadRequired: true,
      }
    }
    const finalState = {
      schema: 2,
      lastAttemptAt: attemptedAt,
      attempt,
      status: result.status,
      fromVersion: result.fromVersion,
      toVersion: result.toVersion,
      verifiedVersion: result.verifiedVersion,
      ...(result.reloadRequired ? { reloadRequiredAt: new Date().toISOString() } : {}),
    }
    try {
      await writePrivateJson(statePath, finalState)
    }
    catch {
      if (!result.reloadRequired) return 0
    }
    if (result.reloadRequired) {
      process.stderr.write('Deyo Skill 可能已更新；请重新发起本次请求以安全加载当前版本。\n')
      return UPDATED_EXIT_CODE
    }
    return 0
  }
  finally {
    await lock.close().catch(() => {})
    await rm(lockPath, { force: true })
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  main().then((code) => {
    process.exitCode = code
  }).catch(() => {
    process.exitCode = 0
  })
}
