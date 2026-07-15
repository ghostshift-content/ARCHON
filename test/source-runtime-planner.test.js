'use strict'
// R1: the Source Runtime Planner now DELEGATES its session ladder to src/runtime/session-planner (one planner
// truth — the §6 ladder: 1-25→1, 26-75→2, 76-150→3, 151-300→4, 301+→5). Quota reduces ACTIVE concurrency, never
// the session count. Output SHAPE stays backward-compatible (mapping_sessions / max_concurrent_sessions /
// sessions[{session_id, feature_count, domain_focus, features}]). Domain-aware sharding is preserved.
const { test } = require('node:test')
const assert = require('node:assert/strict')
const P = require('../src/dispatch/source-runtime-planner')

const mk = (n, domain = 'misc') => Array.from({ length: n }, (_, i) => ({ slug: `${domain}-${i}`, domain }))

test('unified §6 ladder: 1-25→1, 26-75→2, 76-150→3, 151-300→4, 301+→5', () => {
  assert.equal(P.baseSessions(0), 1)
  assert.equal(P.baseSessions(25), 1)
  assert.equal(P.baseSessions(26), 2)
  assert.equal(P.baseSessions(75), 2)
  assert.equal(P.baseSessions(76), 3)
  assert.equal(P.baseSessions(150), 3)
  assert.equal(P.baseSessions(151), 4)
  assert.equal(P.baseSessions(300), 4)
  assert.equal(P.baseSessions(301), 5)
  assert.equal(P.baseSessions(100000), 5)
})

test('20 features → 1 single persistent worker', () => {
  const p = P.planSourceRuntime({ features: mk(20) })
  assert.equal(p.mapping_sessions, 1)
  assert.equal(p.max_concurrent_sessions, 1)
  assert.equal(p.strategy, 'single_persistent_worker')
})

test('75 features across 3 domains → 2 sessions (§6), all features sharded, none dropped', () => {
  const feats = [...mk(25, 'auth'), ...mk(25, 'api'), ...mk(25, 'files')]
  const p = P.planSourceRuntime({ features: feats })
  assert.equal(p.mapping_sessions, 2)
  assert.equal(p.max_concurrent_sessions, 2)
  assert.equal(p.strategy, 'persistent_sharded_mapping')
  const placed = p.sessions.reduce((s, x) => s + x.feature_count, 0)
  assert.equal(placed, 75, 'every feature landed in exactly one session')
  assert.equal(new Set(p.sessions.flatMap((s) => s.features)).size, 75, 'no duplicate placement')
})

test('200 features → 4 shards but only 3 run concurrently (rate-limit guard)', () => {
  const p = P.planSourceRuntime({ features: [...mk(50, 'a'), ...mk(50, 'b'), ...mk(50, 'c'), ...mk(50, 'd')] })
  assert.equal(p.mapping_sessions, 4)
  assert.equal(p.max_concurrent_sessions, 3)
})

test('sharding keeps a domain together in one session', () => {
  const p = P.planSourceRuntime({ features: [...mk(25, 'auth'), ...mk(25, 'api'), ...mk(25, 'files')] })
  for (const domain of ['auth', 'api', 'files']) {
    const owners = p.sessions.filter((s) => s.features.some((sl) => sl.startsWith(domain + '-')))
    assert.equal(owners.length, 1, `${domain} lives in exactly one session`)
  }
})

test('§6 quota reduces ACTIVE concurrency, NEVER the session count', () => {
  const big = [...mk(50, 'a'), ...mk(50, 'b'), ...mk(50, 'c'), ...mk(50, 'd')] // §6 → 4 sessions
  for (const q of ['healthy', 'warm', 'constrained', 'cooling'])
    assert.equal(P.planSourceRuntime({ features: big, quota: q }).mapping_sessions, 4, `session count unchanged under ${q}`)
  assert.equal(P.planSourceRuntime({ features: big, quota: 'healthy' }).max_concurrent_sessions, 3)
  assert.equal(P.planSourceRuntime({ features: big, quota: 'warm' }).max_concurrent_sessions, 2)
  assert.equal(P.planSourceRuntime({ features: big, quota: 'constrained' }).max_concurrent_sessions, 1)
  const cooling = P.planSourceRuntime({ features: big, quota: 'cooling' })
  assert.equal(cooling.max_concurrent_sessions, 1)
  assert.equal(cooling.strategy, 'paused_rate_limit')
})

test('operator maxSessions caps but never raises', () => {
  const big = [...mk(50, 'a'), ...mk(50, 'b'), ...mk(50, 'c'), ...mk(50, 'd')] // §6 → 4
  assert.equal(P.planSourceRuntime({ features: big, maxSessions: 2 }).mapping_sessions, 2)
  assert.equal(P.planSourceRuntime({ features: mk(20), maxSessions: 5 }).mapping_sessions, 1, 'cap never raises above the ladder')
})

test('single broad domain still follows the §6 ladder (no same-domain collapse)', () => {
  assert.equal(P.planSourceRuntime({ features: mk(20, 'misc') }).mapping_sessions, 1)
  assert.equal(P.planSourceRuntime({ features: mk(75, 'misc') }).mapping_sessions, 2)
  assert.equal(P.planSourceRuntime({ features: mk(200, 'misc') }).mapping_sessions, 4)
  assert.equal(P.planSourceRuntime({ features: mk(500, 'misc') }).mapping_sessions, 5)
  assert.equal(P.planSourceRuntime({ features: mk(1000, 'misc') }).mapping_sessions, 5)
})

test('oversized domain is split into balanced ~targetPerSession chunks', () => {
  const p = P.planSourceRuntime({ features: mk(200, 'misc') })
  assert.equal(p.sessions.length, 4)
  assert.equal(p.sessions.reduce((s, x) => s + x.feature_count, 0), 200, 'every feature placed exactly once')
  assert.equal(new Set(p.sessions.flatMap(s => s.features)).size, 200, 'no duplicates')
  assert.ok(p.sessions.every(s => s.feature_count >= 40 && s.feature_count <= 60), 'balanced ~50 per session')
  assert.ok(p.sessions.every(s => s.domain_focus.includes('misc')), 'same-domain sessions are fine')
})

test('one huge domain + small domains → balanced, §6 session count', () => {
  const feats = [...mk(60, 'big'), ...mk(5, 's1'), ...mk(5, 's2'), ...mk(5, 's3')] // 75 → §6 2 sessions
  const p = P.planSourceRuntime({ features: feats })
  assert.equal(p.mapping_sessions, 2)
  assert.equal(p.sessions.reduce((s, x) => s + x.feature_count, 0), 75)
  assert.ok(p.sessions.every(s => s.feature_count >= 30 && s.feature_count <= 45), 'balanced ~37 each despite one huge domain')
})

test('max_concurrent_sessions NEVER exceeds mapping_sessions', () => {
  for (const n of [1, 5, 20, 21, 75, 200, 500, 1000]) {
    for (const quota of ['healthy', 'warm', 'constrained', 'cooling']) {
      const p = P.planSourceRuntime({ features: mk(n, 'misc'), quota })
      assert.ok(p.max_concurrent_sessions <= p.mapping_sessions, `n=${n} quota=${quota}: ${p.max_concurrent_sessions} > ${p.mapping_sessions}`)
      assert.ok(p.max_concurrent_sessions >= 1)
    }
  }
})

test('never exceeds the §6 hard ceiling of 5 sessions', () => {
  const domains = Array.from({ length: 12 }, (_, i) => mk(60, `d${i}`)).flat() // 720 features, 12 domains
  const p = P.planSourceRuntime({ features: domains })
  assert.equal(P.HARD_MAX_SESSIONS, 5)
  assert.ok(p.mapping_sessions <= P.HARD_MAX_SESSIONS)
  assert.equal(p.mapping_sessions, 5)
})
