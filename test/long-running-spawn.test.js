// test/long-running-spawn.test.js
//
// Unit tests for agents/long-running-spawn.js — async subprocess wrapper.
// Spec: docs/superpowers/plans/2026-05-08-supervisor-heartbeat-fix.md (Task 1)

const assert = require('node:assert')
const { test } = require('node:test')
const { runWithHeartbeat } = require('../agents/long-running-spawn')

test('runWithHeartbeat: captures stdout from a successful command', async () => {
  const result = await runWithHeartbeat('echo "hello world"', { timeout: 5000 })
  assert.strictEqual(result.code, 0, 'exit code 0')
  assert.match(result.stdout, /hello world/, 'stdout captured')
  assert.strictEqual(result.timedOut, false)
})

test('runWithHeartbeat: returns non-zero exit code without throwing', async () => {
  const result = await runWithHeartbeat('exit 7', { timeout: 5000 })
  assert.strictEqual(result.code, 7, 'exit code propagated')
  assert.strictEqual(result.timedOut, false)
})

test('runWithHeartbeat: shell semantics work (redirection, pipes)', async () => {
  const result = await runWithHeartbeat('echo to-err 1>&2; echo to-out', { timeout: 5000 })
  assert.match(result.stderr, /to-err/, 'stderr captured separately')
  assert.match(result.stdout, /to-out/, 'stdout captured separately')
})

test('runWithHeartbeat: heartbeat callback fires during long-running command', async () => {
  let heartbeatCount = 0
  const result = await runWithHeartbeat('sleep 1.5', {
    timeout: 10000,
    heartbeatMs: 500,
    onHeartbeat: () => { heartbeatCount++ },
  })
  assert.strictEqual(result.code, 0)
  assert.ok(heartbeatCount >= 2, `heartbeat should fire >=2x in 1.5s @ 500ms (got ${heartbeatCount})`)
})

test('runWithHeartbeat: heartbeat does NOT fire on instant commands', async () => {
  let heartbeatCount = 0
  await runWithHeartbeat('echo done', {
    timeout: 5000,
    heartbeatMs: 1000,
    onHeartbeat: () => { heartbeatCount++ },
  })
  assert.strictEqual(heartbeatCount, 0, 'no heartbeat for sub-heartbeat-interval commands')
})

test('runWithHeartbeat: timeout kills runaway child', async () => {
  const start = Date.now()
  const result = await runWithHeartbeat('sleep 60', { timeout: 500 })
  const elapsed = Date.now() - start
  assert.strictEqual(result.timedOut, true, 'timedOut flag set')
  assert.ok(elapsed < 5000, `must return within ~5s of timeout (got ${elapsed}ms)`)
})

test('runWithHeartbeat: heartbeat errors do not crash the wrapper', async () => {
  const result = await runWithHeartbeat('sleep 1', {
    timeout: 5000,
    heartbeatMs: 200,
    onHeartbeat: () => { throw new Error('heartbeat-broke') },
  })
  assert.strictEqual(result.code, 0, 'wrapper completes despite throwing heartbeat')
})

test('runWithHeartbeat: ENOENT on bad shell does not throw', async () => {
  const result = await runWithHeartbeat('echo ok', { timeout: 5000, shell: '/nonexistent-shell' })
  // Either spawn throws synchronously (caught + returned as { error }),
  // or the shell-not-found surfaces via exit code or 'error' event. Any of
  // these is acceptable — what matters is the wrapper resolves without throwing.
  assert.ok(result.code !== 0 || result.error, 'returns non-success rather than throws')
})

test('runWithHeartbeat: clears interval on completion (no leaked timers)', async () => {
  let heartbeatCount = 0
  const start = Date.now()
  await runWithHeartbeat('echo done', {
    timeout: 5000,
    heartbeatMs: 50,
    onHeartbeat: () => { heartbeatCount++ },
  })
  const elapsed = Date.now() - start
  assert.ok(elapsed < 1000, `must resolve quickly even with frequent heartbeat (got ${elapsed}ms)`)
})

test('runWithHeartbeat: stdout buffer does not deadlock on large output', async () => {
  // 64KB pipe buffer is the typical Linux default. Generate >64KB to verify drain works.
  const result = await runWithHeartbeat('yes "x" | head -c 100000', { timeout: 5000 })
  assert.strictEqual(result.code, 0)
  assert.ok(result.stdout.length >= 100000, `expected >=100K chars (got ${result.stdout.length})`)
})
