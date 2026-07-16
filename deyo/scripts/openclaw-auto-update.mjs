#!/usr/bin/env node

import { spawn } from 'node:child_process'
import { constants } from 'node:fs'
import { chmod, mkdir, open, readFile, rename, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'

const DAY_MS = 24 * 60 * 60 * 1000
const TIMEOUT_MS = 20_000
const OWNER_QUALIFIED_SKILL = '@casatwy/deyo'
const UPDATED_EXIT_CODE = 10

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

export function isVerificationClean(envelope) {
  return envelope?.schema === 'clawhub.skill.verify.v1'
    && envelope?.ok === true
    && envelope?.decision === 'pass'
    && envelope?.security?.passed === true
    && envelope?.security?.status === 'clean'
}

export function updateSucceeded(output) {
  const normalized = output.toLowerCase()
  if (/already (?:up[- ]to[- ]date|current)|no updates?|unchanged/.test(normalized)) return false
  return /updated|upgraded|installed/.test(normalized)
}

function cacheDirectory(environment = process.env) {
  const cacheRoot = environment.XDG_CACHE_HOME || path.join(os.homedir(), '.cache')
  return path.join(cacheRoot, 'deyo', 'openclaw-skill-update')
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

export async function performUpdate({ scope, run = runWithDeadline, now = Date.now(), cwd = process.cwd(), env = process.env }) {
  const deadline = now + TIMEOUT_MS
  const scopeArgs = scope === 'global' ? ['--global'] : []
  const verification = await run('openclaw', ['skills', 'verify', OWNER_QUALIFIED_SKILL, ...scopeArgs], {
    deadline,
    cwd,
    env,
  })
  if (verification.code !== 0) return { status: 'verification_failed' }

  let envelope
  try {
    envelope = JSON.parse(verification.stdout)
  }
  catch {
    return { status: 'verification_failed' }
  }
  if (!isVerificationClean(envelope)) return { status: 'verification_failed' }

  const update = await run('openclaw', ['skills', 'update', OWNER_QUALIFIED_SKILL, ...scopeArgs], {
    deadline,
    cwd,
    env,
  })
  if (update.code !== 0) return { status: 'update_failed' }
  const combinedOutput = `${update.stdout}\n${update.stderr}`
  return { status: updateSucceeded(combinedOutput) ? 'updated' : 'up_to_date' }
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseArguments(argv)
  if (options.help) {
    process.stderr.write('Usage: openclaw-auto-update.mjs [--scope global|workspace]\n')
    return 0
  }

  process.umask(0o077)
  const directory = cacheDirectory()
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
    await writePrivateJson(statePath, {
      schema: 1,
      lastAttemptAt: attemptedAt,
      lastStatus: 'attempting',
    })

    let result
    try {
      result = await performUpdate({ scope: options.scope })
    }
    catch {
      result = { status: 'failed' }
    }
    await writePrivateJson(statePath, {
      schema: 1,
      lastAttemptAt: attemptedAt,
      lastStatus: result.status,
      ...(result.status === 'updated' ? { updatedAt: new Date().toISOString() } : {}),
    })
    if (result.status === 'updated') {
      process.stderr.write('Deyo Skill 已更新；请重新发起本次请求以加载新版本。\n')
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
