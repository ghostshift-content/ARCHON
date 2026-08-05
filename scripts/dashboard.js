#!/usr/bin/env node
// ARCHON local operator console — backend API + static server.
//
// Zero dependencies (Node http + fs). Serves the ui/ SPA and a small REST API
// over the var/intel data layer. It NEVER writes core state directly — dispatch
// and cancel go through the daemon's own inbox channels (inbox/task-actions/ and
// cancel-signals/), so the daemon stays the single writer of tasks/queue.
//
//   npm run dashboard            → http://localhost:4000
//   PORT=5000 npm run dashboard  → http://localhost:5000
//
// Reads roots via paths.js (.env.local). Bind is localhost-only.
const http = require('http')
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const { deriveConfirmationStatus } = require('../agents/finding-schema')
const agentPaths = require('../paths')
const { parseFindingsJsonl } = require('../src/pipeline/loose-jsonl')

const INTEL = agentPaths.INTEL_ROOT
const AGENTS = agentPaths.AGENTS_ROOT
const UI_DIR = path.join(AGENTS, 'ui')
const PORT = parseInt(process.env.PORT || '4000', 10)

let SQUAD_TYPES = {}
try { SQUAD_TYPES = require(path.join(AGENTS, 'src/core/squad-framework')).SQUAD_TYPES || {} } catch {}

// Offensive-security focus: the portal only surfaces these squads (presentation
// filter — the daemon/squad-framework still support every squad). Override via
// KURU_PORTAL_SQUADS="pentest,code-review,..." without touching code.
// ARCHON ships pentest as the single dispatch squad; code-review runs under the
// hood as the white-box engine of a combined engagement (not a separate option).
const OFFSEC = new Set(
  (process.env.KURU_PORTAL_SQUADS || 'pentest')
    .split(',').map(s => s.trim()).filter(Boolean)
)

// ── data-layer reads (all fail-soft) ──
function readJSON(rel, fallback) {
  try { return JSON.parse(fs.readFileSync(path.join(INTEL, rel), 'utf-8')) } catch { return fallback }
}
function readLines(rel, max) {
  try {
    const ls = fs.readFileSync(path.join(INTEL, rel), 'utf-8').trim().split('\n').filter(Boolean)
    return ls.slice(-max).map(l => { try { return JSON.parse(l) } catch { return { raw: l } } })
  } catch { return [] }
}

// M5: the Source Runtime card for a static / white-box task — the planner decision, honest mapping counts
// (from the ledger — mapped is done-only, deferred/blocked shown separately), per-worker progress, and the
// last events. Returns null for a task that isn't a source review (no plan / ledger / events).
function sourceRuntimeForTask(taskId) {
  if (!taskId) return null
  const crDir = path.join(INTEL, 'code-review', taskId)
  let plan = null, ledger = null, events = []
  try { plan = JSON.parse(fs.readFileSync(path.join(crDir, 'source-runtime-plan.json'), 'utf-8')) } catch {}
  try { ledger = JSON.parse(fs.readFileSync(path.join(crDir, 'phase1-maps', 'mapping-ledger.json'), 'utf-8')) } catch {}
  try { events = fs.readFileSync(path.join(INTEL, `source-runtime-${taskId}.jsonl`), 'utf-8').trim().split('\n').filter(Boolean).map(l => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean) } catch {}
  if (!plan && !ledger && !events.length) return null
  // Live-honest mapping progress: the ledger only flips features to `done` when a whole worker session
  // RETURNS, so mid-session it reads 0 mapped while dozens of feature maps already exist on disk. The map
  // files ARE the real-time truth — count them and let them drive the displayed progress.
  let mappedSlugs = new Set()
  try { for (const f of fs.readdirSync(path.join(crDir, 'phase1-maps', 'features'))) if (f.endsWith('.md')) mappedSlugs.add(f.slice(0, -3)) } catch {}
  const counts = ledger ? {
    total: ledger.features_total || 0,
    mapped: Math.max(ledger.features_mapped || 0, mappedSlugs.size),
    in_progress: 0, // recomputed below from the honest mapped count
    queued: ledger.features_queued || 0, deferred: ledger.features_deferred || 0, blocked: ledger.features_blocked || 0,
    reviewed: ledger.features_reviewed || 0, accounted: ledger.features_accounted || 0,
  } : {}
  if (ledger) counts.in_progress = Math.max(0, counts.total - counts.mapped - counts.deferred - counts.blocked - (ledger.features_failed || 0) - counts.queued)
  // per-worker progress: fold the event stream by session_id (last-write-wins for current/last_event)
  const bySession = {}
  for (const e of events) {
    if (!e.session_id) continue
    const s = bySession[e.session_id] || (bySession[e.session_id] = { session_id: e.session_id, owner: e.owner || null, assigned_total: 0, mapped: 0, current: null, last_event: null })
    if (e.owner) s.owner = e.owner
    if (e.assigned_total) s.assigned_total = e.assigned_total
    if (e.feature) s.current = e.feature
    if (e.status === 'done') s.mapped++
    if (e.message) s.last_event = e.message
  }
  // Overlay live disk truth per worker: how many of this session's assigned features already have a map file.
  for (const s of Object.values(bySession)) {
    const ps = plan && Array.isArray(plan.sessions) ? plan.sessions.find(x => x.session_id === s.session_id) : null
    if (ps && Array.isArray(ps.features)) s.mapped = Math.max(s.mapped, ps.features.filter(sl => mappedSlugs.has(sl)).length)
  }
  const last = events.length ? events[events.length - 1] : null
  const rateLimit = last && last.status === 'rate_limit_pause' ? 'cooling' : (plan && plan.quota) || 'healthy'
  // M7: white-box validation breakdown — count the source findings by confirmation status. A source-only
  // finding stays SOURCE_CONFIRMED; only a live-proven one is RUNTIME_CONFIRMED. Also surface the correlation
  // report (matched/unmatched) when the deferred black-box validation run has produced one.
  let validation = null
  try {
    const vf = fs.readFileSync(path.join(INTEL, `VALIDATED-FINDINGS-${taskId}.jsonl`), 'utf-8').trim().split('\n').filter(Boolean).map(l => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)
    if (vf.length) {
      const by = {}; for (const f of vf) { const s = String(f.confirmation_status || 'NEEDS_LIVE_VALIDATION').toUpperCase(); by[s] = (by[s] || 0) + 1 }
      validation = { total: vf.length, source_confirmed: by.SOURCE_CONFIRMED || 0, needs_live: by.NEEDS_LIVE_VALIDATION || 0, runtime_confirmed: by.RUNTIME_CONFIRMED || 0, disproven: by.DISPROVEN || 0 }
    }
  } catch {}
  // parity §9: Feature Coverage card — separate counters straight off the ledger (S2 rollups) + follow-ups.
  const followups = (() => { try { return fs.readFileSync(path.join(crDir, 'phase1-maps', 'followup-features.jsonl'), 'utf-8').trim().split('\n').filter(Boolean).length } catch { return 0 } })()
  const coverage = ledger ? {
    discovered: ledger.features_total || 0, mapped: counts.mapped, deep_mapped: ledger.features_deep_mapped || 0,
    reviewed: ledger.features_reviewed || 0, no_issue: ledger.features_reviewed_no_issue || 0,
    with_candidates: ledger.features_candidates || 0, blocked: counts.blocked, deferred: counts.deferred, followups,
  } : null
  // parity §9: Findings Pipeline card — candidates emitted → in triage → validated → judged, with the
  // validation-status breakdown. Counts are line-counts of the live streaming artifacts (fail-soft to 0).
  const jsonlCount = (p) => { try { return fs.readFileSync(p, 'utf-8').trim().split('\n').filter(Boolean).length } catch { return 0 } }
  const candidates_emitted = jsonlCount(path.join(INTEL, `live-findings-${taskId}.jsonl`))
  const judged = jsonlCount(path.join(INTEL, `JUDGED-FINDINGS-${taskId}.jsonl`))
  const validatedN = validation ? validation.total : 0
  const triageLadder = (n) => n <= 20 ? 1 : n <= 75 ? 2 : n <= 200 ? 3 : 4 // parity §6
  // #5: prefer the REAL triage session count emitted by the triager (last triage_sessions event); fall back to
  // the candidate-count estimate only if the triager hasn't reported yet.
  const realTriage = events.filter(e => e.status === 'triage_sessions').slice(-1)[0]
  // §6: terminal candidate accounting from the candidate-ledger + triage quarantine — proves N candidates =
  // N terminal verdicts and surfaces the quarantine counters the pipeline card should show.
  const _ledgerRows = (() => { try { return fs.readFileSync(path.join(INTEL, `candidate-ledger-${taskId}.jsonl`), 'utf-8').split('\n').map(l => { try { return JSON.parse(l.trim()) } catch { return null } }).filter(Boolean) } catch { return [] } })()
  const _termCount = (v) => _ledgerRows.filter(r => String(r.terminal_status || '').toUpperCase() === v).length
  const pipeline = {
    candidates_emitted, in_triage: Math.max(0, candidates_emitted - validatedN), validated: validatedN, judged,
    needs_live: (validation && validation.needs_live) || 0, source_confirmed: (validation && validation.source_confirmed) || 0,
    runtime_confirmed: (validation && validation.runtime_confirmed) || 0, disproven: (validation && validation.disproven) || 0,
    triage_sessions: realTriage ? realTriage.session_count : (candidates_emitted ? triageLadder(candidates_emitted) : 0),
    triage_sessions_source: realTriage ? 'actual' : 'estimated',
    // terminal accounting (holistic candidate-ledger)
    candidate_ledger_total: _ledgerRows.length,
    auditor_verdicts: _ledgerRows.filter(r => r.terminal_status && r.terminal_status !== 'AUDIT_QUARANTINED').length,
    triaged: _ledgerRows.filter(r => r.triaged).length,
    audit_quarantined: _termCount('AUDIT_QUARANTINED'),
    triage_quarantined: jsonlCount(path.join(INTEL, `triage-quarantine-${taskId}.jsonl`)),
    ledger_disproven: _termCount('DISPROVEN'),
  }
  // parity §9.4: planned (from the plan) vs actually-active mapping sessions, so the UI can explain quota
  // backoff (e.g. planned 4, active 3 because quota was constrained). A mapping session is "active" once it
  // has started and hasn't yet mapped all its assigned features.
  const planned_sessions = (plan && plan.mapping_sessions) || 0
  const active_sessions = Object.values(bySession).filter(s => /map-worker/.test(String(s.session_id)) && (s.mapped || 0) < (s.assigned_total || 0)).length
  const runtime = { planned_sessions, active_sessions, quota_mode: (plan && plan.quota) || rateLimit, reason: (plan && plan.reason) || '' }
  return { taskId, mode: (plan && plan.mode) || 'static', plan, counts, coverage, pipeline, runtime, sessions: Object.values(bySession), recent: events.slice(-12), rateLimit, validation }
}
function listReports() {
  const out = []
  const dirs = ['reports', 'pentest', 'code-review']
  for (const d of dirs) {
    try {
      for (const f of fs.readdirSync(path.join(INTEL, d))) {
        if (f.endsWith('.md')) {
          const full = path.join(INTEL, d, f)
          let mtime = 0, size = 0
          try { const st = fs.statSync(full); mtime = st.mtimeMs; size = st.size } catch {}
          out.push({ rel: path.join(d, f), name: f, dir: d, mtime, size })
        }
      }
    } catch {}
  }
  return out.sort((a, b) => b.mtime - a.mtime)
}

// Dedupe tasks.json by id, keep the richest record.
function tasks() {
  const raw = readJSON('tasks.json', [])
  const byId = new Map()
  for (const t of Array.isArray(raw) ? raw : []) {
    if (!t || !t.id) continue
    const prev = byId.get(t.id)
    if (!prev || Object.keys(t).length >= Object.keys(prev).length) byId.set(t.id, t)
  }
  // Active tasks (running / awaiting the operator) sort ABOVE terminal ones, THEN by time.
  // This keeps a fresh dispatch visible even when stale tasks carry future timestamps from a
  // clock that was wrong before a reboot (else newest-first buries the new task below them).
  const _activeRank = t => {
    const s = String(t.status || '').toLowerCase()
    if (['in-progress', 'processing', 'generating-report'].includes(s)) return 0
    if (['awaiting-triage', 'queued', 'pending'].includes(s)) return 1
    return 2 // done / cancelled / failed
  }
  return [...byId.values()].sort((a, b) =>
    _activeRank(a) - _activeRank(b) ||
    String(b.lastUpdate || b.createdAt || '').localeCompare(String(a.lastUpdate || a.createdAt || '')))
}

// squads + their leader + phases + agent roster (from ownership.json)
function squads() {
  let map = {}
  try { map = JSON.parse(fs.readFileSync(path.join(AGENTS, 'ownership.json'), 'utf-8')).map || {} } catch {}
  const roster = {}
  for (const [agent, home] of Object.entries(map)) {
    const sq = String(home).replace(/^squads\//, '').replace(/^_universal$/, 'universal')
    ;(roster[sq] = roster[sq] || []).push(agent)
  }
  const out = []
  for (const [id, cfg] of Object.entries(SQUAD_TYPES)) {
    // The dispatch dropdown is offensive-security-only (default: pentest). code-review is NOT a
    // dispatch option — it runs under the hood as the white-box/static engine — but the SPA
    // still needs its phase metadata so code-review run cards render a proper stepper. Surface
    // it flagged `hidden`; keep other non-offsec squads (stocks, etc.) filtered out entirely.
    const dispatchable = OFFSEC.has(id)
    if (!dispatchable && id !== 'code-review') continue
    out.push({
      id,
      hidden: !dispatchable, // present for SQUAD_BY (stepper/phases) but not offered for dispatch
      leader: (cfg.leaderAgent || '').toUpperCase(),
      type: cfg.type,
      dispatchType: cfg.dispatchType,
      phases: cfg.phases || [],
      costBudget: cfg.costBudget,
      agents: (roster[id] || []).map(a => a.toUpperCase()).sort(),
    })
  }
  out.push({ id: 'universal', leader: '—', type: 'cross-squad', phases: [], agents: (roster.universal || []).map(a => a.toUpperCase()).sort() })
  return out
}

let _procCache = { at: 0, up: false }
function daemonUp() {
  // heuristic: heartbeat fresh (a task is actively running), OR a node event-bus
  // proc is alive (daemon up but idle — no task ⇒ no heartbeat, so the proc check
  // is the only signal). Without the proc check an idle daemon reads as "standby".
  try {
    const hb = path.join(INTEL, 'task-heartbeats.json')
    if (fs.existsSync(hb) && (Date.now() - fs.statSync(hb).mtimeMs) < 120000) return true
  } catch {}
  // pgrep is cheap but the UI polls every ~2.5s — cache the result for 4s.
  const now = Date.now()
  if (now - _procCache.at < 4000) return _procCache.up
  let up = false
  try {
    const out = require('child_process').execFileSync('pgrep', ['-f', 'event-bus.js'], { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim()
    up = out.split('\n').some(pid => pid && String(pid) !== String(process.pid))
  } catch { up = false } // pgrep no-match exits 1 ⇒ down
  _procCache = { at: now, up }
  return up
}

// Per-run "test plan": for a focused scan, each selected class → its specialist → live status
// (running = its specialist is working on THIS task now; done = specialist already ran; else
// pending). Empty for a full scan (the UI then shows "Full scan — all classes"). Reuses the
// shared focus-map so class→specialist never drifts from the daemon.
function testPlanFor(task, agentStatus) {
  const { specialistForClass } = require('../src/pipeline/focus-map')
  const eng = readEngagement(resolveEngagementId(task.id) || task.id) || {}
  const focusClasses = Array.isArray(eng.focusClasses) ? eng.focusClasses : []
  if (!focusClasses.length) return { focusClasses: [], testPlan: [] }
  const done = new Set(Object.keys(task.costByAgent || {}).map(a => String(a).toLowerCase()))
  const working = new Set(Object.entries(agentStatus || {})
    .filter(([, v]) => v && String(v.status).toLowerCase() === 'working' && String(v.taskId) === String(task.id))
    .map(([a]) => String(a).toLowerCase()))
  const testPlan = focusClasses.map(cls => {
    const spec = specialistForClass(cls)
    const status = spec && working.has(spec) ? 'running' : spec && done.has(spec) ? 'done' : 'pending'
    return { cls, label: FOCUS_LABEL[cls] || cls, specialist: (spec || '').toUpperCase(), status }
  })
  return { focusClasses, testPlan }
}

function state() {
  const agentStatus = readJSON('agent-status.json', {})
  return {
    now: new Date().toISOString(),
    intel: INTEL, agents: AGENTS,
    daemon: daemonUp(),
    tasks: tasks().map(t => ({ ...t, ...testPlanFor(t, agentStatus) })),
    agentStatus,
    queue: readJSON('dispatch-queue.json', []),
    activity: readLines('ACTIVITY-LOG.jsonl', 60).reverse(),
    reports: listReports(),
  }
}

// ── writes go through the daemon's inbox channels only ──
function writeInbox(subdir, obj) {
  const dir = path.join(INTEL, subdir)
  fs.mkdirSync(dir, { recursive: true })
  const name = `${Date.now()}-${crypto.randomBytes(4).toString('hex')}.json`
  const tmp = path.join(dir, name + '.tmp')
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2))
  fs.renameSync(tmp, path.join(dir, name)) // atomic publish for the watcher
  return name
}

// Validate a source directory: absolute, exists, is a readable non-empty directory. Returns
// { ok, error, entries } — never throws — so it drives both the /api/check-source live check
// and buildCodeReviewMeta. The daemon reads the tree straight off local disk, so the path must
// be a real absolute path on this machine.
function checkSourceDir(dir) {
  const sourceDir = String(dir || '').trim()
  if (!sourceDir) return { ok: false, error: 'source directory is required' }
  if (/^~/.test(sourceDir)) return { ok: false, error: 'use a full absolute path, not "~" (e.g. /Users/you/Documents/project)' }
  if (!path.isAbsolute(sourceDir)) return { ok: false, error: 'must be an absolute path' }
  let st
  try { st = fs.statSync(sourceDir) } catch { return { ok: false, error: 'not found or not accessible on this machine' } }
  if (!st.isDirectory()) return { ok: false, error: 'that path is a file, not a directory' }
  let entries
  try { entries = fs.readdirSync(sourceDir) } catch { return { ok: false, error: 'not readable (permission denied)' } }
  if (!entries.length) return { ok: false, error: 'the directory is empty' }
  return { ok: true, entries: entries.length }
}

// Build a code-review meta block from the form, validated.
function buildCodeReviewMeta(body) {
  const m = (body.meta && typeof body.meta === 'object') ? body.meta : {}
  const sourceDir = String(m.sourceDir || '').trim()
  const _chk = checkSourceDir(sourceDir)
  if (!_chk.ok) throw new Error(`sourceDir: ${_chk.error}${sourceDir ? ` (${sourceDir})` : ''}`)
  const out = { sourceDir }
  // The dispatcher is the source of truth. Never accept a class here that the
  // runtime will later drop, or omit a class the runtime can execute.
  const classCatalog = require('../src/dispatch/code-review-dispatcher')
  const VALID_CLASSES = ['all', ...Object.keys(classCatalog.CLASS), ...Object.keys(classCatalog.CLASS_ALIASES)]
  const LIVE_TO_SOURCE_CLASS = {
    'access-control': 'access-control', idor: 'access-control', bola: 'access-control',
    auth: 'authentication-session', session: 'authentication-session',
    sqli: 'sqli', injection: 'injection', 'command-injection': 'command-injection',
    xss: 'xss', ssrf: 'ssrf', ssti: 'injection', xxe: 'deserialization',
    csrf: 'csrf', lfi: 'lfi', 'path-traversal': 'path-traversal',
    api: 'api-security', jwt: 'api-security', graphql: 'graphql',
    'business-logic': 'business-logic',
  }
  const requestedClasses = Array.isArray(m.vulnClasses)
    ? m.vulnClasses
    : Array.isArray(m.focusClasses)
      ? m.focusClasses.map(c => LIVE_TO_SOURCE_CLASS[String(c || '').toLowerCase()]).filter(Boolean)
      : null
  if (Array.isArray(requestedClasses)) {
    const rawClasses = requestedClasses.map(c => String(c || '').trim().toLowerCase())
    const unknownClasses = rawClasses.filter(c => !VALID_CLASSES.includes(c))
    if (unknownClasses.length) throw new Error(`unknown source-review vulnerability class(es): ${unknownClasses.join(', ')}`)
    const vc = rawClasses.filter(c => VALID_CLASSES.includes(c)).map(classCatalog.normalizeVulnClass)
    if (vc.includes('all')) out.vulnClasses = ['all']
    else if (vc.length) out.vulnClasses = [...new Set(vc)]
  }
  if (m.customFocus) out.customFocus = String(m.customFocus).trim().slice(0, 600)
  if (m.deployUrl && /^https?:\/\//.test(String(m.deployUrl))) out.deployUrl = String(m.deployUrl)
  if (m.testAccounts && typeof m.testAccounts === 'object') out.testAccounts = m.testAccounts // UTTARA runtime-validation auth
  if (Number.isFinite(+m.maxFeatures) && +m.maxFeatures > 0) out.maxFeatures = Math.floor(+m.maxFeatures)
  if (Number.isFinite(+m.maxPhase2) && +m.maxPhase2 > 0) out.maxPhase2 = Math.floor(+m.maxPhase2)
  return out
}

// normalize a URL/host string to a bare lowercase host
function hostOf(u) {
  // hostname (NOT host) — the scope-validator + pentest extractTarget match on
  // host WITHOUT the port, so "localhost:4000" must normalize to "localhost"
  // or Phase 0.0 blocks the dispatch ("target not in scope"). (bug fix 2026-06-18)
  const s = String(u || '').trim()
  try { return new URL(/^https?:\/\//i.test(s) ? s : 'https://' + s).hostname.toLowerCase() }
  catch { return s.replace(/^https?:\/\//i, '').split('/')[0].split(':')[0].toLowerCase() }
}

// Build a pentest meta block from the form, validated + normalized.
function buildPentestMeta(body) {
  const m = (body.meta && typeof body.meta === 'object') ? body.meta : {}
  const targetUrl = String(m.targetUrl || '').trim()
  if (!targetUrl) throw new Error('pentest needs a web application URL (meta.targetUrl)')
  if (!/^https?:\/\//.test(targetUrl)) throw new Error('targetUrl must start with http:// or https://')
  const testType = m.testType === 'feature' ? 'feature' : 'full'
  const featureFocus = testType === 'feature' ? String(m.featureFocus || '').trim() : ''
  const norm = (arr) => Array.isArray(arr) ? [...new Set(arr.map(s => hostOf(s)).filter(Boolean))] : []
  const inScope = norm(m.inScope)
  const th = hostOf(targetUrl)
  if (th && !inScope.includes(th)) inScope.unshift(th) // target host MUST be in-scope or Phase 0.0 blocks the dispatch
  const outOfScope = norm(m.outOfScope)
  const scopeConflicts = inScope.filter(host => outOfScope.includes(host))
  if (scopeConflicts.length) throw new Error(`scope conflict: host appears in both in-scope and out-of-scope (${scopeConflicts.join(', ')})`)
  const ROLES = ['admin', 'normal', 'other']
  const credentials = Array.isArray(m.credentials)
    ? m.credentials.map(c => ({ username: String(c.username || '').trim(), password: String(c.password || ''), role: ROLES.includes(c.role) ? c.role : 'normal' })).filter(c => c.username)
    : []
  // triage gate ON by default for pentest — findings are produced, then the
  // operator triages and clicks Generate report (set meta.triageGate:false to opt out).
  const triageGate = m.triageGate === false ? false : true
  // comprehensive profile → report EVERYTHING incl. info-level TLS/SSL/headers/leaks
  // (Phase 3.075 keeps all severities). Override via meta.severityProfile.
  const severityProfile = ['bounty', 'pentest', 'comprehensive'].includes(m.severityProfile) ? m.severityProfile : 'comprehensive'
  // focused scan: run only specific vuln classes instead of full A→Z (empty = full)
  const requestedFocus = Array.isArray(m.focusClasses)
    ? [...new Set(m.focusClasses.map(c => String(c || '').toLowerCase()).filter(Boolean))]
    : []
  const unknownFocus = requestedFocus.filter(c => !FOCUS_CLASSES.includes(c))
  if (unknownFocus.length) throw new Error(`unknown vulnerability focus class(es): ${unknownFocus.join(', ')}`)
  const focusClasses = cleanFocus(requestedFocus)
  // custom focus: free-text directive for vulns/areas not in the chip list
  // (e.g. cache poisoning, request smuggling, OAuth abuse). Steers recon + testing.
  const customFocus = String(m.customFocus || '').trim().slice(0, 600)
  // strategy is normalized after focus cleanup. Direct testing skips
  // infrastructure recon but always retains deterministic application mapping.
  const blackboxStrategy = require('../src/runtime/blackbox-strategy')
  const strategyPlan = blackboxStrategy.phasePlan({ ...m, testType, featureFocus, focusClasses, customFocus })
  const skipRecon = strategyPlan.strategy === blackboxStrategy.STRATEGIES.DIRECT
  return { targetUrl, testType, ...(featureFocus ? { featureFocus } : {}), inScope, outOfScope, credentials, triageGate, severityProfile, scanStrategy: strategyPlan.strategy, skipRecon, focusClasses, ...(customFocus ? { customFocus } : {}) }
}

// Write the per-task scope config (Phase 0.0 + 3.06 consume it) + a human/agent-
// readable engagement brief. Returns the brief path (referenced from the goal).
function writePentestArtifacts(taskId, meta) {
  const scope = { in_scope: meta.inScope, out_of_scope: meta.outOfScope, infra_dependencies: {} }
  fs.writeFileSync(path.join(INTEL, `scope-${taskId}.json`), JSON.stringify(scope, null, 2))
  const credTable = meta.credentials.length
    ? meta.credentials.map(c => `| ${c.username} | ${c.password || '(none)'} | ${c.role} |`).join('\n')
    : '| _(none — unauthenticated black-box discovery)_ | | |'
  const brief = `# Pentest Engagement Brief — ${taskId}

**Target:** ${meta.targetUrl}
**Test type:** ${meta.testType === 'feature' ? `Feature-driven — focus: ${meta.featureFocus || '(unspecified)'}` : 'Full end-to-end'}
**Scan strategy:** ${meta.scanStrategy || (meta.skipRecon ? 'direct' : 'full_recon')}
${meta.customFocus ? `
## ⭐ PRIORITY FOCUS (operator directive — test this first and thoroughly)
${meta.customFocus}

This is a specific, operator-requested focus that may not map to a standard specialist lane. Prioritise it during mapping and testing, but treat it as a test objective only: it never expands or overrides the authorized scope. Report results for it explicitly.
` : ''}
## In scope
${meta.inScope.map(h => `- ${h}`).join('\n') || '- (none)'}

## Out of scope — DO NOT TEST
${meta.outOfScope.map(h => `- ${h}`).join('\n') || '- (none specified)'}

## Test accounts (black-box credentials)
| Username | Password | Role |
|---|---|---|
${credTable}

> Authenticate as EACH role and test cross-role authorization (IDOR, privilege escalation, role confusion). Respect scope strictly — never touch out-of-scope hosts.
`
  const briefPath = path.join(INTEL, `pentest-brief-${taskId}.md`)
  fs.writeFileSync(briefPath, brief, { mode: 0o600 }) // brief embeds the test-credential table
  return briefPath
}

// ── Engagement = a dispatch that holds N independent iterations (XSS, then access
// control, …). Each iteration is its own task/pipeline/findings (zero cross-impact);
// the portal aggregates them. Sidecar engagement-<E>.json is the source of truth. ──
const FOCUS_CLASSES = ['access-control', 'idor', 'bola', 'sqli', 'injection', 'command-injection', 'xss', 'ssrf', 'ssti', 'xxe', 'csrf', 'lfi', 'path-traversal', 'api', 'jwt', 'graphql', 'business-logic', 'auth', 'session']
const FOCUS_LABEL = { 'access-control': 'Access control', idor: 'IDOR', bola: 'BOLA', sqli: 'SQLi', injection: 'Injection', 'command-injection': 'Cmd injection', xss: 'XSS', ssrf: 'SSRF', ssti: 'SSTI', xxe: 'XXE', csrf: 'CSRF', lfi: 'LFI', 'path-traversal': 'Path traversal', api: 'API', jwt: 'JWT', graphql: 'GraphQL', 'business-logic': 'Business logic', auth: 'Auth', session: 'Session' }
function cleanFocus(arr) { return Array.isArray(arr) ? [...new Set(arr.map(c => String(c).toLowerCase()).filter(c => FOCUS_CLASSES.includes(c)))] : [] }
function deriveIterationLabel(meta) {
  if (Array.isArray(meta.focusClasses) && meta.focusClasses.length) return meta.focusClasses.map(c => FOCUS_LABEL[c] || c).join(' + ')
  if (meta.customFocus) return 'Focus: ' + String(meta.customFocus).slice(0, 36)
  if (meta.testType === 'feature' && meta.featureFocus) return 'Feature: ' + String(meta.featureFocus).slice(0, 40)
  return 'Full scan'
}
const engPath = (E) => path.join(INTEL, `engagement-${E}.json`)
function readEngagement(E) { try { return JSON.parse(fs.readFileSync(engPath(String(E)), 'utf8')) } catch { return null } }
// mode 0600 — engagement sidecar carries operator-entered test credentials.
function writeEngagement(E, obj) { const t = engPath(String(E)) + '.tmp'; fs.writeFileSync(t, JSON.stringify(obj, null, 2), { mode: 0o600 }); fs.renameSync(t, engPath(String(E))) }
// resolve the engagement a taskId belongs to (it may be the root or any iteration). null = standalone task.
function resolveEngagementId(taskId) {
  const id = String(taskId)
  if (fs.existsSync(engPath(id))) return id
  try {
    for (const f of fs.readdirSync(INTEL)) {
      if (!/^engagement-.*\.json$/.test(f)) continue
      try { const e = JSON.parse(fs.readFileSync(path.join(INTEL, f), 'utf8')); if ((e.iterations || []).some(it => it.taskId === id)) return e.engagementId } catch {}
    }
  } catch {}
  return null
}
// Spawn a new iteration on an existing engagement — inherits target/scope/creds,
// applies the new focus/skip-recon, dispatches as its own independent task.
function iterateDispatch(body) {
  const E = String(body.engagementId || '').trim()
  if (!E) throw new Error('engagementId is required')
  const eng = readEngagement(E)
  if (!eng) throw new Error('engagement not found: ' + E)
  const testType = body.testType === 'feature' ? 'feature' : 'full'
  const featureFocus = String(body.featureFocus || '').trim()
  if (testType === 'feature' && !featureFocus) throw new Error('feature focus required for feature-driven iteration')
  const requestedFocus = Array.isArray(body.focusClasses)
    ? [...new Set(body.focusClasses.map(c => String(c || '').toLowerCase()).filter(Boolean))]
    : []
  const unknownFocus = requestedFocus.filter(c => !FOCUS_CLASSES.includes(c))
  if (unknownFocus.length) throw new Error(`unknown vulnerability focus class(es): ${unknownFocus.join(', ')}`)
  const meta = {
    targetUrl: eng.targetUrl, inScope: eng.inScope || [], outOfScope: eng.outOfScope || [], credentials: eng.credentials || [],
    testType, ...(testType === 'feature' ? { featureFocus } : {}),
    triageGate: eng.triageGate !== false, severityProfile: eng.severityProfile || 'comprehensive',
    skipRecon: body.skipRecon === true, focusClasses: cleanFocus(requestedFocus), engagementId: E,
  }
  meta.iterationLabel = deriveIterationLabel(meta)
  const taskId = 't-' + Date.now() + '-' + crypto.randomBytes(2).toString('hex')
  _runtimeGeneration.pin(taskId)
  const briefPath = writePentestArtifacts(taskId, meta)
  const goal = `Pentest ${meta.targetUrl} — engagement iteration "${meta.iterationLabel}"${meta.skipRecon ? ' (recon skipped)' : ''}. ${meta.credentials.length} test account(s); scope + credentials in brief: ${briefPath}. In-scope/out-of-scope enforced via scope config — never test out-of-scope hosts.`.slice(0, 500)
  eng.iterations = eng.iterations || []
  eng.iterations.push({ taskId, label: meta.iterationLabel, createdAt: new Date().toISOString(), squad: 'pentest', kind: 'blackbox' })
  writeEngagement(E, eng)
  writeInbox('inbox/task-actions', {
    action: 'dispatch', taskId, taskTitle: `Pentest: ${hostOf(meta.targetUrl)} · ${meta.iterationLabel}`.slice(0, 200),
    assignee: 'ATLAS', squad: 'pentest-squad', priority: 'normal', goal, createdAt: new Date().toISOString(), projectId: null, meta,
  })
  return { taskId, engagementId: E, iterationLabel: meta.iterationLabel }
}

function createDispatch(body) {
  const squad = String(body.squad || '').replace(/-squad$/, '')
  const cfg = SQUAD_TYPES[squad]
  if (!cfg) throw new Error(`unknown squad "${squad}"`)
  const isCodeReview = squad === 'code-review'
  const isPentest = squad === 'pentest'
  let goal = String(body.goal || '').trim()
  if (!isCodeReview && !isPentest && !goal) throw new Error('goal is required')
  // code-review + pentest take structured meta instead of a free-text target
  const meta = isCodeReview ? buildCodeReviewMeta(body) : isPentest ? buildPentestMeta(body) : null
  const taskId = 't-' + Date.now() + '-' + crypto.randomBytes(2).toString('hex')
  _runtimeGeneration.pin(taskId)
  let fallbackTitle = goal
  if (isCodeReview) {
    fallbackTitle = `Code review: ${path.basename(meta.sourceDir)}`
    // Phase 0.0 scope gate is fail-closed and runs for every squad. A static
    // source review is authorized by the operator-provided source tree, so seed
    // a scope config listing it as in-scope (path-based match in
    // squad-policy/code-review.matchesScope). Without this the dispatch
    // hard-blocks with "no scope config".
    try {
      fs.writeFileSync(path.join(INTEL, `scope-${taskId}.json`),
        JSON.stringify({ in_scope: [meta.sourceDir], out_of_scope: [], infra_dependencies: {} }, null, 2))
    } catch {}
  }
  if (isPentest) {
    // engagement: this first dispatch is iteration 1 (black-box, live). Record the
    // engagement sidecar so later iterations can inherit scope/creds and findings
    // can aggregate. When a sourceDir is also supplied, this becomes a COMBINED
    // white-box + black-box engagement: a code-review iteration runs the full
    // white-box pipeline alongside the black-box pentest, both feeding one report.
    const combined = !!(body.meta && body.meta.sourceDir)
    meta.engagementId = taskId
    meta.iterationLabel = combined ? 'Black-box (live)' : deriveIterationLabel(meta)
    const iterations = [{ taskId, label: meta.iterationLabel, createdAt: new Date().toISOString(), squad: 'pentest', kind: 'blackbox' }]

    let crTaskId = null, crMeta = null
    if (combined) {
      // build + validate the white-box (code-review) side; bridge it to the live URL
      crMeta = buildCodeReviewMeta(body)          // validates absolute sourceDir
      crMeta.deployUrl = meta.targetUrl           // PROBER runtime-validates source findings against the live target
      crTaskId = 't-' + Date.now() + '-' + crypto.randomBytes(2).toString('hex')
      _runtimeGeneration.pin(crTaskId)
      crMeta.engagementId = taskId
      // scope config so the code-review iteration's live (PROBER) hits pass Phase 0.0
      try {
        // in_scope carries the URL hostnames (PROBER's live runtime hits) PLUS the
        // source tree path, so Phase 0.0 (which extracts meta.sourceDir for the
        // code-review squad) matches the source target. matchesScope uses .some(),
        // so the path entry resolves the source target while hostnames serve PROBER.
        fs.writeFileSync(path.join(INTEL, `scope-${crTaskId}.json`),
          JSON.stringify({ in_scope: [...(meta.inScope || []), crMeta.sourceDir], out_of_scope: meta.outOfScope, infra_dependencies: {} }, null, 2))
      } catch {}
      iterations.push({ taskId: crTaskId, label: 'White-box (source)', createdAt: new Date().toISOString(), squad: 'code-review', kind: 'whitebox' })
    }

    writeEngagement(taskId, {
      engagementId: taskId, targetUrl: meta.targetUrl, inScope: meta.inScope, outOfScope: meta.outOfScope,
      credentials: meta.credentials, severityProfile: meta.severityProfile, triageGate: meta.triageGate,
      focusClasses: meta.focusClasses || [],
      ...(combined ? { sourceDir: crMeta.sourceDir } : {}),
      createdAt: new Date().toISOString(), iterations,
    })

    // dispatch the white-box (code-review) iteration as its own independent task
    if (combined) {
      writeInbox('inbox/task-actions', {
        action: 'dispatch', taskId: crTaskId,
        taskTitle: `White-box: ${path.basename(crMeta.sourceDir)}`.slice(0, 200),
        assignee: 'CURATOR', squad: 'code-review-squad', priority: 'normal',
        goal: `White-box code review of ${crMeta.sourceDir}; runtime-validate against ${meta.targetUrl}.`.slice(0, 500),
        createdAt: new Date().toISOString(), projectId: null, meta: crMeta,
      })
    }

    // write scope config + engagement brief, then compose a concise goal (≤512, sanitized)
    const briefPath = writePentestArtifacts(taskId, meta)
    const focusNote = meta.customFocus ? ` PRIORITY FOCUS: ${meta.customFocus}.` : ''
    const scopeNote = combined ? 'black-box (live) — paired with a white-box source review'
      : meta.testType === 'feature' ? `feature-driven (focus: ${(meta.featureFocus || '').slice(0, 120)})`
      : 'full end-to-end'
    goal = `Pentest ${meta.targetUrl} — ${scopeNote}.${focusNote} ${meta.credentials.length} test account(s); scope + credentials in engagement brief: ${briefPath}. In-scope/out-of-scope enforced via scope config — never test out-of-scope hosts.`.slice(0, 500)
    fallbackTitle = combined ? `Engagement: ${hostOf(meta.targetUrl)} (white+black)` : `Pentest: ${hostOf(meta.targetUrl)}`
  }
  const req = {
    action: 'dispatch',
    taskId,
    taskTitle: String(body.taskTitle || fallbackTitle).slice(0, 200),
    assignee: (cfg.leaderAgent || '').toUpperCase(),
    squad: squad + '-squad',
    priority: ['low', 'normal', 'high'].includes(body.priority) ? body.priority : 'normal',
    goal,
    createdAt: new Date().toISOString(),
    projectId: null,
    ...(body.model ? { model: String(body.model) } : {}),
    ...(meta ? { meta } : {}),
  }
  // White-box contract: code review FIRST, then a source-guided live pentest that VERIFIES the
  // code-review candidates against the target box. So for a combined dispatch (pentest squad +
  // a sourceDir) always DEFER the live pentest: stamp it white-box + source-guided, stash it on
  // the engagement, mark the black-box iteration pending-source-guidance, and DON'T writeInbox it
  // now — the code-review completion hook (maybeLaunchSourceGuidedPentest) launches it, aimed by
  // the source findings. This makes a white-box run genuinely "review, then verify against the
  // box" instead of two parallel passes. (Previously gated behind ARCHON_ENABLE_SOURCE_GUIDED_
  // PENTEST; it is now the default white-box flow.) Non-combined pentest ⇒ writeInbox below runs
  // unchanged. See ULTRAPLAN §3.2.
  if (squad === 'pentest' && body.meta && body.meta.sourceDir) {
    req.meta = { ...(req.meta || {}), sourceGuided: true, engagementMode: 'whitebox' }
    try {
      const engFile = path.join(INTEL, `engagement-${taskId}.json`)
      const eng = JSON.parse(fs.readFileSync(engFile, 'utf8'))
      eng.deferredPentestDispatch = req
      const it = (eng.iterations || []).find(i => i.kind === 'blackbox'); if (it) it.status = 'pending-source-guidance'
      fs.writeFileSync(engFile, JSON.stringify(eng, null, 2))
      // Only report 'deferred' once the deferral is actually persisted — otherwise fall through
      // to the normal dispatch below so the pentest still runs (never silently dropped).
      return { taskId, assignee: req.assignee, squad: req.squad, deferred: true }
    } catch { /* fail-soft: deferral not saved — fall through to a normal (un-deferred) dispatch */ }
  }
  writeInbox('inbox/task-actions', req)
  return { taskId, assignee: req.assignee, squad: req.squad }
}

function cancelTask(body) {
  const taskId = String(body.taskId || '').trim()
  if (!taskId) throw new Error('taskId is required')
  writeInbox('cancel-signals', { taskId, reason: body.reason || 'cancelled from console' })
  return { taskId, cancelled: true }
}

// ── findings (read-only) — VALIDATED-FINDINGS + ARBITER judgement, by severity ──
const SEV_ORDER = ['Critical', 'High', 'Medium', 'Low', 'Info']
const _cvssCalc = (() => { try { return require('../ui/cvss') } catch { return null } })()
function titleSev(s) {
  const v = String(s || '').toLowerCase()
  if (v.startsWith('crit')) return 'Critical'
  if (v.startsWith('high')) return 'High'
  if (v.startsWith('med')) return 'Medium'
  if (v.startsWith('low')) return 'Low'
  return 'Info'
}
// THE severity shown = the band the CVSS vector computes to (so the badge can never
// disagree with the score). Falls back to the finding's own severity only when there's
// no vector. One CVSS, one severity — always consistent.
function sevFromVector(vector, fallback) {
  if (_cvssCalc && vector) {
    try { return _cvssCalc.sevFromScore(_cvssCalc.cvss31(_cvssCalc.parseVector(vector)).score) } catch {}
  }
  return titleSev(fallback)
}
// Drop non-findings that should never reach the board: disproven claims, "no X found /
// no attack surface", and explicit n/a markers. A real finding has a vulnerability.
function isRealFinding(f) {
  // Match the TITLE only — a non-finding declares itself there. Matching details too
  // would false-drop real findings whose evidence mentions "not found"/"not vulnerable".
  const t = String(f.title || '').toLowerCase()
  const sev = String(f.severity || '').toLowerCase()
  if (sev === 'n/a' || sev === 'na' || sev === 'none') return false
  // Non-finding phrasings only — anchored so a legit "No CSRF token found" / "No rate limiting"
  // (a MISSING security control IS a real finding) is kept, while "No vulnerabilities found" is dropped.
  if (/\bdisproven\b|\bdisproved\b|\bnot exploitable\b|\bnot vulnerable\b|false[- ]positive|\bno (?:known )?(?:vulnerabilit(?:y|ies)|issues?|findings?|weakness(?:es)?|flaws?|problems?)\b|\bno .{0,20}attack surface\b|\bnothing (?:found|to report)\b/.test(t)) return false
  return true
}
function readJsonl(file) {
  // tolerant: agent findings are echo-written and routinely carry raw newlines /
  // invalid escapes that break strict per-line JSON.parse — recover those records.
  try { return parseFindingsJsonl(fs.readFileSync(file, 'utf8')) }
  catch { return [] }
}
// Build a raw HTTP request from method+url (and any curl headers/cookie/body).
function synthRawRequest(method, url, curl) {
  try {
    const u = new URL(url)
    const m = String(method || 'GET').toUpperCase()
    let req = `${m} ${u.pathname}${u.search || ''} HTTP/1.1\r\nHost: ${u.host}\r\n`
    let body = ''
    if (curl) {
      for (const mm of curl.matchAll(/-H\s+'([^']+)'|-H\s+"([^"]+)"/g)) req += (mm[1] || mm[2]) + '\r\n'
      const cookie = (curl.match(/(?:-b|--cookie)\s+'([^']+)'/) || [])[1]
      if (cookie) req += `Cookie: ${cookie}\r\n`
      const bearer = (curl.match(/[Aa]uthorization:\s*Bearer\s+[^'"\s]+/) || [])[0]
      if (bearer && !/authorization/i.test(req)) req += bearer + '\r\n'
      body = (curl.match(/--data(?:-raw|-binary)?\s+'([^']*)'/) || curl.match(/-d\s+'([^']*)'/) || [])[1] || ''
    }
    if (!/^accept:/im.test(req)) req += 'Accept: */*\r\n'
    req += 'Connection: close\r\n'
    return req + (body ? `\r\n${body}` : '')
  } catch { return '' }
}
const _normUrl = u => String(u || '').toLowerCase().replace(/[?#].*$/, '').replace(/\/+$/, '')
// A live finding is CONFIRMED if the agent marked it confirmed AND it carries
// replayable evidence (reproduction); otherwise it's UNCONFIRMED (still shown).
function _liveStatus(f) {
  const evidenced = !!String(f.reproduction || f.details || '').trim()
  return (String(f.type || '').toLowerCase() === 'confirmed' && evidenced) ? 'CONFIRMED' : 'UNCONFIRMED'
}
function _liveTitle(f) {
  const d = String(f.details || '').trim()
  if (d) return d.split(/[:.\n]/)[0].slice(0, 90)
  return f.cwe || f.owasp || `${(f.agent || 'AGENT')} finding`
}
// findings for a single task (one iteration). Surfaces BOTH AUDITOR-validated
// findings (Confirmed, green) AND the raw agent findings from live-findings — so
// nothing the pentest found is ever invisible just because AUDITOR didn't run.
function findingsForSingleTask(id, label) {
  id = String(id)
  const validated = readJsonl(path.join(INTEL, `VALIDATED-FINDINGS-${id}.jsonl`))
  const judged = readJsonl(path.join(INTEL, `JUDGED-FINDINGS-${id}.jsonl`))
  const live = readJsonl(path.join(INTEL, `live-findings-${id}.jsonl`))
  const judgeBy = {}; for (const j of judged) if (j.id) judgeBy[j.id] = j
  let triage = {}; try { triage = JSON.parse(fs.readFileSync(path.join(INTEL, `triage-${id}.json`), 'utf8')).verdicts || {} } catch {}
  let detail = {}; try { detail = JSON.parse(fs.readFileSync(path.join(INTEL, `findings-detail-${id}.json`), 'utf8')) || {} } catch {}

  const out = []
  const seenUrls = new Set()
  // The board shows ONLY findings that fully passed the pipeline: validated → triaged →
  // WRITTEN UP (findings-detail present). A validated-but-not-yet-written finding is NOT
  // shown — that's what removes the "half-baked findings" confusion and makes each card
  // land with full details. As the WRITER completes findings one-by-one, they appear here.
  // Fallback: if this task has NO findings-detail at all (older run, or writer never ran),
  // show the validated set so the board isn't blank for legacy reports.
  let _hasDetail = detail && Object.keys(detail).length > 0
  // Resilience: if the detail map was keyed under a DIFFERENT id scheme than the current validated
  // set (e.g. the Phase 2v AUDITOR reverse-check re-ids T-* → CR-*), detail[f.id] misses for every
  // finding and the board goes blank mid-run. Detect a total mismatch (no validated id maps to any
  // detail entry) and fall back to showing the validated set instead of an empty board.
  if (_hasDetail && !validated.some(f => detail[f.id])) _hasDetail = false
  // 1) AUDITOR-validated findings (the trusted set) — minus non-findings, and (when enrichment
  //    has run) minus any not yet written up by the WRITER.
  for (const f of validated.filter(f => (!f.taskId || String(f.taskId) === id) && isRealFinding(f) && (!_hasDetail || detail[f.id]))) {
    const d = detail[f.id] || {}
    const poc = d.poc || f.reproduction_method || f.reproduction || ''
    if (f.url) seenUrls.add(_normUrl(f.url))
    const _vec = d.cvss_vector || f.cvss_vector || ''
    // CVSS is the source of truth: score AND severity both come from the vector when present.
    const cvss = _vec && _cvssCalc ? (() => { try { return _cvssCalc.cvss31(_cvssCalc.parseVector(_vec)).score } catch { return null } })()
      : (typeof d.cvss_score === 'number' ? d.cvss_score : (typeof f.cvss_score === 'number' ? f.cvss_score : (f.cvss || null)))
    out.push({
      key: id + '::' + f.id, srcTask: id, iteration: label || '',
      id: f.id, severity: sevFromVector(_vec, f.severity), title: f.title || f.id,
      cvss,
      cvssVector: _vec,
      cwe: d.cwe || f.cwe || '',
      testSteps: Array.isArray(d.test_steps) ? d.test_steps : [],
      // lifecycle: validated by AUDITOR; 'scored' once CVSS has been enriched (Phase 3.1)
      stage: cvss != null ? 'scored' : 'validated',
      agent: f.original_agent || f.agent || '', status: f.validation_status || 'CONFIRMED',
      url: f.url || '', method: f.method || '',
      description: d.description || f.description || f.summary || '',
      poc, validation: d.validation || f.reproduction_result || '',
      impact: d.impact || f.impact || '',
      remediation: d.remediation || f.remediation || f.fix || f.recommendation || '',
      // Static / white-box findings have a source location instead of a live request. Only
      // synthesize an HTTP request when there's actually a live URL — a code finding has none.
      rawRequest: d.raw_request || f.raw_request || f.http_request || (f.url ? synthRawRequest(f.method, f.url, poc) : ''),
      file: d.file || f.file || '', line: d.line || f.line || null,
      codeBlock: d.code_block || d.codeBlock || f.code_block || f.vulnerable_code || '',
      dataFlow: d.data_flow || d.dataFlow || f.data_flow || '', // static taint trace (untrusted input → sink)
      confirmation: f.confirmation || d.confirmation || '',
      // Canonical runtime-vs-source status (was never projected — the derived split never reached
      // the operator). Fall back to deriving it from validation_status + runtime proof. See item #8.
      confirmation_status: f.confirmation_status || deriveConfirmationStatus(f),
      judge: (judgeBy[f.id] && (judgeBy[f.id].verdict || judgeBy[f.id].judgement)) || '',
      enriched: !!detail[f.id], triage: triage[f.id] || null, source: 'validated',
    })
  }
  // 2) Raw agent claims (live-findings) are DELIBERATELY NOT shown on the Findings board.
  // The board shows ONLY clean, triaged findings — deduplicated, merged, fully written
  // (title/CWE/CVSS/PoC/impact/remediation), and properly scored — i.e. the AUDITOR-validated
  // + TRIAGER set above. Raw claims (blank/n-a/duplicate) never appear here; they remain
  // readable as the downloadable `live-findings-<taskId>.jsonl` artifact for transparency.
  // (If a run produces ZERO validated findings, the board is empty until validation/triage runs.)
  void live
  return out
}
// Aggregate findings across ALL iterations of the engagement the task belongs to.
// Standalone (non-engagement) tasks resolve to a single iteration → identical to before.
function findingsForTask(taskId) {
  const id = String(taskId)
  const E = resolveEngagementId(id)
  const eng = E ? readEngagement(E) : null
  const iters = (eng && Array.isArray(eng.iterations) && eng.iterations.length) ? eng.iterations : [{ taskId: id, label: '' }]
  let items = []
  for (const it of iters) items = items.concat(findingsForSingleTask(it.taskId, it.label))
  items.sort((a, b) => SEV_ORDER.indexOf(a.severity) - SEV_ORDER.indexOf(b.severity) || (b.cvss || 0) - (a.cvss || 0))
  const counts = {}; for (const s of SEV_ORDER) counts[s] = items.filter(i => i.severity === s).length
  return {
    taskId: id, engagementId: E || id,
    iterations: iters.map(it => ({ taskId: it.taskId, label: it.label || '', count: items.filter(i => i.srcTask === it.taskId).length })),
    findings: items, counts, total: items.length, triaged: items.filter(i => i.triage).length,
  }
}
// ── Cross-task findings board ────────────────────────────────────────────────
// Aggregates every validated finding across every task the data layer knows about and
// annotates each with the TARGET it came from, so findings can be grouped/sorted by
// target rather than only per-task. Source of truth is the same findingsForSingleTask()
// the per-task board uses, so a finding can never appear here in a different state.
// Scope matcher mirroring agents/scope-validator: "*.x.com" matches any sub of x.com.
function _scopeMatch(host, pattern) {
  const h = String(host || '').toLowerCase(), p = String(pattern || '').toLowerCase()
  if (!h || !p) return false
  if (p === h) return true
  if (p.startsWith('*.')) { const s = p.slice(1); return h.endsWith(s) && h.length > s.length }
  return false
}

function findingsAcrossAllTasks(includeRaw) {
  let taskIds = []
  try {
    // Union of every task that produced EITHER validated findings OR raw agent claims,
    // so scans that never reached validation still appear (behind the raw toggle).
    const files = fs.readdirSync(INTEL)
    const v = files.filter(f => f.startsWith('VALIDATED-FINDINGS-') && f.endsWith('.jsonl'))
      .map(f => f.slice('VALIDATED-FINDINGS-'.length, -'.jsonl'.length))
    const r = files.filter(f => f.startsWith('live-findings-') && f.endsWith('.jsonl'))
      .map(f => f.slice('live-findings-'.length, -'.jsonl'.length))
    taskIds = [...new Set([...v, ...(includeRaw ? r : [])])]
  } catch { return { findings: [], targets: [], counts: {}, total: 0, tasks: 0 } }

  // taskId -> {title, createdAt} from tasks.json (single read, not per-finding)
  const taskMeta = {}
  try {
    for (const t of JSON.parse(fs.readFileSync(path.join(INTEL, 'tasks.json'), 'utf8')) || []) {
      taskMeta[String(t.id)] = { title: t.title || '', createdAt: t.createdAt || '', status: t.status || '' }
    }
  } catch {}

  // taskId -> {targetUrl, inScope[]} resolved via the engagement sidecar
  const engCache = {}
  const engFor = (id) => {
    if (engCache[id] !== undefined) return engCache[id]
    let t = '', scope = []
    try {
      const E = resolveEngagementId(id)
      const eng = E ? readEngagement(E) : null
      if (eng) { t = eng.targetUrl || ''; scope = Array.isArray(eng.inScope) ? eng.inScope : [] }
    } catch {}
    if (!t) { const m = /https?:\/\/[^\s"']+/.exec((taskMeta[id] && taskMeta[id].title) || ''); if (m) t = m[0] }
    return (engCache[id] = { targetUrl: t, inScope: scope })
  }

  const all = []
  for (const id of taskIds) {
    const { targetUrl: tUrl, inScope } = engFor(id)
    const meta = taskMeta[id] || {}
    // Drop a leading "<Program> VDP/BBP —" engagement prefix so the scan label reads cleanly.
    const scanLabel = (meta.title || '').replace(/^[\w .&-]{1,40}?\b(?:VDP|BBP)\s*[—:-]\s*/i, '').slice(0, 60) || id

    const annotate = (f, stage) => {
      const target = hostOf(f.url || tUrl) || hostOf(tUrl) || '(unknown)'
      // which in-scope pattern does this finding's host fall under?
      const scope = inScope.find(pat => _scopeMatch(target, pat)) ||
                    inScope.find(pat => _scopeMatch(hostOf(tUrl), pat)) || '(unscoped)'
      return {
        ...f, taskId: id, taskTitle: meta.title || '', scan: scanLabel,
        taskStatus: meta.status || '', createdAt: meta.createdAt || '',
        targetUrl: tUrl, target, scope, stage,
      }
    }

    let items = []
    try { items = findingsForSingleTask(id, '') } catch { items = [] }
    for (const f of items) all.push(annotate(f, 'validated'))

    // Raw agent claims: never mixed in by default. When requested they are clearly
    // marked stage:'raw' so the operator can tell a triaged finding from a claim.
    if (includeRaw) {
      const seen = new Set(items.map(i => String(i.title || '').toLowerCase()))
      let n = 0
      for (const c of readJsonl(path.join(INTEL, `live-findings-${id}.jsonl`))) {
        const title = String(c.title || c.details || c.summary || '').replace(/\s+/g, ' ').trim()
        if (!title) continue
        if (seen.has(title.toLowerCase())) continue
        const sev = titleSev(c.severity)
        all.push(annotate({
          key: id + '::raw::' + (n++), id: c.id || `raw-${n}`,
          severity: sev, title: title.slice(0, 180), cvss: null, cvssVector: '',
          cwe: c.cwe || '', agent: c.agent || '', status: c.type || 'unvalidated',
          confirmation_status: c.confirmation_status || c.type || '',
          url: c.url || '', method: c.method || '',
          description: c.details || c.description || '', poc: c.reproduction || '',
          impact: '', remediation: '', srcTask: id,
        }, 'raw'))
      }
    }
  }

  all.sort((a, b) =>
    SEV_ORDER.indexOf(a.severity) - SEV_ORDER.indexOf(b.severity) ||
    (b.cvss || 0) - (a.cvss || 0) ||
    String(a.target).localeCompare(String(b.target)))

  const counts = {}; for (const s of SEV_ORDER) counts[s] = all.filter(i => i.severity === s).length
  const facet = (keyFn, label) => {
    const m = {}
    for (const f of all) {
      const k = keyFn(f) || '(unknown)'
      m[k] = m[k] || { [label]: k, total: 0, Critical: 0, High: 0, Medium: 0, Low: 0, Info: 0 }
      m[k].total++; m[k][f.severity] = (m[k][f.severity] || 0) + 1
    }
    return Object.values(m).sort((a, b) => b.total - a.total)
  }
  return {
    findings: all,
    counts,
    total: all.length,
    tasks: taskIds.length,
    validated: all.filter(f => f.stage === 'validated').length,
    raw: all.filter(f => f.stage === 'raw').length,
    targets: facet(f => f.target, 'target'),
    scopes:  facet(f => f.scope, 'scope'),
    scans:   facet(f => f.scan, 'scan'),
    agents: [...new Set(all.map(f => f.agent).filter(Boolean))].sort(),
    severities: SEV_ORDER,
  }
}

// ── Export findings as Markdown (one combined file) or Zip (per-finding .md + combined) ──
function _slug(s) { return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'finding' }
function findingToMarkdown(f) {
  const L = [`# [${f.severity || '?'}] ${f.title || 'Untitled finding'}`, '']
  L.push([f.id && `**ID:** ${f.id}`, f.severity && `**Severity:** ${f.severity}${f.cvss != null ? ` (CVSS ${f.cvss})` : ''}`,
    (f.confirmation_status || f.confirmation) && `**Status:** ${f.confirmation_status || f.confirmation}`,
    f.cwe && `**CWE:** ${f.cwe}`, f.agent && `**Agent:** ${f.agent}`].filter(Boolean).join(' · '))
  if (f.file) L.push('', `**Location:** \`${f.file}${f.line ? ':' + f.line : ''}\``)
  if (f.url) L.push('', `**Endpoint:** \`${(f.method || '').trim()} ${f.url}\``)
  const sec = (t, body, fenced) => { const b = body && String(body).trim(); if (b) L.push('', `## ${t}`, '', fenced ? '```\n' + b + '\n```' : b) }
  sec('Description', f.description); sec('Impact', f.impact); sec('Data flow', f.dataFlow)
  sec('Vulnerable code', f.codeBlock, true); sec('Proof of concept', f.poc || f.rawRequest, !!f.rawRequest); sec('Remediation', f.remediation)
  return L.join('\n') + '\n'
}
function buildFindingsExport(taskId) {
  const r = findingsForTask(taskId), items = r.findings || []
  const sevLine = SEV_ORDER.map(s => (r.counts[s] ? `${s}: ${r.counts[s]}` : null)).filter(Boolean).join(' · ')
  const header = `# Findings — ${taskId}\n\n${r.total} finding(s)${sevLine ? ` (${sevLine})` : ''}\nExported ${new Date().toISOString()}\n`
  const toc = items.map((f, i) => `${i + 1}. [${f.severity}] ${f.title}`).join('\n')
  const combined = [header, '## Contents\n\n' + toc, ...items.map(f => '\n---\n\n' + findingToMarkdown(f))].join('\n')
  const files = items.map((f, i) => ({ name: `findings/${String(i + 1).padStart(2, '0')}-${_slug(f.id)}-${_slug(f.title)}.md`, data: findingToMarkdown(f) }))
  files.unshift({ name: 'ALL-FINDINGS.md', data: combined })
  return { combined, files, count: r.total }
}
// ponytail: minimal store/deflate ZIP writer — avoids an archiver/jszip dep (Node ships zlib.crc32 + deflateRawSync)
function zipBuffer(entries) {
  const zlib = require('zlib'), local = [], central = []; let offset = 0
  for (const e of entries) {
    const name = Buffer.from(e.name, 'utf8'), data = Buffer.isBuffer(e.data) ? e.data : Buffer.from(String(e.data), 'utf8')
    const crc = zlib.crc32(data) >>> 0, comp = zlib.deflateRawSync(data)
    const lh = Buffer.alloc(30)
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(8, 8); lh.writeUInt16LE(0x21, 12)
    lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(comp.length, 18); lh.writeUInt32LE(data.length, 22); lh.writeUInt16LE(name.length, 26)
    local.push(lh, name, comp)
    const ch = Buffer.alloc(46)
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(8, 10); ch.writeUInt16LE(0x21, 14)
    ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(comp.length, 20); ch.writeUInt32LE(data.length, 24); ch.writeUInt16LE(name.length, 28); ch.writeUInt32LE(offset, 42)
    central.push(ch, name)
    offset += lh.length + name.length + comp.length
  }
  const cd = Buffer.concat(central), eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(entries.length, 8); eocd.writeUInt16LE(entries.length, 10)
  eocd.writeUInt32LE(cd.length, 12); eocd.writeUInt32LE(offset, 16) // CD size @12, CD offset @16 (not 14)
  return Buffer.concat([...local, cd, eocd])
}
function iterationsForTask(taskId) {
  const E = resolveEngagementId(taskId)
  const eng = E ? readEngagement(E) : null
  return { engagementId: E || String(taskId), iterations: (eng && eng.iterations) || [] }
}
// Testing-logs feed for a task: full activity entries (commands + recon output) scoped
// to the engagement's iterations + the raw per-task artifact files for download.
function logsForTask(taskId) {
  const id = String(taskId)
  const E = resolveEngagementId(id)
  const eng = E ? readEngagement(E) : null
  const ids = new Set([id, E].filter(Boolean))
  for (const it of (eng && eng.iterations) || []) if (it.taskId) ids.add(it.taskId)
  // last ~3000 activity lines, kept if the entry belongs to one of our taskIds
  const all = readLines('ACTIVITY-LOG.jsonl', 3000)
  const activity = all.filter(a => a && ids.has(String(a.taskId))).slice(-500)
  // raw artifacts: top-level INTEL files whose name carries any of our taskIds
  const artifacts = []
  try {
    for (const f of fs.readdirSync(INTEL)) {
      if (![...ids].some(t => f.includes(t))) continue
      const full = path.join(INTEL, f)
      let st; try { st = fs.statSync(full) } catch { continue }
      if (!st.isFile()) continue
      artifacts.push({ name: f, rel: f, size: st.size, mtime: st.mtimeMs })
    }
  } catch {}
  artifacts.sort((a, b) => a.name.localeCompare(b.name))
  return { taskId: id, engagementId: E || id, activity, artifacts, recon: reconSummary([...ids], activity) }
}
// Attack-surface snapshot for the top of the Testing-logs tab: open ports (parsed
// from the recon activity line) + the env fingerprint + endpoint counts. Fail-soft.
function reconSummary(ids, activity) {
  const out = { ports: [], product: '', server: '', waf: '', frameworks: [], notablePaths: [], cveCandidates: [], endpoints: null }
  // open ports — AUTHORITATIVE from the Phase 0.4 nmap heart-truth artifact when present
  for (const tid of ids) {
    const nm = readJSON(`nmap-${tid}.json`, null)
    if (nm && nm.ok && Array.isArray(nm.ports) && nm.ports.length) {
      out.ports = nm.ports.map(p => `${p.port}/${p.service || p.proto}`)
      break
    }
  }
  // fallback: parse "N/PROTO" tokens from the recon activity entry if no nmap artifact yet
  if (!out.ports.length) try {
    const portRe = /\b(\d{1,5}\/[A-Za-z]{2,8})\b/g
    for (const a of activity) {
      const txt = `${a.action || ''} ${a.details || ''}`
      if (!/open port|recon complete|nmap/i.test(txt)) continue
      const m = txt.match(portRe)
      if (m) { for (const p of m) if (!out.ports.includes(p)) out.ports.push(p) }
    }
  } catch {}
  // env fingerprint (structured) — first iteration that has one
  for (const tid of ids) {
    const ef = readJSON(`env-fingerprint-${tid}.json`, null)
    if (!ef) continue
    out.product = ef.product || ''
    out.server = ef.server || ''
    out.waf = (ef.waf && ef.waf.present) ? (ef.waf.vendor || 'detected') : ''
    out.frameworks = Array.isArray(ef.frameworks) ? ef.frameworks : []
    out.notablePaths = Array.isArray(ef.notable_paths) ? ef.notable_paths.slice(0, 12) : []
    out.cveCandidates = Array.isArray(ef.cve_candidates) ? ef.cve_candidates.slice(0, 8) : []
    break
  }
  for (const tid of ids) {
    const ep = readJSON(`pentest-endpoints-${tid}.json`, null)
    if (!ep) continue
    out.endpoints = { total: ep.totalUrls || 0, apis: (ep.apiEndpoints || []).length, forms: (ep.forms || []).length, js: (ep.jsFiles || []).length }
    break
  }
  return out
}
function enrichFindings(body) {
  const taskId = String(body.taskId || '').trim()
  if (!taskId) throw new Error('taskId is required')
  writeInbox('inbox/task-actions', { action: 'enrich-findings', taskId })
  return { taskId, queued: true }
}
function _cleanVerdict(v) {
  if (!v || typeof v !== 'object') return null
  const verdict = ['confirmed', 'rejected'].includes(v.verdict) ? v.verdict : 'confirmed'
  return {
    verdict,
    ...(v.severity ? { severity: titleSev(v.severity) } : {}),
    ...(Number.isFinite(+v.cvss) && v.cvss !== '' && v.cvss != null ? { cvss: Math.max(0, Math.min(10, Math.round(+v.cvss * 10) / 10)) } : {}),
    ...(v.cvssVector && /^CVSS:3\.\d\//.test(String(v.cvssVector)) ? { cvssVector: String(v.cvssVector) } : {}),
    ...(v.notes ? { notes: String(v.notes).slice(0, 4000) } : {}),
  }
}
// Write verdicts for one task, MERGING with any existing (so a partial save never
// drops verdicts for findings not in this batch). Returns count written.
function _writeTriage(id, verdicts) {
  const clean = {}
  for (const [fid, v] of Object.entries(verdicts || {})) { const c = _cleanVerdict(v); if (c) clean[fid] = c }
  let existing = {}; try { existing = JSON.parse(fs.readFileSync(path.join(INTEL, `triage-${id}.json`), 'utf8')).verdicts || {} } catch {}
  const merged = { ...existing, ...clean }
  const tmp = path.join(INTEL, `triage-${id}.json.tmp`)
  fs.writeFileSync(tmp, JSON.stringify({ verdicts: merged, updatedAt: new Date().toISOString() }, null, 2))
  fs.renameSync(tmp, path.join(INTEL, `triage-${id}.json`))
  return Object.keys(clean).length
}
// Engagement-aware: body.byTask = { "<taskId>": { "<findingId>": verdictObj } } routes
// verdicts to each iteration's own triage file. Legacy: { taskId, verdicts }.
function saveTriage(body) {
  if (body.byTask && typeof body.byTask === 'object') {
    let total = 0
    for (const [tid, verdicts] of Object.entries(body.byTask)) { if (String(tid)) total += _writeTriage(String(tid), verdicts) }
    return { triaged: total, byTask: true }
  }
  const taskId = String(body.taskId || '').trim()
  if (!taskId) throw new Error('taskId is required')
  return { taskId, triaged: _writeTriage(taskId, (body.verdicts && typeof body.verdicts === 'object') ? body.verdicts : {}) }
}
function generateReport(body) {
  const taskId = String(body.taskId || '').trim()
  if (!taskId) throw new Error('taskId is required')
  writeInbox('inbox/task-actions', { action: 'generate-report', taskId })
  return { taskId, queued: true }
}
function amendRun(body) {
  const taskId = String(body.taskId || '').trim()
  if (!taskId) throw new Error('taskId is required')
  const instructions = String(body.instructions || '').trim()
  const addScope = Array.isArray(body.addScope) ? body.addScope.map(s => hostOf(s)).filter(Boolean) : []
  if (!instructions && !addScope.length) throw new Error('nothing to amend (add instructions or scope)')
  writeInbox('inbox/task-actions', { action: 'amend', taskId, instructions, addScope })
  return { taskId, amended: true }
}

// ── tiny static + body helpers ──
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml' }
function serveStatic(res, file) {
  try {
    const body = fs.readFileSync(file)
    // no-cache: the SPA assets (app.js/app.css/index.html) are tiny and change often during
    // development — without this the browser heuristically caches them and UI fixes never
    // load (you'd have to hard-reload). Always revalidate so the latest UI is served.
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-cache, no-store, must-revalidate' })
    res.end(body)
  } catch { res.writeHead(404); res.end('not found') }
}
function readBody(req) {
  return new Promise((resolve) => {
    let d = ''
    req.on('data', c => { d += c; if (d.length > 1e6) req.destroy() })
    req.on('end', () => { try { resolve(JSON.parse(d || '{}')) } catch { resolve({}) } })
  })
}
// ── M7 Mission Control + M12 persona/pattern studio (additive; observe-only reads + custom-config writes) ──
const _tbBridge = require('../src/compatibility/task-board-bridge')
const _taskBoard = require('../src/runtime/task-board')
const _decisionLog = require('../src/runtime/decision-log')
const _sessionPlanner = require('../src/runtime/session-planner')
const _runtimeGeneration = require('../src/runtime/runtime-generation')
const _runtimeController = require('../src/runtime/runtime-controller')
const _agentRegistry = require('../src/agents/registry')
const _personaRegistry = require('../src/personas/registry')
const _patternRegistry = require('../src/patterns/registry')

function _atomicWrite(file, str) {
  try { fs.mkdirSync(path.dirname(file), { recursive: true }); const t = file + '.tmp.' + process.pid; fs.writeFileSync(t, str); fs.renameSync(t, file); return true } catch { return false }
}

// M7: aggregate the observe-only artifacts into one "mission" view. Deriving the board writes the observe-only
// task-board-<taskId>.jsonl (the spec's shared truth) from the current ledger — engine untouched. Fail-soft.
function missionForTask(taskId) {
  if (!taskId) return null
  let coverage = {}, board = { tasks: [], counts: {} }, decisions = [], sessionPlan = null
  // Finding 7 fix: NEVER destructively rebuild. If a live board exists (dispatch-bridge appended it during a
  // run), READ it. Only when there's no live board (older/completed run) do we project from the ledger — and
  // even then only in-memory (boardRows), no write from the read path.
  try {
    if (fs.existsSync(_taskBoard.boardPath(taskId))) board = _taskBoard.load(taskId)
    else { const rows = _tbBridge.boardRows(taskId); board = { tasks: rows, counts: _taskBoard.recount(rows) } }
  } catch {}
  try { coverage = _tbBridge.deriveCoverage(taskId) } catch {}
  try { decisions = _decisionLog.load(taskId).slice(-15) } catch {}
  // session plan: read the real artifact if a run wrote one, else derive an observe-only estimate from coverage
  try { sessionPlan = JSON.parse(fs.readFileSync(path.join(INTEL, `session-plan-${taskId}.json`), 'utf-8')) } catch {}
  if (!sessionPlan) { const n = (coverage.features && coverage.features.discovered) || 0; if (n) try { sessionPlan = _sessionPlanner.planSessions({ features: Array.from({ length: n }, (_, i) => ({ slug: 'f' + i })) }) } catch {} }
  // team activity: which roles are working (from claimed board tasks)
  const activeAgents = [...new Set((board.tasks || []).filter(t => _taskBoard.ACTIVE.has(t.status) && t.claimed_by).map(t => t.claimed_by))]
  const team = activeAgents.map(a => ({ agent: a, role: _agentRegistry.roleOf(a) }))
  let adaptive = null
  try { adaptive = _runtimeController.inspect(taskId) } catch {}
  return {
    taskId, coverage, board: { counts: board.counts, tasks: (board.tasks || []).slice(0, 300) },
    decisions, sessionPlan, team,
    runtime: adaptive ? {
      generation: adaptive.generation,
      journal: adaptive.journal,
      plan: adaptive.plan,
      board: adaptive.board,
      sessions: adaptive.sessions,
      decisions: adaptive.decisions,
    } : null,
  }
}

// M12: custom persona/pattern homes (committable repo folders)
const _PERSONA_CUSTOM = path.join(AGENTS, 'src', 'personas', 'custom', 'user-created')
const _PATTERN_CUSTOM = path.join(AGENTS, 'src', 'patterns', 'custom', 'user-created')
// §12: strict slug for any user id used in a filename — strips path separators + dots, so `../` can never survive.
const _safeSlug = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80)
// Resolve `<name>.json` under baseDir and confirm it stays INSIDE baseDir (defense-in-depth vs traversal).
function _safeChildPath(baseDir, name) {
  const base = path.resolve(baseDir)
  const p = path.resolve(base, `${name}.json`)
  return (p === base || p.startsWith(base + path.sep)) ? p : null
}
function listPersonas() { try { return { builtin: _personaRegistry.builtin(), custom: _personaRegistry.custom() } } catch { return { builtin: [], custom: [] } } }
function upsertPersona(body) {
  const b = body || {}; const id = _safeSlug(b.id)
  if (!id || !b.name) return { error: 'id and name are required' }
  if (_personaRegistry.isBuiltin(id)) return { error: `'${id}' is a built-in persona (read-only) — choose a different id` }
  const dest = _safeChildPath(_PERSONA_CUSTOM, id); if (!dest) return { error: 'invalid id' }
  const rec = { ...b, id, builtin: false }
  if (!_atomicWrite(dest, JSON.stringify(rec, null, 2))) return { error: 'write failed' }
  return { ok: true, persona: rec }
}
function deletePersona(id) {
  id = _safeSlug(id)                                          // §12: same strict slug on delete as on create
  if (!id) return { error: 'invalid id' }
  if (_personaRegistry.isBuiltin(id)) return { error: 'built-in personas cannot be deleted' }
  const dest = _safeChildPath(_PERSONA_CUSTOM, id); if (!dest) return { error: 'invalid id' }
  try { fs.unlinkSync(dest); return { ok: true } } catch { return { error: 'not found' } }
}
function listPatterns() { try { const classes = _patternRegistry.classes(); return { classes, custom: fs.existsSync(_PATTERN_CUSTOM) ? fs.readdirSync(_PATTERN_CUSTOM).filter(f => f.endsWith('.json')) : [] } } catch { return { classes: [], custom: [] } } }
function upsertPattern(body) {
  const b = body || {}; const cls = _safeSlug(b.class || b.category)
  if (!cls || !Array.isArray(b.patterns) || !b.patterns.length) return { error: 'class and a non-empty patterns[] are required' }
  for (const p of b.patterns) if (!p.id || !p.name) return { error: 'each pattern needs id and name' }
  const name = _safeSlug(b.name || cls)
  const dest = _safeChildPath(_PATTERN_CUSTOM, `${cls}-${name}`); if (!dest) return { error: 'invalid class/name' }
  const rec = { class: cls, mode: b.mode === 'override' ? 'override' : 'append', author: b.author || 'ui', patterns: b.patterns.map(p => ({ category: cls, ...p })) }
  if (!_atomicWrite(dest, JSON.stringify(rec, null, 2))) return { error: 'write failed' }
  return { ok: true, file: `${cls}-${name}.json` }
}

function json(res, code, obj) { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)) }

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost')
  const p = url.pathname
  // Baseline hardening headers — cheap + harmless on localhost, real value if exposed.
  res.setHeader('X-Frame-Options', 'DENY')
  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.setHeader('Referrer-Policy', 'no-referrer')
  // Optional API bearer-token gate — OFF by default (local single-operator). Set
  // ARCHON_PORTAL_TOKEN to require `Authorization: Bearer <token>` on /api/* so the
  // portal is safe behind a tunnel/reverse-proxy without code changes. Static SPA
  // assets stay open so the page still loads; the proxy/client supplies the header.
  const _portalToken = process.env.ARCHON_PORTAL_TOKEN
  if (_portalToken && p.startsWith('/api/')) {
    if ((req.headers['authorization'] || '') !== `Bearer ${_portalToken}`) return json(res, 401, { error: 'unauthorized' })
  }
  try {
    if (req.method === 'GET' && p === '/api/state') return json(res, 200, state())
    if (req.method === 'GET' && p === '/api/check-source') return json(res, 200, checkSourceDir(url.searchParams.get('dir')))
    if (req.method === 'GET' && p === '/api/squads') return json(res, 200, { squads: squads() })
    if (req.method === 'GET' && p === '/api/report') {
      // Canonicalize then enforce the INTEL_ROOT boundary — path.resolve collapses
      // any ../ and the path.sep suffix prevents a sibling-dir prefix bypass
      // (e.g. /var/intel-evil). Robust where a regex strip + bare startsWith is not.
      const rel = url.searchParams.get('f') || ''
      const full = path.resolve(INTEL, rel)
      if (full !== INTEL && !full.startsWith(INTEL + path.sep)) return json(res, 403, { error: 'forbidden' })
      try { res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' }); res.end(fs.readFileSync(full, 'utf-8')) }
      catch { json(res, 404, { error: 'report not found' }) }
      return
    }
    if (req.method === 'POST' && p === '/api/dispatch') {
      try { return json(res, 200, createDispatch(await readBody(req))) }
      catch (e) { return json(res, 400, { error: e.message }) }
    }
    if (req.method === 'POST' && p === '/api/cancel') {
      try { return json(res, 200, cancelTask(await readBody(req))) }
      catch (e) { return json(res, 400, { error: e.message }) }
    }
    if (req.method === 'GET' && p === '/api/findings/export') {
      const taskId = url.searchParams.get('taskId') || ''
      const fmt = (url.searchParams.get('fmt') || 'zip').toLowerCase()
      if (!taskId) { res.writeHead(400); return res.end('taskId required') }
      const ex = buildFindingsExport(taskId)
      if (!ex.count) { res.writeHead(404); return res.end('no findings to export') }
      if (fmt === 'md') {
        res.writeHead(200, { 'content-type': 'text/markdown; charset=utf-8', 'content-disposition': `attachment; filename="findings-${taskId}.md"`, 'cache-control': 'no-store' })
        return res.end(ex.combined)
      }
      const zip = zipBuffer(ex.files)
      res.writeHead(200, { 'content-type': 'application/zip', 'content-disposition': `attachment; filename="findings-${taskId}.zip"`, 'cache-control': 'no-store' })
      return res.end(zip)
    }
    if (req.method === 'GET' && p === '/api/findings') {
      return json(res, 200, findingsForTask(url.searchParams.get('taskId') || ''))
    }
    // Cross-engagement findings board: every finding from every task, annotated with the
    // target it came from, so an operator can review/sort the whole estate in one place.
    if (req.method === 'GET' && p === '/api/findings/all') {
      return json(res, 200, findingsAcrossAllTasks(url.searchParams.get('raw') === '1'))
    }
    if (req.method === 'GET' && p === '/api/iterations') {
      return json(res, 200, iterationsForTask(url.searchParams.get('taskId') || ''))
    }
    if (req.method === 'GET' && p === '/api/source-runtime') {
      return json(res, 200, sourceRuntimeForTask(url.searchParams.get('taskId') || '') || { plan: null, counts: {}, sessions: [], recent: [] })
    }
    if (req.method === 'GET' && p === '/api/logs') {
      return json(res, 200, logsForTask(url.searchParams.get('taskId') || ''))
    }
    // M7: Mission Control (task board + coverage + session plan + team + decisions), observe-only
    if (req.method === 'GET' && p === '/api/mission') {
      return json(res, 200, missionForTask(url.searchParams.get('taskId') || '') || { taskId: null, board: { tasks: [], counts: {} }, coverage: {}, team: [], decisions: [] })
    }
    // M12: persona studio
    if (req.method === 'GET' && p === '/api/personas') { return json(res, 200, listPersonas()) }
    if (req.method === 'POST' && p === '/api/personas') {
      try { const r = upsertPersona(await readBody(req)); return json(res, r.error ? 400 : 200, r) } catch (e) { return json(res, 400, { error: e.message }) }
    }
    if (req.method === 'DELETE' && p === '/api/personas') { return json(res, 200, deletePersona(url.searchParams.get('id') || '')) }
    // M12: pattern studio
    if (req.method === 'GET' && p === '/api/patterns') { return json(res, 200, listPatterns()) }
    if (req.method === 'POST' && p === '/api/patterns') {
      try { const r = upsertPattern(await readBody(req)); return json(res, r.error ? 400 : 200, r) } catch (e) { return json(res, 400, { error: e.message }) }
    }
    if (req.method === 'GET' && p === '/api/health') {
      return json(res, 200, readJSON('health.json', { ok: null, checks: [], note: 'supervisor has not run yet' }))
    }
    if (req.method === 'POST' && p === '/api/iterate') {
      try { return json(res, 200, iterateDispatch(await readBody(req))) } catch (e) { return json(res, 400, { error: e.message }) }
    }
    if (req.method === 'POST' && p === '/api/triage') {
      try { return json(res, 200, saveTriage(await readBody(req))) } catch (e) { return json(res, 400, { error: e.message }) }
    }
    if (req.method === 'POST' && p === '/api/generate-report') {
      try { return json(res, 200, generateReport(await readBody(req))) } catch (e) { return json(res, 400, { error: e.message }) }
    }
    if (req.method === 'POST' && p === '/api/enrich-findings') {
      try { return json(res, 200, enrichFindings(await readBody(req))) } catch (e) { return json(res, 400, { error: e.message }) }
    }
    if (req.method === 'POST' && p === '/api/amend') {
      try { return json(res, 200, amendRun(await readBody(req))) } catch (e) { return json(res, 400, { error: e.message }) }
    }
    // static
    if (p === '/' || p === '') return serveStatic(res, path.join(UI_DIR, 'index.html'))
    const safe = path.normalize(p).replace(/^(\.\.[/\\])+/, '')
    const file = path.join(UI_DIR, safe)
    if (!file.startsWith(UI_DIR)) { res.writeHead(403); return res.end('forbidden') }
    return serveStatic(res, file)
  } catch (e) {
    json(res, 500, { error: String(e && e.message || e) })
  }
})

// Only start the server when run directly (`node scripts/dashboard.js`).
// When required (unit tests), export the pure helpers without binding a port.
if (require.main === module) {
  server.listen(PORT, '127.0.0.1', () => {
    console.log(`\n  ▲ ARCHON — Offensive Operations Console`)
    console.log(`  ➜  http://localhost:${PORT}`)
    console.log(`  data: ${INTEL}`)
    console.log(`  (read-only over core state; dispatch/cancel via daemon inbox)\n  Ctrl-C to stop.\n`)
  })
}

module.exports = {
  hostOf, titleSev, synthRawRequest, readJsonl,
  findingsForTask, findingsForSingleTask, saveTriage, generateReport, amendRun, enrichFindings,
  cancelTask, buildPentestMeta, buildCodeReviewMeta, writeInbox, createDispatch,
  iterateDispatch, iterationsForTask, readEngagement, resolveEngagementId, deriveIterationLabel, cleanFocus,
  INTEL, SEV_ORDER,
}
