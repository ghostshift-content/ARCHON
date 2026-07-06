'use strict'
// S2: the mapping ledger — ONE source of truth for scalable source-review mapping (spec §6). Tracks every
// feature's domain/status/depth/owner/batch/risk/output so batches never overlap and no feature is lost.
// Persisted at <outDir>/phase1-maps/mapping-ledger.json (atomic). Pure builders + fail-soft fs helpers.

const fs = require('fs')
const path = require('path')

const STATUSES = ['queued', 'assigned', 'in_progress', 'done', 'merged', 'duplicate', 'non_security', 'dead_code', 'blocked']
const DEPTHS = ['fast', 'deep', 'deep_complete']
// A feature is "accounted for" (completion gate §13) when its status is terminal.
const TERMINAL = new Set(['done', 'merged', 'duplicate', 'non_security', 'dead_code', 'blocked'])

function ledgerPath(outDir) { return path.join(outDir, 'phase1-maps', 'mapping-ledger.json') }

function _feature(f, batch) {
  return {
    slug: f.slug, name: f.name || f.slug, domain: f.domain || (batch && batch.domain) || 'misc',
    status: 'queued', depth: null, owner: (batch && batch.owner) || null, batch: batch && batch.id,
    risk: f.risk_hint || (batch && batch.risk) || 'medium', output: `phase1-maps/features/${f.slug}.md`,
  }
}

// Build a fresh ledger from assigned batches (each: {id, domain, risk, owner, features:[{slug,name,domain,risk_hint}]}).
function build(taskId, batches) {
  const features = {}

  for (const b of batches || []) {
    for (const f of (b.features || [])) {

      if (features[f.slug]) {
        throw new Error(
          `duplicate feature slug detected: ${f.slug}`
        )
      }

      features[f.slug] = _feature(f, b)
    }
  }

  return recount({
    taskId: String(taskId),
    features_total: 0,
    features_done: 0,
    batches_total: 0,
    batches_done: 0,
    features
  })
}

// Recompute rollup counts: features_done = terminal features; batches_done = batches whose features are all terminal.
function recount(ledger) {
  const feats = Object.values(ledger.features || {})
  ledger.features_total = feats.length
  ledger.features_done = feats.filter(f => TERMINAL.has(f.status)).length
  const byBatch = {}
  for (const f of feats) { const b = f.batch || '_'; (byBatch[b] = byBatch[b] || []).push(f) }
  ledger.batches_total = Object.keys(byBatch).length
  ledger.batches_done = Object.values(byBatch).filter(g => g.every(f => TERMINAL.has(f.status))).length
  return ledger
}

// Update one feature's fields (status/depth/owner/output/...); returns the recounted ledger.
function setFeature(ledger, slug, patch) {
  if (!ledger.features) ledger.features = {}
  ledger.features[slug] = { ...(ledger.features[slug] || { slug }), ...(patch || {}) }
  return recount(ledger)
}

// Add NEW features discovered during reconciliation (§9); never overwrites an existing one.
function addFeatures(ledger, newFeatures, batchId) {
  for (const f of newFeatures || []) {
    if (!f || !f.slug || (ledger.features && ledger.features[f.slug])) continue
    ledger.features[f.slug] = _feature(f, { id: batchId, domain: f.domain, risk: f.risk_hint, owner: null })
  }
  return recount(ledger)
}

// Completion gate (§13): every feature has a terminal status.
function isComplete(ledger) {
  const feats = Object.values((ledger && ledger.features) || {})
  return feats.length > 0 && feats.every(f => TERMINAL.has(f.status))
}
function blockers(ledger) { return Object.values((ledger && ledger.features) || {}).filter(f => f.status === 'blocked') }
function pending(ledger) { return Object.values((ledger && ledger.features) || {}).filter(f => !TERMINAL.has(f.status)) }

// Reconcile raw follow-up items (§9) against the ledger: NEW (unknown slug → must be mapped), DUPLICATE
// (already a feature). Dedups within the list. Nothing may remain only in followup-features.jsonl — new
// items get added + mapped; duplicates are accounted for by the existing feature.
function reconcileFollowups(followups, ledger) {
  const existing = new Set(Object.keys((ledger && ledger.features) || {}))
  const seen = new Set()
  const newFeatures = [], duplicates = [], invalid = []
  for (const f of followups || []) {
    if (!f || !f.slug) { invalid.push(f || {}); continue } // no slug → NOT silently dropped (§9)
    if (seen.has(f.slug)) continue
    seen.add(f.slug)
    ;(existing.has(f.slug) ? duplicates : newFeatures).push(f)
  }
  return { newFeatures, duplicates, invalid }
}

// S7: deterministic completion-gate artifact from the ledger (the source of truth) — counts, coverage
// gaps (blocked), and the per-feature roll-up. Pure (returns markdown); the dispatcher writes it.
function renderGateMd(ledger) {
  const feats = Object.values((ledger && ledger.features) || {})
  const byStatus = {}; for (const f of feats) byStatus[f.status] = (byStatus[f.status] || 0) + 1
  const blocked = feats.filter(f => f.status === 'blocked')
  const rows = feats.slice().sort((a, b) => String(a.slug).localeCompare(String(b.slug)))
    .map(f => `| ${f.slug} | ${f.domain} | ${f.risk} | ${f.status} | ${f.depth || '-'} | ${f.owner || '-'} |`)
  return `# Phase 1 Completion Gate\n\n` +
    `${ledger.features_done || 0}/${ledger.features_total || 0} feature(s) accounted for · ${ledger.batches_done || 0}/${ledger.batches_total || 0} batch(es).\n\n` +
    `Status counts: ${Object.entries(byStatus).map(([k, v]) => `${k}=${v}`).join(', ') || '(none)'}\n\n` +
    (blocked.length
      ? `## ⚠️ Coverage gaps (blocked: ${blocked.length}) — reviewed + reported, never silently skipped\n${blocked.map(f => `- ${f.slug} (${f.domain})`).join('\n')}\n`
      : `No coverage gaps — every feature is fast/deep-mapped or terminally reconciled.\n`) +
    `\n## Ledger\n| Feature | Domain | Risk | Status | Depth | Owner |\n|---|---|---|---|---|---|\n${rows.join('\n')}\n`
}

function _writeAtomic(file, data) {
  try { fs.mkdirSync(path.dirname(file), { recursive: true }); const t = `${file}.tmp.${process.pid}.${Math.abs((Date.now() % 1e6))}`; fs.writeFileSync(t, JSON.stringify(data, null, 2)); fs.renameSync(t, file); return true } catch { return false }
}
function save(outDir, ledger) { return _writeAtomic(ledgerPath(outDir), recount(ledger)) }
function load(outDir) { try { return JSON.parse(fs.readFileSync(ledgerPath(outDir), 'utf8')) } catch { return null } }

module.exports = { STATUSES, DEPTHS, TERMINAL, ledgerPath, build, recount, setFeature, addFeatures, isComplete, blockers, pending, reconcileFollowups, renderGateMd, save, load }

// self-check
if (require.main === module) {
  const assert = require('node:assert')
  const batches = [
    { id: 'auth_identity-1', domain: 'auth_identity', risk: 'high', owner: 'marshal', features: [{ slug: 'login', name: 'Login', risk_hint: 'high' }, { slug: 'reset', name: 'Reset' }] },
    { id: 'search_browse-1', domain: 'search_browse', risk: 'normal', owner: 'cipher', features: [{ slug: 'search', name: 'Search' }] },
  ]
  let L = build('t1', batches)
  assert.strictEqual(L.features_total, 3); assert.strictEqual(L.features_done, 0)
  assert.strictEqual(L.batches_total, 2); assert.strictEqual(L.features.login.owner, 'marshal')
  assert.strictEqual(L.features.login.risk, 'high'); assert.strictEqual(L.features.login.status, 'queued')
  assert.ok(!isComplete(L), 'not complete while queued')
  L = setFeature(L, 'login', { status: 'done', depth: 'fast' })
  L = setFeature(L, 'reset', { status: 'done', depth: 'deep_complete' })
  assert.strictEqual(L.features_done, 2)
  assert.strictEqual(L.batches_done, 1, 'auth batch done (both its features terminal)')
  L = setFeature(L, 'search', { status: 'non_security' }) // still counts as accounted-for
  assert.strictEqual(L.features_done, 3); assert.ok(isComplete(L), 'all terminal → complete')
  // addFeatures (reconciliation) never overwrites
  L = addFeatures(L, [{ slug: 'login', name: 'DUP' }, { slug: 'oauth', name: 'OAuth', risk_hint: 'high' }], 'auth_identity-2')
  assert.strictEqual(L.features.login.name, 'Login', 'existing feature not overwritten')
  assert.strictEqual(L.features.oauth.status, 'queued'); assert.ok(!isComplete(L), 'new feature reopens the gate')
  // blockers
  L = setFeature(L, 'oauth', { status: 'blocked' })
  assert.strictEqual(blockers(L).length, 1)
  console.log('ok — mapping-ledger: tracks every feature, terminal-status gate, additive reconciliation')
}
