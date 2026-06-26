// test/trajectory-observer-concurrency.test.js
//
// FIX 2 (2026-05-10): cap concurrent observer LLM subprocesses at 5.
// Why: every specialist completion fires `claude --print` via the observer.
// With parallel pentests + 18 specialists each, 30+ concurrent processes
// could stress host memory + hit Anthropic rate-limits.
//
// Implementation: in-process semaphore inside trajectory-observer.js. Default
// QUEUE mode — calls beyond CAP wait for a slot. CAP_DROP_OVER mode — calls
// beyond CAP get logged with `error: 'cap-exceeded'`, no LLM fired.

const assert = require('node:assert')
const { test, beforeEach } = require('node:test')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')

const observer = require('../agents/trajectory-observer')

// Per-test isolated log file — keeps the live pentest /root/intel/trajectory/
// observations.jsonl clean during testing.
function newTmpLogFile() {
  return path.join(os.tmpdir(), `trajobs-test-${Date.now()}-${Math.random().toString(36).slice(2)}.jsonl`)
}

beforeEach(() => {
  // Reset semaphore between tests — module state otherwise leaks across cases
  if (typeof observer._resetConcurrencyForTest === 'function') {
    observer._resetConcurrencyForTest()
  }
  delete process.env.TRAJECTORY_OBSERVER_CAP
  delete process.env.TRAJECTORY_OBSERVER_CAP_DROP_OVER
})

test('exposes OBSERVER_CONCURRENCY_CAP = 5 by default', () => {
  assert.strictEqual(observer.OBSERVER_CONCURRENCY_CAP, 5,
    'default concurrent observer cap should be 5')
})

test('queue mode (default): 10 concurrent calls, only 5 active at any moment', async () => {
  const logFile = newTmpLogFile()
  let active = 0
  let peak = 0
  const totalDone = []

  const slowMockLLM = async (_prompt) => {
    active++
    if (active > peak) peak = active
    await new Promise(r => setTimeout(r, 80))
    active--
    return JSON.stringify({ verdict: 'on-track', first_failed_dim: null, reason: 'mock' })
  }

  const promises = []
  for (let i = 0; i < 10; i++) {
    promises.push(
      observer.observeSpecialistOutput({
        agent: `AGENT_${i}`,
        taskId: `T${i}`,
        goal: 'mock goal',
        output: 'mock output',
        callLLM: slowMockLLM,
        logFile,
      }).then(r => totalDone.push(r))
    )
  }

  await Promise.all(promises)
  assert.strictEqual(totalDone.length, 10, 'all 10 must complete')
  assert.ok(peak <= 5, `peak concurrency must be <= 5, was ${peak}`)
  assert.ok(peak >= 1, `peak concurrency must be > 0, was ${peak}`)
})

test('queue mode: all 10 log entries written (correctness preserved)', async () => {
  const logFile = newTmpLogFile()
  const fastMockLLM = async () => JSON.stringify({ verdict: 'on-track', first_failed_dim: null, reason: 'mock' })

  const promises = []
  for (let i = 0; i < 10; i++) {
    promises.push(observer.observeSpecialistOutput({
      agent: `A${i}`, taskId: `T${i}`, goal: 'g', output: 'o',
      callLLM: fastMockLLM, logFile,
    }))
  }
  await Promise.all(promises)

  const raw = fs.readFileSync(logFile, 'utf-8').trim()
  const lines = raw.split('\n').filter(Boolean)
  assert.strictEqual(lines.length, 10, `expected 10 log lines, got ${lines.length}`)
})

test('queue mode: queued calls eventually run after slot frees', async () => {
  const logFile = newTmpLogFile()
  const startTimes = []
  const slowLLM = async () => {
    startTimes.push(Date.now())
    await new Promise(r => setTimeout(r, 100))
    return JSON.stringify({ verdict: 'on-track', first_failed_dim: null, reason: 'm' })
  }

  const promises = []
  for (let i = 0; i < 10; i++) {
    promises.push(observer.observeSpecialistOutput({
      agent: `A${i}`, taskId: `T${i}`, goal: 'g', output: 'o',
      callLLM: slowLLM, logFile,
    }))
  }
  await Promise.all(promises)

  assert.strictEqual(startTimes.length, 10, '10 LLM invocations expected')
  // First batch (5) start near t=0; second batch (5) starts >=80ms later (after queue release)
  const first5 = startTimes.slice(0, 5).sort((a, b) => a - b)
  const last5 = startTimes.slice(5, 10).sort((a, b) => a - b)
  const gap = last5[0] - first5[4]
  assert.ok(gap >= 50,
    `second batch must start at least 50ms after first batch finishes, gap=${gap}ms`)
})

test('drop mode: TRAJECTORY_OBSERVER_CAP_DROP_OVER=true → 6th-10th get error="cap-exceeded"', async () => {
  process.env.TRAJECTORY_OBSERVER_CAP_DROP_OVER = 'true'
  const logFile = newTmpLogFile()
  let llmCalls = 0
  const slowLLM = async () => {
    llmCalls++
    await new Promise(r => setTimeout(r, 80))
    return JSON.stringify({ verdict: 'on-track', first_failed_dim: null, reason: 'm' })
  }

  const promises = []
  const results = []
  for (let i = 0; i < 10; i++) {
    promises.push(
      observer.observeSpecialistOutput({
        agent: `A${i}`, taskId: `T${i}`, goal: 'g', output: 'o',
        callLLM: slowLLM, logFile,
      }).then(r => results.push(r))
    )
  }
  await Promise.all(promises)

  // 5 LLM calls fire; 5 dropped
  assert.strictEqual(llmCalls, 5, `expected 5 LLM calls in drop mode, got ${llmCalls}`)
  const dropped = results.filter(r => r.error === 'cap-exceeded')
  assert.strictEqual(dropped.length, 5, `expected 5 dropped, got ${dropped.length}`)
  // All 10 still log — drop is observable as `verdict='indeterminate' + error='cap-exceeded'`
  const raw = fs.readFileSync(logFile, 'utf-8').trim()
  const lines = raw.split('\n').filter(Boolean)
  assert.strictEqual(lines.length, 10, `all 10 must log even in drop mode, got ${lines.length}`)
})

test('drop mode: dropped entries have verdict="indeterminate"', async () => {
  process.env.TRAJECTORY_OBSERVER_CAP_DROP_OVER = 'true'
  const logFile = newTmpLogFile()
  const slowLLM = async () => {
    await new Promise(r => setTimeout(r, 80))
    return JSON.stringify({ verdict: 'on-track', first_failed_dim: null, reason: 'm' })
  }

  const promises = []
  const results = []
  for (let i = 0; i < 7; i++) {
    promises.push(
      observer.observeSpecialistOutput({
        agent: `A${i}`, taskId: `T${i}`, goal: 'g', output: 'o',
        callLLM: slowLLM, logFile,
      }).then(r => results.push(r))
    )
  }
  await Promise.all(promises)

  const dropped = results.filter(r => r.error === 'cap-exceeded')
  for (const d of dropped) {
    assert.strictEqual(d.verdict, 'indeterminate',
      'dropped entries must have indeterminate verdict (not faked on-track)')
  }
})

test('TRAJECTORY_OBSERVER_CAP env var overrides default cap', async () => {
  // Drop default of 5 down to 2
  process.env.TRAJECTORY_OBSERVER_CAP = '2'
  if (typeof observer._resetConcurrencyForTest === 'function') {
    observer._resetConcurrencyForTest()
  }
  const logFile = newTmpLogFile()
  let active = 0
  let peak = 0
  const slowLLM = async () => {
    active++
    if (active > peak) peak = active
    await new Promise(r => setTimeout(r, 60))
    active--
    return JSON.stringify({ verdict: 'on-track', first_failed_dim: null, reason: 'm' })
  }

  const promises = []
  for (let i = 0; i < 8; i++) {
    promises.push(observer.observeSpecialistOutput({
      agent: `A${i}`, taskId: `T${i}`, goal: 'g', output: 'o',
      callLLM: slowLLM, logFile,
    }))
  }
  await Promise.all(promises)
  assert.ok(peak <= 2, `with cap=2, peak should be <= 2, was ${peak}`)
})

test('semaphore releases on LLM error (does not deadlock)', async () => {
  const logFile = newTmpLogFile()
  // First 5 calls throw, next 5 should still complete (slot must free on error)
  let i = 0
  const flakyLLM = async () => {
    const myI = i++
    await new Promise(r => setTimeout(r, 30))
    if (myI < 5) throw new Error('mock LLM error')
    return JSON.stringify({ verdict: 'on-track', first_failed_dim: null, reason: 'm' })
  }

  const promises = []
  for (let n = 0; n < 10; n++) {
    promises.push(observer.observeSpecialistOutput({
      agent: `A${n}`, taskId: `T${n}`, goal: 'g', output: 'o',
      callLLM: flakyLLM, logFile,
    }))
  }
  // If semaphore leaks, this hangs forever. Test runner timeout will catch.
  const results = await Promise.all(promises)
  assert.strictEqual(results.length, 10, 'all 10 must resolve (no deadlock)')
})
