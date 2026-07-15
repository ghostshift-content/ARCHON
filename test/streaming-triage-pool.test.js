'use strict'
// Triager "squad" — the parallel / dynamically-sized streaming-triage pool.
//   1) triageWorkers() scales the pool by backlog and caps it (kill-switch at 1).
//   2) the concurrency contract (mirrors runWithConcurrency in event-bus.js:984) hands each
//      finding to EXACTLY ONE worker — no double-processing, no over-looping — while running
//      up to `limit` in parallel.
const { test } = require('node:test')
const assert = require('node:assert')
const { triageWorkers, triageSessions } = require('../src/pipeline/streaming-triage')

test('triageSessions: source-review candidate→session ladder (parity §6), cap 4', () => {
  assert.strictEqual(triageSessions(0), 1)
  assert.strictEqual(triageSessions(4), 1)
  assert.strictEqual(triageSessions(5), 2)
  assert.strictEqual(triageSessions(12), 2)
  assert.strictEqual(triageSessions(13), 3)
  assert.strictEqual(triageSessions(30), 3)
  assert.strictEqual(triageSessions(31), 4)
  assert.strictEqual(triageSessions(9999), 4)   // hard cap 4 sessions (F8 ladder)
})

test('triageWorkers: two hands by default, a 3rd walks up at 20+, capped at 3', () => {
  assert.strictEqual(triageWorkers(3, 20, 0), 2)    // baseline: two triagers work by default
  assert.strictEqual(triageWorkers(3, 20, 19), 2)
  assert.strictEqual(triageWorkers(3, 20, 20), 3)   // ">20 → another agent walks up"
  assert.strictEqual(triageWorkers(3, 20, 39), 3)
  assert.strictEqual(triageWorkers(3, 20, 200), 3)  // capped at 3
})

test('triageWorkers cap=1 stays strictly serial (kill-switch)', () => {
  for (const b of [0, 1, 20, 100, 1000]) assert.strictEqual(triageWorkers(1, 20, b), 1)
})

test('triageWorkers: explicit base overrides the default-2 (base=1 → old 1→scale)', () => {
  assert.strictEqual(triageWorkers(3, 20, 0, 1), 1)
  assert.strictEqual(triageWorkers(3, 20, 20, 1), 2)
  assert.strictEqual(triageWorkers(3, 20, 40, 1), 3)
})

test('triageWorkers ignores bad cap/step/base (fail-open to 3/20/2)', () => {
  assert.strictEqual(triageWorkers(0, 0, 40), 3)     // invalid cap/step → 3/20, base 2 → 2+floor(40/20)=4→cap 3
  assert.strictEqual(triageWorkers(null, null, 0), 2)
  assert.strictEqual(triageWorkers(3, 20, -5), 2)    // negative backlog treated as 0 → baseline 2
})

// Verbatim mirror of runWithConcurrency (event-bus.js:984) — the contract the squad relies on.
async function runWithConcurrency(items, limit, worker) {
  const arr = Array.isArray(items) ? items : []
  const out = new Array(arr.length)
  const n = Math.max(1, Math.min(limit || 1, arr.length || 1))
  let idx = 0
  async function runner() { while (idx < arr.length) { const i = idx++; out[i] = await worker(arr[i], i) } }
  await Promise.all(Array.from({ length: n }, () => runner()))
  return out
}

test('pool processes each finding EXACTLY once — no two workers grab the same one', async () => {
  const N = 50
  const findings = Array.from({ length: N }, (_, i) => ({ id: `T-${i + 1}` }))
  const processed = []
  let active = 0, maxActive = 0
  await runWithConcurrency(findings, 3, async (f) => {
    active++; maxActive = Math.max(maxActive, active)
    await new Promise(r => setTimeout(r, 1))         // simulate the slow spawnAgent('triager') await
    processed.push(f.id)
    active--
  })
  assert.strictEqual(processed.length, N, 'every finding processed')
  assert.strictEqual(new Set(processed).size, N, 'a finding was picked up by more than one worker')
  assert.deepStrictEqual([...processed].sort(), findings.map(f => f.id).sort(), 'full coverage, no dupes')
  assert.ok(maxActive > 1, 'expected genuine parallelism (>1 worker at once)')
  assert.ok(maxActive <= 3, 'must never exceed the worker cap')
})
