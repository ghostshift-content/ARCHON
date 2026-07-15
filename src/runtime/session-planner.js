'use strict'
// M6: the SESSION PLANNER (spec §6). Decides how many controlled project sessions a mission needs (PLANNED
// capacity) and how many run concurrently NOW (quota-adjusted). Pure + deterministic (no clock/random) so it's
// fully testable. Persisted at var/intel/session-plan-<taskId>.json (schema: common/schemas/session-plan.schema.json).
//
// KEY RULE: session_count = planned capacity; active_concurrency = how many run now. Do NOT spawn more sessions
// to solve rate limits — you REDUCE active_concurrency instead.

const DEFAULT_MAX_CONCURRENT = 3
const HARD_MAX_SESSIONS = 5

// Ladder by feature count (spec §6).
function baseSessions(featureCount) {
  const n = Number(featureCount) > 0 ? Number(featureCount) : 0
  if (n <= 25) return 1
  if (n <= 75) return 2
  if (n <= 150) return 3
  if (n <= 300) return 4
  return 5
}

// Quota → active concurrency + strategy (spec §6 / §15 backoff). Never changes session_count.
function applyQuota(sessionCount, quota) {
  const healthy = Math.min(sessionCount, DEFAULT_MAX_CONCURRENT)
  switch (quota) {
    case 'warm':        return { active: Math.max(1, healthy - 1), strategy: 'reduced_concurrency', note: 'first rate-limit → concurrency reduced by 1' }
    case 'constrained': return { active: 1, strategy: 'high_risk_only', note: 'repeated rate-limits → single active session, high-risk first' }
    case 'cooling':     return { active: 1, strategy: 'paused_rate_limit', note: 'long cooldown → pause new review, let triage finish, checkpoint' }
    case 'healthy':
    default:            return { active: healthy, strategy: 'balanced_feature_shards', note: '' }
  }
}

const _risk = (f) => String((f && (f.risk || f.risk_hint)) || 'medium').toLowerCase()
const _rank = (f) => (_risk(f) === 'high' || _risk(f) === 'critical' ? 0 : _risk(f) === 'medium' ? 1 : 2)
const _slug = (f) => (typeof f === 'string' ? f : (f && (f.slug || f.name)) || '')

// Balanced shards: high-risk first, greedy-packed into the fewest-features bin. Keeps a session focused but even.
function shard(features, sessionCount, owners) {
  const n = Math.max(1, Math.min(sessionCount, features.length || 1))
  const sorted = features.slice().sort((a, b) => _rank(a) - _rank(b) || String(_slug(a)).localeCompare(String(_slug(b))))
  const bins = Array.from({ length: n }, (_, i) => ({ session_id: `session-${i + 1}`, owner: (owners && owners[i % owners.length]) || null, features: [], _risk: {} }))
  for (const f of sorted) {
    let t = bins[0]; for (const b of bins) if (b.features.length < t.features.length) t = b
    t.features.push(_slug(f)); t._risk[_risk(f)] = (t._risk[_risk(f)] || 0) + 1
  }
  return bins.filter((b) => b.features.length).map((b) => ({
    session_id: b.session_id, owner: b.owner, features: b.features,
    risk: (b._risk.high || b._risk.critical) ? 'high' : Object.keys(b._risk).length > 1 ? 'mixed' : (Object.keys(b._risk)[0] || 'medium'),
  }))
}

// input: { mode, features:[{slug,risk_hint}]|[string], fileCount?, quota?, persona?, maxSessions?, owners? }
function planSessions(input) {
  const inp = input || {}
  const features = inp.features || []
  const total = features.length
  const quota = inp.quota || 'healthy'
  let sessionCount = baseSessions(total)
  if (Number.isFinite(inp.maxSessions)) sessionCount = Math.min(sessionCount, Math.max(1, inp.maxSessions))
  sessionCount = Math.max(1, Math.min(sessionCount, HARD_MAX_SESSIONS, total || 1))

  const q = applyQuota(sessionCount, quota)
  const shards = shard(features, sessionCount, inp.owners)
  const active_concurrency = Math.max(1, Math.min(q.active, shards.length || 1))

  const bits = [`${total} feature(s) → ${sessionCount} planned session(s) (ladder)`]
  if (quota !== 'healthy') bits.push(q.note)
  else bits.push(`quota healthy → ${active_concurrency} concurrent`)
  if (inp.persona && inp.persona.id && inp.persona.id !== 'default') bits.push(`persona ${inp.persona.id}`)

  return {
    session_count: sessionCount,
    active_concurrency,
    strategy: q.strategy,
    reason: bits.join('; '),
    quota_state: quota,
    shards,
  }
}

module.exports = { planSessions, baseSessions, applyQuota, shard, DEFAULT_MAX_CONCURRENT, HARD_MAX_SESSIONS }

// self-check
if (require.main === module) {
  const assert = require('node:assert')
  assert.strictEqual(baseSessions(25), 1); assert.strictEqual(baseSessions(26), 2); assert.strictEqual(baseSessions(75), 2)
  assert.strictEqual(baseSessions(150), 3); assert.strictEqual(baseSessions(300), 4); assert.strictEqual(baseSessions(9999), 5)
  const mk = (n) => Array.from({ length: n }, (_, i) => ({ slug: `f${i}`, risk_hint: i % 5 === 0 ? 'high' : 'medium' }))
  let p = planSessions({ features: mk(68) })
  assert.strictEqual(p.session_count, 2); assert.ok(p.active_concurrency <= p.session_count)
  assert.strictEqual(p.shards.reduce((s, x) => s + x.features.length, 0), 68, 'every feature sharded')
  p = planSessions({ features: mk(200), quota: 'warm' })
  assert.strictEqual(p.session_count, 4); assert.strictEqual(p.active_concurrency, Math.min(3, 4) - 1)
  p = planSessions({ features: mk(200), quota: 'cooling' })
  assert.strictEqual(p.strategy, 'paused_rate_limit'); assert.strictEqual(p.active_concurrency, 1)
  console.log('ok — session planner: ladder, quota backoff (reduce active NOT sessions), balanced shards')
}
