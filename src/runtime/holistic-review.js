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

// §2: detect SHARED security-relevant files — cross-cutting code a feature session must not lose. Two signals:
//  (a) known shared-security path patterns (base/application controllers, middleware, policies, serializers, auth);
//  (b) reference-based — a file whose module is required/imported from files in ≥2 different top-level directories.
// Bounded (caps files read + bytes/file) so it stays cheap even on a large repo. Returns a Set of relative paths.
const _SHARED_PAT = /(application_?controller|base_?controller|app[\/\\]controllers[\/\\]concerns|middleware|(^|[\/\\])policy|policies|(^|[\/\\])abilit|serializer|authoriz|authentic|(^|[\/\\])guard|session_store|application_record|models[\/\\]concerns|(^|[\/\\])config[\/\\]|routes\.|urls\.py|security|_helper)/i
function _detectSharedFiles(sourceDir, manifest) {
  const shared = new Set()
  for (const f of manifest) if (_SHARED_PAT.test(f.path)) shared.add(f.path)
  const byBase = new Map()
  for (const f of manifest) { const b = path.basename(f.path).replace(/\.[^.]+$/, '').toLowerCase(); if (!byBase.has(b)) byBase.set(b, f.path) }
  const refDirs = new Map()   // target path → Set(referrer top-level dir)
  let read = 0
  for (const f of manifest) {
    if (read >= 4000) break; read++
    let txt; try { txt = fs.readFileSync(path.join(sourceDir, f.path), 'utf8').slice(0, 20000) } catch { continue }
    const top = String(f.path).split(/[\/\\]/)[0]
    for (const m of txt.matchAll(/(?:require(?:_relative)?|import|include|from|use)\s+['"]?([\w./\\-]+)['"]?/g)) {
      const base = path.basename(String(m[1])).replace(/\.[^.]+$/, '').toLowerCase()
      const target = byBase.get(base)
      if (target && target !== f.path) { if (!refDirs.has(target)) refDirs.set(target, new Set()); refDirs.get(target).add(top) }
    }
  }
  for (const [p, dirs] of refDirs) if (dirs.size >= 2) shared.add(p)
  return shared
}

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
  let profile, plan, fileManifest = []
  // §3: budget against the ACTUAL lead-model context (smallest among the leads), not a hardcoded 1M. The dispatcher
  // resolves it (opts.model_context); if absent we fall back to 1M but say so, so an oversized plan is never silent.
  const model_context = Number(opts.model_context) || 0
  if (!model_context) log(`⚠️ holistic: no lead-model context supplied — budgeting at the 1M default (may over-fill a smaller model)`)
  try {
    profile = profiler.profileSource(opts.sourceDir, { mode: opts.mode || 'static', model_context: model_context || undefined })
    fileManifest = profiler.listSourceFiles(opts.sourceDir)   // §2: real files (path+bytes) for dependency-locality slicing
    // §2: when the project will SHARD, detect shared security files (base controllers, middleware, policies, models
    // referenced across the tree) so the planner REPLICATES them into every shard that needs them.
    const sharedFiles = (profile.est_tokens > profile.usable_context) ? [..._detectSharedFiles(opts.sourceDir, fileManifest)] : []
    plan = workstreamPlanner.planWorkstreams({ profile, features: opts.features || [], files: fileManifest, sharedFiles, quota: opts.quota })
  } catch (e) { return { status: 'failed_before_start', plan: null, results: [], coverage: [], candidateCount: 0, errors: [e.message] } }
  if (!plan.workstreams.length) return { status: 'failed_before_start', plan, results: [], coverage: [], candidateCount: 0, errors: ['no workstreams planned'] }
  // §2: a multi-workstream plan whose shards have no explicit files[] would make every session read the whole repo —
  // reject it rather than silently defeat context budgeting.
  if (plan.session_count > 1 && plan.workstreams.some((w) => !(w.files && w.files.length))) {
    return { status: 'failed_before_start', profile, plan, results: [], coverage: [], candidateCount: 0, errors: [`sharded plan (${plan.session_count} sessions) has a workstream with no file manifest — refusing to read the whole repo per shard`] }
  }

  const _tokStr = profile.est_tokens >= 1000 ? `~${Math.round(profile.est_tokens / 1000)}k tok` : `${profile.est_tokens} tok`
  log(`🧠 Holistic review: ${profile.files} file(s), ${_tokStr} → ${plan.session_count} session(s) (${plan.strategy}); ${plan.reason}`)
  const allFiles = fileManifest.length ? fileManifest.map((f) => f.path) : listFiles(opts.sourceDir)
  const leads = opts.leadAgents && opts.leadAgents.length ? opts.leadAgents : ['marshal', 'cipher', 'quill', 'siphon', 'breaker']
  // §1/§8: map every feature to the workstream that owns it (for failed-session attribution + assigned-file coverage).
  const wsOfFeature = {}
  for (const w of plan.workstreams) for (const s of (w.features || [])) wsOfFeature[_slug(s)] = w
  const candByFeature = {}                                  // canonical slug → { count, classes:Set, files:Set }
  const anomalies = []                                     // §4: unmatched candidates — never folded to a feature
  const featureIndex = _featureIndex(opts.features)         // F2-robust: candidate feature name → discovered slug

  const results = await runWaves(plan.workstreams, plan.active_concurrency || 1, async (ws, i) => {
    if (cancelled()) return null
    const started_at = _now()
    const agent = leads[i % leads.length]
    // §1: an OVERSIZED workstream cannot fit its assigned source in one context — do NOT spawn a session that
    // would review only a truncated slice and mislead. It is an explicit coverage BLOCKER (surfaced by
    // workstream_coverage as non-terminal); its features become blocked_coverage_gap.
    if (ws.oversized) { errors.push({ workstream: ws.id, error: 'oversized — exceeds a single lead context; not reviewed' }); log(`⛔ ${ws.id} OVERSIZED (~${Math.round((ws.est_tokens || 0) / 1000)}k tok > budget) — skipped (coverage blocker), not spawned`); return { workstream: ws.id, agent, candidates: 0, oversized: true, skipped: true, error: 'oversized', started_at, finished_at: _now() } }
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

  // §3: WORKSTREAM-LEVEL coverage — independent of feature coverage. Every PLANNED workstream must reach a terminal
  // state; a shard with no feature, a cancelled-before-start shard (null result), and an oversized shard are all
  // tracked here so a large-repo run can never look complete while a whole slice went unreviewed.
  const resByWs = new Map(res.map((r) => [r.workstream, r]))
  const workstream_coverage = plan.workstreams.map((w, i) => {
    const r = resByWs.get(w.id)
    let status
    if (!r) status = (results && results[i] === null && cancelled()) ? 'cancelled' : 'not_started'   // null result = never produced
    else if (r.oversized || r.skipped) status = 'oversized_blocked'                                    // §1: skipped, not reviewed
    else if (r.error) status = 'failed'
    else status = 'completed'
    return { workstream: w.id, status, terminal: status === 'completed', features: w.features || [], file_count: (w.files || []).length, oversized: !!w.oversized, error: (r && r.error) || undefined }
  })
  const incompleteWs = workstream_coverage.filter((w) => !w.terminal)

  // §1/§8: per-feature coverage. A feature whose workstream FAILED is NEVER reviewed_no_issue — it is a coverage
  // gap (its session never produced a verdict). Evidence of review = the ASSIGNED file manifest + the FULL lens list
  // the session was tasked with (recorded when the session ran), NOT just the files/classes that produced candidates.
  const failedWs = new Set(workstream_coverage.filter((w) => !w.terminal).map((w) => w.workstream))
  const lensList = (opts.lenses || DEFAULT_LENSES).map((c) => String(c).split(' ')[0])   // the classes every session reviews
  const coverage = (opts.features || []).map((f) => {
    const slug = _slug(f); const c = candByFeature[slug]
    const ws = wsOfFeature[slug]
    const assignedFiles = (ws && ws.files && ws.files.length) ? ws.files : allFiles
    if (ws && failedWs.has(ws.id)) {
      return { feature: slug, mapping_status: 'failed', depth: 'holistic_incomplete', review_status: 'blocked_coverage_gap',
        reason: `holistic session ${ws.id} failed — feature not reviewed`, candidate_count: c ? c.count : 0,
        files_reviewed: [], classes_reviewed: [], assigned_files: assignedFiles }
    }
    return { feature: slug, mapping_status: 'done', depth: 'holistic_complete',
      review_status: c && c.count ? 'candidate_found' : 'reviewed_no_issue',
      candidate_count: c ? c.count : 0,
      // §8: reviewed evidence = what the session was tasked with, independent of whether it found anything.
      files_reviewed: assignedFiles, classes_reviewed: lensList,
      candidate_files: c ? [...c.files] : [], candidate_classes: c ? [...c.classes] : [] }
  })
  const candidateCount = res.reduce((s, r) => s + (r.candidates || 0), 0)
  const ran = res.filter((r) => !r.error).length
  // §3: 'completed' requires EVERY planned workstream terminal — an unreviewed/failed/oversized shard ⇒ 'partial'.
  const status = ran === 0 ? 'failed_before_start' : ((errors.length || incompleteWs.length) ? 'partial' : 'completed')
  if (incompleteWs.length) log(`⚠️ Holistic: ${incompleteWs.length}/${plan.workstreams.length} workstream(s) did not complete cleanly — ${incompleteWs.map((w) => `${w.workstream}:${w.status}`).join(', ')}`)
  return { status, profile, plan, results: res, coverage, workstream_coverage, anomalies, candidateCount, errors }
}

module.exports = { buildHolisticPrompt, listFiles, runHolistic, DEFAULT_LENSES, _matchFeature, _featureIndex, _detectSharedFiles }

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
