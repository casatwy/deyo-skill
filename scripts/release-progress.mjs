import { AsyncLocalStorage } from 'node:async_hooks'
import path from 'node:path'
import process from 'node:process'

const reporterStorage = new AsyncLocalStorage()
const SPINNER_FRAMES = ['|', '/', '-', '\\']

export function formatDuration(durationMs) {
  const safeDuration = Math.max(0, Math.round(durationMs))
  if (safeDuration < 1000) return `${safeDuration}ms`
  return `${(safeDuration / 1000).toFixed(1)}s`
}

function commandToken(commandName, args) {
  const executable = path.basename(commandName)
  if (executable === 'git') return args[0] ? `git ${args[0]}` : 'git'
  if (executable === 'node') {
    const script = args.find(value => /\.mjs$/.test(value))
    return script ? `node ${path.basename(script)}` : 'node'
  }
  if (executable === 'clawhub') {
    if (args[0] === 'skill' && args[1]) return `clawhub skill ${args[1]}`
    if (args.includes('install')) return 'clawhub install'
    const action = args.find(value => !value.startsWith('-'))
    return action ? `clawhub ${action}` : 'clawhub'
  }
  if (['pnpm', 'npm', 'claude', 'tar'].includes(executable)) {
    const action = args.find(value => !value.startsWith('-'))
    return action ? `${executable} ${path.basename(action)}` : executable
  }
  return executable || 'subprocess'
}

export function safeCommandLabel(commandName, args = [], explicitLabel = '') {
  if (explicitLabel) return String(explicitLabel).replace(/[\r\n]+/g, ' ').trim()
  return commandToken(commandName, args)
}

export class CommandExecutionError extends Error {
  constructor(label, outcome = {}) {
    const status = outcome.timedOut
      ? `timed out after ${outcome.timeoutMs}ms`
      : outcome.signal
        ? `stopped by ${outcome.signal}`
        : `exited with code ${outcome.code ?? 'unknown'}`
    super(outcome.message ?? `${label} ${status}`)
    this.name = 'CommandExecutionError'
    this.commandLabel = label
    this.exitCode = outcome.code ?? null
    this.signal = outcome.signal ?? null
    this.timedOut = Boolean(outcome.timedOut)
    this.timeoutMs = outcome.timeoutMs ?? null
    if (outcome.cause) this.cause = outcome.cause
  }
}

export class ReleaseProgressReporter {
  constructor(options = {}) {
    this.stdout = options.stdout ?? process.stdout
    this.stderr = options.stderr ?? process.stderr
    this.isTTY = options.isTTY ?? Boolean(this.stderr?.isTTY)
    this.spinnerIntervalMs = options.spinnerIntervalMs ?? 100
    this.heartbeatIntervalMs = options.heartbeatIntervalMs ?? 10_000
    this.now = options.now ?? Date.now
    this.setInterval = options.setInterval ?? globalThis.setInterval
    this.clearInterval = options.clearInterval ?? globalThis.clearInterval
    this.activities = new Set()
    this.stageStack = []
    this.lastFailedStage = null
    this.phase = 'none'
    this.nextCommand = 'make publish DRY_RUN=1'
    this.spinnerRendered = false
    this.timer = null
    this.paused = 0
    this.frame = 0
    this.lastOutputAt = this.now()
  }

  writeLine(message) {
    this.clearSpinner()
    this.stderr.write(`[release] ${message}\n`)
    this.lastOutputAt = this.now()
  }

  mode(mode) {
    this.writeLine(`MODE ${mode}`)
  }

  setRecovery(phase, nextCommand = this.nextCommand) {
    this.phase = phase || 'none'
    this.nextCommand = nextCommand
  }

  async stage(name, operation) {
    const startedAt = this.now()
    if (this.stageStack.length === 0) this.lastFailedStage = null
    this.stageStack.push(name)
    this.writeLine(`START ${name}`)
    const activity = this.startActivity(name)
    try {
      const result = await operation()
      this.writeLine(`OK ${name} (${formatDuration(this.now() - startedAt)})`)
      return result
    }
    catch (error) {
      if (!this.lastFailedStage) this.lastFailedStage = name
      const detail = error instanceof CommandExecutionError
        ? `; ${commandFailureDetail(error)}`
        : ''
      this.writeLine(`FAIL ${name} (${formatDuration(this.now() - startedAt)}${detail})`)
      throw error
    }
    finally {
      activity.finish()
      const index = this.stageStack.lastIndexOf(name)
      if (index !== -1) this.stageStack.splice(index, 1)
    }
  }

  skip(name, reason) {
    this.writeLine(`SKIP ${name}${reason ? ` (${reason})` : ''}`)
  }

  poll(reason, timing = {}) {
    const elapsed = formatDuration(timing.elapsedMs ?? 0)
    const remaining = formatDuration(timing.remainingMs ?? 0)
    const next = formatDuration(timing.nextMs ?? 0)
    this.writeLine(`POLL ClawHub review: ${reason}; waited=${elapsed}; remaining=${remaining}; next=${next}`)
  }

  ensureTimer() {
    if (this.timer !== null || this.paused || !this.activities.size) return
    this.timer = this.setInterval(() => {
      if (this.paused) return
      const interval = this.isTTY ? this.spinnerIntervalMs : this.heartbeatIntervalMs
      if (this.now() - this.lastOutputAt < interval) return
      if ([...this.activities].some(activity => Object.values(activity.openLine).some(Boolean))) return
      const active = [...this.activities]
      const activity = active.at(-1)
      if (!activity) return
      const label = activity.label
      const elapsed = formatDuration(this.now() - activity.startedAt)
      if (this.isTTY) {
        const frame = SPINNER_FRAMES[this.frame++ % SPINNER_FRAMES.length]
        this.stderr.write(`\r\u001B[2K[release] ${frame} ${label} (${elapsed})`)
        this.spinnerRendered = true
      }
      else this.writeLine(`WAIT ${label} (${elapsed})`)
    }, this.isTTY ? this.spinnerIntervalMs : this.heartbeatIntervalMs)
  }

  async suspend(operation) {
    this.paused += 1
    this.clearSpinner()
    if (this.timer !== null) this.clearInterval(this.timer)
    this.timer = null
    try { return await operation() }
    finally {
      this.paused -= 1
      this.lastOutputAt = this.now()
      this.ensureTimer()
    }
  }

  startActivity(label, command = false) {
    const activity = {
      label, startedAt: this.now(), finished: false,
      openLine: { stdout: false, stderr: false },
    }
    activity.forward = (stream, chunk) => {
      this.clearSpinner()
      const target = stream === 'stderr' ? this.stderr : this.stdout
      target.write(chunk)
      this.lastOutputAt = this.now()
      const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))
      activity.openLine[stream] = value.length > 0 && value.at(-1) !== 0x0a && value.at(-1) !== 0x0d
    }
    activity.finish = (outcome = {}) => {
      if (activity.finished) return
      activity.finished = true
      this.activities.delete(activity)
      if (!this.activities.size && this.timer !== null) {
        this.clearInterval(this.timer)
        this.timer = null
      }
      this.clearSpinner()
      if (activity.openLine.stdout) this.stdout.write('\n')
      if (activity.openLine.stderr) this.stderr.write('\n')
      const status = outcome.timedOut
        ? `timeout=${outcome.timeoutMs}ms`
        : outcome.signal
          ? `signal=${outcome.signal}`
          : `exit=${outcome.code ?? 0}`
      if (command) this.writeLine(`EXIT ${label} ${status} (${formatDuration(this.now() - activity.startedAt)})`)
    }
    this.activities.add(activity)
    this.ensureTimer()
    return activity
  }

  startCommand(label) {
    this.writeLine(`RUN ${label}`)
    return this.startActivity(label, true)
  }

  clearSpinner() {
    if (!this.spinnerRendered || !this.isTTY) return
    this.stderr.write('\r\u001B[2K')
    this.spinnerRendered = false
  }

  stop() {
    for (const activity of [...this.activities]) activity.finish({ signal: 'stopped' })
    this.clearSpinner()
  }

  failure(error) {
    this.stop()
    const stage = this.lastFailedStage ?? this.stageStack.at(-1) ?? 'startup'
    const detail = error instanceof CommandExecutionError
      ? `; ${commandFailureDetail(error)}`
      : ''
    const message = String(error instanceof Error ? error.message : error)
      .replace(/[\r\n]+/g, ' ')
      .trim()
    this.writeLine(
      `FAILURE stage=${stage}${detail}; recovery_phase=${this.phase}; message="${message}"; ` +
      `next="${this.nextCommand}"`,
    )
    if (error && typeof error === 'object') error.progressReported = true
  }
}

function commandFailureDetail(error) {
  if (error.timedOut) return `timeout=${error.timeoutMs}ms`
  if (error.signal) return `signal=${error.signal}`
  return `exit=${error.exitCode ?? 'unknown'}`
}

export function currentProgressReporter() {
  return reporterStorage.getStore() ?? null
}

export async function withProgressReporter(reporter, operation) {
  const interrupt = signal => {
    reporter.stop()
    process.removeListener('SIGINT', interrupt)
    process.removeListener('SIGTERM', interrupt)
    process.kill(process.pid, signal)
  }
  process.on('SIGINT', interrupt)
  process.on('SIGTERM', interrupt)
  try { return await reporterStorage.run(reporter, operation) }
  finally {
    process.removeListener('SIGINT', interrupt)
    process.removeListener('SIGTERM', interrupt)
    reporter.stop()
  }
}

export async function progressStage(name, operation) {
  const reporter = currentProgressReporter()
  return reporter ? await reporter.stage(name, operation) : await operation()
}

export function progressSkip(name, reason) {
  currentProgressReporter()?.skip(name, reason)
}
