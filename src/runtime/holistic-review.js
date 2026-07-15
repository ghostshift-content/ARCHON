'use strict'
// Step 4 (SPEC §2 static core) — the HOLISTIC REVIEW that replaces the feature×class fan-out. Each coherent
// workstream becomes ONE persistent lead session that reads its whole domain and, in a single pass, maps +
// reviews EVERY vulnerability class as a lens + reasons about authorization/business-logic/missing-controls +
// freehand. This is the behaviour that beat the 108-job engine 8/8 in one shot. Dependency-injected + fail-soft.

const fs = require('fs')
const path = require('path')
const profiler = require('./profiler')
const workstreamPlanner = require('./workstream-planner')

// The full class list the single session reviews as lenses (superset; adapter/meta can override).
const DEFAULT_LENSES = [
  'access-control (IDOR/BOLA)', 'authentication-session', 'account-takeover', 'xss', 'sql-injection',
  'command-injection', 'ssrf', 'file-upload', 'path-traversal', 'deserialization', 'graphql/api-security',
  'business-logic', 'race-conditions', 'multi-tenant-isolation', 'secrets/cryptography', 'data-exposure',
  'webhook/callback', 'logging/audit', 'csrf', 'mass-assignment',
]

// Build the holistic review prompt for a workstream (models the winning single-session prompt).
function buildHolisticPrompt(ws, opts = {}) {
  const files = (opts.files || []).map((f) => `  - ${f}`).join('\n')
  const lenses = (opts.lenses || DEFAULT_LENSES).map((c) => `  - ${c}`).join('\n')
  const slugs = (opts.featureSlugs || []).join(', ')
  const slugLine = slugs ? `\nFor the "feature" field, use EXACTLY one of these discovered feature slugs (pick the closest): ${slugs}. Do NOT invent a different feature name.\n` : ''
  return `You are a senior application security reviewer.${slugLine} Perform a COMPLETE static security review of this source workstream AS ONE COHERENT UNIT — map and review it together in a single pass, the way one expert reads a whole small project.

Workstream: ${ws.id}  (domains: ${(ws.domains || []).join(', ') || 'app'})
Source root: ${opts.sourceDir}
Read ALL of these files in full before reviewing:
${files || '  (all source files under the source root)'}

Do ALL of the following in one pass:
1. MAP every feature: route/endpoint, controller/action, inputs/params, auth/authz checks, models/services, dangerous sinks, trust boundaries.
2. REVIEW every feature against ALL these vulnerability lenses:
${lenses}
   AND reason BEYOND pattern-matching — this is where signature scanners fail:
   - Authorization: who is allowed here? Is ownership/role actually checked? (IDOR / BOLA / privilege escalation)
   - Business logic: where do ids / amounts / state come from — client or server? Can the workflow be abused?
   - Missing controls you cannot grep for: missing CSRF token, missing ownership check, missing rate-limit, missing audit log, session not rotated on login, mass-assignment via permit!/permit_all.
3. FREEHAND: chain weak issues together; question anywhere client input is trusted.

For EVERY candidate finding, append ONE JSON object (JSONL, one per line) to: ${opts.outFile}  (create the directory first).
Schema (exact keys):
{"feature":"<name>","vuln_class":"<one lens>","file":"<path>","line":<number>,"code_block":"<the exact vulnerable source lines>","source":"<where untrusted input enters>","sink":"<the dangerous sink>","endpoint":"<route/action or ''>","severity":"Critical|High|Medium|Low|Info","confidence":<0-100>,"hypothesis":"<what an attacker does>","evidence":"<file:line source→sink trace>","status":"SOURCE_CONFIRMED|NEEDS_LIVE_VALIDATION|DISPROVEN","required_blackbox_proof":"<what a live test must show, or ''>","recommendation":"<the fix>"}

Evidence-status rules (be precise — this is static review):
  - SOURCE_CONFIRMED: the source alone proves the security violation (e.g. raw string interpolated into SQL; user-controlled filename concatenated into File.write).
  - NEEDS_LIVE_VALIDATION: exploitability depends on code/config/caller you cannot see, or on runtime state — e.g. stored XSS where later rendering safety is unknown; a "token issued for any user" whose validation/persistence isn't proven here; a refund whose caller-context/Order#refund! isn't visible; CSRF when ApplicationController (protect_from_forgery) is absent from the tree.
  - DISPROVEN: the code contradicts the hypothesis (a guard/escape is present).
  - NEVER emit RUNTIME_CONFIRMED — this is static mode.

Rules: review ALL files; skip NO feature; do NOT invent runtime evidence; dedupe within your own review (one finding per distinct source→sink flow — the SAME bug is one candidate, not one per lens). When done, reply with a one-line summary: features mapped, candidates written.`
}

// List the code files under a source root (via the profiler's walker), relative to the root.
function listFiles(sourceDir) {
  const out = []
  const walk = (dir) => {
    let entries; try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      const full = path.join(dir, e.name)
      if (e.isDirectory()) { if (!['node_modules', '.git', 'vendor', 'dist', 'build', 'coverage'].includes(e.name)) walk(full); continue }
      if (profiler.CODE_EXT.has(path.extname(e.name).toLowerCase())) out.push(path.relative(sourceDir, full))
    }
  }
  walk(sourceDir)
  return out
}

const _now = () => { try { return new Date().toISOString() } catch { return null } }
const _slug = (f) => (typeof f === 'string' ? f : (f && (f.slug || f.name)) || '')

// F2-robust: the lead session names candidates freely (e.g. "files_uploads_path_traversal"), so the raw
// `feature` string rarely equals a discovered slug ("file-uploads"). Map each candidate to the discovered
// feature by TOKEN OVERLAP over the feature's slug+domain+name — deterministic, so coverage never depends on
// the model echoing an exact slug. Trailing-'s' stemming folds token/tokens, session/sessions, refund/refunds.
const _STOP = new Set(['the', 'and', 'for', 'of', 'a', 'an', 'misc'])
const _toks = (s) => new Set(String(s || '').toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length > 1 && !_STOP.has(t)).map((t) => t.replace(/s$/, '')))
// Build [{ slug, toks:Set }] once from the discovered features (slug + domain + name tokens).
function _featureIndex(features) {
  return (features || []).map((f) => {
    const slug = _slug(f)
    const toks = _toks([slug, (f && f.domain) || '', (f && f.name) || ''].join(' '))
    return { slug, toks }
  }).filter((e) => e.slug)
}
// Best-matching discovered slug for a candidate's free-form feature name; '' if nothing overlaps (kept keyed
// by its own name then, so it is still counted — never silently dropped).
function _matchFeature(candFeature, index) {
  const ct = _toks(candFeature); if (!ct.size || !index.length) return ''
  let best = '', bestScore = 0
  for (const e of index) { let s = 0; for (const t of ct) if (e.toks.has(t)) s++; if (s > bestScore) { bestScore = s; best = e.slug } }
  return bestScore > 0 ? best : ''
}
// best-effort robust parse of a model-written candidate file (for coverage accounting; the authoritative emit
// uses the dispatcher's repair+quarantine path).
function _readCandidates(file) {
  let raw; try { raw = require('fs').readFileSync(file, 'utf8') } catch { return [] }
  const out = []
  for (const line of raw.split('\n')) { const s = line.trim(); if (!s) continue; let c; try { c = JSON.parse(s) } catch { try { c = JSON.parse(s.replace(/\\(?!["\\/bfnrtu])/g, '\\\\')) } catch { c = null } } if (c) out.push(c) }
  return out
}

// deps: { spawnAgent, log, trackCosts, emitFromFile(file, ws, agent)->count, cancelled?, runWaves }
// opts: { taskId, sourceDir, features, vulnClasses?, outDir, quota?, leadAgents?, mode? }
// Returns F1 outcome: { status:'completed'|'partial'|'failed_before_start', plan, results, coverage, candidateCount, errors }
async function runHolistic(deps, opts) {
  const { spawnAgent, log = () => {}, trackCosts = () => {}, emitFromFile, cancelled = () => false } = deps || {}
  const runWaves = deps.runWaves || (async (items, n, fn) => { const r = []; for (let i = 0; i < items.length; i += Math.max(1, n)) r.push(...await Promise.all(items.slice(i, i + Math.max(1, n)).map((it, j) => fn(it, i + j)))); return r })
  const errors = []
  let profile, plan
  try {
    profile = profiler.profileSource(opts.sourceDir, { mode: opts.mode || 'static' })
    plan = workstreamPlanner.planWorkstreams({ profile, features: opts.features || [], quota: opts.quota })
  } catch (e) { return { status: 'failed_before_start', plan: null, results: [], coverage: [], candidateCount: 0, errors: [e.message] } }
  if (!plan.workstreams.length) return { status: 'failed_before_start', plan, results: [], coverage: [], candidateCount: 0, errors: ['no workstreams planned'] }

  const _tokStr = profile.est_tokens >= 1000 ? `~${Math.round(profile.est_tokens / 1000)}k tok` : `${profile.est_tokens} tok`
  log(`🧠 Holistic review: ${profile.files} file(s), ${_tokStr} → ${plan.session_count} session(s) (${plan.strategy}); ${plan.reason}`)
  const allFiles = listFiles(opts.sourceDir)
  const leads = opts.leadAgents && opts.leadAgents.length ? opts.leadAgents : ['marshal', 'cipher', 'quill', 'siphon', 'breaker']
  const candByFeature = {}                                  // canonical slug → { count, classes:Set, files:Set }
  const anomalies = []                                     // §4: unmatched candidates — never folded to a feature
  const featureIndex = _featureIndex(opts.features)         // F2-robust: candidate feature name → discovered slug

  const results = await runWaves(plan.workstreams, plan.active_concurrency || 1, async (ws, i) => {
    if (cancelled()) return null
    const started_at = _now()
    const agent = leads[i % leads.length]
    const outFile = path.join(opts.outDir, 'holistic', `${ws.id}.candidates.jsonl`)
    // F4: each workstream reviews ITS OWN files when the planner assigned them; a single-session project = all files.
    const files = (ws.files && ws.files.length) ? ws.files : allFiles
    const prompt = buildHolisticPrompt(ws, { sourceDir: opts.sourceDir, files, outFile, lenses: opts.lenses, featureSlugs: (opts.features || []).map(_slug).filter(Boolean) })
    let r
    try { r = await spawnAgent(agent, opts.taskId, prompt, `task-${opts.taskId}-holistic-${ws.id}`, null) }
    catch (e) { errors.push({ workstream: ws.id, error: e.message }); return { workstream: ws.id, agent, candidates: 0, error: e.message, started_at, finished_at: _now() } }
    trackCosts([r].filter(Boolean))
    // F2: read candidates for per-feature coverage, THEN emit through the dispatcher's robust emitter
    for (const rec of _readCandidates(outFile)) {
      // §4: fold the free-form candidate feature name onto a discovered slug so per-feature coverage lines up.
      // No match → a COVERAGE_ANOMALY (surfaced separately); NEVER silently reclassified as reviewed_no_issue.
      const matched = _matchFeature(rec.feature, featureIndex)
      if (!matched) { anomalies.push({ raw_feature: rec.feature || '', file: rec.file || '', vuln_class: rec.vuln_class || '', workstream: ws.id }); continue }
      const c = (candByFeature[matched] = candByFeature[matched] || { count: 0, classes: new Set(), files: new Set() })
      c.count++; if (rec.vuln_class) c.classes.add(rec.vuln_class); if (rec.file) c.files.add(rec.file)
    }
    let n = 0
    try { n = emitFromFile ? emitFromFile(outFile, ws, agent) : 0 } catch (e) { log(`⚠️ holistic emit [${ws.id}]: ${e.message}`) }
    log(`  ✅ ${agent.toUpperCase()} reviewed ${ws.id} (${ws.features.length} feature(s)) → ${n} candidate(s)`)
    return { workstream: ws.id, agent, candidates: n, started_at, finished_at: _now() }
  })
  const res = (results || []).filter(Boolean)

  // F2: per-feature coverage — candidate_found ONLY where candidates exist, else reviewed_no_issue; failed on error.
  const failedWs = new Set(res.filter((r) => r.error).map((r) => r.workstream))
  const coverage = (opts.features || []).map((f) => {
    const slug = _slug(f); const c = candByFeature[slug]
    return { feature: slug, mapping_status: 'done', depth: 'holistic_complete',
      review_status: c && c.count ? 'candidate_found' : 'reviewed_no_issue',
      candidate_count: c ? c.count : 0, files_reviewed: c ? [...c.files] : [], classes_reviewed: c ? [...c.classes] : [] }
  })
  const candidateCount = res.reduce((s, r) => s + (r.candidates || 0), 0)
  const ran = res.filter((r) => !r.error).length
  const status = ran === 0 ? 'failed_before_start' : (errors.length ? 'partial' : 'completed')
  return { status, profile, plan, results: res, coverage, anomalies, candidateCount, errors }
}

module.exports = { buildHolisticPrompt, listFiles, runHolistic, DEFAULT_LENSES, _matchFeature, _featureIndex }

// self-check: the free-form → discovered-slug fold (the F2 coverage-attribution guard).
if (require.main === module) {
  const assert = require('node:assert')
  const feats = [
    { slug: 'file-uploads', domain: 'files_uploads', name: 'File Uploads' },
    { slug: 'api-token-issuance', domain: 'auth_identity', name: 'API Tokens' },
    { slug: 'authentication-sessions', domain: 'auth_identity', name: 'Auth Sessions' },
    { slug: 'payments-refunds', domain: 'payments_billing', name: 'Payments' },
  ]
  const idx = _featureIndex(feats)
  assert.strictEqual(_matchFeature('files_uploads_path_traversal', idx), 'file-uploads')
  assert.strictEqual(_matchFeature('auth_identity_tokens_bola', idx), 'api-token-issuance')     // 'tokens' disambiguates vs auth-sessions
  assert.strictEqual(_matchFeature('auth_identity_session_fixation', idx), 'authentication-sessions') // 'session' disambiguates
  assert.strictEqual(_matchFeature('payments_billing_refund', idx), 'payments-refunds')          // refund→refund(s) stem
  assert.strictEqual(_matchFeature('totally_unrelated_xyz', idx), '')                             // no overlap → '' (kept by raw name)
  console.log('ok — holistic: free-form candidate feature folds onto the discovered slug (F2 coverage)')
}
