#!/usr/bin/env node

import { spawn } from 'node:child_process'
import { chmod, cp, mkdtemp, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
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
  compareSemver,
  compareFingerprints,
  ClawHubConflictError,
  confirmationPhrase,
  fixForwardConfirmationPhrase,
  hashTree,
  phaseAtLeast,
  reconcileResumeGitState,
  remoteFileFingerprint,
  sha256,
  validateRemoteConfiguration,
  validateReleaseNotes,
  validateFrozenAbortState,
  validateReleaseState,
  validateTerminalFixForwardState,
} from './release-core.mjs'
import { generateProviders } from './generate-providers.mjs'
import { projectClawHubSkill } from './clawhub-projection.mjs'
import {
  CommandExecutionError,
  currentProgressReporter,
  progressSkip,
  progressStage,
  ReleaseProgressReporter,
  safeCommandLabel,
  withProgressReporter,
} from './release-progress.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const clawhub = path.join(root, 'node_modules', '.bin', 'clawhub')
const recoveryDirectory = path.join(root, '.git', 'deyo-release')
const statePath = path.join(recoveryDirectory, 'state.json')
const receiptsDirectory = path.join(recoveryDirectory, 'receipts')
const abortedDirectory = path.join(recoveryDirectory, 'aborted')
const abandonedDirectory = path.join(recoveryDirectory, 'abandoned')
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
  const known = new Set(['--abort', '--dry-run', '--fix-forward', '--resume'])
  for (const value of argv) if (!known.has(value)) throw new Error(`Unknown release option: ${value}`)
  if (new Set(argv).size !== argv.length) throw new Error('Release options must not be repeated')
  const dryRun = argv.includes('--dry-run')
  const resume = argv.includes('--resume')
  const abort = argv.includes('--abort')
  const fixForward = argv.includes('--fix-forward')
  if ([dryRun, resume, abort, fixForward].filter(Boolean).length > 1) {
    throw new Error('--abort, --dry-run, --fix-forward, and --resume cannot be combined')
  }
  return { abort, dryRun, fixForward, resume }
}

async function command(commandName, args, options = {}) {
  return await new Promise((resolve, reject) => {
    let settled = false
    const label = safeCommandLabel(commandName, args, options.label)
    const reporter = currentProgressReporter()
    const activity = reporter?.startCommand(label)
    const child = spawn(commandName, args, {
      cwd: options.cwd ?? root,
      env: options.env ?? process.env,
      stdio: [options.input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
    })
    const stdout = []
    const stderr = []
    const timeout = options.timeoutMs
      ? setTimeout(() => {
          if (settled) return
          settled = true
          child.kill('SIGKILL')
          activity?.finish({ timedOut: true, timeoutMs: options.timeoutMs })
          reject(new CommandExecutionError(label, { timedOut: true, timeoutMs: options.timeoutMs }))
        }, options.timeoutMs)
      : null
    child.stdout.on('data', (chunk) => {
      stdout.push(chunk)
      if (options.forwardStdout !== false) activity?.forward('stdout', chunk)
    })
    child.stderr.on('data', (chunk) => {
      stderr.push(chunk)
      if (options.forwardStderr !== false) activity?.forward('stderr', chunk)
    })
    child.on('error', (error) => {
      if (settled) return
      settled = true
      if (timeout) clearTimeout(timeout)
      activity?.finish({ signal: error?.code ?? 'spawn-error' })
      reject(new CommandExecutionError(label, { signal: error?.code ?? 'spawn-error', cause: error }))
    })
    child.on('close', (code, signal) => {
      if (settled) return
      settled = true
      if (timeout) clearTimeout(timeout)
      activity?.finish({ code, signal })
      const result = {
        code,
        signal,
        stdout: Buffer.concat(stdout),
        stderr: Buffer.concat(stderr),
      }
      if (code !== 0 && !options.allowFailure) {
        reject(new CommandExecutionError(label, { code, signal }))
      }
      else resolve(result)
    })
    if (options.input !== undefined) child.stdin.end(options.input)
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
  currentProgressReporter()?.setRecovery(phase, 'make publish RESUME=1')
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
  throw new CommandExecutionError('clawhub inspect', {
    code: result.code,
    signal: result.signal,
    message: `Could not determine whether ClawHub ${version} exists`,
  })
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
  const expectedRemoteBase = frozen.remoteBaseCommit ?? frozen.baseCommit
  await assertGitPreflight()
  await assertLocalTooling()

  const localHead = (await git(['rev-parse', 'HEAD'])).stdout.trim()
  if (localHead !== frozen.baseCommit) {
    throw new Error('Cannot abort because local master no longer matches the frozen base commit')
  }
  const remoteMaster = await remoteMasterCommit()
  if (remoteMaster !== expectedRemoteBase) {
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
    remoteMaster,
  }
}

async function verifyExact(version) {
  const result = await textCommand(
    clawhub,
    ['skill', 'verify', officialRef, '--version', version],
    { allowFailure: true, timeoutMs: NETWORK_TIMEOUT_MS },
  )
  const payload = (result.stdout || result.stderr).trim()
  try {
    return JSON.parse(payload)
  }
  catch {
    if (result.code !== 0) {
      throw new CommandExecutionError('clawhub skill verify', {
        code: result.code,
        signal: result.signal,
        message: `Could not verify ClawHub ${version}`,
      })
    }
    throw new Error(`ClawHub verification returned invalid JSON for ${version}`)
  }
}

async function stageCanonicalVersion(version) {
  const canonical = await mkdtemp(path.join(os.tmpdir(), 'deyo-canonical-stage-'))
  const projected = await mkdtemp(path.join(os.tmpdir(), 'deyo-clawhub-stage-'))
  try {
    await cp(path.join(root, 'deyo'), canonical, { recursive: true, dereference: false, preserveTimestamps: false })
    const manifestPath = path.join(canonical, 'manifest.json')
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
    manifest.skillVersion = version
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
    await projectClawHubSkill(canonical, projected)
    return projected
  }
  catch (error) {
    await rm(projected, { recursive: true, force: true })
    throw error
  }
  finally {
    await rm(canonical, { recursive: true, force: true })
  }
}

async function runRepositoryValidation() {
  await progressStage('Check generated providers', async () => {
    await textCommand(process.execPath, ['scripts/generate-providers.mjs', '--check'])
  })
  await progressStage('Validate provider artifacts', async () => {
    await textCommand(process.execPath, ['scripts/validate-artifacts.mjs'])
  })
  await progressStage('Run release tests', async () => {
    await textCommand('pnpm', ['test'])
  })
  await progressStage('Check Git diff whitespace', async () => {
    await git(['diff', '--check'])
  })
  await progressStage('Validate Claude plugin', async () => {
    const claude = await textCommand('claude', ['plugin', 'validate', '.'], { allowFailure: true })
    if (claude.code !== 0) {
      throw new CommandExecutionError('claude plugin validate', {
        code: claude.code,
        signal: claude.signal,
        message: 'Claude plugin validator failed',
      })
    }
  })
}

async function assertCliPublished(minimumCliVersion, targetVersion) {
  await progressStage('Verify minimum npm CLI version', async () => {
    const compatibleRange = `^${minimumCliVersion}`
    const result = await textCommand('npm', ['view', `@casatwy/deyo@${compatibleRange}`, 'version', '--json'], { allowFailure: true, timeoutMs: NETWORK_TIMEOUT_MS })
    if (result.code !== 0) {
      throw new CommandExecutionError('npm view', {
        code: result.code,
        signal: result.signal,
        message: `A published @casatwy/deyo version satisfying ${compatibleRange} is required before Deyo Skill v${targetVersion}`,
      })
    }
    const payload = JSON.parse(result.stdout || 'null')
    const publishedVersion = Array.isArray(payload) ? payload.at(-1) : payload
    assertStableSemver(publishedVersion, 'published CLI version')
    if (compareSemver(publishedVersion, minimumCliVersion) < 0) {
      throw new Error(
        `Published @casatwy/deyo ${publishedVersion} does not satisfy minimum CLI ${minimumCliVersion} ` +
        `for Deyo Skill v${targetVersion}`,
      )
    }
  })
}

async function clawHubPublishDryRun(stage, targetVersion, releaseNotes, sourceCommit) {
  await progressStage('Run ClawHub publish dry-run', async () => {
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
    ], { timeoutMs: 60_000, label: 'clawhub publish --dry-run' })
  })
}

async function fullPreflight({ resume, state }) {
  let recoveredState = resume ? validateReleaseState(state) : null
  await progressStage('Check Git release preflight', assertGitPreflight)
  await progressStage('Check local release tooling and ClawHub login', assertLocalTooling)
  const { remoteMaster, localHead } = await progressStage('Read local and remote Git baseline', async () => ({
    remoteMaster: await remoteMasterCommit(),
    localHead: (await git(['rev-parse', 'HEAD'])).stdout.trim(),
  }))
  if (resume) {
    recoveredState = await progressStage('Reconcile recovery Git state', async () => {
      let localHeadParent = null
      let localHeadSubject = null
      if (!phaseAtLeast(recoveredState, 'committed') && localHead !== recoveredState.baseCommit) {
        localHeadParent = (await git(['rev-parse', `${localHead}^`])).stdout.trim()
        localHeadSubject = (await git(['show', '-s', '--format=%s', localHead])).stdout.trim()
      }
      return reconcileResumeGitState(recoveredState, {
        localHead,
        localHeadParent,
        localHeadSubject,
        remoteMaster,
      })
    })
  }
  if (!resume || phaseAtLeast(recoveredState, 'prepared')) await runRepositoryValidation()
  else progressSkip('Repository validation preflight', 'runs while preparing the frozen workspace')
  const canonical = JSON.parse(await readFile(path.join(root, 'deyo/manifest.json'), 'utf8'))

  if (resume) {
    await assertCliPublished(canonical.minimumCliVersion, recoveredState.targetVersion)
    return { canonical, state: recoveredState }
  }

  const { inspect, allocation } = await progressStage('Allocate next immutable ClawHub version', async () => {
    const inspect = await inspectVersions()
    const allocation = allocateTargetVersion(inspect)
    assertTargetAbsent(allocation.versions, allocation.targetVersion)
    const exact = await inspectExact(allocation.targetVersion)
    if (exact) throw new Error(`ClawHub target ${allocation.targetVersion} is already reserved`)
    return { inspect, allocation }
  })
  let remoteBaseCommit = null
  if (localHead !== remoteMaster) {
    await authorizeAbandonedFixForwardBase({ localHead, remoteMaster, allocation, inspect })
    remoteBaseCommit = remoteMaster
  }
  await assertCliPublished(canonical.minimumCliVersion, allocation.targetVersion)
  const releaseNotes = await progressStage('Validate release notes', async () => (
    validateReleaseNotes(await readFile(path.join(root, 'release/next.md'))).content
  ))
  const stage = await progressStage('Build ClawHub preflight projection', async () => (
    await stageCanonicalVersion(allocation.targetVersion)
  ))
  try {
    await clawHubPublishDryRun(stage, allocation.targetVersion, releaseNotes, localHead)
  }
  finally {
    await rm(stage, { recursive: true, force: true })
  }
  return { canonical, allocation, releaseNotes, remoteBaseCommit }
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
    throw new Error('Formal Skill publishing, abort, and fix-forward are forbidden in CI environments')
  }
  const interactive = runtime.interactive ?? Boolean(process.stdin.isTTY && process.stdout.isTTY)
  if (!interactive) throw new Error('Formal Skill publishing, abort, and fix-forward require an interactive TTY')
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
    remoteMaster: preflight.remoteMaster,
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
  const initialPreflight = await progressStage('Check frozen release abort preflight', async () => (
    await frozenAbortPreflight(state)
  ))
  process.stdout.write(
    `Deyo frozen release abort plan: ${state.baseVersion} -> ${state.targetVersion}; ` +
    'no worktree or remote refs will be changed.\n',
  )
  await progressStage('Confirm frozen release abort', async () => {
    await confirmAbort(state.targetVersion, runtime)
  })
  const finalPreflight = await progressStage('Recheck frozen release abort preflight', async () => (
    await frozenAbortPreflight(state)
  ))
  if (finalPreflight.currentSourceSnapshot !== initialPreflight.currentSourceSnapshot) {
    process.stdout.write('Release source changed while confirming; the final snapshot will be recorded in the abort archive.\n')
  }
  return await progressStage('Archive frozen release state', async () => (
    await archiveFrozenAbort(state, finalPreflight)
  ))
}

function terminalSecurityEvidence(verification, targetVersion) {
  const reasons = verification?.reasons
  const security = verification?.security
  if (
    verification?.slug !== 'deyo' ||
    verification?.publisherHandle !== 'casatwy' ||
    verification?.version !== targetVersion ||
    verification?.resolvedFrom !== 'version' ||
    verification?.ok !== false ||
    verification?.decision !== 'fail' ||
    !Array.isArray(reasons) ||
    reasons.length !== 1 ||
    reasons[0] !== 'security.status_not_clean' ||
    security?.passed !== false ||
    security?.status !== 'suspicious'
  ) {
    throw new Error(
      `Fix-forward requires exact @casatwy/deyo@${targetVersion} terminal suspicious verification ` +
      'failure only for security.status_not_clean',
    )
  }
  return JSON.parse(JSON.stringify({
    slug: verification.slug,
    publisherHandle: verification.publisherHandle,
    version: verification.version,
    resolvedFrom: verification.resolvedFrom,
    decision: verification.decision,
    reasons,
    security,
  }))
}

async function tagEvidence(state) {
  const local = await git(['rev-parse', '-q', '--verify', `refs/tags/${state.tag}^{commit}`], { allowFailure: true })
  if (local.code !== 0 || local.stdout.trim() !== state.releaseCommit) {
    throw new Error(`Local tag ${state.tag} does not resolve to the frozen release commit`)
  }
  const remote = await git(
    ['ls-remote', '--tags', 'origin', `refs/tags/${state.tag}`, `refs/tags/${state.tag}^{}`],
    { timeoutMs: NETWORK_TIMEOUT_MS },
  )
  const refs = new Map(remote.stdout.trim().split('\n').filter(Boolean).map((line) => {
    const [commit, ref] = line.trim().split(/\s+/)
    return [ref, commit]
  }))
  const tagObject = refs.get(`refs/tags/${state.tag}`)
  const commit = refs.get(`refs/tags/${state.tag}^{}`)
  if (!/^[a-f0-9]{40}$/.test(tagObject ?? '') || commit !== state.releaseCommit) {
    throw new Error(`Remote tag ${state.tag} does not resolve to the frozen release commit`)
  }

  const stage = await archiveTaggedSkill(state.tag)
  try {
    const treeHash = await hashTree(stage)
    if (treeHash !== state.canonicalTreeHash) {
      throw new Error('Tagged artifact tree differs from the frozen canonical tree hash')
    }
    const projected = await mkdtemp(path.join(os.tmpdir(), 'deyo-clawhub-evidence-'))
    try {
      const projection = await projectClawHubSkill(stage, projected)
      return {
        commit,
        tagObject,
        treeHash,
        projectionKind: projection.kind,
        projectionTreeHash: projection.projectionTreeHash,
        fingerprint: await clawHubFileFingerprint(projected),
      }
    }
    finally {
      await rm(projected, { recursive: true, force: true })
    }
  }
  finally {
    await rm(stage, { recursive: true, force: true })
  }
}

async function terminalFixForwardPreflight(state) {
  const frozen = validateTerminalFixForwardState(state)
  const expectedRemoteBase = frozen.remoteBaseCommit ?? frozen.baseCommit
  await assertGitPreflight()
  await assertLocalTooling()
  if (await readJsonIfPresent(path.join(receiptsDirectory, `v${frozen.targetVersion}.json`))) {
    throw new Error(`Cannot fix-forward a release with a success receipt for v${frozen.targetVersion}`)
  }

  const localHead = (await git(['rev-parse', 'HEAD'])).stdout.trim()
  if (localHead !== frozen.releaseCommit) {
    throw new Error('Cannot fix-forward because local master no longer matches the failed release commit')
  }
  const remoteMaster = await remoteMasterCommit()
  if (remoteMaster !== expectedRemoteBase) {
    throw new Error('Cannot fix-forward because origin/master no longer matches the frozen base commit')
  }

  const tag = await tagEvidence(frozen)
  const inspect = await inspectVersions()
  const allocation = allocateTargetVersion(inspect)
  const nextTarget = allocation.targetVersion
  if (allocation.baseVersion !== frozen.targetVersion) {
    throw new Error(`Cannot fix-forward because ClawHub highest version is ${allocation.baseVersion}, not ${frozen.targetVersion}`)
  }
  if (inspect.skill?.tags?.latest !== frozen.targetVersion) {
    throw new Error(`Cannot fix-forward because ClawHub latest is not ${frozen.targetVersion}`)
  }
  const exact = await inspectExact(frozen.targetVersion)
  if (exact?.version?.version !== frozen.targetVersion) {
    throw new Error(`Cannot fix-forward because ClawHub exact ${frozen.targetVersion} is unavailable`)
  }
  const remoteFingerprint = remoteFileFingerprint(exact)
  if (!compareFingerprints(tag.fingerprint, remoteFingerprint)) {
    throw new Error(`Cannot fix-forward because ClawHub ${frozen.targetVersion} has a different artifact fingerprint`)
  }
  if (
    Object.hasOwn(frozen, 'clawHubFileFingerprint') &&
    !compareFingerprints(frozen.clawHubFileFingerprint, tag.fingerprint)
  ) {
    throw new Error('Cannot fix-forward because the frozen file fingerprint differs from the tagged artifact')
  }
  if (await inspectExact(nextTarget)) {
    throw new Error(`Cannot fix-forward because next patch ${nextTarget} already exists`)
  }
  const verification = await verifyExact(frozen.targetVersion)
  const terminalSecurity = terminalSecurityEvidence(verification, frozen.targetVersion)

  return {
    state: frozen,
    currentSourceSnapshot: await sourceSnapshot(frozen.targetVersion, nextTarget),
    nextTarget,
    remoteMaster,
    tag,
    terminalSecurity,
  }
}

async function confirmFixForward(targetVersion, nextTarget, runtime = {}) {
  const expected = fixForwardConfirmationPhrase(targetVersion, nextTarget)
  if (runtime.confirm) {
    await runtime.confirm(expected)
    return
  }
  const prompt = readline.createInterface({ input: process.stdin, output: process.stdout })
  try {
    const answer = await prompt.question(`Type "${expected}" to abandon this terminal security release: `)
    if (answer.trim() !== expected) throw new Error('Fix-forward confirmation did not match')
  }
  finally {
    prompt.close()
  }
}

async function archiveTerminalFixForward(originalState, preflight) {
  const liveState = await readJsonIfPresent(statePath)
  if (JSON.stringify(liveState) !== JSON.stringify(originalState)) {
    throw new Error('Release state changed while fix-forward was being confirmed')
  }
  await mkdir(abandonedDirectory, { recursive: true, mode: 0o700 })
  await chmod(abandonedDirectory, 0o700)
  const archiveDirectory = await mkdtemp(path.join(abandonedDirectory, `v${originalState.targetVersion}-`))
  await chmod(archiveDirectory, 0o700)
  const archivedStatePath = path.join(archiveDirectory, 'state.json')
  const auditPath = path.join(archiveDirectory, 'fix-forward.json')
  const audit = {
    schema: 1,
    kind: 'deyo.terminal-security-fix-forward',
    state: originalState,
    abandonedAt: new Date().toISOString(),
    reason: 'security.status_not_clean',
    terminalSecurity: preflight.terminalSecurity,
    currentSourceSnapshot: preflight.currentSourceSnapshot,
    nextTarget: preflight.nextTarget,
    remoteMaster: preflight.remoteMaster,
    tagCommit: preflight.tag.commit,
    tagObject: preflight.tag.tagObject,
    tagArchiveTreeHash: preflight.tag.treeHash,
    artifactFingerprint: preflight.tag.fingerprint,
  }
  await atomicPrivateJson(auditPath, audit)
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
    ...audit,
    archivePath: path.relative(root, auditPath).split(path.sep).join('/'),
    archivedStatePath: path.relative(root, archivedStatePath).split(path.sep).join('/'),
  }
}

async function fixForwardTerminalRelease(state, runtime = {}) {
  const initial = await progressStage('Check terminal fix-forward preflight', async () => (
    await terminalFixForwardPreflight(state)
  ))
  process.stdout.write(
    `Deyo terminal security fix-forward plan: ${state.targetVersion} -> ${initial.nextTarget}; ` +
    'the worktree, tags, ClawHub, latest, and origin/master will not be changed.\n',
  )
  await progressStage('Confirm terminal fix-forward', async () => {
    await confirmFixForward(state.targetVersion, initial.nextTarget, runtime)
  })
  const final = await progressStage('Recheck terminal fix-forward preflight', async () => (
    await terminalFixForwardPreflight(state)
  ))
  if (final.currentSourceSnapshot !== initial.currentSourceSnapshot) {
    throw new Error('Release source changed while fix-forward was being confirmed')
  }
  return await progressStage('Archive terminal fix-forward state', async () => (
    await archiveTerminalFixForward(state, final)
  ))
}

async function abandonedFixForwardAudits() {
  let entries
  try {
    entries = await readdir(abandonedDirectory, { withFileTypes: true })
  }
  catch (error) {
    if (error?.code === 'ENOENT') return []
    throw error
  }
  const audits = []
  for (const entry of entries.filter(item => item.isDirectory()).sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
    const directory = path.join(abandonedDirectory, entry.name)
    const audit = await readJsonIfPresent(path.join(directory, 'fix-forward.json'))
    const archivedState = await readJsonIfPresent(path.join(directory, 'state.json'))
    if (!audit && !archivedState) continue
    if (!audit || !archivedState || JSON.stringify(audit.state) !== JSON.stringify(archivedState)) {
      throw new Error(`Invalid fix-forward archive ${entry.name}`)
    }
    audits.push(audit)
  }
  return audits
}

async function authorizeAbandonedFixForwardBase({ localHead, remoteMaster, allocation, inspect }) {
  const candidates = []
  for (const audit of await abandonedFixForwardAudits()) {
    if (audit?.schema !== 1 || audit?.kind !== 'deyo.terminal-security-fix-forward') continue
    const failed = validateTerminalFixForwardState(audit.state)
    const expectedRemoteBase = failed.remoteBaseCommit ?? failed.baseCommit
    if (
      failed.releaseCommit === localHead &&
      expectedRemoteBase === remoteMaster &&
      failed.targetVersion === allocation.baseVersion &&
      audit.nextTarget === allocation.targetVersion
    ) candidates.push({ audit, failed })
  }
  if (candidates.length !== 1) {
    throw new Error('Local master is ahead of origin/master without one matching terminal-security fix-forward archive')
  }
  const { audit, failed } = candidates[0]
  if (
    audit.reason !== 'security.status_not_clean' ||
    !/^[a-f0-9]{64}$/.test(audit.currentSourceSnapshot ?? '') ||
    audit.remoteMaster !== remoteMaster ||
    audit.tagCommit !== localHead ||
    audit.tagArchiveTreeHash !== failed.canonicalTreeHash ||
    !Array.isArray(audit.artifactFingerprint)
  ) {
    throw new Error('Terminal-security fix-forward archive is incomplete or inconsistent')
  }
  terminalSecurityEvidence({ ok: false, ...audit.terminalSecurity }, failed.targetVersion)
  const ancestor = await git(['merge-base', '--is-ancestor', remoteMaster, localHead], { allowFailure: true })
  if (ancestor.code !== 0) throw new Error('Failed release commit is not a fast-forward descendant of origin/master')
  if (inspect.skill?.tags?.latest !== allocation.baseVersion) {
    throw new Error(`ClawHub latest is not the abandoned base ${allocation.baseVersion}`)
  }
  if (await readJsonIfPresent(path.join(receiptsDirectory, `v${failed.targetVersion}.json`))) {
    throw new Error(`Abandoned release v${failed.targetVersion} has a success receipt`)
  }
  const tag = await tagEvidence(failed)
  if (!compareFingerprints(audit.artifactFingerprint, tag.fingerprint)) {
    throw new Error('Abandoned artifact fingerprint differs from the immutable tag archive')
  }
  const exact = await inspectExact(failed.targetVersion)
  if (
    exact?.version?.version !== failed.targetVersion ||
    !compareFingerprints(audit.artifactFingerprint, remoteFileFingerprint(exact))
  ) {
    throw new Error('Abandoned ClawHub artifact no longer matches the immutable tag archive')
  }
  return audit
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
  await progressStage('Generate provider artifacts', generateProviders)
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
  const archive = await command('git', ['archive', '--format=tar', tag, 'deyo'], {
    forwardStdout: false,
    label: 'git archive tagged canonical skill',
  })
  await command('tar', ['-x', '--strip-components=1', '-C', temporary], {
    input: archive.stdout,
    label: 'tar extract tagged canonical skill',
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
    if (!afterFailure) {
      throw new CommandExecutionError('clawhub publish', {
        code: result.code,
        signal: result.signal,
        message: `ClawHub publish failed and target ${state.targetVersion} is absent`,
      })
    }
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
  await progressStage('Publish ClawHub exact version', async () => {
    await publishClawHubIfNeeded(state, stage, localFingerprint)
  })
  return await progressStage('Wait for ClawHub review', async () => {
    const reviewTimeoutMs = runtime.reviewTimeoutMs ?? 10 * 60 * 1000
    const reviewPollMs = runtime.reviewPollMs ?? 15_000
    const sleep = runtime.sleep ?? (delay => new Promise(resolve => setTimeout(resolve, delay)))
    const startedAt = Date.now()
    const deadline = startedAt + reviewTimeoutMs
    let lastReason = 'ClawHub review is pending'
    while (Date.now() <= deadline) {
      try {
        const [inspect, verification] = await Promise.all([
          inspectExact(state.targetVersion),
          verifyExact(state.targetVersion),
        ])
        assertClawHubReady(inspect, verification, state.targetVersion, localFingerprint)
        currentProgressReporter()?.poll('ClawHub is pass/clean', {
          elapsedMs: Date.now() - startedAt,
          remainingMs: Math.max(0, deadline - Date.now()),
          nextMs: 0,
        })
        await progressStage('Verify isolated ClawHub install', async () => {
          await isolatedInstallAndVerify(state, localFingerprint)
        })
        return await advanceState(state, 'clawhub_ready', {
          clawHubFileFingerprint: localFingerprint,
          clawHubProjectionKind: runtime.projection?.kind ?? 'unknown',
          clawHubProjectionTreeHash: runtime.projection?.projectionTreeHash ?? await hashTree(stage),
        })
      }
      catch (error) {
        if (error instanceof ClawHubConflictError) throw error
        lastReason = error instanceof Error ? error.message : String(error)
        const remaining = Math.max(0, deadline - Date.now())
        const next = Math.min(reviewPollMs, remaining)
        currentProgressReporter()?.poll(lastReason, {
          elapsedMs: Date.now() - startedAt,
          remainingMs: remaining,
          nextMs: next,
        })
        if (remaining <= 0) break
        await sleep(next)
      }
    }
    throw new Error(`${lastReason}. Resume the same version with: make publish RESUME=1`)
  })
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
  await progressStage('Verify remote provider activation', async () => {
    await verifyRemoteProviders(state)
  })
  return await progressStage('Write release receipt', async () => {
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
      clawHubProjectionKind: state.clawHubProjectionKind,
      clawHubProjectionTreeHash: state.clawHubProjectionTreeHash,
      releaseNotes: state.releaseNotes,
      releaseNotesPath,
      releaseNotesHash: state.releaseNotesHash,
      clawHubFileFingerprint: state.clawHubFileFingerprint,
      completedAt: new Date().toISOString(),
    }
    await atomicPrivateJson(path.join(receiptsDirectory, `v${state.targetVersion}.json`), receipt)
    await rm(statePath, { force: true })
    currentProgressReporter()?.setRecovery('complete', 'none')
    return receipt
  })
}

async function executeRelease(initialState, runtime = {}) {
  let state = initialState
  currentProgressReporter()?.setRecovery(state.phase, 'make publish RESUME=1')
  await progressStage('Validate frozen release source', async () => {
    const currentSourceSnapshot = await sourceSnapshot(state.baseVersion, state.targetVersion)
    if (currentSourceSnapshot !== state.sourceSnapshot) {
      throw new Error('Release source changed after the version was frozen')
    }
  })
  if (!phaseAtLeast(state, 'prepared')) {
    state = await progressStage('Prepare release workspace', async () => await prepareWorkspace(state))
  }
  else progressSkip('Prepare release workspace', `recovery phase ${state.phase}`)
  if (!phaseAtLeast(state, 'committed')) {
    state = await progressStage('Create release commit', async () => await createReleaseCommit(state))
  }
  else progressSkip('Create release commit', `recovery phase ${state.phase}`)
  if (!phaseAtLeast(state, 'tagged')) {
    state = await progressStage('Create annotated release tag', async () => await createAnnotatedTag(state))
  }
  else progressSkip('Create annotated release tag', `recovery phase ${state.phase}`)

  const canonicalStage = await progressStage('Extract immutable tag archive', async () => (
    await archiveTaggedSkill(state.tag)
  ))
  const stage = await mkdtemp(path.join(os.tmpdir(), 'deyo-clawhub-release-'))
  try {
    const projection = await progressStage('Build and validate ClawHub projection', async () => {
      const archiveHash = await hashTree(canonicalStage)
      if (archiveHash !== state.canonicalTreeHash) throw new Error('Tagged canonical tree differs from the release state')
      const projection = await projectClawHubSkill(canonicalStage, stage)
      if (projection.canonicalTreeHash !== state.canonicalTreeHash) {
        throw new Error('ClawHub projection does not record the frozen canonical tree hash')
      }
      if (projection.skillVersion !== state.targetVersion) {
        throw new Error('ClawHub projection version differs from the frozen release target')
      }
      if (phaseAtLeast(state, 'clawhub_ready')) {
        const projectionFingerprint = await clawHubFileFingerprint(stage)
        if (projection.kind !== state.clawHubProjectionKind) {
          throw new Error('Rebuilt ClawHub projection kind differs from the recovery state')
        }
        if (projection.projectionTreeHash !== state.clawHubProjectionTreeHash) {
          throw new Error('Rebuilt ClawHub projection tree hash differs from the recovery state')
        }
        if (!compareFingerprints(projectionFingerprint, state.clawHubFileFingerprint)) {
          throw new Error('Rebuilt ClawHub projection fingerprint differs from the recovery state')
        }
      }
      return projection
    })
    if (!phaseAtLeast(state, 'tag_pushed')) {
      state = await progressStage('Push immutable release tag', async () => await pushTag(state))
    }
    else progressSkip('Push immutable release tag', `recovery phase ${state.phase}`)
    if (!phaseAtLeast(state, 'clawhub_ready')) {
      state = await waitForClawHub(state, stage, { ...runtime, projection })
    }
    else progressSkip('Publish and verify ClawHub', `recovery phase ${state.phase}`)
    if (!phaseAtLeast(state, 'master_pushed')) {
      state = await progressStage('Push verified release to master', async () => await pushMaster(state))
    }
    else progressSkip('Push verified release to master', `recovery phase ${state.phase}`)
    return await completeRelease(state)
  }
  finally {
    await rm(canonicalStage, { recursive: true, force: true })
    await rm(stage, { recursive: true, force: true })
  }
}

async function runRelease(options, runtime, reporter) {
  const existingState = await readJsonIfPresent(statePath)
  const defaultNext = options.fixForward
    ? 'make fix-forward'
    : options.abort
      ? 'make abort'
      : options.resume
        ? 'make publish RESUME=1'
        : 'make publish DRY_RUN=1'
  reporter.setRecovery(existingState?.phase ?? 'none', existingState && !options.abort && !options.fixForward
    ? 'make publish RESUME=1'
    : defaultNext)
  if (options.fixForward) {
    if (!existingState) throw new Error('No unfinished Deyo Skill release exists to fix-forward')
    assertFormalEnvironment(runtime)
    return await fixForwardTerminalRelease(existingState, runtime)
  }
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

  await progressStage('Confirm release execution', async () => {
    await confirm(targetVersion, options.resume, runtime)
  })
  if (options.resume) return await executeRelease(preflight.state, runtime)

  const state = await progressStage('Freeze release recovery state', async () => {
    const notes = validateReleaseNotes(preflight.releaseNotes)
    const state = {
      schema: 1,
      phase: 'frozen',
      baseVersion,
      targetVersion,
      baseCommit: (await git(['rev-parse', 'HEAD'])).stdout.trim(),
      ...(preflight.remoteBaseCommit ? { remoteBaseCommit: preflight.remoteBaseCommit } : {}),
      sourceSnapshot: await sourceSnapshot(baseVersion, targetVersion),
      releaseNotes: preflight.releaseNotes,
      releaseNotesHash: notes.sha256,
      frozenAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }
    await writeState(state)
    reporter.setRecovery('frozen', 'make publish RESUME=1')
    return state
  })
  return await executeRelease(state, runtime)
}

export async function main(argv = process.argv.slice(2), runtime = {}) {
  const options = parseReleaseOptions(argv)
  const mode = options.fixForward
    ? 'fix-forward'
    : options.abort
      ? 'abort'
      : options.resume
        ? 'resume'
        : options.dryRun
          ? 'dry-run'
          : 'publish'
  const reporter = runtime.progressReporter ?? new ReleaseProgressReporter({
    stdout: runtime.progressStdout ?? process.stdout,
    stderr: runtime.progressStderr ?? process.stderr,
    isTTY: runtime.progressIsTTY ?? Boolean(process.stderr.isTTY),
  })
  return await withProgressReporter(reporter, async () => {
    reporter.mode(mode)
    try {
      return await runRelease(options, runtime, reporter)
    }
    catch (error) {
      reporter.failure(error)
      throw error
    }
    finally {
      reporter.stop()
    }
  })
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then((receipt) => {
    if (receipt?.kind === 'deyo.terminal-security-fix-forward') {
      process.stdout.write(
        `Archived terminal-security Deyo Skill v${receipt.state.targetVersion} release at ${receipt.archivePath}; ` +
        `the next publish target is v${receipt.nextTarget}.\n`,
      )
    }
    else if (receipt?.kind === 'deyo.frozen-release-abort') {
      process.stdout.write(`Archived frozen Deyo Skill v${receipt.state.targetVersion} release at ${receipt.archivePath}.\n`)
    }
    else if (receipt) process.stdout.write(`Published Deyo Skill v${receipt.skillVersion}.\n`)
  }).catch((error) => {
    if (!error?.progressReported) process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  })
}
