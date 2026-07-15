'use strict'
// Mode-adapter interface (SPEC §2) — the ONLY place the three modes differ. The shared runtime (board, lifecycle,
// triage, judge, evidence, quota, UI) is identical; an adapter supplies: the workstream UNIT, how to PLAN
// workstreams, the specialist INSTRUCTIONS, the EVIDENCE requirements, and the CONFIRMATION rule. White-box reuses
// the static + black-box adapters — it is never a third pipeline.

const REQUIRED = ['mode', 'workstreamUnit', 'evidenceRequired', 'confirm']

function defineAdapter(spec) {
  for (const k of REQUIRED) if (!(k in spec)) throw new Error(`mode-adapter '${spec.mode || '?'}' missing '${k}'`)
  return { plan: () => { throw new Error(`plan() not implemented for ${spec.mode}`) }, specialistInstructions: () => '', ...spec }
}

// ── STATIC: coherent context-sized source domains; source evidence; never RUNTIME_CONFIRMED ──
const staticAdapter = defineAdapter({
  mode: 'static',
  workstreamUnit: 'source_domain',
  evidenceRequired: ['affected_files', 'source', 'sink'],
  // planning delegates to the context-budget workstream planner (shadow-only until Step 4 wires it)
  plan(profile, budget, ctx = {}) { return require('./workstream-planner').planWorkstreams({ profile, features: ctx.features || [], usable_context: budget, quota: ctx.quota, maxSessions: ctx.maxSessions }) },
  specialistInstructions(ws) {
    return `Holistically review the source domain "${ws && ws.id}" AS A WHOLE: map its features, then review EVERY vulnerability class as a lens, AND reason about authorization/business-logic/missing-controls (who is authorized? where do ids/amounts come from? missing CSRF/ownership/rate-limit?), plus freehand. Emit deduped source candidates.`
  },
  // a source-only finding can NEVER be RUNTIME_CONFIRMED
  confirm(status) { const s = String(status || '').toUpperCase(); if (s === 'DISPROVEN') return 'DISPROVEN'; if (s === 'NEEDS_LIVE_VALIDATION') return 'NEEDS_LIVE_VALIDATION'; return 'SOURCE_CONFIRMED' },
})

// ── BLACK-BOX: assets / endpoint-groups / attack-hypotheses; runtime evidence; expands dynamically ──
const blackboxAdapter = defineAdapter({
  mode: 'blackbox',
  workstreamUnit: 'asset_endpoint_or_hypothesis',
  evidenceRequired: ['endpoint', 'reproduction_request', 'reproduction_response'],
  dynamic: true, // workstreams expand during execution as the surface is discovered
  plan() { return { strategy: 'dynamic_recon_and_hypotheses', session_count: null, reason: 'black-box workstreams expand during execution (recon → hypotheses → specialists)' } },
  specialistInstructions(ws) { return `Test the target workstream "${ws && ws.id}": recon → attack hypotheses → specialist actions. New discoveries create shared follow-up tasks. Confirm only with captured runtime evidence.` },
  confirm(status, hasRuntimeProof) { const s = String(status || '').toUpperCase(); if (s === 'DISPROVEN') return 'DISPROVEN'; return hasRuntimeProof ? 'RUNTIME_CONFIRMED' : 'NEEDS_LIVE_VALIDATION' },
})

// ── WHITE-BOX: static source review + linked runtime-validation tasks; reuses BOTH adapters ──
const whiteboxAdapter = defineAdapter({
  mode: 'whitebox',
  workstreamUnit: 'source_domain_with_linked_runtime',
  evidenceRequired: ['affected_files', 'source', 'sink'], // + runtime proof to upgrade
  plan(profile, budget, ctx = {}) { return staticAdapter.plan(profile, budget, ctx) }, // source sessions; runtime-validation sessions are created by findings
  specialistInstructions(ws) { return staticAdapter.specialistInstructions(ws) + ' For each source finding, emit a linked runtime-validation task (endpoint + required proof).' },
  // upgrade to RUNTIME_CONFIRMED ONLY with real linked runtime proof
  confirm(status, hasRuntimeProof) { const s = String(status || '').toUpperCase(); if (s === 'DISPROVEN') return 'DISPROVEN'; if (s === 'RUNTIME_CONFIRMED' && hasRuntimeProof) return 'RUNTIME_CONFIRMED'; if (s === 'NEEDS_LIVE_VALIDATION') return 'NEEDS_LIVE_VALIDATION'; return 'SOURCE_CONFIRMED' },
})

const ADAPTERS = { static: staticAdapter, blackbox: blackboxAdapter, whitebox: whiteboxAdapter }
function get(mode) { return ADAPTERS[String(mode || '').toLowerCase()] || null }
function modes() { return Object.keys(ADAPTERS) }

module.exports = { defineAdapter, get, modes, ADAPTERS, REQUIRED }

// self-check
if (require.main === module) {
  const assert = require('node:assert')
  assert.deepStrictEqual(modes().sort(), ['blackbox', 'static', 'whitebox'])
  assert.strictEqual(get('static').confirm('RUNTIME_CONFIRMED'), 'SOURCE_CONFIRMED', 'static never runtime-confirmed')
  assert.strictEqual(get('blackbox').confirm('anything', true), 'RUNTIME_CONFIRMED')
  assert.strictEqual(get('whitebox').confirm('RUNTIME_CONFIRMED', false), 'SOURCE_CONFIRMED', 'no proof ⇒ stays source')
  assert.strictEqual(get('whitebox').confirm('RUNTIME_CONFIRMED', true), 'RUNTIME_CONFIRMED')
  assert.ok(get('blackbox').dynamic)
  console.log('ok — mode-adapter: static/blackbox/whitebox contracts, per-mode confirmation rules')
}
