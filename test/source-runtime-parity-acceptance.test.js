'use strict'
// Parity §11 acceptance checklist — the "implementation is complete when…" list, asserted in one place
// against the pure primitives delivered by S1–S6. Heavy end-to-end execution shapes are covered by
// source-runtime-workers/review/whitebox/smoke; this file is the spec-bullet ↔ code map.
const { test } = require('node:test')
const assert = require('node:assert/strict')
const P = require('../src/dispatch/source-runtime-planner')
const L = require('../src/dispatch/mapping-ledger')
const { triageSessions } = require('../src/pipeline/streaming-triage')
const cr = require('../src/dispatch/code-review-dispatcher')
const wb = require('../src/dispatch/whitebox-correlation')

const mk = (n, d = 'misc') => Array.from({ length: n }, (_, i) => ({ slug: `${d}-${i}`, domain: d }))

test('§11: mapping plans for ANY feature count (unified §6 ladder)', () => {
  for (const [n, want] of [[1, 1], [25, 1], [26, 2], [75, 2], [76, 3], [200, 4], [500, 5], [2000, 5]]) {
    assert.equal(P.planSourceRuntime({ features: mk(n) }).mapping_sessions, want, `${n} → ${want}`)
  }
})

test('§11: review + triage use controlled, capped persistent sessions (S1/S4)', () => {
  const plan = P.planSourceRuntime({ features: mk(200) })
  assert.ok(plan.review.max_concurrent_sessions <= P.DEFAULT_MAX_CONCURRENT, 'review sessions capped')
  assert.equal(triageSessions(300), 4, 'triage caps at 4 sessions')
  assert.equal(triageSessions(3), 1)   // F8 ladder: 1-4→1
  assert.equal(triageSessions(10), 2)  // F8 ladder: 5-12→2
})

test('§11: a failed review never clobbers a done map (mapping/review split, S2/S6)', () => {
  let l = L.build('t', [{ id: 'b', domain: 'x', owner: 'a', features: [{ slug: 'f' }] }])
  l = L.setFeature(l, 'f', { status: 'done' })
  l = L.setReview(l, 'f', 'failed', { error: 'session crashed' })
  assert.equal(l.features.f.status, 'done')
  assert.equal(l.features.f.mapping_status, 'done')
  assert.equal(l.features.f.review_status, 'failed')
  assert.equal(l.features_mapped, 1)
  assert.equal(l.features_blocked, 0)
})

test('§11: no duplicate feature review — deterministic duplicate_key (S3)', () => {
  const c = { feature: 'uploads', file: 'u.rb', sink: 'File.open', source: 'params' }
  const a = cr.toLiveCandidate(c, 'path-traversal', { slug: 'uploads' }, 'marshal', '/s', 'static')
  const b = cr.toLiveCandidate({ ...c, confidence: 0.9 }, 'path-traversal', { slug: 'uploads' }, 'cipher', '/s', 'white-box')
  assert.equal(a.duplicate_key, b.duplicate_key, 'same source→sink flow collapses to one key')
})

test('§11: follow-up features are never lost (reconcileFollowups)', () => {
  const led = L.build('t', [{ id: 'b', domain: 'x', owner: 'a', features: [{ slug: 'known' }] }])
  const { newFeatures, duplicates, invalid } = L.reconcileFollowups(
    [{ slug: 'known' }, { slug: 'brand-new' }, { name: 'no-slug' }], led)
  assert.deepEqual(newFeatures.map(f => f.slug), ['brand-new'], 'new follow-up must be mapped')
  assert.equal(duplicates.length, 1, 'known one accounted for by the existing feature')
  assert.equal(invalid.length, 1, 'a slug-less item is surfaced, never silently dropped')
})

test('§11: source-only findings are NOT marked runtime-confirmed (S3/M7)', () => {
  const rec = cr.toLiveCandidate({ feature: 'f', file: 'a.rb', sink: 's', status: 'SOURCE_CONFIRMED' }, 'access-control', { slug: 'f' }, 'marshal', '/s', 'static')
  assert.equal(rec.confirmation_status, 'SOURCE_CONFIRMED')
  assert.notEqual(rec.confirmation_status, 'RUNTIME_CONFIRMED')
  assert.ok(!rec.url, 'no fabricated runtime evidence')
  // and a refuted finding is never relabelled confirmed (the DISPROVEN → SOURCE_CONFIRMED bug)
  assert.equal(cr.toLiveCandidate({ feature: 'f', file: 'a.rb', sink: 's', status: 'DISPROVEN' }, 'access-control', { slug: 'f' }, 'm', '/s', 'static').confirmation_status, 'DISPROVEN')
  // only real captured runtime proof promotes; a URL alone does not
  const src = { confirmation_status: 'NEEDS_LIVE_VALIDATION' }
  assert.notEqual(wb.finalizeSourceStatus(src, { confirmation_status: 'RUNTIME_CONFIRMED', url: 'https://x' }).status, 'RUNTIME_CONFIRMED')
  assert.equal(wb.finalizeSourceStatus(src, { confirmation_status: 'RUNTIME_CONFIRMED', reproduction_response: 'HTTP/1.1 200\n\n{}' }).status, 'RUNTIME_CONFIRMED')
})

test('§11: every streamed candidate carries the report-ready field set (S3/§7)', () => {
  const rec = cr.toLiveCandidate({ feature: 'f', file: 'a.rb', source: 'p', sink: 's', endpoint: 'GET /f', recommendation: 'fix it' },
    'xss', { slug: 'f' }, 'marshal', '/s', 'white-box')
  for (const k of ['mode', 'feature', 'vulnerability_class', 'affected_files', 'affected_endpoint', 'exploit_hypothesis',
    'confidence', 'confirmation_status', 'requires_runtime_validation', 'duplicate_key', 'recommendation']) {
    assert.ok(k in rec, `candidate carries ${k}`)
  }
  assert.equal(rec.mode, 'white-box')
})
