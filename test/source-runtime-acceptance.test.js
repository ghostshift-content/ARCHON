'use strict'
// M8: the source-runtime redesign acceptance checklist (spec §9) in one place. Each case maps to a spec
// bullet. Heavy end-to-end shapes (200 features) are asserted through the pure planner; the execution shapes
// they drive are covered by source-runtime-workers/review/deferral/whitebox tests.
const { test } = require('node:test')
const assert = require('node:assert/strict')
const P = require('../src/dispatch/source-runtime-planner')
const L = require('../src/dispatch/mapping-ledger')
const wb = require('../src/dispatch/whitebox-correlation')
const { deriveConfirmationStatus } = require('../agents/finding-schema')

const mk = (n, d = 'misc') => Array.from({ length: n }, (_, i) => ({ slug: `${d}-${i}`, domain: d }))

test('M8.1 — 20 features → 1 persistent mapping session', () => {
  assert.equal(P.planSourceRuntime({ features: mk(20) }).mapping_sessions, 1)
})

test('M8.2 — 75 features → 2 mapping sessions (unified §6 ladder)', () => {
  const p = P.planSourceRuntime({ features: [...mk(25, 'a'), ...mk(25, 'b'), ...mk(25, 'c')] })
  assert.equal(p.mapping_sessions, 2)
  assert.equal(p.max_concurrent_sessions, 2)
})

test('M8.3 — 200 features → 4 shards, only 3 concurrent by default', () => {
  const p = P.planSourceRuntime({ features: [...mk(50, 'a'), ...mk(50, 'b'), ...mk(50, 'c'), ...mk(50, 'd')] })
  assert.equal(p.mapping_sessions, 4)
  assert.equal(p.max_concurrent_sessions, 3)
})

test('M8.4 — a rate limit becomes deferred_rate_limit, NEVER blocked, and keeps the gate open', () => {
  let l = L.build('t', [{ id: 'b', domain: 'x', owner: 'a', features: [{ slug: 'f1' }, { slug: 'f2' }] }])
  l = L.setFeature(l, 'f1', { status: 'done' })
  l = L.setFeature(l, 'f2', { status: 'deferred_rate_limit' })
  assert.equal(l.features_deferred, 1)
  assert.equal(l.features_blocked, 0, 'a rate limit is not a coverage gap')
  assert.ok(!L.isComplete(l), 'deferred keeps the completion gate open (work resumes)')
})

test('M8.5 — progress uses features_mapped (done only), NOT accounted-for (which includes blocked)', () => {
  let l = L.build('t', [{ id: 'b', domain: 'x', owner: 'a', features: [{ slug: 'f1' }, { slug: 'f2' }, { slug: 'f3' }] }])
  l = L.setFeature(l, 'f1', { status: 'done' })
  l = L.setFeature(l, 'f2', { status: 'blocked_coverage_gap' })
  l = L.setFeature(l, 'f3', { status: 'deferred_rate_limit' })
  assert.equal(l.features_mapped, 1, 'only the real map counts as mapped')
  assert.equal(l.features_accounted, 2, 'accounted = done + blocked (terminal), but that is NOT the progress number')
  assert.notEqual(l.features_mapped, l.features_accounted, 'the two numbers are distinct — the old bug conflated them')
})

test('M8.6 — a static source-only finding stays SOURCE_CONFIRMED (never RUNTIME_CONFIRMED)', () => {
  // CONFIRMED by code reading, but no url / captured response / proof-of-execution
  assert.equal(deriveConfirmationStatus({ validation_status: 'CONFIRMED', file: 'app.rb', line: 3 }), 'SOURCE_CONFIRMED')
})

test('M8.7 — white-box upgrades to RUNTIME_CONFIRMED ONLY with real captured runtime proof', () => {
  const src = { confirmation_status: 'NEEDS_LIVE_VALIDATION' }
  assert.equal(wb.finalizeSourceStatus(src, { confirmation_status: 'RUNTIME_CONFIRMED', reproduction_response: 'HTTP/1.1 200 OK\n\n{}' }).status, 'RUNTIME_CONFIRMED')
  assert.notEqual(wb.finalizeSourceStatus(src, { confirmation_status: 'RUNTIME_CONFIRMED', url: 'https://x' }).status, 'RUNTIME_CONFIRMED')
  assert.equal(wb.finalizeSourceStatus({ confirmation_status: 'SOURCE_CONFIRMED' }, null).status, 'SOURCE_CONFIRMED')
})

test('M8.8 — §6 quota control: reduces ACTIVE concurrency, session count unchanged', () => {
  const big = [...mk(50, 'a'), ...mk(50, 'b'), ...mk(50, 'c'), ...mk(50, 'd')] // §6 → 4 sessions
  const cooling = P.planSourceRuntime({ features: big, quota: 'cooling' })
  assert.equal(cooling.mapping_sessions, 4, 'session count unchanged')
  assert.equal(cooling.max_concurrent_sessions, 1, 'cooling → 1 active')
  assert.equal(P.planSourceRuntime({ features: big, quota: 'constrained' }).max_concurrent_sessions, 1)
})
