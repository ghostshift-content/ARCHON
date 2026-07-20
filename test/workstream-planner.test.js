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

// §2: with a file manifest, a sharded plan gives every workstream an explicit NON-EMPTY files[] — never all-repo.
test('§2: file-based slicing assigns an explicit file manifest to every shard', () => {
  const files = []
  // two localities, each ~600k tokens (2.4MB) → forces >1 shard against a 500k budget
  for (let i = 0; i < 6; i++) files.push({ path: `app/auth/f${i}.rb`, bytes: 400_000 })
  for (let i = 0; i < 6; i++) files.push({ path: `app/billing/f${i}.rb`, bytes: 400_000 })
  const features = [{ slug: 'login', domain: 'auth' }, { slug: 'refund', domain: 'billing' }]
  const p = W.planWorkstreams({ features, files, usable_context: 500_000 })
  assert.ok(p.session_count >= 2, `sharded (${p.session_count})`)
  assert.ok(p.workstreams.every(w => Array.isArray(w.files) && w.files.length > 0), 'every shard has a non-empty files[]')
  assert.ok(p.workstreams.every(w => w.est_tokens <= 500_000), 'each shard within budget')
  // every file placed in exactly one shard (no duplication, none dropped)
  const all = p.workstreams.flatMap(w => w.files)
  assert.equal(all.length, 12); assert.equal(new Set(all).size, 12)
})

// §2: a single-session plan (fits budget) still carries the full file list.
test('§2: single holistic session carries the whole file manifest', () => {
  const files = [{ path: 'a.rb', bytes: 1000 }, { path: 'b.rb', bytes: 1000 }]
  const p = W.planWorkstreams({ features: [{ slug: 'x', domain: 'app' }], files, usable_context: 500_000 })
  assert.equal(p.session_count, 1)
  assert.deepEqual(p.workstreams[0].files.sort(), ['a.rb', 'b.rb'])
})

// §1: a single file larger than the budget → its OWN workstream, flagged oversized (a coverage blocker), and the
// budget assertion holds for every non-oversized workstream.
test('§1: oversized single file becomes its own oversized workstream; budget asserted otherwise', () => {
  const files = [
    { path: 'app/huge.rb', bytes: 4_000_000 },   // ~1M tok > 500k budget → oversized, cannot be split
    { path: 'app/a.rb', bytes: 100_000 },
    { path: 'app/b.rb', bytes: 100_000 },
  ]
  const p = W.planWorkstreams({ features: [{ slug: 'x', domain: 'app' }], files, usable_context: 500_000 })
  const over = p.workstreams.filter(w => w.oversized)
  assert.equal(over.length, 1, 'the huge file is isolated + flagged oversized')
  assert.ok(over[0].files.includes('app/huge.rb'))
  assert.deepEqual(p.oversized_workstreams, over.map(w => w.id))
  // every NON-oversized workstream fits the budget (the post-planning assertion)
  assert.ok(p.workstreams.filter(w => !w.oversized).every(w => w.est_tokens <= 500_000))
})

// §1: a single feature no longer forces one session regardless of size — an oversized single-feature repo shards.
test('§1: single-feature oversized repo is NOT force-collapsed into one session', () => {
  const files = Array.from({ length: 4 }, (_, i) => ({ path: `svc/f${i}.rb`, bytes: 700_000 }))
  const p = W.planWorkstreams({ features: [{ slug: 'only', domain: 'svc' }], files, usable_context: 500_000 })
  assert.ok(p.session_count >= 2, `single feature still sharded by size (${p.session_count})`)
})

// §2: shared security files are REPLICATED into every shard as shared_context_files, tracked apart from primary.
test('§2: shared files replicate into every shard (primary vs shared tracked)', () => {
  const files = [
    { path: 'app/application_controller.rb', bytes: 40_000 },   // shared
    ...Array.from({ length: 6 }, (_, i) => ({ path: `app/auth/a${i}.rb`, bytes: 300_000 })),
    ...Array.from({ length: 6 }, (_, i) => ({ path: `app/billing/b${i}.rb`, bytes: 300_000 })),
  ]
  const shared = new Set(['app/application_controller.rb'])
  const p = W.planWorkstreams({ features: [{ slug: 'login', domain: 'auth' }, { slug: 'refund', domain: 'billing' }], files, sharedFiles: shared, usable_context: 500_000 })
  assert.ok(p.session_count >= 2)
  assert.ok(p.workstreams.every(w => w.files.includes('app/application_controller.rb')), 'shared file in every shard')
  assert.ok(p.workstreams.every(w => w.shared_context_files.includes('app/application_controller.rb')))
  assert.ok(p.workstreams.every(w => !w.primary_files.includes('app/application_controller.rb')), 'shared file not counted as primary')
})
