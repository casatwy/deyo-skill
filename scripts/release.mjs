#!/usr/bin/env node

import { spawn } from 'node:child_process'
import { chmod, cp, mkdtemp, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import readline from 'node:readline/promises'
import { fileURLToPath } from 'node:url'
import {
  abortConfirmationPhrase,
  allocateTargetVersion,
  assertClawHubReady,
  assertReleasePathsAllowed,
  assertStableSemver,
  assertTargetAbsent,
  clawHubFileFingerprint,
  compareFingerprints,
  ClawHubConflictError,
  confirmationPhrase,
  hashTree,
  phaseAtLeast,
  reconcileResumeGitState,
  remoteFileFingerprint,
  sha256,
  validateRemoteConfiguration,
  validateReleaseNotes,
  validateFrozenAbortState,
  validateReleaseState,
} from './release-core.mjs'
import { generateProviders } from './generate-providers.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const clawhub = path.join(root, 'node_modules', '.bin', 'clawhub')
const recoveryDirectory = path.join(root, '.git', 'deyo-release')
const statePath = path.join(recoveryDirectory, 'state.json')
const receiptsDirectory = path.join(recoveryDirectory, 'receipts')
const abortedDirectory = path.join(recoveryDirectory, 'aborted')
const officialRef = '@casatwy/deyo'
const NETWORK_TIMEOUT_MS = 30_000
const CLAWHUB_LICENSE = 'MIT-0'

export function isCiEnvironment(environment = process.env) {
  const keys = ['CI', 'GITHUB_ACTIONS', 'BUILDKITE', 'JENKINS_URL', 'TF_BUILD']
  return keys.some((key) => {
    const value = String(environment[key] ?? '').trim().toLowerCase()
    return value !== '' && value !== '0' && value !== 'false'
  })
}

export function parseReleaseOptions(argv) {
  const known = new Set(['--abort', '--dry-run', '--resume'])
  for (const value of argv) if (!known.has(value)) throw new Error(`Unknown release option: ${value}`)
  if (new Set(argv).size !== argv.length) throw new Error('Release options must not be repeated')
  const dryRun = argv.includes('--dry-run')
  const resume = argv.includes('--resume')
  const abort = argv.includes('--abort')
  if ([dryRun, resume, abort].filter(Boolean).length > 1) {
    throw new Error('--abort, --dry-run, and --resume cannot be combined')
  }
  return { abort, dryRun, resume }
}

async function command(commandName, args, options = {}) {
  return await new Promise((resolve, reject) => {
    let settled = false
    const child = spawn(commandName, args, {
      cwd: options.cwd ?? root,
      env: options.env ?? process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const stdout = []
    const stderr = []
    const timeout = options.timeoutMs
      ? setTimeout(() => {
          if (settled) return
          settled = true
          child.kill('SIGKILL')
          reject(new Error(`${commandName} ${args.join(' ')} timed out after ${options.timeoutMs} ms`))
        }, options.timeoutMs)
      : null
    child.stdout.on('data', chunk => stdout.push(chunk))
    child.stderr.on('data', chunk => stderr.push(chunk))
    child.on('error', (error) => {
      if (settled) return
      settled = true
      if (timeout) clearTimeout(timeout)
      reject(error)
    })
    child.on('close', (code, signal) => {
      if (settled) return
      settled = true
      if (timeout) clearTimeout(timeout)
      const result = {
        code,
        signal,
        stdout: Buffer.concat(stdout),
        stderr: Buffer.concat(stderr),
      }
      if (code !== 0 && !options.allowFailure) {
        const detail = result.stderr.toString('utf8').trim() || result.stdout.toString('utf8').trim()
        reject(new Error(`${commandName} ${args.join(' ')} failed (${code ?? signal}): ${detail}`))
      }
      else resolve(result)
    })
  })
}

async function textCommand(commandName, args, options = {}) {
  const result = await command(commandName, args, options)
  return {
    ...result,
    stdout: result.stdout.toString('utf8'),
    stderr: result.stderr.toString('utf8'),
  }
}

async function git(args, options = {}) {
  return await textCommand('git', args, options)
}

async function readJsonIfPresent(target) {
  try {
    return JSON.parse(await readFile(target, 'utf8'))
  }
  catch (error) {
    if (error?.code === 'ENOENT') return null
    throw error
  }
}

async function atomicPrivateJson(target, value) {
  await mkdir(path.dirname(target), { recursive: true, mode: 0o700 })
  await chmod(path.dirname(target), 0o700)
  const temporary = `${target}.${process.pid}.${Date.now()}.tmp`
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: 'wx' })
  await rename(temporary, target)
  await chmod(target, 0o600)
}

async function writeState(state) {
  await atomicPrivateJson(statePath, state)
}

async function advanceState(state, phase, extra = {}) {
  const updated = { ...state, ...extra, phase, updatedAt: new Date().toISOString() }
  await writeState(updated)
  return updated
}

async function assertGitPreflight() {
  const branch = (await git(['branch', '--show-current'])).stdout.trim()
  if (branch !== 'master') throw new Error(`Skill releases require master, received ${branch || 'detached HEAD'}`)
  const upstream = (await git(['rev-parse', '--abbrev-ref', '@{upstream}'])).stdout.trim()
  if (upstream !== 'origin/master') throw new Error(`master upstream must be origin/master, received ${upstream}`)
  const remotes = (await git(['remote'])).stdout.trim().split('\n').filter(Boolean)
  const origin = (await git(['remote', 'get-url', 'origin'])).stdout.trim()
  validateRemoteConfiguration(remotes, origin)

  const gitDirectory = (await git(['rev-parse', '--git-dir'])).stdout.trim()
  const markers = ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'rebase-merge', 'rebase-apply']
  for (const marker of markers) {
    try {
      await stat(path.resolve(root, gitDirectory, marker))
      throw new Error(`Git operation is in progress: ${marker}`)
    }
    catch (error) {
      if (error?.code !== 'ENOENT') throw error
    }
  }

  const changed = (await git(['diff', '--name-only', '-z', 'HEAD'])).stdout.split('\0').filter(Boolean)
  const untracked = (await git(['ls-files', '--others', '--exclude-standard', '-z'])).stdout.split('\0').filter(Boolean)
  assertReleasePathsAllowed([...new Set([...changed, ...untracked])])
}

async function sourceSnapshot(baseVersion, targetVersion) {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'deyo-release-source-'))
  const generatedRoots = new Set([
    '.agents',
    '.claude-plugin',
    'gemini-extension.json',
    'node_modules',
    'plugins',
    'providers',
    'skills',
  ])
  try {
    const trackedAndUntracked = (await git(['ls-files', '--cached', '--others', '--exclude-standard', '-z'])).stdout
      .split('\0')
      .filter(Boolean)
      .sort()
    for (const relativePath of trackedAndUntracked) {
      const topLevel = relativePath.split('/')[0]
      if (generatedRoots.has(topLevel)) continue
      if (relativePath === `release/notes/v${targetVersion}.md`) continue
      const source = path.join(root, relativePath)
      const target = path.join(temporary, relativePath)
      await mkdir(path.dirname(target), { recursive: true })
      await cp(source, target, { dereference: false, preserveTimestamps: false })
    }
    const manifestPath = path.join(temporary, 'deyo/manifest.json')
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
    if (![baseVersion, targetVersion].includes(manifest.skillVersion)) {
      throw new Error(`Canonical manifest diverged while computing source snapshot: ${manifest.skillVersion}`)
    }
    manifest.skillVersion = baseVersion
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
    return await hashTree(temporary)
  }
  finally {
    await rm(temporary, { recursive: true, force: true })
  }
}

async function remoteMasterCommit() {
  const result = await git(['ls-remote', 'origin', 'refs/heads/master'], { timeoutMs: NETWORK_TIMEOUT_MS })
  const commit = result.stdout.trim().split(/\s+/)[0]
  if (!/^[a-f0-9]{40}$/.test(commit)) throw new Error('Could not read official origin/master')
  return commit
}

async function assertLocalTooling() {
  await stat(clawhub)
  const version = (await textCommand(clawhub, ['--cli-version'])).stdout.trim()
  if (version !== '0.23.1') throw new Error(`Expected local clawhub 0.23.1, received ${version}`)
  const account = (await textCommand(clawhub, ['whoami'], { timeoutMs: NETWORK_TIMEOUT_MS })).stdout.trim()
  if (account !== 'casatwy') throw new Error(`ClawHub login must be casatwy, received ${account || 'none'}`)
}

async function inspectVersions() {
  const result = await textCommand(clawhub, ['inspect', officialRef, '--json', '--versions', '--limit', '200'], { timeoutMs: NETWORK_TIMEOUT_MS })
  return JSON.parse(result.stdout)
}

async function inspectExact(version) {
  const result = await textCommand(
    clawhub,
    ['inspect', officialRef, '--version', version, '--json', '--files'],
    { allowFailure: true, timeoutMs: NETWORK_TIMEOUT_MS },
  )
  if (result.code === 0) return JSON.parse(result.stdout)
  const detail = `${result.stdout}\n${result.stderr}`
  if (/not found|404|unknown version/i.test(detail)) return null
  throw new Error(`Could not determine whether ClawHub ${version} exists: ${detail.trim()}`)
}

async function assertTargetTagsAbsent(targetVersion) {
  const tag = `v${targetVersion}`
  const local = await git(['rev-parse', '-q', '--verify', `refs/tags/${tag}`], { allowFailure: true })
  if (local.code === 0) throw new Error(`Cannot abort because local tag ${tag} exists`)
  if (local.code !== 1) throw new Error(`Could not prove that local tag ${tag} is absent`)
  const remote = await git(
    ['ls-remote', '--tags', 'origin', `refs/tags/${tag}`, `refs/tags/${tag}^{}`],
    { timeoutMs: NETWORK_TIMEOUT_MS },
  )
  if (remote.stdout.trim()) throw new Error(`Cannot abort because remote tag ${tag} exists`)
}

async function frozenAbortPreflight(state) {
  const frozen = validateFrozenAbortState(state)
  await assertGitPreflight()
  await assertLocalTooling()

  const localHead = (await git(['rev-parse', 'HEAD'])).stdout.trim()
  if (localHead !== frozen.baseCommit) {
    throw new Error('Cannot abort because local master no longer matches the frozen base commit')
  }
  const remoteMaster = await remoteMasterCommit()
  if (remoteMaster !== frozen.baseCommit) {
    throw new Error('Cannot abort because origin/master no longer matches the frozen base commit')
  }
  await assertTargetTagsAbsent(frozen.targetVersion)

  const inspect = await inspectVersions()
  const allocation = allocateTargetVersion(inspect)
  if (allocation.baseVersion !== frozen.baseVersion || allocation.targetVersion !== frozen.targetVersion) {
    throw new Error(
      `Cannot abort because ClawHub now allocates ${allocation.baseVersion} -> ${allocation.targetVersion}, ` +
      `not ${frozen.baseVersion} -> ${frozen.targetVersion}`,
    )
  }
  assertTargetAbsent(allocation.versions, frozen.targetVersion)
  if (await inspectExact(frozen.targetVersion)) {
    throw new Error(`Cannot abort because ClawHub exact version ${frozen.targetVersion} exists`)
  }

  return {
    state: frozen,
    currentSourceSnapshot: await sourceSnapshot(frozen.baseVersion, frozen.targetVersion),
  }
}

async function verifyExact(version) {
  const result = await textCommand(clawhub, ['skill', 'verify', officialRef, '--version', version], { timeoutMs: NETWORK_TIMEOUT_MS })
  return JSON.parse(result.stdout)
}

async function stageCanonicalVersion(version) {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'deyo-clawhub-stage-'))
  await cp(path.join(root, 'deyo'), temporary, { recursive: true, dereference: false, preserveTimestamps: false })
  const manifestPath = path.join(temporary, 'manifest.json')
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  manifest.skillVersion = version
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
  return temporary
}

async function runRepositoryValidation() {
  await textCommand(process.execPath, ['scripts/generate-providers.mjs', '--check'])
  await textCommand(process.execPath, ['scripts/validate-artifacts.mjs'])
  await textCommand('pnpm', ['test'])
  await git(['diff', '--check'])
  const claude = await textCommand('claude', ['plugin', 'validate', '.'], { allowFailure: true })
  if (claude.code !== 0) throw new Error(`Claude plugin validator failed: ${(claude.stderr || claude.stdout).trim()}`)
}

async function assertCliPublished(minimumCliVersion, targetVersion) {
  const result = await textCommand('npm', ['view', `@casatwy/deyo@${minimumCliVersion}`, 'version', '--json'], { allowFailure: true, timeoutMs: NETWORK_TIMEOUT_MS })
  if (result.code !== 0 || JSON.parse(result.stdout || 'null') !== minimumCliVersion) {
    throw new Error(`@casatwy/deyo@${minimumCliVersion} must be published before Deyo Skill v${targetVersion}`)
  }
}

async function clawHubPublishDryRun(stage, targetVersion, releaseNotes, sourceCommit) {
  await textCommand(clawhub, [
    'publish', stage,
    '--slug', 'deyo',
    '--name', 'Deyo',
    '--owner', 'casatwy',
    '--version', targetVersion,
    '--tags', 'latest',
    '--changelog', releaseNotes,
    '--source-repo', 'https://github.com/casatwy/deyo-skill',
    '--source-commit', sourceCommit,
    '--source-ref', `v${targetVersion}`,
    '--source-path', 'deyo',
    '--dry-run',
    '--json',
  ], { timeoutMs: 60_000 })
}

async function fullPreflight({ resume, state }) {
  let recoveredState = resume ? validateReleaseState(state) : null
  await assertGitPreflight()
  await assertLocalTooling()
  const remoteMaster = await remoteMasterCommit()
  const localHead = (await git(['rev-parse', 'HEAD'])).stdout.trim()
  if (!resume && localHead !== remoteMaster) throw new Error('Local master must exactly match official origin/master before a new release')
  if (resume) {
    let localHeadParent = null
    let localHeadSubject = null
    if (!phaseAtLeast(recoveredState, 'committed') && localHead !== recoveredState.baseCommit) {
      localHeadParent = (await git(['rev-parse', `${localHead}^`])).stdout.trim()
      localHeadSubject = (await git(['show', '-s', '--format=%s', localHead])).stdout.trim()
    }
    recoveredState = reconcileResumeGitState(recoveredState, {
      localHead,
      localHeadParent,
      localHeadSubject,
      remoteMaster,
    })
  }
  if (!resume || phaseAtLeast(recoveredState, 'prepared')) await runRepositoryValidation()
  const canonical = JSON.parse(await readFile(path.join(root, 'deyo/manifest.json'), 'utf8'))

  if (resume) {
    await assertCliPublished(canonical.minimumCliVersion, recoveredState.targetVersion)
    return { canonical, state: recoveredState }
  }

  const inspect = await inspectVersions()
  const allocation = allocateTargetVersion(inspect)
  assertTargetAbsent(allocation.versions, allocation.targetVersion)
  const exact = await inspectExact(allocation.targetVersion)
  if (exact) throw new Error(`ClawHub target ${allocation.targetVersion} is already reserved`)
  await assertCliPublished(canonical.minimumCliVersion, allocation.targetVersion)
  const releaseNotes = validateReleaseNotes(await readFile(path.join(root, 'release/next.md'))).content
  const stage = await stageCanonicalVersion(allocation.targetVersion)
  try {
    await clawHubPublishDryRun(stage, allocation.targetVersion, releaseNotes, localHead)
  }
  finally {
    await rm(stage, { recursive: true, force: true })
  }
  return { canonical, allocation, releaseNotes }
}

async function confirm(targetVersion, resume, runtime = {}) {
  const expected = confirmationPhrase(targetVersion, resume)
  if (runtime.confirm) {
    await runtime.confirm(expected)
    return
  }
  const prompt = readline.createInterface({ input: process.stdin, output: process.stdout })
  try {
    const answer = await prompt.question(`Type "${expected}" to continue: `)
    if (answer.trim() !== expected) throw new Error('Release confirmation did not match')
  }
  finally {
    prompt.close()
  }
}

function assertFormalEnvironment(runtime = {}) {
  const environment = runtime.environment ?? process.env
  if (isCiEnvironment(environment)) {
    throw new Error('Formal Skill publishing and abort are forbidden in CI environments')
  }
  const interactive = runtime.interactive ?? Boolean(process.stdin.isTTY && process.stdout.isTTY)
  if (!interactive) throw new Error('Formal Skill publishing and abort require an interactive TTY')
}

async function confirmAbort(targetVersion, runtime = {}) {
  const expected = abortConfirmationPhrase(targetVersion)
  if (runtime.confirm) {
    await runtime.confirm(expected)
    return
  }
  const prompt = readline.createInterface({ input: process.stdin, output: process.stdout })
  try {
    const answer = await prompt.question(`Type "${expected}" to archive this frozen release: `)
    if (answer.trim() !== expected) throw new Error('Abort confirmation did not match')
  }
  finally {
    prompt.close()
  }
}

async function archiveFrozenAbort(originalState, preflight) {
  const liveState = await readJsonIfPresent(statePath)
  if (JSON.stringify(liveState) !== JSON.stringify(originalState)) {
    throw new Error('Frozen release state changed while abort was being confirmed')
  }

  await mkdir(abortedDirectory, { recursive: true, mode: 0o700 })
  await chmod(abortedDirectory, 0o700)
  const archiveDirectory = await mkdtemp(path.join(abortedDirectory, `v${originalState.targetVersion}-`))
  await chmod(archiveDirectory, 0o700)
  const archivedStatePath = path.join(archiveDirectory, 'state.json')
  const abortReceiptPath = path.join(archiveDirectory, 'abort.json')
  const receipt = {
    schema: 1,
    kind: 'deyo.frozen-release-abort',
    state: originalState,
    abortedAt: new Date().toISOString(),
    reason: 'maintainer_requested_safe_restart',
    currentSourceSnapshot: preflight.currentSourceSnapshot,
  }
  await atomicPrivateJson(abortReceiptPath, receipt)
  await chmod(statePath, 0o600)
  try {
    await rename(statePath, archivedStatePath)
  }
  catch (error) {
    await rm(archiveDirectory, { recursive: true, force: true })
    throw error
  }
  await chmod(archivedStatePath, 0o600)
  return {
    ...receipt,
    archivePath: path.relative(root, abortReceiptPath).split(path.sep).join('/'),
    archivedStatePath: path.relative(root, archivedStatePath).split(path.sep).join('/'),
  }
}

async function abortFrozenRelease(state, runtime = {}) {
  const initialPreflight = await frozenAbortPreflight(state)
  process.stdout.write(
    `Deyo frozen release abort plan: ${state.baseVersion} -> ${state.targetVersion}; ` +
    'no worktree or remote refs will be changed.\n',
  )
  await confirmAbort(state.targetVersion, runtime)
  const finalPreflight = await frozenAbortPreflight(state)
  if (finalPreflight.currentSourceSnapshot !== initialPreflight.currentSourceSnapshot) {
    process.stdout.write('Release source changed while confirming; the final snapshot will be recorded in the abort archive.\n')
  }
  return await archiveFrozenAbort(state, finalPreflight)
}

async function prepareWorkspace(state) {
  const manifestPath = path.join(root, 'deyo/manifest.json')
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  if (![state.baseVersion, state.targetVersion].includes(manifest.skillVersion)) {
    throw new Error(`Canonical manifest has diverged from recovery state: ${manifest.skillVersion}`)
  }
  if (manifest.skillVersion !== state.targetVersion) {
    manifest.skillVersion = state.targetVersion
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
  }
  const notePath = path.join(root, `release/notes/v${state.targetVersion}.md`)
  await mkdir(path.dirname(notePath), { recursive: true })
  try {
    const existing = await readFile(notePath, 'utf8')
    if (existing !== state.releaseNotes) throw new Error(`Archived release notes conflict at ${notePath}`)
  }
  catch (error) {
    if (error?.code !== 'ENOENT') throw error
    await writeFile(notePath, state.releaseNotes)
  }
  await generateProviders()
  await runRepositoryValidation()
  const canonicalTreeHash = await hashTree(path.join(root, 'deyo'))
  return await advanceState(state, 'prepared', { canonicalTreeHash })
}

async function createReleaseCommit(state) {
  await assertGitPreflight()
  await git(['add', '-A'])
  const stagedPaths = (await git(['diff', '--cached', '--name-only', '-z'])).stdout.split('\0').filter(Boolean)
  assertReleasePathsAllowed(stagedPaths)
  await git(['commit', '-m', `release(skill): v${state.targetVersion}`])
  const releaseCommit = (await git(['rev-parse', 'HEAD'])).stdout.trim()
  return await advanceState(state, 'committed', { releaseCommit })
}

async function createAnnotatedTag(state) {
  const tag = `v${state.targetVersion}`
  const existing = await git(['rev-parse', '-q', '--verify', `refs/tags/${tag}^{commit}`], { allowFailure: true })
  if (existing.code === 0) {
    if (existing.stdout.trim() !== state.releaseCommit) throw new Error(`${tag} already points to a different commit`)
  }
  else {
    await git(['tag', '-a', tag, state.releaseCommit, '-F', `release/notes/${tag}.md`])
  }
  return await advanceState(state, 'tagged', { tag })
}

async function archiveTaggedSkill(tag) {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'deyo-tag-archive-'))
  const archive = await command('git', ['archive', '--format=tar', tag, 'deyo'])
  await new Promise((resolve, reject) => {
    const tar = spawn('tar', ['-x', '--strip-components=1', '-C', temporary], { stdio: ['pipe', 'pipe', 'pipe'] })
    const errors = []
    tar.stderr.on('data', chunk => errors.push(chunk))
    tar.on('error', reject)
    tar.on('close', (code) => code === 0 ? resolve() : reject(new Error(Buffer.concat(errors).toString('utf8'))))
    tar.stdin.end(archive.stdout)
  })
  return temporary
}

async function pushTag(state) {
  await git(['push', 'origin', `refs/tags/${state.tag}:refs/tags/${state.tag}`], { timeoutMs: 60_000 })
  return await advanceState(state, 'tag_pushed')
}

async function publishClawHubIfNeeded(state, stage, localFingerprint) {
  const existing = await inspectExact(state.targetVersion)
  if (existing) {
    if (!compareFingerprints(localFingerprint, remoteFileFingerprint(existing))) {
      throw new ClawHubConflictError(`ClawHub ${state.targetVersion} exists with a different file fingerprint`)
    }
    return
  }
  const result = await textCommand(clawhub, [
    'publish', stage,
    '--slug', 'deyo',
    '--name', 'Deyo',
    '--owner', 'casatwy',
    '--version', state.targetVersion,
    '--tags', 'latest',
    '--changelog', state.releaseNotes,
    '--source-repo', 'https://github.com/casatwy/deyo-skill',
    '--source-commit', state.releaseCommit,
    '--source-ref', state.tag,
    '--source-path', 'deyo',
    '--json',
  ], { allowFailure: true, timeoutMs: 60_000 })
  if (result.code !== 0) {
    const afterFailure = await inspectExact(state.targetVersion)
    if (!afterFailure) throw new Error(`ClawHub publish failed and the target is absent: ${(result.stderr || result.stdout).trim()}`)
    if (!compareFingerprints(localFingerprint, remoteFileFingerprint(afterFailure))) {
      throw new ClawHubConflictError(`ClawHub publish outcome is ambiguous and ${state.targetVersion} has a different fingerprint`)
    }
  }
}

async function isolatedInstallAndVerify(state, localFingerprint) {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'deyo-isolated-install-'))
  try {
    await textCommand(clawhub, [
      '--workdir', temporary,
      '--dir', 'skills',
      'install', officialRef,
      '--version', state.targetVersion,
    ], { timeoutMs: NETWORK_TIMEOUT_MS })
    const installed = path.join(temporary, 'skills', 'deyo')
    const fingerprint = (await clawHubFileFingerprint(installed)).filter(file => !file.path.startsWith('.clawhub/'))
    if (!compareFingerprints(localFingerprint, fingerprint)) throw new ClawHubConflictError('Isolated ClawHub install fingerprint mismatch')
  }
  finally {
    await rm(temporary, { recursive: true, force: true })
  }
}

async function waitForClawHub(state, stage, runtime = {}) {
  const localFingerprint = await clawHubFileFingerprint(stage)
  await publishClawHubIfNeeded(state, stage, localFingerprint)
  const reviewTimeoutMs = runtime.reviewTimeoutMs ?? 10 * 60 * 1000
  const reviewPollMs = runtime.reviewPollMs ?? 15_000
  const sleep = runtime.sleep ?? (delay => new Promise(resolve => setTimeout(resolve, delay)))
  const deadline = Date.now() + reviewTimeoutMs
  let lastReason = 'ClawHub review is pending'
  while (Date.now() <= deadline) {
    try {
      const [inspect, verification] = await Promise.all([
        inspectExact(state.targetVersion),
        verifyExact(state.targetVersion),
      ])
      assertClawHubReady(inspect, verification, state.targetVersion, localFingerprint)
      await isolatedInstallAndVerify(state, localFingerprint)
      return await advanceState(state, 'clawhub_ready', { clawHubFileFingerprint: localFingerprint })
    }
    catch (error) {
      if (error instanceof ClawHubConflictError) throw error
      lastReason = error instanceof Error ? error.message : String(error)
      const remaining = deadline - Date.now()
      if (remaining <= 0) break
      await sleep(Math.min(reviewPollMs, remaining))
    }
  }
  throw new Error(`${lastReason}. Resume the same version with: make publish RESUME=1`)
}

async function pushMaster(state) {
  await git(['push', 'origin', `${state.releaseCommit}:refs/heads/master`], { timeoutMs: 60_000 })
  return await advanceState(state, 'master_pushed')
}

async function verifyRemoteProviders(state) {
  await git(['fetch', 'origin', 'master'], { timeoutMs: 60_000 })
  const remoteCommit = (await git(['rev-parse', 'origin/master'])).stdout.trim()
  if (remoteCommit !== state.releaseCommit) throw new Error('origin/master does not match the release commit')
  const paths = [
    'deyo/manifest.json',
    'plugins/deyo/.codex-plugin/plugin.json',
    'plugins/deyo/.claude-plugin/plugin.json',
    'gemini-extension.json',
    'providers/metadata.json',
  ]
  for (const manifestPath of paths) {
    const content = (await git(['show', `origin/master:${manifestPath}`])).stdout
    const manifest = JSON.parse(content)
    const version = manifest.skillVersion ?? manifest.version
    if (version !== state.targetVersion) throw new Error(`Remote ${manifestPath} version mismatch`)
    if (manifestPath === 'providers/metadata.json' && manifest.canonicalTreeHash !== state.canonicalTreeHash) {
      throw new Error('Remote canonical tree hash metadata mismatch')
    }
  }
}

async function completeRelease(state) {
  await verifyRemoteProviders(state)
  const releaseNotesPath = `release/notes/v${state.targetVersion}.md`
  const archivedReleaseNotes = await readFile(path.join(root, releaseNotesPath), 'utf8')
  if (archivedReleaseNotes !== state.releaseNotes) {
    throw new Error(`Archived release notes conflict at ${releaseNotesPath}`)
  }
  if (sha256(archivedReleaseNotes) !== state.releaseNotesHash) {
    throw new Error(`Archived release notes hash mismatch at ${releaseNotesPath}`)
  }
  const receipt = {
    schema: 1,
    skillVersion: state.targetVersion,
    minimumCliVersion: JSON.parse(await readFile(path.join(root, 'deyo/manifest.json'), 'utf8')).minimumCliVersion,
    releaseCommit: state.releaseCommit,
    tag: state.tag,
    canonicalTreeHash: state.canonicalTreeHash,
    clawHubLicense: CLAWHUB_LICENSE,
    releaseNotes: state.releaseNotes,
    releaseNotesPath,
    releaseNotesHash: state.releaseNotesHash,
    clawHubFileFingerprint: state.clawHubFileFingerprint,
    completedAt: new Date().toISOString(),
  }
  await atomicPrivateJson(path.join(receiptsDirectory, `v${state.targetVersion}.json`), receipt)
  await rm(statePath, { force: true })
  return receipt
}

async function executeRelease(initialState, runtime = {}) {
  let state = initialState
  const currentSourceSnapshot = await sourceSnapshot(state.baseVersion, state.targetVersion)
  if (currentSourceSnapshot !== state.sourceSnapshot) {
    throw new Error('Release source changed after the version was frozen')
  }
  if (!phaseAtLeast(state, 'prepared')) state = await prepareWorkspace(state)
  if (!phaseAtLeast(state, 'committed')) state = await createReleaseCommit(state)
  if (!phaseAtLeast(state, 'tagged')) state = await createAnnotatedTag(state)

  const stage = await archiveTaggedSkill(state.tag)
  try {
    const archiveHash = await hashTree(stage)
    if (archiveHash !== state.canonicalTreeHash) throw new Error('Tagged canonical tree differs from the release state')
    if (!phaseAtLeast(state, 'tag_pushed')) state = await pushTag(state)
    if (!phaseAtLeast(state, 'clawhub_ready')) state = await waitForClawHub(state, stage, runtime)
    if (!phaseAtLeast(state, 'master_pushed')) state = await pushMaster(state)
    return await completeRelease(state)
  }
  finally {
    await rm(stage, { recursive: true, force: true })
  }
}

export async function main(argv = process.argv.slice(2), runtime = {}) {
  const options = parseReleaseOptions(argv)
  const existingState = await readJsonIfPresent(statePath)
  if (options.abort) {
    if (!existingState) throw new Error('No unfinished Deyo Skill release exists to abort')
    assertFormalEnvironment(runtime)
    return await abortFrozenRelease(existingState, runtime)
  }
  if (options.resume && !existingState) throw new Error('No unfinished Deyo Skill release exists')
  if (!options.resume && existingState) throw new Error('An unfinished release exists; use make publish RESUME=1')
  if (!options.dryRun) assertFormalEnvironment(runtime)

  const preflight = await fullPreflight({ resume: options.resume, state: existingState })
  const targetVersion = options.resume ? preflight.state.targetVersion : preflight.allocation.targetVersion
  const baseVersion = options.resume ? preflight.state.baseVersion : preflight.allocation.baseVersion

  process.stdout.write(`Deyo Skill release plan: ${baseVersion} -> ${targetVersion}\n`)
  process.stdout.write('Providers: Codex, Claude, Gemini, OpenClaw; npm CLI and web deployment excluded.\n')
  if (options.dryRun) {
    process.stdout.write('Actions: freeze state, write one version, generate providers, validate, commit, annotate tag, push tag, publish and verify ClawHub, push master, verify remote providers, write receipt.\n')
    process.stdout.write('Dry run complete. No files, state, commits, tags, pushes, or publications were created.\n')
    return null
  }

  await confirm(targetVersion, options.resume, runtime)
  if (options.resume) return await executeRelease(preflight.state, runtime)

  const notes = validateReleaseNotes(preflight.releaseNotes)
  const state = {
    schema: 1,
    phase: 'frozen',
    baseVersion,
    targetVersion,
    baseCommit: (await git(['rev-parse', 'HEAD'])).stdout.trim(),
    sourceSnapshot: await sourceSnapshot(baseVersion, targetVersion),
    releaseNotes: preflight.releaseNotes,
    releaseNotesHash: notes.sha256,
    frozenAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }
  await writeState(state)
  return await executeRelease(state, runtime)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then((receipt) => {
    if (receipt?.kind === 'deyo.frozen-release-abort') {
      process.stdout.write(`Archived frozen Deyo Skill v${receipt.state.targetVersion} release at ${receipt.archivePath}.\n`)
    }
    else if (receipt) process.stdout.write(`Published Deyo Skill v${receipt.skillVersion}.\n`)
  }).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  })
}
