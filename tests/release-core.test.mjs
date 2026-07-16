import assert from 'node:assert/strict'
import { chmod, mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {
  abortConfirmationPhrase,
  allocateTargetVersion,
  assertClawHubReady,
  assertReleasePathsAllowed,
  assertTargetAbsent,
  clawHubFileFingerprint,
  ClawHubConflictError,
  ClawHubPendingError,
  confirmationPhrase,
  enumerateImmutableVersions,
  fixForwardConfirmationPhrase,
  hashTree,
  incrementPatch,
  reconcileResumeGitState,
  sha256,
  validateOriginUrl,
  validateRemoteConfiguration,
  validateReleaseNotes,
  validateFrozenAbortState,
  validateReleaseState,
  validateTerminalFixForwardState,
} from '../scripts/release-core.mjs'
import { isCiEnvironment, parseReleaseOptions } from '../scripts/release.mjs'

function inspect(versions, overrides = {}) {
  return {
    skill: {
      stats: { versions: versions.length },
      tags: { latest: versions[0] },
    },
    owner: { handle: 'casatwy' },
    versions: versions.map(version => ({ version })),
    ...overrides,
  }
}

test('allocates the next patch from every immutable version and ignores mutable latest', () => {
  const response = inspect(['1.0.8', '1.0.2', '1.0.7'])
  response.skill.tags.latest = '1.0.2'
  assert.deepEqual(allocateTargetVersion(response), {
    baseVersion: '1.0.8',
    targetVersion: '1.0.9',
    versions: ['1.0.2', '1.0.7', '1.0.8'],
  })
  assert.equal(incrementPatch('1.0.9'), '1.0.10')
})

test('version enumeration fails closed for invalid, duplicate, or incomplete histories', () => {
  assert.throws(() => enumerateImmutableVersions(inspect(['1.0.8-beta.1'])), /stable three-part SemVer/)
  assert.throws(() => enumerateImmutableVersions(inspect(['1.0.8', '1.0.8'])), /duplicate/)
  const incomplete = inspect(['1.0.8'])
  incomplete.skill.stats.versions = 2
  assert.throws(() => enumerateImmutableVersions(incomplete), /incomplete/)
  const paginated = inspect(Array.from({ length: 200 }, (_, index) => `1.0.${index}`))
  paginated.skill.stats.versions = 201
  assert.throws(() => enumerateImmutableVersions(paginated), /incomplete/)
  assert.throws(() => enumerateImmutableVersions(inspect(['1.0.8'], { owner: { handle: 'someone-else' } })), /owner mismatch/)
})

test('target reservation and resume state never allocate another patch', () => {
  assert.throws(() => assertTargetAbsent(['1.0.8', '1.0.9'], '1.0.9'), /already reserved/)
  const releaseNotes = 'release notes\n'
  const state = validateReleaseState({
    schema: 1,
    phase: 'tag_pushed',
    baseVersion: '1.0.8',
    targetVersion: '1.0.9',
    baseCommit: 'b'.repeat(40),
    sourceSnapshot: 'a'.repeat(64),
    canonicalTreeHash: 'c'.repeat(64),
    releaseCommit: 'd'.repeat(40),
    tag: 'v1.0.9',
    releaseNotesHash: sha256(releaseNotes),
    releaseNotes,
  })
  assert.equal(state.targetVersion, '1.0.9')
  assert.equal(confirmationPhrase(state.targetVersion, true), 'resume deyo v1.0.9')
})

test('release options forbid overrides and incompatible modes', () => {
  assert.deepEqual(parseReleaseOptions([]), { abort: false, dryRun: false, fixForward: false, resume: false })
  assert.deepEqual(parseReleaseOptions(['--dry-run']), { abort: false, dryRun: true, fixForward: false, resume: false })
  assert.deepEqual(parseReleaseOptions(['--resume']), { abort: false, dryRun: false, fixForward: false, resume: true })
  assert.deepEqual(parseReleaseOptions(['--abort']), { abort: true, dryRun: false, fixForward: false, resume: false })
  assert.deepEqual(parseReleaseOptions(['--fix-forward']), { abort: false, dryRun: false, fixForward: true, resume: false })
  assert.throws(() => parseReleaseOptions(['--dry-run', '--resume']), /cannot be combined/)
  assert.throws(() => parseReleaseOptions(['--abort', '--resume']), /cannot be combined/)
  assert.throws(() => parseReleaseOptions(['--fix-forward', '--resume']), /cannot be combined/)
  assert.throws(() => parseReleaseOptions(['--version', '1.2.3']), /Unknown release option/)
  assert.equal(isCiEnvironment({ CI: 'true' }), true)
  assert.equal(isCiEnvironment({ GITHUB_ACTIONS: '1' }), true)
  assert.equal(isCiEnvironment({ CI: 'false' }), false)
  assert.equal(isCiEnvironment({}), false)
})

test('terminal fix-forward validation is limited to a complete tag_pushed state', () => {
  const notes = 'notes\n'
  const state = {
    schema: 1,
    phase: 'tag_pushed',
    baseVersion: '1.0.8',
    targetVersion: '1.0.9',
    baseCommit: 'b'.repeat(40),
    sourceSnapshot: 'a'.repeat(64),
    canonicalTreeHash: 'c'.repeat(64),
    releaseCommit: 'd'.repeat(40),
    tag: 'v1.0.9',
    releaseNotes: notes,
    releaseNotesHash: sha256(notes),
  }
  assert.equal(validateTerminalFixForwardState(state), state)
  assert.equal(fixForwardConfirmationPhrase('1.0.9', '1.0.10'), 'fix-forward deyo v1.0.9 to v1.0.10')
  assert.throws(() => fixForwardConfirmationPhrase('1.0.9', '1.0.11'), /next patch/)
  assert.throws(() => validateTerminalFixForwardState({ ...state, phase: 'tagged' }), /tag_pushed/)
  assert.throws(() => validateTerminalFixForwardState({ ...state, clawHubFileFingerprint: [{}] }), /invalid ClawHub/)
})

test('frozen abort validation rejects later phases and post-frozen fields', () => {
  const notes = 'notes\n'
  const frozen = {
    schema: 1,
    phase: 'frozen',
    baseVersion: '1.0.8',
    targetVersion: '1.0.9',
    baseCommit: 'b'.repeat(40),
    sourceSnapshot: 'a'.repeat(64),
    releaseNotes: notes,
    releaseNotesHash: sha256(notes),
  }
  assert.equal(validateFrozenAbortState(frozen), frozen)
  assert.equal(abortConfirmationPhrase('1.0.9'), 'abort deyo v1.0.9')
  assert.throws(
    () => validateFrozenAbortState({ ...frozen, phase: 'prepared', canonicalTreeHash: 'c'.repeat(64) }),
    /Only a frozen release can be aborted safely/,
  )
  for (const field of ['canonicalTreeHash', 'releaseCommit', 'tag', 'clawHubFileFingerprint']) {
    assert.throws(
      () => validateFrozenAbortState({ ...frozen, [field]: field === 'clawHubFileFingerprint' ? [] : 'x' }),
      /post-frozen state/,
    )
  }
})

test('release allowlist and official remote fail closed', () => {
  assert.doesNotThrow(() => assertReleasePathsAllowed(['deyo/SKILL.md', 'plugins/deyo/.codex-plugin/plugin.json']))
  assert.throws(() => assertReleasePathsAllowed(['../outside', '.env']), /outside the allowlist/)
  assert.equal(validateOriginUrl('git@github.com:casatwy/deyo-skill.git'), 'git@github.com:casatwy/deyo-skill.git')
  assert.equal(validateOriginUrl('https://github.com/casatwy/deyo-skill.git'), 'https://github.com/casatwy/deyo-skill.git')
  assert.throws(() => validateOriginUrl('git@github.com:fork/deyo-skill.git'), /not the official/)
  assert.equal(validateRemoteConfiguration(['origin'], 'git@github.com:casatwy/deyo-skill.git'), 'git@github.com:casatwy/deyo-skill.git')
  assert.throws(() => validateRemoteConfiguration(['origin', 'fork'], 'git@github.com:casatwy/deyo-skill.git'), /only the official origin/)
})

test('resume recovers only exact commit and master-push crash windows', () => {
  const prepared = {
    schema: 1,
    phase: 'prepared',
    baseVersion: '1.0.8',
    targetVersion: '1.0.9',
    baseCommit: 'b'.repeat(40),
    sourceSnapshot: 'a'.repeat(64),
    canonicalTreeHash: 'c'.repeat(64),
    releaseNotes: 'notes\n',
    releaseNotesHash: sha256('notes\n'),
  }
  const releaseCommit = 'd'.repeat(40)
  const recoveredCommit = reconcileResumeGitState(prepared, {
    localHead: releaseCommit,
    localHeadParent: prepared.baseCommit,
    localHeadSubject: 'release(skill): v1.0.9',
    remoteMaster: prepared.baseCommit,
  })
  assert.equal(recoveredCommit.phase, 'committed')
  assert.equal(recoveredCommit.releaseCommit, releaseCommit)
  assert.throws(() => reconcileResumeGitState(prepared, {
    localHead: releaseCommit,
    localHeadParent: prepared.baseCommit,
    localHeadSubject: 'unrelated commit',
    remoteMaster: prepared.baseCommit,
  }), /diverged/)

  const clawhubReady = {
    ...prepared,
    phase: 'clawhub_ready',
    releaseCommit,
    tag: 'v1.0.9',
    clawHubFileFingerprint: [{ path: 'SKILL.md', size: 1, sha256: 'e'.repeat(64) }],
  }
  const recoveredPush = reconcileResumeGitState(clawhubReady, {
    localHead: releaseCommit,
    remoteMaster: releaseCommit,
  })
  assert.equal(recoveredPush.phase, 'master_pushed')
  assert.throws(() => reconcileResumeGitState(clawhubReady, {
    localHead: releaseCommit,
    remoteMaster: 'f'.repeat(40),
  }), /origin\/master changed/)

  const fixForwardPrepared = {
    ...prepared,
    baseVersion: '1.0.9',
    targetVersion: '1.0.10',
    baseCommit: releaseCommit,
    remoteBaseCommit: prepared.baseCommit,
  }
  const fixForwardCommit = 'e'.repeat(40)
  const recoveredFixForward = reconcileResumeGitState(fixForwardPrepared, {
    localHead: fixForwardCommit,
    localHeadParent: releaseCommit,
    localHeadSubject: 'release(skill): v1.0.10',
    remoteMaster: prepared.baseCommit,
  })
  assert.equal(recoveredFixForward.phase, 'committed')
  assert.equal(recoveredFixForward.releaseCommit, fixForwardCommit)
})

test('1.0.10 ClawHub-ready state records projection evidence separately from canonical hash', () => {
  const notes = 'notes\n'
  const ready = {
    schema: 1,
    phase: 'clawhub_ready',
    baseVersion: '1.0.9',
    targetVersion: '1.0.10',
    baseCommit: 'b'.repeat(40),
    sourceSnapshot: 'a'.repeat(64),
    canonicalTreeHash: 'c'.repeat(64),
    releaseCommit: 'd'.repeat(40),
    tag: 'v1.0.10',
    releaseNotes: notes,
    releaseNotesHash: sha256(notes),
    clawHubFileFingerprint: [{ path: 'SKILL.md', size: 1, sha256: 'e'.repeat(64) }],
    clawHubProjectionKind: 'openclaw-v1',
    clawHubProjectionTreeHash: 'f'.repeat(64),
  }
  assert.equal(validateReleaseState(ready), ready)
  assert.throws(
    () => validateReleaseState({ ...ready, clawHubProjectionKind: undefined }),
    /projection kind/,
  )
  assert.throws(
    () => validateReleaseState({ ...ready, clawHubProjectionTreeHash: undefined }),
    /projection tree hash/,
  )
})

test('1.0.11 ClawHub-ready state requires the v2 projection kind', () => {
  const notes = 'notes\n'
  const ready = {
    schema: 1,
    phase: 'clawhub_ready',
    baseVersion: '1.0.10',
    targetVersion: '1.0.11',
    baseCommit: 'b'.repeat(40),
    sourceSnapshot: 'a'.repeat(64),
    canonicalTreeHash: 'c'.repeat(64),
    releaseCommit: 'd'.repeat(40),
    tag: 'v1.0.11',
    releaseNotes: notes,
    releaseNotesHash: sha256(notes),
    clawHubFileFingerprint: [{ path: 'SKILL.md', size: 1, sha256: 'e'.repeat(64) }],
    clawHubProjectionKind: 'openclaw-v2',
    clawHubProjectionTreeHash: 'f'.repeat(64),
  }
  assert.equal(validateReleaseState(ready), ready)
  assert.throws(
    () => validateReleaseState({ ...ready, clawHubProjectionKind: 'openclaw-v1' }),
    /projection kind/,
  )
})

test('tree hashing includes modes, symlinks, paths, and contents', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'deyo-tree-hash-'))
  try {
    await mkdir(path.join(directory, 'nested'))
    const script = path.join(directory, 'nested', 'script.mjs')
    await writeFile(script, 'one\n')
    await chmod(script, 0o644)
    await symlink('nested/script.mjs', path.join(directory, 'link'))
    const initial = await hashTree(directory)
    const fingerprint = await clawHubFileFingerprint(directory)
    assert.deepEqual(fingerprint.map(entry => entry.path), ['nested/script.mjs'])
    await chmod(script, 0o755)
    assert.notEqual(await hashTree(directory), initial)
    await chmod(script, 0o644)
    await writeFile(script, 'two\n')
    assert.notEqual(await hashTree(directory), initial)
  }
  finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('ClawHub readiness requires exact fingerprint, latest, and pass-clean security', () => {
  const fingerprint = [{ path: 'SKILL.md', size: 4, sha256: 'a'.repeat(64) }]
  const exact = {
    skill: { tags: { latest: '1.0.9' } },
    version: { version: '1.0.9', files: fingerprint },
  }
  const verification = {
    ok: true,
    decision: 'pass',
    security: { passed: true, status: 'clean' },
  }
  assert.doesNotThrow(() => assertClawHubReady(exact, verification, '1.0.9', fingerprint))
  assert.throws(
    () => assertClawHubReady(exact, { ...verification, decision: 'review' }, '1.0.9', fingerprint),
    error => error instanceof ClawHubPendingError && /has not passed/.test(error.message),
  )
  assert.throws(
    () => assertClawHubReady(exact, { ...verification, decision: 'reject' }, '1.0.9', fingerprint),
    error => error instanceof ClawHubConflictError && /rejected/.test(error.message),
  )
  assert.throws(
    () => assertClawHubReady(exact, { ...verification, security: { passed: false, status: 'pending' } }, '1.0.9', fingerprint),
    error => error instanceof ClawHubPendingError && /not pass\/clean/.test(error.message),
  )
  assert.throws(
    () => assertClawHubReady(exact, { ...verification, security: { passed: false, status: 'malicious' } }, '1.0.9', fingerprint),
    error => error instanceof ClawHubConflictError && /rejected/.test(error.message),
  )
  assert.throws(
    () => assertClawHubReady({ ...exact, skill: { tags: { latest: '1.0.8' } } }, verification, '1.0.9', fingerprint),
    error => error instanceof ClawHubPendingError && /latest/.test(error.message),
  )
})

test('release notes are non-empty UTF-8 and at most 20 KiB', () => {
  assert.equal(validateReleaseNotes('hello\n').bytes, 6)
  assert.equal(validateReleaseNotes(Buffer.from('hello\n')).content, 'hello\n')
  assert.throws(() => validateReleaseNotes('  \n'), /must not be empty/)
  assert.throws(() => validateReleaseNotes('x'.repeat(20 * 1024 + 1)), /exceeds/)
  assert.throws(() => validateReleaseNotes(Buffer.from([0xc3, 0x28])), /must be UTF-8/)
})
