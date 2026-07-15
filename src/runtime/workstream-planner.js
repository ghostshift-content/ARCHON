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

// input: { profile:{est_tokens,usable_context}, features:[{slug,domain,tokens?,risk_hint?}], usable_context?, quota?, maxSessions?, subagentsPerLead? }
function planWorkstreams(input = {}) {
  const profile = input.profile || {}
  const features = input.features || []
  const usable = Math.max(50_000, Number(input.usable_context || profile.usable_context) || 500_000)
  const quota = input.quota || 'healthy'
  const total = features.length
  // per-feature token estimate: explicit, else evenly split the profiled source, else a small default
  const perFeature = total ? Math.max(1, Math.ceil((Number(profile.est_tokens) || 0) / total)) : 0
  const totalTokens = features.reduce((s, f) => s + _tokens(f, perFeature), 0) || (Number(profile.est_tokens) || 0)

  // FAST PATH: whole project fits in one usable context → ONE holistic session (the fix for small/medium).
  if (totalTokens <= usable || total <= 1) {
    const ws = total ? [{ id: 'workstream-1', owner: null, features: features.map(_slug), domains: [...new Set(features.map(_domain))], est_tokens: totalTokens, risk: features.some(f => _risk(f) === 'high' || _risk(f) === 'critical') ? 'high' : 'mixed' }] : []
    return _result(ws, quota, usable, `whole project (${_k(totalTokens)} tok) fits one usable context (${_k(usable)}) → 1 holistic session`, input)
  }

  // SHARD PATH: pack coherent domains into budget-sized bins. Keep a domain together; split an oversized domain.
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
  // first-fit-decreasing pack chunks into bins ≤ usable (bins = workstreams/sessions)
  chunks.sort((a, b) => b.tokens - a.tokens)
  const bins = []
  for (const ch of chunks) {
    let bin = bins.find(b => b.est_tokens + ch.tokens <= usable)
    if (!bin) { bin = { id: `workstream-${bins.length + 1}`, owner: null, features: [], domains: new Set(), est_tokens: 0, _hi: false }; bins.push(bin) }
    for (const f of ch.feats) bin.features.push(_slug(f))
    bin.domains.add(ch.domain); bin.est_tokens += ch.tokens
    if (ch.feats.some(f => _risk(f) === 'high' || _risk(f) === 'critical')) bin._hi = true
  }
  const ws = bins.map(b => ({ id: b.id, owner: b.owner, features: b.features, domains: [...b.domains], est_tokens: b.est_tokens, risk: b._hi ? 'high' : 'mixed' }))
  return _result(ws, quota, usable, `${_k(totalTokens)} tok across ${byDomain.size} domain(s) → ${ws.length} coherent session(s) (≤${_k(usable)} each)`, input)
}

function _result(workstreams, quota, usable, reason, input) {
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
    reason: `${reason}${quota !== 'healthy' ? `; quota ${quota} → ${active} active` : ''}${Number.isFinite(input.maxSessions) && active < N ? `; ${N - active} queued (maxSessions caps concurrency, not count)` : ''}`,
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
