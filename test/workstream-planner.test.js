'use strict'
// Adaptive workstream planner (SPEC §3/§3b) — N = coherent workstreams within budget, NOT feature count.
const { test } = require('node:test'); const assert = require('node:assert/strict')
const W = require('../src/runtime/workstream-planner')
const mk = (n, d = 'app', tokens = 1000) => Array.from({ length: n }, (_, i) => ({ slug: `${d}-${i}`, domain: d, tokens }))
test('tiny/small project → ONE holistic session reading all features', () => {
  const p = W.planWorkstreams({ features: mk(9, 'app', 500), usable_context: 500_000 })
  assert.equal(p.session_count, 1)
  assert.equal(p.strategy, 'single_holistic_session')
  assert.equal(p.workstreams[0].features.length, 9)
})
test('NOT feature-count based: 200 tiny features still ONE session if they fit', () => {
  const p = W.planWorkstreams({ features: mk(200, 'app', 100), usable_context: 500_000 })
  assert.equal(p.session_count, 1, '200 tiny features fit one context → 1 session (not 200)')
})
test('large repo → coherent budget-bounded sessions, every feature placed, each ≤ budget', () => {
  const p = W.planWorkstreams({ features: [...mk(100, 'auth', 5000), ...mk(100, 'api', 5000), ...mk(100, 'billing', 5000)], usable_context: 500_000 })
  assert.ok(p.session_count >= 3)
  assert.equal(p.workstreams.reduce((s, w) => s + w.features.length, 0), 300)
  assert.ok(p.workstreams.every(w => w.est_tokens <= 500_000))
})
test('quota reduces ACTIVE not session_count; global concurrency counts subagents', () => {
  const big = [...mk(100, 'a', 5000), ...mk(100, 'b', 5000), ...mk(100, 'c', 5000), ...mk(100, 'd', 5000)]
  const h = W.planWorkstreams({ features: big, usable_context: 500_000, quota: 'healthy' })
  const w = W.planWorkstreams({ features: big, usable_context: 500_000, quota: 'warm' })
  assert.equal(h.session_count, w.session_count, 'count unchanged under quota')
  assert.ok(w.active_concurrency < h.active_concurrency)
  assert.equal(h.max_global_concurrency, h.active_concurrency * (1 + h.subagents_per_lead))
})

test('F4: maxSessions caps ACTIVE concurrency, never truncates workstreams', () => {
  const big = [...mk(100, 'a', 5000), ...mk(100, 'b', 5000), ...mk(100, 'c', 5000), ...mk(100, 'd', 5000)]
  const p = W.planWorkstreams({ features: big, usable_context: 500_000, maxSessions: 2 })
  assert.ok(p.session_count >= 3, 'ALL workstreams kept (not sliced to 2)')
  assert.equal(p.workstreams.length, p.session_count, 'no truncation')
  assert.ok(p.active_concurrency <= 2, 'maxSessions caps concurrency')
})
