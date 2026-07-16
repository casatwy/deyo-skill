import assert from 'node:assert/strict'
import test from 'node:test'
import {
  CommandExecutionError,
  ReleaseProgressReporter,
  safeCommandLabel,
} from '../scripts/release-progress.mjs'

function memoryStream(isTTY = false) {
  let content = ''
  return {
    isTTY,
    write(chunk) {
      content += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk)
      return true
    },
    text() {
      return content
    },
  }
}

function fakeIntervals() {
  const timers = new Map()
  let nextId = 1
  return {
    timers,
    setInterval(callback, interval) {
      const id = nextId
      nextId += 1
      timers.set(id, { callback, interval })
      return id
    },
    clearInterval(id) {
      timers.delete(id)
    },
    tickAll() {
      for (const timer of [...timers.values()]) timer.callback()
    },
  }
}

test('TTY command activity clears its spinner around raw output and recycles its timer', () => {
  let now = 0
  const stdout = memoryStream(true)
  const stderr = memoryStream(true)
  const intervals = fakeIntervals()
  const reporter = new ReleaseProgressReporter({
    stdout,
    stderr,
    isTTY: true,
    now: () => now,
    setInterval: intervals.setInterval,
    clearInterval: intervals.clearInterval,
  })

  const activity = reporter.startCommand('clawhub inspect')
  assert.equal([...intervals.timers.values()][0].interval, 100)
  now = 100
  intervals.tickAll()
  assert.match(stderr.text(), /\u001B\[2K\[release\] \| clawhub inspect \(100ms\)/)

  activity.forward('stdout', Buffer.from('raw stdout\n'))
  activity.forward('stderr', Buffer.from('raw stderr\n'))
  activity.finish({ code: 0 })

  assert.equal(stdout.text(), 'raw stdout\n')
  assert.match(stderr.text(), /raw stderr/)
  assert.match(stderr.text(), /EXIT clawhub inspect exit=0 \(100ms\)/)
  assert.equal(intervals.timers.size, 0)
  assert.equal(reporter.spinnerRendered, false)
})

test('non-TTY command activity emits line heartbeats without ANSI sequences', () => {
  let now = 0
  const stdout = memoryStream()
  const stderr = memoryStream()
  const intervals = fakeIntervals()
  const reporter = new ReleaseProgressReporter({
    stdout,
    stderr,
    isTTY: false,
    now: () => now,
    setInterval: intervals.setInterval,
    clearInterval: intervals.clearInterval,
  })

  const activity = reporter.startCommand('pnpm test')
  assert.equal([...intervals.timers.values()][0].interval, 10_000)
  now = 10_000
  intervals.tickAll()
  activity.forward('stdout', Buffer.from('{"ok":true}'))
  activity.finish({ code: 0 })

  assert.match(stderr.text(), /WAIT pnpm test \(10\.0s\)/)
  assert.doesNotMatch(stderr.text(), /\u001B\[/)
  assert.equal(stdout.text(), '{"ok":true}\n')
  assert.equal(intervals.timers.size, 0)
})

test('stage timing, skip, polling, and failure summaries include recovery guidance', async () => {
  let now = 0
  const stderr = memoryStream()
  const intervals = fakeIntervals()
  const reporter = new ReleaseProgressReporter({
    stderr,
    stdout: memoryStream(),
    now: () => now,
    setInterval: intervals.setInterval,
    clearInterval: intervals.clearInterval,
  })

  await reporter.stage('Validate providers', async () => {
    now = 1250
  })
  reporter.skip('Create release commit', 'recovery phase committed')
  reporter.poll('security scan pending', { elapsedMs: 15_000, remainingMs: 585_000, nextMs: 15_000 })
  reporter.setRecovery('tag_pushed', 'make publish RESUME=1')
  const error = new CommandExecutionError('git push', { code: 42 })
  await assert.rejects(
    reporter.stage('Push immutable release tag', async () => {
      now = 1500
      throw error
    }),
    error,
  )
  reporter.startCommand('clawhub inspect')
  assert.equal(intervals.timers.size, 1)
  reporter.failure(error)

  assert.match(stderr.text(), /OK Validate providers \(1\.3s\)/)
  assert.match(stderr.text(), /SKIP Create release commit \(recovery phase committed\)/)
  assert.match(stderr.text(), /POLL ClawHub review: security scan pending; waited=15\.0s; remaining=585\.0s; next=15\.0s/)
  assert.match(stderr.text(), /FAIL Push immutable release tag \(250ms; exit=42\)/)
  assert.match(stderr.text(), /FAILURE stage=Push immutable release tag; exit=42; recovery_phase=tag_pushed/)
  assert.match(stderr.text(), /next="make publish RESUME=1"/)
  assert.equal(intervals.timers.size, 0)
  assert.equal(error.progressReported, true)
})

test('safe command labels never include release notes, temporary paths, or refs', () => {
  const notes = 'private release notes that must not appear'
  const temporary = '/private/tmp/deyo-clawhub-stage-secret'
  const label = safeCommandLabel('/repo/node_modules/.bin/clawhub', [
    'publish', temporary,
    '--changelog', notes,
    '--source-ref', 'v1.2.3',
  ])
  assert.equal(label, 'clawhub publish')
  assert.doesNotMatch(label, /private|tmp|1\.2\.3/)
})
