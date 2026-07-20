'use strict'
// Adaptive Workstream Planner (SPEC §3/§3b). Packs COHERENT, context-budget-sized workstreams — each becomes ONE
// persistent lead session that reads its whole domain and reviews it holistically (all classes + authz/logic +
// freehand). N = number of coherent workstreams that fit in usable_context — NOT feature count. Tiny project → 1
// session; large → N bounded domain sessions. Pure + deterministic.
//
// KEY: a session is the long-lived unit of understanding; it does NOT open per feature × class. Leads may use
// 0–2 subagents; global concurrency counts leads + subagents.

const MAX_ACTIVE_SESSIONS = 3     // sessions are large; cap concurrent leads (quota can shrink further)
const DEFAULT_SUBAGENTS_PER_LEAD = 2

// quota → active concurrency (never changes session_count). Mirrors the §6 backoff.
function activeFor(sessionCount, quota) {
  const base = Math.min(sessionCount, MAX_ACTIVE_SESSIONS)
  switch (quota) {
    case 'warm': return Math.max(1, base - 1)
    case 'constrained': return 1
    case 'cooling': return 1
    default: return base
  }
}

const _tokens = (f, per) => (f && Number.isFinite(f.tokens)) ? f.tokens : per
const _domain = (f) => (f && (f.domain || (f.batch && f.batch.domain))) || 'app'
const _slug = (f) => (typeof f === 'string' ? f : (f && (f.slug || f.name)) || '')
const _risk = (f) => String((f && (f.risk || f.risk_hint)) || 'medium').toLowerCase()
const _toks = (bytes) => Math.ceil((Number(bytes) || 0) / 4)
const _dirKey = (p) => String(p || '').split('/').slice(0, 2).join('/') || String(p || '')  // first 2 path segments = locality unit
// tokens a feature's slug/domain contribute to matching a file path (dependency-locality heuristic).
function _featureFileScore(feature, filePath) {
  const p = String(filePath || '').toLowerCase()
  let s = 0
  for (const tok of new Set(String(`${_slug(feature)} ${_domain(feature)}`).toLowerCase().split(/[^a-z0-9]+/).filter(t => t.length > 2)))
    if (p.includes(tok)) s++
  return s
}

// input: { profile:{est_tokens,usable_context}, features:[{slug,domain,tokens?,risk_hint?}], files?:[{path,bytes}], usable_context?, quota?, maxSessions?, subagentsPerLead? }
function planWorkstreams(input = {}) {
  const profile = input.profile || {}
  const features = input.features || []
  const files = Array.isArray(input.files) ? input.files : []
  const allPaths = files.map(f => f.path)
  const usable = Math.max(50_000, Number(input.usable_context || profile.usable_context) || 500_000)
  const quota = input.quota || 'healthy'
  const total = features.length
  // token budget: prefer REAL file bytes when a manifest is provided, else fall back to feature estimates.
  const perFeature = total ? Math.max(1, Math.ceil((Number(profile.est_tokens) || 0) / total)) : 0
  const fileTokens = files.reduce((s, f) => s + _toks(f.bytes), 0)
  const totalTokens = fileTokens || features.reduce((s, f) => s + _tokens(f, perFeature), 0) || (Number(profile.est_tokens) || 0)

  if (!total) return _result([], quota, usable, 'no features to review', input)

  // FAST PATH: whole project fits in one usable context → ONE holistic session (reads ALL files). §1: the size
  // check is by ACTUAL tokens ONLY — a single-feature repo is NOT auto-forced into one session regardless of size.
  if (totalTokens <= usable) {
    const ws = [{ id: 'workstream-1', owner: null, features: features.map(_slug), domains: [...new Set(features.map(_domain))], files: allPaths, primary_files: allPaths, shared_context_files: [], est_tokens: totalTokens, risk: features.some(f => _risk(f) === 'high' || _risk(f) === 'critical') ? 'high' : 'mixed' }]
    return _result(ws, quota, usable, `whole project (${_k(totalTokens)} tok) fits one usable context (${_k(usable)}) → 1 holistic session`, input)
  }

  // SHARD PATH. §2: when a file manifest is provided, slice by REAL FILES (directory-local bin-packing) and give
  // every workstream an explicit files[] manifest — never let a shard fall back to "read the whole repo".
  if (files.length) return _shardByFiles(files, features, usable, quota, input)

  // No file manifest (unit-test / estimate-only path): pack coherent domains by feature token estimate. These
  // workstreams carry NO files[] — the runner must treat a multi-workstream no-files plan as needing a manifest.
  const byDomain = new Map()
  for (const f of features) { const d = _domain(f); if (!byDomain.has(d)) byDomain.set(d, []); byDomain.get(d).push(f) }
  const chunks = []
  for (const [domain, feats] of byDomain) {
    feats.sort((a, b) => (_risk(a) === 'high' || _risk(a) === 'critical' ? 0 : 1) - (_risk(b) === 'high' || _risk(b) === 'critical' ? 0 : 1) || String(_slug(a)).localeCompare(String(_slug(b))))
    let cur = { domain, feats: [], tokens: 0 }
    for (const f of feats) {
      const t = _tokens(f, perFeature)
      if (cur.tokens + t > usable && cur.feats.length) { chunks.push(cur); cur = { domain, feats: [], tokens: 0 } }
      cur.feats.push(f); cur.tokens += t
    }
    if (cur.feats.length) chunks.push(cur)
  }
  chunks.sort((a, b) => b.tokens - a.tokens)
  const bins = []
  for (const ch of chunks) {
    let bin = bins.find(b => b.est_tokens + ch.tokens <= usable)
    if (!bin) { bin = { id: `workstream-${bins.length + 1}`, owner: null, features: [], domains: new Set(), est_tokens: 0, _hi: false }; bins.push(bin) }
    for (const f of ch.feats) bin.features.push(_slug(f))
    bin.domains.add(ch.domain); bin.est_tokens += ch.tokens
    if (ch.feats.some(f => _risk(f) === 'high' || _risk(f) === 'critical')) bin._hi = true
  }
  const ws = bins.map(b => ({ id: b.id, owner: b.owner, features: b.features, domains: [...b.domains], files: [], est_tokens: b.est_tokens, risk: b._hi ? 'high' : 'mixed' }))
  return _result(ws, quota, usable, `${_k(totalTokens)} tok across ${byDomain.size} domain(s) → ${ws.length} coherent session(s) (≤${_k(usable)} each)`, input)
}

// §1/§2: dependency-locality file slicing. SHARED security files (input.sharedFiles: authz middleware, base
// controllers, policies, models, serializers referenced across the tree) are REPLICATED into every shard as
// shared_context_files, so a feature session never loses the code it depends on. Remaining "primary" files are
// grouped by directory locality and first-fit-decreasing packed into (usable − shared) sized bins. A single file
// larger than the budget can't be split here → its own workstream, flagged oversized (an explicit coverage blocker).
function _shardByFiles(files, features, usable, quota, input) {
  const bytesOf = new Map(files.map(f => [f.path, f.bytes]))
  const sharedSet = (input.sharedFiles instanceof Set) ? input.sharedFiles : new Set(input.sharedFiles || [])
  const shared = files.map(f => f.path).filter(p => sharedSet.has(p))
  const sharedBytes = shared.reduce((s, p) => s + (bytesOf.get(p) || 0), 0)
  const sharedTok = _toks(sharedBytes)
  // reserve room for the replicated shared context in every shard's budget (never below a sane primary floor)
  const budget = Math.max(20_000, usable - sharedTok)
  const primary = files.filter(f => !sharedSet.has(f.path))

  const byDir = new Map()
  for (const f of primary) { const k = _dirKey(f.path); if (!byDir.has(k)) byDir.set(k, []); byDir.get(k).push(f.path) }
  const groups = []                                          // {dir, paths, bytes, oversized}
  for (const [dir, paths] of byDir) {
    let cur = { dir, paths: [], bytes: 0 }
    for (const p of paths) {
      const b = bytesOf.get(p) || 0
      if (_toks(b) > budget) { if (cur.paths.length) { groups.push(cur); cur = { dir, paths: [], bytes: 0 } } groups.push({ dir, paths: [p], bytes: b, oversized: true }); continue } // §1: single file > budget → own bin
      if (_toks(cur.bytes + b) > budget && cur.paths.length) { groups.push(cur); cur = { dir, paths: [], bytes: 0 } }
      cur.paths.push(p); cur.bytes += b
    }
    if (cur.paths.length) groups.push(cur)
  }
  groups.sort((a, b) => b.bytes - a.bytes)
  const bins = []
  for (const g of groups) {
    let bin = g.oversized ? null : bins.find(b => !b.oversized && _toks(b.bytes + g.bytes) <= budget)
    if (!bin) { bin = { id: `workstream-${bins.length + 1}`, files: [], bytes: 0, dirs: new Set(), features: [], _hi: false, oversized: !!g.oversized }; bins.push(bin) }
    bin.files.push(...g.paths); bin.bytes += g.bytes; bin.dirs.add(g.dir)
  }
  if (!bins.length) bins.push({ id: 'workstream-1', files: [], bytes: 0, dirs: new Set(), features: [], _hi: false, oversized: false })
  // assign each feature to the best path-locality match; no-match → smallest bin (load balance).
  for (const f of features) {
    let best = null, bestScore = 0
    for (const bin of bins) { const sc = bin.files.reduce((s, p) => s + _featureFileScore(f, p), 0); if (sc > bestScore) { bestScore = sc; best = bin } }
    if (!best) best = bins.reduce((m, b) => (b.features.length < m.features.length ? b : m), bins[0])
    best.features.push(_slug(f))
    if (_risk(f) === 'high' || _risk(f) === 'critical') best._hi = true
  }
  const ws = bins.map(b => ({
    id: b.id, owner: null, features: b.features, domains: [...b.dirs],
    primary_files: b.files, shared_context_files: shared, files: [...b.files, ...shared],
    est_tokens: _toks(b.bytes) + sharedTok, risk: b._hi ? 'high' : 'mixed', oversized: b.oversized || undefined,
  }))
  const total = _toks(files.reduce((s, f) => s + f.bytes, 0))
  return _result(ws, quota, usable, `${_k(total)} tok sliced by dependency locality → ${ws.length} session(s)${shared.length ? `, ${shared.length} shared file(s) replicated as context` : ''} (≤${_k(usable)} tok each)`, input)
}

function _result(workstreams, quota, usable, reason, input) {
  // §1: ASSERT the budget after planning — a NON-oversized workstream must fit usable_context. A workstream that
  // exceeds it (only possible when a single file > budget, or a no-file single-feature repo) is flagged oversized:
  // an explicit COVERAGE BLOCKER the runner surfaces, never a silently over-budget session.
  for (const w of workstreams) { if (!w.oversized && Number(w.est_tokens) > usable) { w.oversized = true; w.budget_violation = true } }
  const oversized = workstreams.filter(w => w.oversized)
  // F4: NEVER truncate workstreams — every planned workstream must run. maxSessions caps ACTIVE concurrency only;
  // the rest stay queued.
  const N = workstreams.length
  let active = N ? activeFor(N, quota) : 0
  if (Number.isFinite(input.maxSessions)) active = Math.max(N ? 1 : 0, Math.min(active, Math.max(1, input.maxSessions)))
  const subagents = Number.isFinite(input.subagentsPerLead) ? input.subagentsPerLead : DEFAULT_SUBAGENTS_PER_LEAD
  return {
    strategy: N <= 1 ? 'single_holistic_session' : (quota === 'cooling' ? 'paused_rate_limit' : 'coherent_domain_sessions'),
    session_count: N,
    active_concurrency: active,
    subagents_per_lead: subagents,
    // global concurrency budget = active leads + their subagents (quota governor enforces at runtime)
    max_global_concurrency: active + active * subagents,
    usable_context: usable,
    quota_state: quota,
    oversized_workstreams: oversized.map(w => w.id),   // §1: coverage blockers (a file/slice bigger than the budget)
    reason: `${reason}${oversized.length ? `; ⚠️ ${oversized.length} oversized workstream(s) exceed the budget (coverage blocker)` : ''}${quota !== 'healthy' ? `; quota ${quota} → ${active} active` : ''}${Number.isFinite(input.maxSessions) && active < N ? `; ${N - active} queued (maxSessions caps concurrency, not count)` : ''}`,
    workstreams,
  }
}

// Show the REAL token count — never round a small project down to a misleading "0k" (§6 bug #6).
const _k = (n) => { const v = Number(n) || 0; return v >= 1000 ? `${Math.round(v / 1000)}k` : `${v}` }

module.exports = { planWorkstreams, activeFor, MAX_ACTIVE_SESSIONS, DEFAULT_SUBAGENTS_PER_LEAD }

// self-check
if (require.main === module) {
  const assert = require('node:assert')
  const mk = (n, d = 'app', tokens = 1000) => Array.from({ length: n }, (_, i) => ({ slug: `${d}-${i}`, domain: d, tokens }))
  // tiny → 1 holistic session
  let p = planWorkstreams({ features: mk(9, 'app', 500), usable_context: 500_000 })
  assert.strictEqual(p.session_count, 1); assert.strictEqual(p.strategy, 'single_holistic_session')
  assert.strictEqual(p.workstreams[0].features.length, 9, 'one session reads ALL features')
  // large → multiple coherent sessions (300 features × 5k tok = 1.5M > 500k budget)
  p = planWorkstreams({ features: [...mk(100, 'auth', 5000), ...mk(100, 'api', 5000), ...mk(100, 'billing', 5000)], usable_context: 500_000 })
  assert.ok(p.session_count >= 3, `large repo shards (${p.session_count})`)
  assert.strictEqual(p.workstreams.reduce((s, w) => s + w.features.length, 0), 300, 'every feature placed')
  assert.ok(p.workstreams.every(w => w.est_tokens <= 500_000), 'each session within budget')
  // quota reduces ACTIVE not count; subagents counted globally
  p = planWorkstreams({ features: [...mk(100, 'a', 5000), ...mk(100, 'b', 5000), ...mk(100, 'c', 5000), ...mk(100, 'd', 5000)], usable_context: 500_000, quota: 'warm' })
  assert.ok(p.active_concurrency < p.session_count && p.max_global_concurrency === p.active_concurrency * (1 + p.subagents_per_lead))
  console.log('ok — workstream-planner: 1 holistic session for small, coherent budget shards for large, bounded subagents')
}
