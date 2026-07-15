'use strict'
// M6: session planner — spec §6 ladder, quota reduces ACTIVE concurrency (never session count), balanced shards.
const { test } = require('node:test')
const assert = require('node:assert/strict')
const P = require('../src/runtime/session-planner')

const mk = (n) => Array.from({ length: n }, (_, i) => ({ slug: `f${i}`, risk_hint: i % 4 === 0 ? 'high' : 'medium' }))

test('M6 ladder (spec §6): 1-25→1, 26-75→2, 76-150→3, 151-300→4, 301+→5', () => {
  for (const [n, want] of [[1, 1], [25, 1], [26, 2], [75, 2], [76, 3], [150, 3], [151, 4], [300, 4], [301, 5], [5000, 5]])
    assert.equal(P.baseSessions(n), want, `${n} → ${want}`)
})

test('M6: every feature is sharded, balanced, none dropped', () => {
  const p = P.planSessions({ features: mk(68) })
  assert.equal(p.session_count, 2)
  assert.equal(p.shards.reduce((s, x) => s + x.features.length, 0), 68)
  assert.ok(new Set(p.shards.flatMap((s) => s.features)).size === 68, 'no duplicate placement')
})

test('M6: quota reduces ACTIVE concurrency, NOT session count', () => {
  const feats = mk(200) // ladder → 4 sessions
  const healthy = P.planSessions({ features: feats, quota: 'healthy' })
  const warm = P.planSessions({ features: feats, quota: 'warm' })
  const constrained = P.planSessions({ features: feats, quota: 'constrained' })
  assert.equal(healthy.session_count, 4)
  assert.equal(warm.session_count, 4, 'session count UNCHANGED under warm')
  assert.equal(constrained.session_count, 4, 'session count UNCHANGED under constrained')
  assert.ok(warm.active_concurrency < healthy.active_concurrency, 'warm shaves active concurrency')
  assert.equal(constrained.active_concurrency, 1, 'repeated limits → single active session')
})

test('M6: long cooldown pauses new review', () => {
  const p = P.planSessions({ features: mk(200), quota: 'cooling' })
  assert.equal(p.strategy, 'paused_rate_limit')
  assert.equal(p.active_concurrency, 1)
})

test('M6: the plan explains itself (reason is populated)', () => {
  const p = P.planSessions({ features: mk(80), quota: 'warm', persona: { id: 'bug-bounty-hunter' } })
  assert.match(p.reason, /feature\(s\)/)
  assert.match(p.reason, /session/)
  assert.match(p.reason, /bug-bounty-hunter/)
})
