import { createHash } from 'node:crypto'
import { lstat, readFile, readdir, readlink } from 'node:fs/promises'
import path from 'node:path'

export const STABLE_SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/
export const RELEASE_PHASES = [
  'frozen',
  'prepared',
  'committed',
  'tagged',
  'tag_pushed',
  'clawhub_ready',
  'master_pushed',
]

export class ClawHubPendingError extends Error {
  constructor(message) {
    super(message)
    this.name = 'ClawHubPendingError'
  }
}

export class ClawHubConflictError extends Error {
  constructor(message) {
    super(message)
    this.name = 'ClawHubConflictError'
  }
}

const ALLOWED_PATHS = new Set([
  '.gitignore',
  'README.md',
  'README.en.md',
  'gemini-extension.json',
  'makefile',
  'package.json',
  'pnpm-lock.yaml',
])
const ALLOWED_PREFIXES = [
  '.agents/',
  '.claude-plugin/',
  'deyo/',
  'plugins/',
  'providers/',
  'release/',
  'scripts/',
  'skills/',
  'tests/',
]

export function assertStableSemver(version, label = 'version') {
  if (!STABLE_SEMVER.test(version)) {
    throw new Error(`${label} must be a stable three-part SemVer: ${String(version)}`)
  }
  return version
}

export function compareSemver(left, right) {
  const a = assertStableSemver(left).split('.').map(Number)
  const b = assertStableSemver(right).split('.').map(Number)
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index] - b[index]
  }
  return 0
}

export function incrementPatch(version) {
  const [major, minor, patch] = assertStableSemver(version).split('.').map(Number)
  if (!Number.isSafeInteger(patch + 1)) throw new Error('Patch version overflow')
  return `${major}.${minor}.${patch + 1}`
}

export function enumerateImmutableVersions(inspect) {
  if (!inspect || typeof inspect !== 'object') throw new Error('Invalid ClawHub inspect response')
  if (inspect.owner?.handle !== 'casatwy') {
    throw new Error(`ClawHub owner mismatch: expected casatwy, received ${inspect.owner?.handle ?? 'unknown'}`)
  }
  const versions = inspect.versions
  if (!Array.isArray(versions)) throw new Error('ClawHub version history is missing')
  const advertisedCount = inspect.skill?.stats?.versions
  if (!Number.isSafeInteger(advertisedCount) || advertisedCount < 1) {
    throw new Error('ClawHub did not report a trustworthy immutable version count')
  }
  if (advertisedCount > 200 || versions.length !== advertisedCount) {
    throw new Error(`ClawHub version history is incomplete (${versions.length}/${advertisedCount})`)
  }
  const unique = new Set()
  for (const entry of versions) {
    const version = assertStableSemver(entry?.version, 'ClawHub version')
    if (unique.has(version)) throw new Error(`ClawHub returned duplicate version ${version}`)
    unique.add(version)
  }
  return [...unique].sort(compareSemver)
}

export function allocateTargetVersion(inspect) {
  const versions = enumerateImmutableVersions(inspect)
  const baseVersion = versions.at(-1)
  return {
    baseVersion,
    targetVersion: incrementPatch(baseVersion),
    versions,
  }
}

export function assertTargetAbsent(versions, targetVersion) {
  assertStableSemver(targetVersion, 'target version')
  if (versions.includes(targetVersion)) {
    throw new Error(`Target version ${targetVersion} is already reserved on ClawHub`)
  }
}

export function confirmationPhrase(targetVersion, resume = false) {
  assertStableSemver(targetVersion, 'target version')
  return `${resume ? 'resume' : 'publish'} deyo v${targetVersion}`
}

export function abortConfirmationPhrase(targetVersion) {
  assertStableSemver(targetVersion, 'target version')
  return `abort deyo v${targetVersion}`
}

export function phaseAtLeast(state, phase) {
  const currentIndex = RELEASE_PHASES.indexOf(state?.phase)
  const targetIndex = RELEASE_PHASES.indexOf(phase)
  if (currentIndex === -1 || targetIndex === -1) throw new Error('Invalid release phase')
  return currentIndex >= targetIndex
}

export function validateReleaseState(state) {
  if (!state || state.schema !== 1) throw new Error('Unsupported release recovery state')
  assertStableSemver(state.baseVersion, 'state base version')
  assertStableSemver(state.targetVersion, 'state target version')
  if (incrementPatch(state.baseVersion) !== state.targetVersion) {
    throw new Error('Recovery state target is not the frozen next patch')
  }
  if (!RELEASE_PHASES.includes(state.phase)) throw new Error(`Invalid recovery phase ${state.phase}`)
  if (!/^[a-f0-9]{64}$/.test(state.sourceSnapshot)) throw new Error('Invalid source snapshot hash')
  if (!/^[a-f0-9]{40}$/.test(state.baseCommit)) throw new Error('Invalid frozen base commit')
  if (!/^[a-f0-9]{64}$/.test(state.releaseNotesHash)) throw new Error('Invalid release notes hash')
  if (typeof state.releaseNotes !== 'string' || sha256(state.releaseNotes) !== state.releaseNotesHash) {
    throw new Error('Recovery state release notes do not match their frozen hash')
  }
  const phaseIndex = RELEASE_PHASES.indexOf(state.phase)
  if (phaseIndex >= RELEASE_PHASES.indexOf('prepared') && !/^[a-f0-9]{64}$/.test(state.canonicalTreeHash)) {
    throw new Error('Prepared recovery state is missing the canonical tree hash')
  }
  if (phaseIndex >= RELEASE_PHASES.indexOf('committed') && !/^[a-f0-9]{40}$/.test(state.releaseCommit)) {
    throw new Error('Committed recovery state is missing its release commit')
  }
  if (phaseIndex >= RELEASE_PHASES.indexOf('tagged') && state.tag !== `v${state.targetVersion}`) {
    throw new Error('Tagged recovery state has an invalid immutable tag')
  }
  if (phaseIndex >= RELEASE_PHASES.indexOf('clawhub_ready') && !Array.isArray(state.clawHubFileFingerprint)) {
    throw new Error('ClawHub-ready state is missing its file fingerprint')
  }
  if (phaseIndex >= RELEASE_PHASES.indexOf('clawhub_ready')) {
    for (const entry of state.clawHubFileFingerprint) {
      if (
        !entry ||
        typeof entry.path !== 'string' ||
        entry.path.length === 0 ||
        entry.path.startsWith('/') ||
        entry.path.includes('..') ||
        !Number.isSafeInteger(entry.size) ||
        entry.size < 0 ||
        !/^[a-f0-9]{64}$/.test(entry.sha256)
      ) {
        throw new Error('ClawHub-ready state contains an invalid file fingerprint')
      }
    }
  }
  return state
}

export function validateFrozenAbortState(state) {
  const validated = validateReleaseState(state)
  if (validated.phase !== 'frozen') {
    throw new Error(`Only a frozen release can be aborted safely; current phase is ${validated.phase}`)
  }
  const postFrozenFields = [
    'canonicalTreeHash',
    'releaseCommit',
    'tag',
    'clawHubFileFingerprint',
  ]
  const present = postFrozenFields.filter(field => Object.hasOwn(validated, field))
  if (present.length > 0) {
    throw new Error(`Frozen release contains post-frozen state and cannot be aborted: ${present.join(', ')}`)
  }
  return validated
}

export function isReleasePathAllowed(relativePath) {
  const normalized = relativePath.replaceAll('\\', '/').replace(/^\.\//, '')
  if (!normalized || normalized.startsWith('../') || normalized.includes('/../')) return false
  return ALLOWED_PATHS.has(normalized) || ALLOWED_PREFIXES.some(prefix => normalized.startsWith(prefix))
}

export function assertReleasePathsAllowed(paths) {
  const rejected = paths.filter(item => !isReleasePathAllowed(item))
  if (rejected.length > 0) throw new Error(`Release contains paths outside the allowlist: ${rejected.join(', ')}`)
}

export function validateOriginUrl(url) {
  const allowed = new Set([
    'git@github.com:casatwy/deyo-skill.git',
    'https://github.com/casatwy/deyo-skill.git',
  ])
  if (!allowed.has(url)) throw new Error(`origin is not the official Deyo Skill repository: ${url}`)
  return url
}

export function validateRemoteConfiguration(remotes, originUrl) {
  if (!Array.isArray(remotes) || remotes.length !== 1 || remotes[0] !== 'origin') {
    const received = Array.isArray(remotes) ? remotes.join(', ') : String(remotes)
    throw new Error(`Skill releases allow only the official origin remote, received: ${received || 'none'}`)
  }
  return validateOriginUrl(originUrl)
}

export function reconcileResumeGitState(state, context) {
  const recovered = { ...validateReleaseState(state) }
  const expectedSubject = `release(skill): v${recovered.targetVersion}`

  if (!phaseAtLeast(recovered, 'committed')) {
    if (context.localHead !== recovered.baseCommit) {
      if (
        recovered.phase === 'prepared' &&
        context.localHeadParent === recovered.baseCommit &&
        context.localHeadSubject === expectedSubject
      ) {
        recovered.phase = 'committed'
        recovered.releaseCommit = context.localHead
      }
      else {
        throw new Error('Local master diverged from the frozen release before its commit was recorded')
      }
    }
  }
  else if (context.localHead !== recovered.releaseCommit) {
    throw new Error('Local master no longer points to the frozen release commit')
  }

  if (phaseAtLeast(recovered, 'master_pushed')) {
    if (context.remoteMaster !== recovered.releaseCommit) {
      throw new Error('origin/master no longer points to the activated release commit')
    }
  }
  else if (recovered.phase === 'clawhub_ready' && context.remoteMaster === recovered.releaseCommit) {
    recovered.phase = 'master_pushed'
  }
  else if (context.remoteMaster !== recovered.baseCommit) {
    throw new Error('origin/master changed since this release was frozen')
  }

  return recovered
}

export function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

async function listTreeEntries(root, directory = root) {
  const children = await readdir(directory, { withFileTypes: true })
  children.sort((a, b) => a.name.localeCompare(b.name, 'en'))
  const entries = []
  for (const child of children) {
    const absolutePath = path.join(directory, child.name)
    const relativePath = path.relative(root, absolutePath).split(path.sep).join('/')
    const stats = await lstat(absolutePath)
    const mode = (stats.mode & 0o777).toString(8).padStart(3, '0')
    if (stats.isDirectory()) {
      entries.push({ path: relativePath, type: 'directory', mode })
      entries.push(...await listTreeEntries(root, absolutePath))
    }
    else if (stats.isFile()) {
      const content = await readFile(absolutePath)
      entries.push({ path: relativePath, type: 'file', mode, size: content.length, sha256: sha256(content) })
    }
    else if (stats.isSymbolicLink()) {
      const target = await readlink(absolutePath)
      entries.push({ path: relativePath, type: 'symlink', mode, target })
    }
    else {
      throw new Error(`Unsupported file type in release tree: ${relativePath}`)
    }
  }
  return entries
}

export async function describeTree(root) {
  return await listTreeEntries(root)
}

export async function hashTree(root) {
  const entries = await describeTree(root)
  return sha256(JSON.stringify(entries))
}

export async function clawHubFileFingerprint(root) {
  const entries = await describeTree(root)
  return entries
    .filter(entry => entry.type === 'file')
    .map(entry => ({ path: entry.path, size: entry.size, sha256: entry.sha256 }))
    .sort((a, b) => a.path.localeCompare(b.path, 'en'))
}

export function remoteFileFingerprint(inspect) {
  const files = inspect?.version?.files
  if (!Array.isArray(files)) throw new Error('ClawHub exact-version file list is unavailable')
  return files
    .filter(file => file.path !== 'skill-card.md')
    .map(file => ({ path: file.path, size: file.size, sha256: file.sha256 }))
    .sort((a, b) => a.path.localeCompare(b.path, 'en'))
}

export function compareFingerprints(local, remote) {
  return JSON.stringify(local) === JSON.stringify(remote)
}

export function assertClawHubReady(inspect, verification, targetVersion, localFingerprint) {
  if (inspect?.version?.version !== targetVersion) throw new ClawHubPendingError('ClawHub exact version is not available')
  let remoteFingerprint
  try {
    remoteFingerprint = remoteFileFingerprint(inspect)
  }
  catch (error) {
    throw new ClawHubConflictError(`ClawHub ${targetVersion} returned an invalid file fingerprint: ${error.message}`)
  }
  if (!compareFingerprints(localFingerprint, remoteFingerprint)) {
    throw new ClawHubConflictError(`ClawHub ${targetVersion} exists with a different file fingerprint`)
  }
  if (verification?.ok !== true || verification?.decision !== 'pass') {
    if (['fail', 'reject', 'blocked'].includes(verification?.decision)) {
      throw new ClawHubConflictError(`ClawHub verification rejected ${targetVersion}`)
    }
    throw new ClawHubPendingError(`ClawHub verification has not passed for ${targetVersion}`)
  }
  const security = verification?.security
  if (security?.passed !== true || security?.status !== 'clean') {
    if (security?.passed === false && !['pending', 'review', undefined].includes(security?.status)) {
      throw new ClawHubConflictError(`ClawHub security rejected ${targetVersion}: ${security.status}`)
    }
    throw new ClawHubPendingError(`ClawHub security is not pass/clean for ${targetVersion}`)
  }
  if (inspect?.skill?.tags?.latest !== targetVersion) {
    throw new ClawHubPendingError(`ClawHub latest does not resolve to ${targetVersion}`)
  }
}

export function validateReleaseNotes(input) {
  let content
  if (typeof input === 'string') content = input
  else if (input instanceof Uint8Array) {
    try {
      content = new TextDecoder('utf-8', { fatal: true }).decode(input)
    }
    catch {
      throw new Error('release/next.md must be UTF-8')
    }
  }
  else throw new Error('release/next.md must be UTF-8 text')
  if (content.trim().length === 0) throw new Error('release/next.md must not be empty')
  const bytes = Buffer.byteLength(content, 'utf8')
  if (bytes > 20 * 1024) throw new Error('release/next.md exceeds 20 KiB')
  return { bytes, sha256: sha256(content), content }
}
