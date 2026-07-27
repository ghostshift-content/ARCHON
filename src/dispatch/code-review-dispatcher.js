
const __roots = require('../../paths') // portable roots (KURU_*_ROOT) — see paths.js
// ════════════════════════════════════════════════════════════════════════════
// Code-review squad dispatcher — phase1-maps white-box methodology
// ════════════════════════════════════════════════════════════════════════════
// Replaces the old 6-framework→chain flow with a two-phase, feature-by-feature,
// STACK-AGNOSTIC process that reviews any project the same way (Rails, Django,
// Express/Nest, Spring, Laravel, Go, .NET, …) — no per-app or per-framework preset:
//
//   Phase 0   sourceDir validation
//   Phase 0b  App Blueprint — CURATOR reads inventories + tree + bootstrap/auth/
//             config files → a 1-page architecture/auth/data-flow/shared-infra doc
//             that grounds discovery + every feature mapper (catches cross-feature
//             vulns the feature-by-feature pass would miss in isolation)
//   Phase 0a  Inventories — scripted enumeration (routes/endpoints, auth checks, DB
//             queries, render/output, uploads/downloads, tokens/actors, background
//             jobs, business-logic/service objects) via multi-language grep specs
//   Phase 0b  Feature discovery — CURATOR auto-discovers from the surface (or meta.features)
//   Phase 1   Feature mapping — ONE agent per feature, in RAM-safe waves; each
//             builds features/<slug>.md (Endpoint/Action Ledger + auth/actor/data/
//             worker/same-functionality maps + ranked Phase-2 leads + depth status)
//   Phase 1c  Consolidation — CURATOR aggregates coverage matrices + review queue + gate
//   Phase 2   Vuln assessment — per feature × per class, routed to the class specialist
//             with that class's module + pattern catalog (access-control/IDOR, XSS, …)
//   Phase 2v  AUDITOR reverse-check verdicts (+ PROBER runtime validation if deployUrl)
//   Phase 3   SCRIBE merges per-feature reports into the final report (CVSS)
//
// Agents (current env, working together): CURATOR (discovery+consolidation),
// the 6 specialists (per-feature mappers → per-class assessors), AUDITOR (verify),
// PROBER (runtime), SCRIBE (report).
//
// dispatch.meta:
//   sourceDir   (required, absolute) — the source tree to review
//   features    string[] (optional)   — explicit feature-slug queue (overrides discovery)
//   vulnClasses string[] (optional)   — default ['access-control','xss']; ['all'] = every catalog
//   deployUrl   (optional)            — enables PROBER runtime validation
//   testAccounts(optional)            — { attacker, victim } creds for runtime probing
//   outputDir   (optional)            — default <INTEL>/code-review/<taskId>
//   maxFeatures (optional)            — cap mapped features (default: NO cap — every feature the source has)
//   maxPhase2   (optional)            — cap features deep-assessed in Phase 2 (default: ALL mapped features)
//   phasesOnly  (optional)            — subset of PHASES to run (reuse prior artifacts)

const fs = require('fs')
const path = require('path')
const { execSync } = require('child_process')
const sourcePlanner = require('./source-planner') // M3: rank the Phase-2 queue + re-plan from findings
const sourceRuntimePlanner = require('./source-runtime-planner') // M3: session/shard plan (source-runtime-plan.json)
const candidateIndex = require('../pipeline/candidate-index') // M5: deduped candidate index + validation queue
const decisionLog = require('../pipeline/decision-log') // M6: agentic decision log
const featureBatching = require('./feature-batching') // S1: domain grouping + batch fanout
const mappingLedger = require('./mapping-ledger')     // S2: the mapping ledger (source of truth)
let _dispatchBridge; try { _dispatchBridge = require('../compatibility/dispatch-bridge') } catch { _dispatchBridge = null } // M8-M10/M13: live task-board/decision-log emission (fail-soft, flag-gated ARCHON_TASK_BOARD)

const METH = path.join(__roots.AGENTS_ROOT, 'squads/code-review/methodology')

// Read the live-findings JSONL (candidates streamed by emitCandidate) — the re-plan reads it to
// task itself from its own evidence. Fail-soft: missing/partial file → [].
function readLiveFindings(taskId) {
  try {
    const raw = fs.readFileSync(`${__roots.INTEL_ROOT}/live-findings-${taskId}.jsonl`, 'utf8')
    const out = []
    for (const l of raw.split('\n')) { const s = l.trim(); if (!s) continue; try { out.push(JSON.parse(s)) } catch {} }
    return out
  } catch { return [] }
}

const _KNOWN_AUDIT_STATUS = new Set(['SOURCE_CONFIRMED', 'NEEDS_LIVE_VALIDATION', 'RUNTIME_CONFIRMED', 'DISPROVEN'])
// §5/§1: the COMPLETE judge-verdict contract (agents/judge-verifier.js). A judged row MUST carry one of these — a
// copied validation_status ('CONFIRMED'/'NEEDS-LIVE') is NOT a judge verdict. Two families:
//  - INDEPENDENTLY JUDGED: confirmed / downgraded / indeterminate (the judge actually evaluated the finding)
//  - INTENTIONAL PASS-THROUGH: not-judged / not-judged-cap-exceeded (below severity filter or past the promotion
//    cap in promotionMode — a VALID, deliberate outcome, NOT malformed; it must NOT block the report).
const _JUDGE_PASSTHROUGH = new Set(['not-judged', 'not-judged-cap-exceeded'])
const _JUDGE_VERDICTS = new Set(['confirmed', 'downgraded', 'indeterminate', 'not-judged', 'not-judged-cap-exceeded'])
// A judged row is schema-valid iff it carries identity + a genuine judge_verdict (full enum incl. pass-through) +
// a severity. Pure so the Judge coverage contract is unit-testable. Returns { ok, id, passthrough }.
function _validateJudgedRow(r) {
  const id = r && (r.candidate_id || r.id) ? String(r.candidate_id || r.id).trim().toLowerCase() : null
  // MUST be the explicit judge_verdict field — a generic `verdict` (or validation_status) does NOT count as a
  // genuine Judge output, so a non-Judge record cannot satisfy the gate by carrying verdict:"confirmed".
  const verdict = r ? String(r.judge_verdict || '').toLowerCase() : ''
  const hasVerdict = _JUDGE_VERDICTS.has(verdict)
  const hasSeverity = !!(r && (r.severity || typeof r.cvss_score === 'number'))
  return { ok: !!(id && hasVerdict && hasSeverity), id, passthrough: _JUDGE_PASSTHROUGH.has(verdict) }
}

// §2/§3/§4/§5: THE single authoritative board writer, run once after the AUDITOR. It REBUILDS VALIDATED-FINDINGS
// from ALL original candidates (not just the triage subset) so a candidate triage omitted is never permanently
// absent, and it is the ONLY writer after the auditor (cr-normalize / generic-triager / normalize are skipped in
// holistic mode). Rules:
//  - identity (feature/class/file/line/source/sink/candidate_id) ALWAYS from the immutable candidate, never the model
//  - the AUDITOR verdict (joined by candidate_id) decides confirmation_status — authoritative over the triage guess
//  - NO verdict for a candidate → AUDIT_QUARANTINED (fail-CLOSED, kept out of the report), never fail-open (§4)
//  - unknown/malformed status → AUDIT_QUARANTINED, never promoted to SOURCE_CONFIRMED (§5)
//  - DISPROVEN → terminal, excluded from the report set
// Emits candidate-ledger-<taskId>.jsonl (every candidate → a terminal state) so 12 candidates = 12 terminal verdicts
// is provable. Atomic (temp+rename). allCandidates = the deduped-by-candidate_id list the auditor reviewed.
function reconcileBoardFromVerdicts(taskId, verdictsFile, allCandidates, log = () => {}, deployUrl = '') {
  const _nk = (s) => String(s || '').trim().toLowerCase()
  const _cid = (x) => _nk(x.candidate_id || x.duplicate_key || x.id)
  const candidateIds = new Set((allCandidates || []).map(_cid))
  // §4: parse verdicts, REJECTING duplicates (same candidate_id twice → can't trust which), foreign ids (not in the
  // candidate set), and malformed records — each logged + quarantined, never silently overwriting or ignored.
  const verdicts = {}, _dupIds = new Set(), _foreign = [], _malformed = []
  try {
    for (const l of fs.readFileSync(verdictsFile, 'utf8').split('\n')) {
      const s = l.trim(); if (!s) continue
      let r; try { r = JSON.parse(s) } catch { try { r = JSON.parse(s.replace(/\\(?!["\\/bfnrtu])/g, '\\\\')) } catch { r = null } }
      if (!r || !r.candidate_id || !r.status) { _malformed.push(s.slice(0, 120)); continue }
      const k = _nk(r.candidate_id)
      if (!candidateIds.has(k)) { _foreign.push(r.candidate_id); continue }              // foreign id → drop + log
      if (verdicts[k]) { _dupIds.add(k); continue }                                       // duplicate → mark ambiguous
      verdicts[k] = r
    }
  } catch { log(`⚠️ reconcile: could not read AUDITOR-VERDICTS.jsonl — every candidate will be AUDIT_QUARANTINED (fail-closed)`) }
  for (const k of _dupIds) delete verdicts[k]                                             // an ambiguous id gets NO verdict → quarantined below
  if (_dupIds.size || _foreign.length || _malformed.length) log(`⚠️ reconcile: rejected ${_dupIds.size} duplicate, ${_foreign.length} foreign, ${_malformed.length} malformed auditor verdict(s) — quarantined/ignored, not applied`)
  // triage writeups (severity/code_block/description/…) from the current streamed VALIDATED file, by candidate_id.
  const VF = `${__roots.INTEL_ROOT}/VALIDATED-FINDINGS-${taskId}.jsonl`
  const triageByCid = {}
  try { for (const l of fs.readFileSync(VF, 'utf8').split('\n')) { const s = l.trim(); if (!s) continue; let r; try { r = JSON.parse(s) } catch { r = null } if (r) triageByCid[_cid(r)] = r } } catch {}

  const board = []           // authoritative report set (CONFIRMED / NEEDS_LIVE / RUNTIME only)
  const ledger = []          // every candidate → terminal state (accounting: N candidates = N verdicts)
  const st = { confirmed: 0, needs_live: 0, runtime: 0, disproven: 0, quarantined_no_verdict: 0, quarantined_unknown: 0, quarantined_ambiguous: 0, runtime_demoted: 0 }
  const _isWhiteBox = !!deployUrl
  for (const c of (allCandidates || [])) {
    const cid = _cid(c)
    const v = verdicts[cid]
    const tr = triageByCid[cid]
    let terminal, confirmation = null, reason = ''
    if (!v) {
      terminal = 'AUDIT_QUARANTINED'
      if (_dupIds.has(cid)) { reason = 'duplicate auditor verdicts (ambiguous)'; st.quarantined_ambiguous++ }
      else { reason = 'no auditor verdict'; st.quarantined_no_verdict++ }
    } else {
      let status = String(v.status || '').toUpperCase()
      // §2: RUNTIME confirmation is CODE-enforced, not prompt-enforced. The source auditor has no captured runtime
      // proof, so a RUNTIME_CONFIRMED verdict is never trustworthy here:
      //   static (no live target)  → the label is impossible → AUDIT_QUARANTINED (fail-closed, protocol violation)
      //   white-box (live target)  → demote to NEEDS_LIVE_VALIDATION; the DEFERRED pentest confirms it with real proof
      if (status === 'RUNTIME_CONFIRMED') {
        if (!_isWhiteBox) { terminal = 'AUDIT_QUARANTINED'; reason = 'RUNTIME_CONFIRMED without a live target (static review) — protocol violation'; st.quarantined_unknown++; ledger.push(_ledgerRow(c, tr, terminal, null, reason, v)); continue }
        status = 'NEEDS_LIVE_VALIDATION'; reason = 'auditor RUNTIME_CONFIRMED demoted → NEEDS_LIVE (no captured runtime proof at source review; deferred pentest confirms)'; st.runtime_demoted++
      }
      if (!_KNOWN_AUDIT_STATUS.has(status)) { terminal = 'AUDIT_QUARANTINED'; reason = `unknown auditor status "${v.status}"`; st.quarantined_unknown++ }
      else if (status === 'DISPROVEN') { terminal = 'DISPROVEN'; st.disproven++ }
      else { terminal = status; confirmation = status; if (status === 'NEEDS_LIVE_VALIDATION') st.needs_live++; else st.confirmed++ }
    }
    ledger.push(_ledgerRow(c, tr, terminal, confirmation, reason, v))
    if (confirmation) board.push(_buildBoardRecord(c, tr, confirmation, v, taskId))
  }
  const _write = (file, rows) => { const tmp = `${file}.tmp`; fs.writeFileSync(tmp, rows.map(r => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : '')); fs.renameSync(tmp, file) }
  _write(VF, board)
  _write(`${__roots.INTEL_ROOT}/candidate-ledger-${taskId}.jsonl`, ledger)
  // Sentinel: this board is authoritative — downstream writers (cr-normalize / generic-triager) must NOT overwrite it.
  try { fs.writeFileSync(`${__roots.INTEL_ROOT}/VALIDATED-AUTHORITATIVE-${taskId}.flag`, new Date().toISOString()) } catch {}
  const quarantined = st.quarantined_no_verdict + st.quarantined_unknown + st.quarantined_ambiguous
  log(`🔁 Board rebuilt from ${allCandidates.length} candidate(s) by candidate_id → ${board.length} on the report board (${st.confirmed} source-confirmed, ${st.needs_live} needs-live${st.runtime_demoted ? ` incl. ${st.runtime_demoted} demoted-from-runtime` : ''}, ${st.disproven} disproven, ${quarantined} quarantined) — authoritative, atomic. Ledger: candidate-ledger-${taskId}.jsonl`)
  return { board: board.length, ledger: ledger.length, quarantined, ...st }
}

// One candidate-ledger row (the accounting record — every candidate reaches one terminal state).
function _ledgerRow(c, tr, terminal, confirmation, reason, v) {
  return { candidate_id: c.candidate_id || '', feature: c.feature || '', vulnerability_class: c.vulnerability_class || c.cwe || '', file: c.file || '', triaged: !!tr, terminal_status: terminal, confirmation_status: confirmation, reason: reason || '', auditor_evidence: v ? String(v.evidence || '').slice(0, 300) : '' }
}

// Build one authoritative board record: identity from the IMMUTABLE candidate, writeup from the triage record if
// present (else from the candidate), status from the auditor verdict.
function _buildBoardRecord(c, tr, confirmation, v, taskId) {
  const needsLive = confirmation === 'NEEDS_LIVE_VALIDATION'
  const code = (tr && (tr.code_block || tr.vulnerable_code)) || c.code_block || c.vulnerable_code || c.evidence || ''
  return {
    id: (tr && tr.id) || `CR-${String(c.candidate_id || '').replace(/[^a-z0-9]+/gi, '-').slice(-16)}`,
    // §5: the TITLE names the vulnerability → it is identity, taken from the candidate, NOT the triager (which may
    // only refine description/impact/severity/remediation). Prevents "CSRF candidate → Stored XSS title" cross-wiring.
    title: c.title || `${String(c.vulnerability_class || c.cwe || 'issue').replace(/[-_]/g, ' ')} in ${c.feature || c.file || ''}`.trim(),
    severity: (tr && tr.severity) || c.severity || 'Medium',
    validation_status: needsLive ? 'NEEDS-LIVE' : 'CONFIRMED',
    confirmation_status: confirmation,
    requires_runtime_validation: needsLive,
    original_agent: String(c.agent || c.original_agent || 'MARSHAL').toUpperCase(),
    cwe: c.cwe || (tr && tr.cwe) || '', taskId: String(taskId), source: 'streaming-triage',
    // immutable correlation identity — from the candidate, always
    feature: c.feature || '', vulnerability_class: c.vulnerability_class || c.cwe || '',
    duplicate_key: c.duplicate_key || '', candidate_id: c.candidate_id || '',
    workstream_id: c.workstream_id || '', session_id: c.session_id || '',
    // immutable evidence LOCATION — from the candidate, never the triager (bug#6)
    file: c.file || '', line: (c.line ?? ''), source: c.source || '', sink: c.sink || '',
    affected_endpoint: c.endpoint || c.affected_endpoint || '',
    code_block: code, vulnerable_code: code,
    // writeup prose from triage (fail-soft to empty — the WRITER phase fills these for confirmed findings)
    description: (tr && tr.description) || '', impact: (tr && tr.impact) || '', remediation: (tr && tr.remediation) || '',
    cvss_vector: (tr && tr.cvss_vector) || '', cvss_score: (tr && typeof tr.cvss_score === 'number') ? tr.cvss_score : null,
    required_blackbox_proof: (tr && tr.required_blackbox_proof) || c.required_blackbox_proof || '',
    auditor_evidence: v ? String(v.evidence || '').slice(0, 500) : '',
    evidence_tier: (tr && tr.evidence_tier) || undefined,
  }
}

// vuln class → { specialist, phase-2 module, pattern catalog }. The slugs match
// common/patterns/<slug>.json — a null catalog auto-resolves to that pattern
// catalog in phase2Prompt (when the pattern flag is on), else the specialist's
// own skill. access-control, xss + account-takeover keep dedicated methodology-pack
// modules; account-takeover's catalog also backs the authentication-session class.
const CLASS = {
  'access-control':        { agent: 'marshal', module: 'phase2_access_control_idor_v1.md', catalog: 'access_control_40_pattern_catalog.md' },
  'multi-tenant-isolation':{ agent: 'marshal', module: null, catalog: null },
  'admin-privileged':      { agent: 'marshal', module: null, catalog: null },
  'business-logic':        { agent: 'marshal', module: null, catalog: null },
  'csrf':                  { agent: 'marshal', module: null, catalog: null },
  'account-takeover':      { agent: 'siphon',  module: 'phase2_account_takeover_v1.md', catalog: 'account_takeover_pattern_catalog.md' },
  'authentication-session':{ agent: 'siphon',  module: null, catalog: 'account_takeover_pattern_catalog.md' },
  'secrets-cryptography':  { agent: 'siphon',  module: null, catalog: null },
  'xss':                   { agent: 'cipher',  module: 'phase2_xss_html_injection_v1.md', catalog: 'xss_50_pattern_catalog.md' },
  'data-exposure':         { agent: 'cipher',  module: null, catalog: null },
  'logging-audit':         { agent: 'cipher',  module: null, catalog: null },
  'sqli':                  { agent: 'quill',   module: null, catalog: null },
  'nosql-injection':       { agent: 'quill',   module: null, catalog: null },
  'command-injection':     { agent: 'quill',   module: null, catalog: null },
  'injection':             { agent: 'quill',   module: null, catalog: null },
  'deserialization':       { agent: 'quill',   module: null, catalog: null },
  'ssrf':                  { agent: 'beacon',  module: null, catalog: null },
  'webhook-security':      { agent: 'beacon',  module: null, catalog: null },
  'cloud-infrastructure':  { agent: 'beacon',  module: null, catalog: null },
  'api-security':          { agent: 'beacon',  module: null, catalog: null },
  'graphql':               { agent: 'beacon',  module: null, catalog: null },
  'rce':                   { agent: 'breaker', module: null, catalog: null },
  'path-traversal':        { agent: 'breaker', module: null, catalog: null },
  'file-handling':         { agent: 'breaker', module: null, catalog: null },
  'race-conditions':       { agent: 'breaker', module: null, catalog: null },
  'supply-chain':          { agent: 'breaker', module: null, catalog: null },
}
const CLASS_ALIASES = Object.freeze({
  'multi-tenant': 'multi-tenant-isolation',
  'cryptography-secrets': 'secrets-cryptography',
  webhooks: 'webhook-security',
  'cloud-infra': 'cloud-infrastructure',
  lfi: 'path-traversal',
})
function normalizeVulnClass(value) {
  const cls = String(value || '').trim().toLowerCase()
  return CLASS_ALIASES[cls] || cls
}
// Broad default floor when classes aren't explicitly set AND inventories are
// skipped (was just access-control+xss — too thin). With inventories present,
// selectVulnClasses() refines this from the discovered surface.
const DEFAULT_CLASSES = ['access-control', 'authentication-session', 'xss', 'injection', 'data-exposure', 'business-logic']
// Auto-select vuln classes from the Phase-1 inventory surface (counts by
// inventory name, preset-agnostic via substring match). Always keeps a baseline
// floor, then adds surface-specific classes whose inventory actually matched.
function selectVulnClasses(counts) {
  const sel = new Set(['access-control', 'business-logic', 'xss', 'injection', 'data-exposure'])
  const add = (...cs) => cs.forEach(c => sel.add(c))
  for (const [name, n] of Object.entries(counts || {})) {
    if (!n) continue
    if (/auth|token|actor|session/.test(name)) add('authentication-session', 'account-takeover', 'access-control')
    if (/route|endpoint|rest|api/.test(name)) add('api-security', 'access-control')
    if (/graphql/.test(name)) add('graphql', 'api-security')
    if (/db|quer|search|count/.test(name)) add('sqli', 'injection')
    if (/render|output|response|shaping|serial/.test(name)) add('xss', 'data-exposure')
    if (/upload|download|export|file/.test(name)) add('file-handling', 'ssrf', 'path-traversal')
    if (/worker|job/.test(name)) add('race-conditions', 'injection')
    if (/service|finder|polic/.test(name)) add('access-control', 'business-logic')
  }
  return [...sel].filter(c => CLASS[c])
}
const MAPPER_POOL = ['marshal', 'siphon', 'cipher', 'quill', 'beacon', 'breaker']
// Phase 3 freehand source review — the THIRD phase of the three-phase source review, ON by DEFAULT
// (core coverage, not an experiment). 'active' ⇒ candidates feed the report; 'shadow' ⇒ report-neutral;
// 'off' (ARCHON_THREE_PHASE_SOURCE_REVIEW_OFF=1) ⇒ the legacy byte-identical 8-phase flow. Computed via
// paths.sourceReviewMode (no direct env read — grep-gate). See ULTRAPLAN.md §5.3.
const FH_MODE = typeof __roots.sourceReviewMode === 'function' ? __roots.sourceReviewMode() : 'active'
const PHASES = ['inventories', 'blueprint', 'discovery', 'mapping', 'consolidate', 'phase2',
  ...(FH_MODE !== 'off' ? ['freehand'] : []), 'verify', 'report']
const WAVE = 3 // RAM-safe parallelism (mirrors GATE-134 stocks batching)
// Scalable mapping defaults (spec §4). Fast-map features in domain batches of ≤8, ≤6 mappers in parallel.
const MAX_FEATURES_PER_BATCH = 8
const MAX_PARALLEL_MAPPERS = 6
const BATCH_CONCURRENCY = 3 // Phase 1 mapping: how many domain batches map at once
const PHASE2_CONCURRENCY = 6 // Phase 2 review: wave width once every feature is mapped (review fans out wider than mapping)
const REVIEW_SESSION_CONCURRENCY = 3 // M6: how many PERSISTENT specialist review sessions run at once (default 3; the spec's cap)
const MAX_FOLLOWUP_ROUNDS = 3 // reconciliation rounds — bounds the map→followup→map loop (§4)
// M2: rate-limit deferral. A rate-limited mapper marks its feature deferred_rate_limit (never blocked); the
// dispatcher pauses until cooldown, then resumes. Bounded so a persistent limit can't loop forever — after
// the budget, still-deferred features become a real blocked_coverage_gap (reported, not silently dropped).
const DEFER_MAX_RETRIES = 6
const DEFER_MAX_WAIT_MS = 35 * 60 * 1000 // cap a single cooldown wait (covers the 30-min quota ladder rung)
const sleep = (ms) => new Promise((r) => setTimeout(r, Math.max(0, ms)))
// ONE comprehensive source-file extension set — the SAME list gates BOTH preflight file-detection AND
// the scripted inventory grep, so any language a real codebase ships in gets enumerated (not just JS/TS).
// Real source can be anything; keep this broad. The mapping agents also read the live tree directly, so
// a truly exotic extension is still reviewed — this just keeps the scripted surface honest across stacks.
const SOURCE_EXTS = ['js', 'mjs', 'cjs', 'ts', 'jsx', 'tsx', 'vue', 'svelte', 'py', 'pyw', 'rb', 'pl', 'pm',
  'go', 'rs', 'zig', 'c', 'h', 'cpp', 'cc', 'cxx', 'hpp', 'hxx', 'm', 'mm', 'java', 'kt', 'kts', 'scala',
  'groovy', 'cs', 'fs', 'vb', 'swift', 'dart', 'ex', 'exs', 'erl', 'hrl', 'clj', 'cljs', 'hs', 'ml', 'mli',
  'php', 'phtml', 'html', 'htm', 'ejs', 'hbs', 'lua', 'r', 'tf', 'hcl', 'sh', 'bash', 'zsh', 'ps1', 'proto',
  'thrift', 'gql', 'graphql', 'sql']

// The fixed Phase-1 feature-map contract (enforced in the prompt; full template on disk).
const FEATURE_SECTIONS = [
  'Feature Identity', 'Feature Purpose', 'Entry Points', 'Files Reviewed',
  'Endpoint / Action Ledger', 'Full Code Paths', 'Authorization Map',
  'Authentication / Actor Context Map', 'Data Exposure Map', 'Background Job Map',
  'Same-Functionality Map', 'Security-Sensitive Areas for Phase 2 (ranked)', 'Coverage Notes',
]
const LEDGER_COLS = 'Entry Point | Method/Trigger | File | Class/Method | Object Lookup | Auth Check | Object Authorized | Response/State Change | Serializer/Worker | Same-Functionality Siblings | Phase1 Status | Phase2 Priority | Gaps'
const DEPTH = 'Discovered → Mapped → Traced → AuthZ Verified → Deep Complete'

// ── helpers ──────────────────────────────────────────────────────────────────
function slugify(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60)
}

async function runWaves(items, size, fn) {
  const out = []
  for (let i = 0; i < items.length; i += size) {
    const batch = items.slice(i, i + size)
    // A4 fail-forward: one item's failure resolves to null — it can never reject the wave / abort the run.
    out.push(...await Promise.all(batch.map(async (it, j) => { try { return await fn(it, i + j) } catch { return null } })))
  }
  return out
}

// M1: the honest one-line mapping status the UI shows. Headline is MAPPED (real map files); deferred (rate-limit)
// and blocked (coverage gaps) are shown separately, never folded into the mapped count.
function mappingStatusLine(ledger, total) {
  const t = total || ledger.features_total || 0
  let s = `Phase 1: mapping features ${ledger.features_mapped || 0}/${t}`
  const extra = []
  if (ledger.features_in_progress) extra.push(`${ledger.features_in_progress} in progress`)
  if (ledger.features_deferred) extra.push(`${ledger.features_deferred} deferred (rate-limit)`)
  if (ledger.features_blocked) extra.push(`${ledger.features_blocked} blocked`)
  return extra.length ? `${s} · ${extra.join(' · ')}` : s
}

// Detect the primary language/stack of the source tree — INFORMATIONAL ONLY (labels the inventory
// manifest). It never changes behaviour: inventory + feature discovery are identical for every
// project, so any repo (Rails, Django, Express/Nest, Spring, Laravel, Go, .NET, …) reviews the same way.
function detectStack(sourceDir) {
  const has = (p) => { try { return fs.existsSync(path.join(sourceDir, p)) } catch { return false } }
  if (has('Gemfile') || has('config/routes.rb')) return 'ruby'
  if (has('manage.py') || has('pyproject.toml') || has('requirements.txt')) return 'python'
  if (has('go.mod')) return 'go'
  if (has('pom.xml') || has('build.gradle') || has('build.gradle.kts')) return 'java/kotlin'
  if (has('composer.json')) return 'php'
  if (has('Program.cs') || has('Startup.cs')) return 'dotnet'
  if (has('package.json')) return 'node'
  if (has('Cargo.toml')) return 'rust'
  return 'generic'
}

// Scripted inventory enumeration (grep — universally available). ONE comprehensive, multi-language
// spec set surfaces the review surface of ANY project (no per-app or per-framework preset). Each
// spec writes one inventory file; counts feed the coverage denominator. Fail-soft per spec.
function buildInventories(sourceDir, invDir, stack, log) {
  fs.mkdirSync(invDir, { recursive: true })
  const CODE = SOURCE_EXTS.map(e => `--include=*.${e}`) // any-language surface (shared with preflight)
  const specs = [
    ['01_routes_endpoints', '(@(app|router)\\.(get|post|put|delete|patch)|app\\.(get|post|put|delete|route)|router\\.(get|post|put|delete|use)|@(Get|Post|Put|Delete|Patch|RequestMapping|RestController|Path)\\b|http\\.HandleFunc|Route::(get|post|put|delete)|\\bresources?\\b|\\bnamespace\\b|\\bdraw\\b|def [a-z_]+\\(.*request|\\b(field|mutation|resolver)\\b)', CODE],
    ['02_auth_checks', '(authorize|authenticate|permission|access_control|can\\?|allowed\\?|isAuthenticated|@PreAuthorize|@RolesAllowed|require_role|ensure_|before_action|@login_required|IsAuthenticated|hasRole|checkAccess|current_user)', CODE],
    ['03_db_queries', '(SELECT |INSERT INTO|UPDATE |DELETE FROM|find_by|findOne|findAll|\\.query\\(|\\.where\\(|\\.raw\\(|prepareStatement|createQuery|execute\\(|sequelize\\.query|knex\\()', CODE],
    ['04_render_output', '(render|innerHTML|dangerouslySetInnerHTML|\\.html\\(|template|res\\.send|\\braw\\(|\\bexpose |\\brepresent |Serializer|Presenter|\\bEntity\\b|toJSON)', CODE],
    ['05_uploads_downloads', '(upload|download|send_file|send_data|sendFile|multipart|res\\.download|presigned|object_storage|ExportService|\\barchive\\b|FileUpload|MultipartFile)', CODE],
    ['06_tokens_actors', '(token|session|cookie|jwt|api_key|access_token|personal_access_token|current_user|currentUser|principal|\\bactor\\b|impersonat|Authorization)', CODE],
    ['07_background_jobs', '(class .*Worker\\b|perform_async|perform_in|perform_later|sidekiq|ActiveJob|@Scheduled|@Async|@shared_task|celery|\\.enqueue|\\bcron\\b|implements Job\\b|extends Job\\b)', CODE],
    ['08_business_logic', '(class .*(Service|Policy|Finder|UseCase|Handler|Manager|Processor)\\b|def execute\\b|def call\\b|rule \\{|def perform\\b|state_machine|\\btransition\\b|\\bworkflow\\b)', CODE],
  ]
  const counts = {}
  for (const [name, pattern, globs] of specs) {
    const file = path.join(invDir, `${name}.txt`)
    try {
      const cmd = `grep -rEn --exclude-dir={node_modules,vendor,.git,dist,build,coverage,.next,target,.venv,__pycache__} ${globs.join(' ')} -e ${JSON.stringify(pattern)} . 2>/dev/null | head -8000`
      // timeout so a runaway/blocked grep is KILLED rather than freezing the whole daemon; on
      // timeout execSync throws → the catch below records 0 (fail-soft), same as a no-match exit 1.
      const out = execSync(cmd, { cwd: sourceDir, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, shell: '/bin/bash', timeout: 120000, killSignal: 'SIGKILL' })
      fs.writeFileSync(file, out)
      counts[name] = out ? out.trimEnd().split('\n').filter(Boolean).length : 0
    } catch (e) {
      // grep exits 1 when no matches — that's a 0, not an error
      try { fs.writeFileSync(file, '') } catch {}
      counts[name] = 0
    }
  }
  const manifest = `# Phase 1 — Source-of-Truth Inventory Manifest

Target: \`${sourceDir}\`
Stack: **${stack}**
Method: scripted grep enumeration (source-parsed; the agents re-grep + read live code during mapping).

## Inventory files

| File | Matches |
|---|---|
${Object.entries(counts).map(([n, c]) => `| \`${n}.txt\` | ${c} |`).join('\n')}

## Reconciliation rule
Every inventory item must land in exactly one of: (1) mapped to a feature + ledger row,
(2) shared infrastructure mapped to all consuming features, (3) not security-relevant (with reason),
(4) unclear → Phase 1 gap, (5) dead/unreachable (with evidence). No item disappears silently.
`
  fs.writeFileSync(path.join(invDir, '00_MANIFEST.md'), manifest)
  log(`  📇 Inventories: ${Object.entries(counts).map(([n, c]) => `${n}=${c}`).join(', ')}`)
  return counts
}

// ── prompt builders (self-contained — read the ported methodology pack) ───────
function commonHeader(taskId, sourceDir, outDir, invDir) {
  return `Source tree (read-only target): ${sourceDir}
Phase-1 inventories (grep enumeration, your starting denominator): ${invDir}/
Output dir (write your artifacts here, absolute paths): ${outDir}/
Methodology pack (read these for the exact contract): ${METH}/
Use bash (rg/grep/cat/sed) to enumerate and read source. This is MAPPING + EVIDENCE work — produce files, not chat.`
}

function blueprintPrompt(taskId, sourceDir, outDir, invDir) {
  return `You are CURATOR, code-review squad leader. Produce the APP BLUEPRINT — a one-page architectural orientation that EVERY downstream feature reviewer reads first. Understand the whole system BEFORE the parts.

${commonHeader(taskId, sourceDir, outDir, invDir)}

Read the inventories + the source-tree layout + the key bootstrap/config files (framework entrypoints, routing tables, auth middleware, ORM/models, settings/env, docker/CI). Do NOT map features yet — this is orientation.

Write a concise (~1 page) blueprint to ${outDir}/phase1-maps/app-blueprint.md with EXACTLY these sections:
1. ## What this application is — purpose, domain, primary actors/personas.
2. ## Tech stack & infrastructure — languages, framework(s), datastores, queues/workers, external services, how it deploys.
3. ## Authentication & authorization model — how a request is authenticated (session/JWT/OAuth/API key), how identity → roles, where authZ is enforced (middleware/decorators/policy objects), and how object ownership / tenancy is checked. Name the EXACT files.
4. ## Shared infrastructure & cross-cutting code — middleware, base controllers, serializers, input parsing/sanitization, file storage, payment, rate-limiting, logging — anything MANY features depend on (where cross-feature vulns hide).
5. ## Data flow & trust boundaries — where untrusted input enters, how it reaches sinks (DB/render/shell/HTTP), and which trust boundaries it crosses.
6. ## Highest-risk areas to prioritize — 3-7 architectural hot spots for Phase 2, each with the file/dir and why.

Cite exact files/dirs. Then reply one line: stack, auth mechanism, top architectural risk.`
}

function featureMapPrompt(agent, feature, taskId, sourceDir, outDir, invDir) {
  const outFile = `${outDir}/phase1-maps/features/${feature.slug}.md`
  return `You are ${agent.toUpperCase()}, a Phase-1 feature-mapping agent on the code-review squad (leader CURATOR).

${commonHeader(taskId, sourceDir, outDir, invDir)}

## Your single feature: ${feature.name} (slug: ${feature.slug})
${feature.keywords ? `Scope keywords/paths: ${feature.keywords}` : ''}

Phase 1 is **mapping, not vulnerability hunting** — do NOT report confirmed vulns. Record security-sensitive
areas, suspicious paths, Phase-2 leads, gaps, assumptions, and required follow-up.

## Method (feature-by-feature, evidence-based)
0. Read the App Blueprint at ${outDir}/phase1-maps/app-blueprint.md FIRST — use its auth/authZ model + shared-infra map when tracing this feature's auth/actor/object-lookup/serializer paths (so you catch where this feature relies on shared, possibly-flawed, infrastructure).
1. grep the inventory files in ${invDir}/ scoped to this feature's keywords, then read the live source under ${sourceDir}.
2. Build the Endpoint/Action Ledger — ONE ROW per route+method / mutation / worker / action. Never merge GET/POST/PUT/DELETE. Never "CRUD reviewed".
3. Trace auth / actor / object-lookup / serializer / worker paths for representative and high-risk rows.
4. Record an honest depth status per row: ${DEPTH}.

## Required output — write the file to: ${outFile}
Use EXACTLY this section order (read ${METH}/templates/phase1_feature_map_template.md for the full table shapes):
${FEATURE_SECTIONS.map((s, i) => `${i + 1}. ## ${s}`).join('\n')}

The Endpoint / Action Ledger table columns (exact):
${LEDGER_COLS}

Ranked Security-Sensitive Areas: for each lead give exact file/method/route, why it matters, what Phase 2 must verify, the likely pattern class (access-control/IDOR, XSS, sqli, ssrf, rce, account-takeover), and which surface (Web/REST/GraphQL/worker/same-functionality) it affects.
Coverage Notes must be honest: what's AuthZ-verified vs mapped-only, assumptions, unmapped files, blockers.

Write the complete markdown file with bash (mkdir -p the dir first). Then reply with a one-line summary: rows mapped, top lead, residual gaps.`
}

// S3: FAST-map a BATCH of features with ONE agent (scalable — not one agent per feature). FAST = identify
// ALL reachable security-relevant surfaces per feature (the fast-map fields), NOT exhaustive line-by-line
// tracing; deep tracing is a later selective pass (S5). The agent owns ONLY its batch, writes one file per
// feature, and records related work it finds to followup-features.jsonl for reconciliation (S6).
function batchMapPrompt(owner, batch, taskId, sourceDir, outDir, invDir) {
  const list = batch.features.map(f => `- ${f.name} (slug: ${f.slug}${f.keywords ? `; keywords: ${f.keywords}` : ''})`).join('\n')
  return `You are ${owner.toUpperCase()}, a PERSISTENT Phase-1 source-review worker session on the code-review squad (leader CURATOR).

${commonHeader(taskId, sourceDir, outDir, invDir)}

## You are a long-running worker session, NOT a one-feature agent (M4)
You own a SHARD of ${batch.features.length} features and map ALL of them in THIS one session. Work through them one at a
time and DO NOT stop after the first — keep going until every assigned feature has a map file on disk. Do not ask the
operator what to do next; decide and proceed. If a tool call fails or you are interrupted, resume with the next feature —
a transient failure is NOT a coverage decision. NEVER report a feature as done unless its map file actually exists.

## Your shard — domain: ${batch.domain}, risk: ${batch.risk}. Map ONLY these ${batch.features.length} features, nothing else:
${list}

RULES (§7): map ONLY your shard's features — do NOT map features outside it, do NOT edit another agent's output.
If you discover related security-relevant work NOT in your shard, append it (do NOT map it) to
${outDir}/phase1-maps/followup-features.jsonl — one JSON per line: {"slug","name","domain","risk_hint","keywords","reason"}.

Phase 1 is MAPPING, not vulnerability hunting — record surfaces, suspicious paths, Phase-2 leads, gaps, follow-up.

## Worker loop — repeat for EACH feature in your shard, in order (FAST — identify ALL reachable security-relevant
## surfaces; deep per-path tracing is a later selective pass, not now):
0. (once) Read the App Blueprint at ${outDir}/phase1-maps/app-blueprint.md FIRST (auth/authZ model + shared infra).
1. grep the inventory files in ${invDir}/ scoped to the feature's keywords, then read the live source under ${sourceDir}.
2. Write ${outDir}/phase1-maps/features/<slug>.md (mkdir -p first) with these fast-map fields:
   Feature name · Domain · Business purpose · UI paths · Frontend components/forms · API endpoints/actions · GraphQL
   operations · Controllers/handlers · Services/business logic · Models/queries · Middleware · Auth checks · Role/permission
   checks · Object-ownership checks · Tenant/org/user boundary · Parameters · Sensitive data read/write · File upload/download
   paths · External calls · Background jobs · Trust boundaries · Ranked Phase-2 leads · Coverage gaps · Risk score.
   Fast map does NOT need exhaustive per-path tracing, but it MUST identify EVERY reachable security-relevant surface.
   Endpoint/Action Ledger: ONE ROW per route+method / mutation / worker / action (never merge GET/POST/PUT/DELETE).
3. Move to the NEXT feature and repeat until ALL ${batch.features.length} are mapped.

Write each feature's markdown file with bash AS YOU FINISH THAT FEATURE (so partial progress survives an interruption),
not all at the end. Then reply one line: features mapped, top leads, follow-ups written.`
}

function discoveryPrompt(taskId, sourceDir, outDir, invDir, cap) {
  return `You are CURATOR, code-review squad leader. Discover the FEATURE QUEUE for a Phase-1 white-box review.

${commonHeader(taskId, sourceDir, outDir, invDir)}

Read the App Blueprint at ${outDir}/phase1-maps/app-blueprint.md (architecture/auth/shared-infra/data-flow) and the
inventories + source tree layout (top-level dirs, route/controller/module groupings), then propose the
distinct security-relevant FEATURE AREAS to map (e.g. authentication, file-upload, admin, api-keys, search, webhooks…).
Group by business capability, not by file. ${Number.isFinite(cap) ? `Cap at ${cap} features (most security-relevant first).` : `List EVERY distinct security-relevant feature area the source has — do NOT cap or omit any (order most security-relevant first).`}

Tag each feature with a DOMAIN (one of: auth_identity, admin, user_profile, payments_billing, orders_checkout,
search_browse, files_uploads, notifications_webhooks, background_jobs, integrations_api, reporting_analytics,
config_infra, misc) and a risk_hint (high | medium | low) — high for auth/admin/payments/checkout/uploads/
external-integration/raw-query/tenant-boundary/sensitive-data surfaces. These drive domain-batched mapping and
risk-first Phase 2 (the orchestrator infers them if you omit them, but your judgment is better).

Write the queue to ${outDir}/phase1-maps/feature-queue.json as:
{"features":[{"slug":"kebab-slug","name":"Display Name","domain":"auth_identity","risk_hint":"high","keywords":"comma,separated,grep,hints"}, ...]}

Then reply with the JSON array only (no prose) so the orchestrator can parse it.`
}

function consolidationPrompt(taskId, outDir, features) {
  return `You are CURATOR, code-review squad leader. Consolidate Phase 1.

Read every feature map in ${outDir}/phase1-maps/features/*.md (${features.length} features: ${features.map(f => f.slug).join(', ')}).
Read the consolidated templates: ${METH}/templates/phase1_consolidated_templates.md and the gate ${METH}/checklists/phase1_completion_gate.md.

Write these files under ${outDir}/phase1-maps/consolidated/ (use bash, follow the templates):
- 00_INDEX.md
- feature_coverage_matrix.md          (per-feature depth-status rollup)
- source_inventory_coverage_matrix.md (inventory items reconciled vs gaps — the denominator vs numerator)
- same_functionality_cross_feature_map.md (recurring patterns reviewed as classes, not one-offs)
- phase2_review_queue.md              (ranked, evidence-backed Phase-2 leads aggregated from each map's top risks + gaps, each pointing back to features/<slug>.md)
- phase1_completion_gate.md           (honest: incomplete reconciliation / unresolved rows = blockers; evidence not confidence)

Then reply with a one-line summary: features consolidated, total ledger rows, top Phase-2 classes, open blockers.`
}

// Deterministic path for a Phase-2 job's structured candidate JSONL — the records that stream to the
// live board. phase2Prompt tells the specialist to write here; the dispatcher reads it after the job.
function candFileFor(outDir, cls, slug) { return `${outDir}/phase2/${cls}/${slug}.candidates.jsonl` }

// Resolve a specialist-emitted source path against the reviewed tree. Agents emit RELATIVE paths
// (e.g. 'routes/auth.js'); the streaming TRIAGER runs from the daemon cwd, not sourceDir, so a relative
// path would read the wrong file (or nothing) and silently drop the finding — worst on monorepos /
// subdirectory reviews. Normalizing to absolute at emission makes every downstream consumer correct.
function _absFile(file, sourceDir) {
  const f = String(file || '').trim()
  if (!f) return ''
  return (path.isAbsolute(f) || !sourceDir) ? f : path.resolve(sourceDir, f)
}

// Shape a specialist-emitted SOURCE candidate into a live-findings record. It NEVER sets a `url` or any
// runtime field — that is exactly what keeps deriveConfirmationStatus (finding-schema.js) at
// SOURCE_CONFIRMED, so a source-only finding can never become RUNTIME_CONFIRMED. type='candidate'
// passes isCandidate; cwe=cls gives canonicalKey a per-class dedup discriminator.
// S3 (parity §7): a deterministic dedup key so the same source→sink flow reported twice collapses to one.
function _dupKey(feature, cls, fileRel, c) {
  const norm = s => String(s || '').toLowerCase().trim().replace(/\s+/g, '-').slice(0, 60)
  return [norm(c.feature || feature.slug), norm(cls), norm(fileRel), norm(c.sink || c.source)].join(':')
}

// Canonical confirmation status for a source-review candidate — the SINGLE source of truth for both the
// `status` and `confirmation_status` fields (they must never diverge). A candidate can be:
//   • DISPROVEN            — refuted (killed / false positive). Never relabelled as confirmed.
//   • SOURCE_CONFIRMED     — affirmatively substantiated in code (the specialist SAID so).
//   • NEEDS_LIVE_VALIDATION — a hypothesis awaiting a live target (the conservative default for anything the
//                             specialist did not affirmatively confirm — never over-promoted to SOURCE_CONFIRMED).
// RUNTIME_CONFIRMED is impossible at the source stage (code can't self-prove runtime) → downgraded to
// SOURCE_CONFIRMED; only captured live proof upgrades it later. Mirrors agents/finding-schema deriveConfirmationStatus.
function candidateConfirmation(raw) {
  const s = String(raw == null ? '' : raw).toUpperCase().trim().replace(/[\s-]+/g, '_')
  if (s === 'DISPROVEN' || s === 'KILLED' || s === 'FALSE_POSITIVE') return 'DISPROVEN'
  if (s === 'SOURCE_CONFIRMED' || s === 'CONFIRMED' || s === 'RUNTIME_CONFIRMED') return 'SOURCE_CONFIRMED'
  return 'NEEDS_LIVE_VALIDATION'
}

function toLiveCandidate(c, cls, feature, agent, sourceDir, mode) {
  if (!c || typeof c !== 'object') return null
  const title = (String(c.hypothesis || c.pattern || c.title || '').split(/[\n.:]/)[0].trim().slice(0, 120))
    || `${cls} candidate in ${feature.name || feature.slug}`
  const status = candidateConfirmation(c.status)
  const fileRel = c.file || ''
  // Preserve the emitted vulnerability class: a freehand job is dispatched with cls='freehand' but the
  // specialist tags the real class (business-logic, access-control, …) in c.vuln_class — honour it so the
  // board categorises the finding correctly and its duplicate_key lines up with a Phase-2 hit on the same class.
  const vClass = c.vuln_class || c.vulnerability_class || cls
  // affected_files: an explicit array wins; else the single file. requires_runtime_validation is true for any
  // source-substantiated finding that hasn't been live-proven (a DISPROVEN one needs nothing further).
  const affected = Array.isArray(c.affected_files) && c.affected_files.length ? c.affected_files : (fileRel ? [fileRel] : [])
  return {
    type: 'candidate', mode: mode || 'static', agent: String(agent).toUpperCase(), original_agent: String(agent),
    severity: c.severity || 'Medium', cwe: c.cwe || vClass, vulnerability_class: vClass, title,
    details: String(c.evidence || c.hypothesis || '').slice(0, 2000),
    feature: c.feature || feature.slug, pattern: c.pattern || '', pattern_id: c.pattern_id || '',
    // absolute so the TRIAGER (which runs from the daemon cwd) reads the right source file; file_rel keeps
    // the specialist's original relative path for display.
    file: _absFile(c.file, sourceDir), file_rel: fileRel, affected_files: affected, line: c.line ?? '',
    source: c.source || '', sink: c.sink || '', endpoint: c.endpoint || '', affected_endpoint: c.endpoint || c.affected_endpoint || '',
    confidence: c.confidence ?? '', hypothesis: c.hypothesis || '', exploit_hypothesis: c.exploit_hypothesis || c.hypothesis || '',
    evidence: c.evidence || '', code_block: c.code_block || c.vulnerable_code || c.evidence || '',
    recommendation: c.recommendation || '', duplicate_key: c.duplicate_key || _dupKey(feature, vClass, fileRel, c),
    // F22: correlation fields — candidate_id (stable), workstream_id (owning session), session_id.
    candidate_id: c.candidate_id || c.id || _dupKey(feature, vClass, fileRel, c),
    workstream_id: c.workstream_id || (feature && feature.slug) || '', session_id: c.session_id || '',
    // a DISPROVEN finding needs nothing further; anything else source-substantiated still wants live proof.
    requires_runtime_validation: c.requires_runtime_validation ?? (status !== 'DISPROVEN'),
    // status and confirmation_status are ONE truth — never let them diverge (that misrepresents validation).
    status, required_blackbox_proof: c.required_blackbox_proof || '',
    confirmation_status: status,
  }
}

// The in-run emit dedupe key (used by event-bus's emitCandidate). Prefer the candidate's deterministic
// duplicate_key — it collapses the SAME source→sink flow even when two specialists phrase the title
// differently — and fall back to cwe|file|line|title only when a candidate carries no duplicate_key. Pure.
function candidateDedupeKey(rec) {
  if (rec && rec.duplicate_key) return String(rec.duplicate_key)
  return `${(rec && rec.cwe) || ''}|${(rec && rec.file) || ''}|${(rec && rec.line) || ''}|${String((rec && rec.title) || '').slice(0, 60)}`
}

// Read a job's candidate JSONL + push each shaped record to the emit sink. Fail-soft: a missing file
// (specialist wrote none) or malformed lines yield 0 without throwing.
// F5: LLMs frequently emit *almost*-valid JSON — a lone backslash from a regex (\A, \z, \d) or a Windows path
// breaks JSON.parse. Repair the common case (escape any backslash that isn't a valid JSON escape), then retry.
function _repairJsonLine(s) { return s.replace(/\\(?!["\\/bfnrtu])/g, '\\\\') }
function parseCandidateLine(s) {
  try { return { ok: true, c: JSON.parse(s) } } catch {}
  try { return { ok: true, c: JSON.parse(_repairJsonLine(s)), repaired: true } } catch {}
  return { ok: false, raw: s }
}
// F5: emit candidates from a model-written JSONL file, NEVER silently dropping one. Malformed records are
// repaired where possible, else quarantined to rejected-candidates-<taskId>.jsonl and logged.
function emitCandidatesFromFile(candFile, cls, feature, agent, taskId, emitCandidate, log, sourceDir, mode) {
  let raw; try { raw = fs.readFileSync(candFile, 'utf8') } catch { return 0 }
  let n = 0, rejected = 0, repaired = 0
  const rejectFile = `${__roots.INTEL_ROOT}/rejected-candidates-${taskId}.jsonl`
  for (const line of raw.split('\n')) {
    const s = line.trim(); if (!s) continue
    const p = parseCandidateLine(s)
    if (!p.ok) { rejected++; try { fs.appendFileSync(rejectFile, JSON.stringify({ ts: new Date().toISOString(), taskId, agent: String(agent), cls, reason: 'invalid JSON (unrepairable)', raw: s.slice(0, 4000) }) + '\n') } catch {}; continue }
    if (p.repaired) repaired++
    const rec = toLiveCandidate(p.c, cls, feature, agent, sourceDir, mode)
    if (rec) { try { emitCandidate(taskId, rec); n++ } catch {} }
  }
  if ((n || rejected) && typeof log === 'function') log(`  📡 ${String(agent).toUpperCase()} → ${n} candidate(s)${repaired ? ` (${repaired} repaired)` : ''}${rejected ? `, ⚠️ ${rejected} QUARANTINED → rejected-candidates` : ''} [${cls}/${feature.slug}]`)
  return n
}

function phase2Prompt(cls, agent, feature, taskId, sourceDir, outDir) {
  const c = CLASS[cls]
  const mapFile = `${outDir}/phase1-maps/features/${feature.slug}.md`
  const outFile = `${outDir}/phase2/${cls}/${feature.slug}.md`
  const candFile = candFileFor(outDir, cls, feature.slug)
  const moduleLine = c.module ? `Vuln module (follow it exactly): ${METH}/prompts/${c.module}` : `(no dedicated module for ${cls} — use your ${cls}-review skill)`
  let catalogLine = c.catalog ? `Pattern catalog (apply EVERY pattern): ${METH}/catalogs/${c.catalog}` : `(no catalog — apply your skill's full pattern set for ${cls})`
  if (!c.catalog) {
    // Use the structured catalog engine whenever a catalog exists. The flag still controls
    // downstream experimental pattern-id correlation, but static review quality should not
    // depend on an env flag being set.
    const p = (() => { try { return require('../intel/pattern-catalog').catalogPathFor(cls) } catch { return null } })()
    if (p) catalogLine = `Pattern catalog (apply EVERY pattern): ${p}`
  }
  return `You are ${agent.toUpperCase()}, Phase-2 ${cls} assessor on the code-review squad.

Source tree: ${sourceDir}
Phase-1 feature map (your input — read it fully): ${mapFile}
${moduleLine}
${catalogLine}
Router + anti-drift contract: ${METH}/prompts/phase2_vulnerability_assessment_router.md , ${METH}/checklists/anti_drift_execution_contract.md
Report template + CVSS: ${METH}/templates/phase2_feature_report_template.md , ${METH}/templates/cvss_scoring_guide.md

## Execution (per-feature, row-by-row — NOT batch/coordinator output)
1. Load the feature map's Endpoint/Action Ledger, files, gaps, required follow-up, same-functionality notes, ranked leads.
2. Build a reverse-check matrix: review EVERY ledger row + EVERY listed file + EVERY unresolved Mapped/Traced/Discovered/GAP/Verify item + same-functionality siblings — ranked leads set ORDER, not scope.
3. Re-read the source behind each row. Apply the full ${cls} pattern catalog.
4. Produce a source-backed per-feature report (evidence tables, review matrix, findings with file:line traces + CVSS, gaps). NOT an orchestration log.

## Structured candidates (REQUIRED — this is what streams to the LIVE findings board during the run)
For EVERY finding, also append ONE JSON object (JSONL, one per line) to: ${candFile}  (mkdir -p first)
Each object MUST have exactly these fields:
{"feature":"${feature.slug}","pattern":"<pattern / test-case name>","pattern_id":"<catalog id or ''>","file":"<source path>","line":<number>,"code_block":"<the EXACT vulnerable source lines, verbatim from file:line — this is the proof shown on the board>","source":"<where untrusted input enters>","sink":"<the dangerous sink>","endpoint":"<affected route/action or ''>","severity":"Critical|High|Medium|Low|Info","confidence":<0-100>,"hypothesis":"<what an attacker does>","evidence":"<the file:line source→sink trace>","status":"SOURCE_CONFIRMED|NEEDS_LIVE_VALIDATION","required_blackbox_proof":"<what a live test must show, or ''>"}
Status rule: a source-only finding is SOURCE_CONFIRMED (you read the bug in the code) or NEEDS_LIVE_VALIDATION (needs a live hit to prove) — NEVER RUNTIME_CONFIRMED (you have no live evidence here).
APPEND each candidate line the MOMENT you confirm it (one JSON object per line) — do NOT batch them to the end. A background watcher surfaces each new line on the live board within ~10s, so streaming as you go is what makes findings appear mid-review.

## Audit trail (REQUIRED — proves the FULL ${cls} catalog was considered, not just the hits)
- Pattern coverage: write ${outDir}/phase2/${cls}/${feature.slug}_pattern_review.md — for EACH pattern in the ${cls} catalog, one line: pattern name + result state (matched_candidate / reviewed_no_issue / not_applicable / needs_more_context).
- Rejected patterns: for each pattern you REJECT, append one JSON line to ${outDir}/rejected/${cls}-${feature.slug}.jsonl (mkdir -p first): {"pattern":"…","file":"…","reason":"false_positive|not_applicable|reviewed_no_issue|duplicate","note":"…"}

Write the report to: ${outFile} (mkdir -p first). Then reply one line: rows reverse-checked, findings (by severity), residual gaps.`
}

// M6: a PERSISTENT review-worker prompt — one specialist session works through MANY (feature × class) jobs in a
// single call, instead of one fresh spawn per job. Each job keeps its own per-job report + candidate + pattern-
// review + rejected files (so streaming/audit are unchanged); the worker just processes them back-to-back.
function reviewSessionPrompt(agent, jobs, taskId, sourceDir, outDir) {
  const catalogFor = (cls) => {
    const c = CLASS[cls]
    if (c.catalog) return `${METH}/catalogs/${c.catalog}`
    try { const p = require('../intel/pattern-catalog').catalogPathFor(cls); if (p) return p } catch {}
    return `(no catalog file — apply your full ${cls} pattern set)`
  }
  const rows = jobs.map((j, i) => {
    const cf = candFileFor(outDir, j.cls, j.feature.slug)
    return `${i + 1}. [${j.cls}] feature "${j.feature.slug}"
   feature map (read fully): ${outDir}/phase1-maps/features/${j.feature.slug}.md
   pattern catalog (apply EVERY pattern): ${catalogFor(j.cls)}
   report → ${outDir}/phase2/${j.cls}/${j.feature.slug}.md
   candidates (JSONL, append live) → ${cf}
   pattern-review → ${outDir}/phase2/${j.cls}/${j.feature.slug}_pattern_review.md`
  }).join('\n')
  return `You are ${agent.toUpperCase()}, a PERSISTENT Phase-2 review worker session on the code-review squad (leader CURATOR).

You own ${jobs.length} review job(s) below and process ALL of them in THIS one session — do NOT stop after the first,
do NOT ask what to do next. A rate limit or tool failure is not a decision to skip a job; resume with the next one.

Source tree: ${sourceDir}
Router + anti-drift contract: ${METH}/prompts/phase2_vulnerability_assessment_router.md , ${METH}/checklists/anti_drift_execution_contract.md
Report template + CVSS: ${METH}/templates/phase2_feature_report_template.md , ${METH}/templates/cvss_scoring_guide.md

## Your review queue — process EACH job in order:
${rows}

## For EACH job above (repeat the full method per (feature, class) — do not batch or summarize across jobs):
1. Read that feature's map fully: Endpoint/Action Ledger, files, gaps, follow-ups, same-functionality notes, ranked leads.
2. Reverse-check EVERY ledger row + listed file + unresolved item + same-functionality sibling — re-read the source behind
   each row and apply the FULL pattern catalog for that job's class (ranked leads set ORDER, not scope).
3. For EVERY finding, the MOMENT you confirm it, APPEND one JSON object (JSONL, one per line) to THAT job's candidates
   file (mkdir -p first) — do NOT batch to the end (a watcher streams each new line to the live board within ~10s):
   {"feature":"<slug>","pattern":"<name>","pattern_id":"<catalog id or ''>","file":"<path>","line":<n>,"code_block":"<exact vulnerable source lines, verbatim>","source":"<untrusted input entry>","sink":"<dangerous sink>","endpoint":"<route/action or ''>","severity":"Critical|High|Medium|Low|Info","confidence":<0-100>,"hypothesis":"<attacker action>","evidence":"<file:line source→sink trace>","status":"SOURCE_CONFIRMED|NEEDS_LIVE_VALIDATION","required_blackbox_proof":"<what a live test must show, or ''>"}
   Status: SOURCE_CONFIRMED (you read the bug) or NEEDS_LIVE_VALIDATION (needs a live hit) — NEVER RUNTIME_CONFIRMED here.
4. Write that job's report file + pattern-review (EACH catalog pattern: matched_candidate/reviewed_no_issue/not_applicable/
   needs_more_context). Rejected patterns → ${outDir}/rejected/<cls>-<slug>.jsonl (mkdir -p first).
5. Move to the NEXT job and repeat until ALL ${jobs.length} are done.

Then reply one line: jobs reviewed, findings by severity, residual gaps.`
}

// Phase 3 — freehand senior-pentester review (Autonomous OS Block D). Open-ended
// reasoning to surface novel / business-logic vulns that the pattern pass misses.
// fhDir = phase2/freehand (active, AUDITOR-globbed) or a non-globbed sibling (shadow).
function freehandPrompt(agent, feature, taskId, sourceDir, outDir, fhDir, classes) {
  const mapFile = `${outDir}/phase1-maps/features/${feature.slug}.md`
  const outFile = `${fhDir}/${feature.slug}.md`
  return `You are ${agent.toUpperCase()}, Phase-3 FREEHAND security reviewer on the code-review squad — a senior pentester, NOT a pattern matcher.

Source tree: ${sourceDir}
Phase-1 feature map (read fully): ${mapFile}
Methodology (follow it): ${METH}/prompts/phase3_freehand_review_v1.md
Candidate template (one block per finding): ${METH}/templates/phase3_freehand_candidate_template.md

Pattern review (Phase 2) already covered the KNOWN classes. Your job is the UNKNOWN: logic
flaws, trust-boundary mistakes, state/race issues, abuse of intended functionality, multi-step
chains, and anything that "feels wrong" when you read the code as an attacker. Ask the
methodology's senior-pentester questions of THIS feature; reason about how a real attacker would
abuse it, not which signature matches.

${Array.isArray(classes) && classes.length ? `OPERATOR FOCUS: this dispatch selected ONLY ${classes.join(', ')}. Apply freehand reasoning within those classes only. Do not emit candidates for another vulnerability class.` : ''}

Each candidate MUST follow the template, including the **Required black-box proof** field — a
source-only novel candidate is a HYPOTHESIS (NEEDS-LIVE), never CONFIRMED. Cite file:line for every claim.

## Structured candidates (REQUIRED — streams to the LIVE board like Phase 2)
For EVERY novel candidate, also append ONE JSON object (JSONL) to: ${fhDir}/${feature.slug}.candidates.jsonl  (mkdir -p first)
{"feature":"${feature.slug}","vuln_class":"<business-logic|access-control|…>","pattern":"freehand","file":"<source path>","line":<number>,"source":"<input>","sink":"<sink/abuse>","endpoint":"<route/action or ''>","severity":"Critical|High|Medium|Low|Info","confidence":<0-100>,"hypothesis":"<the abuse/logic flaw>","evidence":"<code + file:line trace>","status":"SOURCE_CONFIRMED|NEEDS_LIVE_VALIDATION","required_blackbox_proof":"<what a live test must show, or ''>"}
A novel/logic candidate you can only reason about (not prove in code) is NEEDS_LIVE_VALIDATION, never RUNTIME_CONFIRMED.

Write your candidates to: ${outFile} (mkdir -p first). Reply one line: novel candidates found, top risk, what needs live proof.`
}

function auditorPrompt(taskId, outDir, features, classes, deployUrl) {
  const liveLine = deployUrl
    ? `A live target IS available (${deployUrl}): a finding you actually exercised there with a captured response is RUNTIME_CONFIRMED; a source-substantiated finding you did NOT fire live is SOURCE_CONFIRMED.`
    : `NO live target is available (source-only review): the strongest verdict you can issue is SOURCE_CONFIRMED — you can confirm a bug by reading code, but you CANNOT mark it RUNTIME_CONFIRMED without live proof. Do not over-claim.`
  return `You are AUDITOR, the independent verifier. Reverse-check the Phase-2 code-review findings — never trust the assessor's claim.

Read the Phase-2 reports under ${outDir}/phase2/**/*.md (classes: ${classes.join(', ')}; features: ${features.map(f => f.slug).join(', ')}).
For each reported finding: re-read the cited source path, confirm the auth/object-lookup/sink claim is real, and issue a
confirmation status with a one-line evidence reason. ${liveLine}

Confirmation status vocabulary (use EXACTLY these):
- RUNTIME_CONFIRMED     — substantiated AND proven against the running target (captured live response).
- SOURCE_CONFIRMED      — substantiated from source, but never fired at a live target.
- NEEDS_LIVE_VALIDATION — a plausible hypothesis that needs a live target to settle.
- DISPROVEN             — checked and refuted from source.
Demote anything you cannot substantiate from source.

Write verdicts to ${outDir}/phase2/AUDITOR-VERDICTS.md (a table: feature | class | finding | status | evidence). Reply one line: runtime-confirmed/source-confirmed/needs-live/disproven counts.`
}

// §4/§7: holistic-mode reverse-check. There are NO phase2/*.md reports in holistic mode, so the AUDITOR must
// reverse-check the ACTUAL streamed candidates — each bound to its immutable candidate_id + the SPECIFIC
// hypothesis it claimed. The auditor may change the VERDICT, never the vulnerability under review.
function holisticAuditorPrompt(taskId, outDir, candidates, deployUrl, outFile) {
  outFile = outFile || `${outDir}/phase2/AUDITOR-VERDICTS.jsonl`
  const liveLine = deployUrl
    ? `A live target IS available (${deployUrl}): a candidate proven live is RUNTIME_CONFIRMED; source-substantiated but not fired is SOURCE_CONFIRMED.`
    : `NO live target (source-only): the strongest verdict is SOURCE_CONFIRMED — never RUNTIME_CONFIRMED without live proof.`
  const list = candidates.map((c) => `- candidate_id: ${c.candidate_id}\n    title: ${String(c.title || c.vulnerability_class || 'issue')} | class=${c.vulnerability_class || c.cwe || '?'} feature=${c.feature || '?'} at ${c.file || '?'}:${c.line ?? '?'}\n    source=${c.source || '?'} → sink=${c.sink || '?'}\n    hypothesis to test: ${String(c.hypothesis || c.exploit_hypothesis || c.details || '').slice(0, 300)}`).join('\n')
  return `You are AUDITOR, the independent verifier. Reverse-check EACH candidate below by re-reading ITS cited source path. Evaluate the EXACT hypothesis stated for that candidate — do NOT substitute a different concern (e.g. if the claim is "token never persisted", verify persistence, not entropy). You may change the verdict; you must NOT change the vulnerability being reviewed.

Candidates (${candidates.length}):
${list}

${liveLine}

Confirmation status vocabulary (use EXACTLY one per candidate):
- RUNTIME_CONFIRMED     — substantiated AND proven against a running target (only if a live target is available).
- SOURCE_CONFIRMED      — the stated hypothesis is substantiated from source.
- NEEDS_LIVE_VALIDATION — plausible but depends on runtime/config/caller not visible in source.
- DISPROVEN             — the source refutes the stated hypothesis (a guard/escape is present).

For EACH candidate append ONE JSON line to ${outFile} (mkdir -p first; APPEND with >>, never overwrite):
{"candidate_id":"<echo the exact candidate_id above>","status":"SOURCE_CONFIRMED|NEEDS_LIVE_VALIDATION|DISPROVEN|RUNTIME_CONFIRMED","evidence":"<one line citing file:line for THIS hypothesis>"}

Echo the candidate_id VERBATIM so each verdict binds to the right candidate. EXACTLY one line per candidate_id — do not omit any, do not merge two candidates. Also write a human table to ${outDir}/phase2/AUDITOR-VERDICTS.md. Reply one line: source-confirmed/needs-live/disproven counts.`
}

function scribePrompt(taskId, projectId, squad, sourceDir, outDir, features, classes, deployUrl, coverage, holistic, reportKind, reportBase, wsGaps) {
  reportKind = reportKind || 'final'
  const preliminary = reportKind === 'preliminary'
  const partial = reportKind === 'partial'
  // §2: a report is FINAL only when a live target correlated (white-box) AND every source slice was reviewed.
  // Preliminary (white-box, pre-live) and partial-coverage (some source slice unreviewed) are NOT final reports.
  const prelimBanner = preliminary
    ? `\n\n**⚠️ THIS IS A PRELIMINARY SOURCE REVIEW REPORT** — a live target is configured (${deployUrl}) but runtime validation of NEEDS_LIVE_VALIDATION candidates has NOT yet run. Title it "PRELIMINARY WHITE-BOX REPORT". Do NOT present NEEDS_LIVE findings as runtime-confirmed; the FINAL white-box report follows once source↔runtime evidence is correlated.\n`
    : partial
    ? `\n\n**⚠️ THIS IS A PARTIAL-COVERAGE REPORT** — ${wsGaps || 'some source slices were not reviewed'} (a workstream failed / was cancelled / exceeded the context budget). Title it "PARTIAL-COVERAGE CODE REVIEW". State the unreviewed slices explicitly in the coverage section; do NOT present this as complete coverage of the codebase.${deployUrl ? ` Additionally, a live target is configured (${deployUrl}) but runtime validation has NOT run — treat NEEDS_LIVE findings as unconfirmed; this is NOT the final white-box report.` : ''}\n`
    : ''
  // §1: in holistic mode there are no phase2/*.md reports — the Judge-gated board IS the finding set. SCRIBE reads
  // the JUDGED findings (post-downgrade/rejection) so the report can never contradict the judge.
  const inputs = holistic
    ? `- ${__roots.INTEL_ROOT}/JUDGED-FINDINGS-${taskId}.jsonl  (the Judge-gated finding set — THE authoritative findings; report these, honoring each record's confirmation_status)
- ${__roots.INTEL_ROOT}/VALIDATED-FINDINGS-${taskId}.jsonl  (the reconciled board, if JUDGED is absent)
- ${outDir}/phase2/AUDITOR-VERDICTS.md  (the auditor's evidence notes)
- ${__roots.INTEL_ROOT}/candidate-ledger-${taskId}.jsonl  (every candidate's terminal state — use for the coverage/accounting section: note DISPROVEN + AUDIT_QUARANTINED counts honestly)`
    : `- ${outDir}/phase1-maps/consolidated/phase1_completion_gate.md and phase2_review_queue.md
- ${outDir}/phase2/**/*.md  (per-feature reports, classes: ${classes.join(', ')})
- ${outDir}/phase2/AUDITOR-VERDICTS.md  (report RUNTIME_CONFIRMED / SOURCE_CONFIRMED / NEEDS_LIVE_VALIDATION findings; note DISPROVEN separately)`
  return `You are SCRIBE, the reporter. Merge the reviewed findings into ONE ${preliminary ? 'PRELIMINARY' : partial ? 'PARTIAL-COVERAGE' : 'final'} code-review report.${prelimBanner}

Inputs (read all):
${inputs}

COVERAGE (deterministic — use these EXACT numbers; do NOT imply the whole codebase was deep-reviewed):
deeply reviewed ${coverage ? coverage.deeplyReviewed : (features ? features.length : 0)} of ${coverage ? coverage.mapped : (features ? features.length : 0)} mapped features${coverage && coverage.capped > 0 ? ` — the other ${coverage.capped} are mapped-only (Phase-2 cap), reviewed at map depth but not deep-assessed` : ''}. Open the report's coverage section with exactly this fact.

Produce an executive white-box code-review report: scope + coverage (features mapped, depth-status rollup), then findings
ordered by CVSS — each tagged with its **confirmation status** (RUNTIME_CONFIRMED / SOURCE_CONFIRMED / NEEDS_LIVE_VALIDATION),
file:line trace, impact, and fix. Be explicit that SOURCE_CONFIRMED means "proven in code, not yet exercised against a
running app"${deployUrl ? '' : ' (this was a source-only review — nothing is RUNTIME_CONFIRMED)'} — never present a source finding as if it were live-proven. Add a recurring-pattern
section (same-functionality classes) and honest gaps. Do NOT include orchestration logs. Keep per-feature structure traceable.

Write the report to ${outDir}/${reportBase}.md AND to ${__roots.INTEL_ROOT}/code-review/${reportBase}.md.
Reply one line: features covered, findings by confirmation status + severity, top risk.`
}

// ── main ──────────────────────────────────────────────────────────────────────
async function runCodeReview(dispatch, deps) {
  const { spawnAgent, trackCosts, updateProgress, log, logActivity, _isTaskCancelled, onFindingsReady, emitCandidate, startStreamingTriage, getQuotaHealth, runJudgeForTask } = deps
  const { taskId, projectId, squad } = dispatch
  const meta = dispatch.meta || {}
  const sourceDir = meta.sourceDir
  // Cancellation parity with the black-box pipeline: the operator's ■ Cancel writes a
  // signal that the daemon turns into task.status='cancelled'. Poll it at every phase
  // boundary so a cancelled white-box run halts between waves instead of grinding on
  // (running agents are already killed by spawnAgent's shared watchdog). Fail-soft.
  const cancelled = () => { try { return typeof _isTaskCancelled === 'function' && _isTaskCancelled(taskId) } catch { return false } }
  const bail = (where) => { log(`🛑 code-review cancelled — halting before ${where}`); return { cancelled: true } }
  // A4 fail-forward: run one agent, never let its failure reject the wave / abort the whole run. Returns
  // the result or null; onFail(err) records the fallout (e.g. mark only THIS feature/job 'blocked').
  const safeSpawn = async (fn, label, onFail) => {
    try { return await fn() }
    catch (e) { log(`⚠️ ${label} failed (fail-forward, run continues): ${(e && e.message) || e}`); try { if (onFail) onFail(e) } catch {} return null }
  }

  const runPhase = (p) => !Array.isArray(meta.phasesOnly) || meta.phasesOnly.length === 0 || meta.phasesOnly.includes(p)
  const outDir = meta.outputDir || `${__roots.INTEL_ROOT}/code-review/${taskId}`
  const deployUrl = meta.deployUrl || null
  const crMode = deployUrl ? 'white-box' : 'static' // S3: stamped on every streamed candidate (parity §7)
  // Step 4 (SPEC §2): holistic review — one session per coherent workstream instead of the feature×class fan-out.
  // Flag-gated (default off) + fail-soft fallback to the standard engine, so current behavior is preserved.
  const HOLISTIC = String(process.env.ARCHON_HOLISTIC_REVIEW || '') === '1'

  // Phase 0 — validate
  updateProgress(4, 'Phase 0: sourceDir validation')
  const p0 = validateSourceDir(sourceDir)
  if (!p0.ok) {
    log(`🚫 Phase 0 failed: ${p0.reason}`)
    logActivity('NEXUS', `🚫 Phase 0 failed: ${p0.reason}`, { taskId, squad, projectId: projectId || '' })
    return { error: p0.reason, phase: 0 }
  }
  // §3: a phasesOnly continuation (e.g. verify/report-only) DELIBERATELY reuses prior artifacts — do NOT archive
  // them or it would delete the evidence it needs. Only a full (fresh) run resets.
  const _isContinuation = Array.isArray(meta.phasesOnly) && meta.phasesOnly.length > 0
  // §4/§6: RESET a prior attempt's artifacts NOW — immediately after source validation, BEFORE any reader/writer
  // (streaming triage, emitCandidate) starts — so a resumed run can never re-triage stale candidates or inherit old
  // quarantines. Archive by rename; if rename fails, COPY (never delete evidence), and if even copy fails, FAIL the
  // attempt rather than run on stale data. (attempt_id = the stamp; artifacts stay keyed by taskId for the readers.)
  if (!_isContinuation) {
    const _stamp = Date.now(); const _archiveFailed = []
    for (const [base, ext] of [['live-findings', 'jsonl'], ['VALIDATED-FINDINGS', 'jsonl'], ['JUDGED-FINDINGS', 'jsonl'], ['candidate-ledger', 'jsonl'], ['findings-detail', 'json'], ['triage-quarantine', 'jsonl'], ['rejected-candidates', 'jsonl'], ['VALIDATED-AUTHORITATIVE', 'flag']]) {
      const p = `${__roots.INTEL_ROOT}/${base}-${taskId}.${ext}`
      if (!fs.existsSync(p)) continue
      const dest = `${p}.attempt-${_stamp}`
      try { fs.renameSync(p, dest) }
      catch { try { fs.copyFileSync(p, dest); fs.unlinkSync(p) } catch { _archiveFailed.push(p) } }  // NEVER unlink without a verified copy
    }
    if (_archiveFailed.length) { log(`🚫 Phase 0: could not archive prior-attempt artifacts (${_archiveFailed.length}) — refusing to run on stale data`); return { error: `could not archive prior attempt artifacts: ${_archiveFailed.join(', ')}`, phase: 0 } }
  }
  const stack = detectStack(sourceDir) // informational label only — behaviour is stack-agnostic
  // Classes: explicit meta.vulnClasses wins; ['all'] = every catalog; otherwise a
  // broad default floor here, refined from the discovered surface after inventories.
  const explicitClasses = Array.isArray(meta.vulnClasses) && meta.vulnClasses.length > 0
  const normalizedExplicitClasses = explicitClasses ? meta.vulnClasses.map(normalizeVulnClass) : []
  let vulnClasses = (explicitClasses
    ? (normalizedExplicitClasses.length === 1 && normalizedExplicitClasses[0] === 'all' ? Object.keys(CLASS) : normalizedExplicitClasses)
    : DEFAULT_CLASSES).filter(c => CLASS[c])
  // NO cap by default — a code review maps EVERY security-relevant feature the source has (real source
  // can be any size / any number of files). An operator may still bound it explicitly via meta.maxFeatures.
  // (Was floor-10/ceil-30, which silently truncated real features — e.g. a 101-file app mapped exactly 10.)
  const maxFeatures = meta.maxFeatures || Infinity
  // A code review must deep-assess EVERY mapped feature — never silently skip one. Default is "all
  // mapped features" (no cap); an operator can still bound it explicitly via meta.maxPhase2. (Was `|| 6`,
  // which quietly dropped features past the top 6 — wrong for static/white-box, where coverage is the point.)
  const maxPhase2 = meta.maxPhase2 || Infinity
  fs.mkdirSync(`${outDir}/phase1-maps/features`, { recursive: true })
  fs.mkdirSync(`${outDir}/phase1-maps/consolidated`, { recursive: true })
  for (const c of vulnClasses) fs.mkdirSync(`${outDir}/phase2/${c}`, { recursive: true })
  const invDir = `${outDir}/phase1-maps/inventories`
  log(`✅ Phase 0: sourceDir=${sourceDir} (${p0.fileCount} code files) · stack=${stack} · classes=${vulnClasses.join(',')}`)
  logActivity('NEXUS', `✅ Phase 0: source valid (${stack})`, {
    taskId, squad, projectId: projectId || '',
    details: `Path: ${sourceDir}\nFiles: ${p0.fileCount}\nStack: ${stack}\nVuln classes: ${vulnClasses.join(', ')}\nOutput: ${outDir}\nDeploy URL: ${deployUrl || '(none — runtime validation skipped)'}`,
  })

  // Phase 0a — inventories
  if (runPhase('inventories')) {
    updateProgress(10, 'Phase 0a: scripted inventory enumeration')
    const invCounts = buildInventories(sourceDir, invDir, stack, log)
    // Auto-select the vuln classes that the discovered surface actually warrants
    // (unless the operator pinned an explicit list).
    if (!explicitClasses) {
      vulnClasses = selectVulnClasses(invCounts)
      for (const c of vulnClasses) fs.mkdirSync(`${outDir}/phase2/${c}`, { recursive: true })
      log(`  🎯 Auto-selected ${vulnClasses.length} vuln classes from surface: ${vulnClasses.join(', ')}`)
    }
  }

  // Phase 0b — App Blueprint (understand the whole system before mapping the parts).
  // Produces app-blueprint.md (architecture / auth model / shared infra / data flow)
  // that discovery + every feature mapper read first — surfaces cross-feature vulns
  // (shared serializer, global middleware, one auth gate) that per-feature passes miss.
  if (cancelled()) return bail('Phase 0b blueprint')
  if (runPhase('blueprint')) {
    updateProgress(13, 'Phase 0b: CURATOR app blueprint')
    logActivity('CURATOR', `🧭 Phase 0b: app blueprint (architecture / auth / shared infra / data flow)`, { taskId, squad, projectId: projectId || '' })
    const bRes = await spawnAgent('curator', taskId, blueprintPrompt(taskId, sourceDir, outDir, invDir), `task-${taskId}-blueprint`, null)
    trackCosts([bRes])
  }

  // Phase 0c — feature queue
  let features = []
  if (Array.isArray(meta.features) && meta.features.length) {
    features = meta.features.map(f => typeof f === 'string' ? { slug: slugify(f), name: f } : f).slice(0, maxFeatures)
    log(`📋 Feature queue from meta.features: ${features.length}`)
  } else if (runPhase('discovery')) {
    updateProgress(16, 'Phase 0c: CURATOR feature discovery')
    const dRes = await spawnAgent('curator', taskId, discoveryPrompt(taskId, sourceDir, outDir, invDir, maxFeatures), `task-${taskId}-discovery`, null)
    trackCosts([dRes])
    try {
      const qf = `${outDir}/phase1-maps/feature-queue.json`
      if (fs.existsSync(qf)) features = JSON.parse(fs.readFileSync(qf, 'utf8')).features || []
      else { const m = (dRes.output || dRes.stdout || '').match(/\[[\s\S]*\]/); if (m) features = JSON.parse(m[0]) }
    } catch (e) { log(`  ⚠️ discovery parse failed: ${e.message}`) }
    features = (features || []).map(f => ({ ...f, slug: slugify(f.slug || f.name) })).slice(0, maxFeatures)
    log(`📋 Discovered ${features.length} features`)
  }
  if (!features.length) {
    log(`🚫 No feature queue — aborting (provide meta.features or enable discovery)`)
    return { error: 'empty feature queue', phase: 'discovery' }
  }

  // ── Phase 1+2 PER-BATCH PIPELINE (S4): fast-map a domain batch, then IMMEDIATELY assess its features
  // (feature × class) before its slot frees — so Phase 2 starts producing findings as soon as the FIRST
  // batch is mapped, not after all N features. Batches process with modest concurrency (BATCH_CONCURRENCY),
  // high-risk domains first. The live streamer + candidate watcher run THROUGHOUT (stopped after freehand).
  if (cancelled()) return bail('Phase 1+2 pipeline')

  // Streamer + candidate watcher — started BEFORE the pipeline so findings stream from the first batch on.
  let _streamer = null
  if (typeof startStreamingTriage === 'function' && (runPhase('phase2') || (FH_MODE !== 'off' && runPhase('freehand')))) {
    try { _streamer = startStreamingTriage(taskId); log(`📥 streaming triage ONLINE — source candidates triaged live as specialists report them`) }
    catch (e) { log(`⚠️ streaming-triage start failed (non-fatal): ${e.message}`) }
  }
  let _candWatch = null
  if (typeof emitCandidate === 'function' && (runPhase('phase2') || (FH_MODE !== 'off' && runPhase('freehand')))) {
    const scan = () => {
      try {
        const base = `${outDir}/phase2`
        let dirs; try { dirs = fs.readdirSync(base, { withFileTypes: true }) } catch { return }
        for (const d of dirs) {
          if (!d.isDirectory()) continue
          const cls = d.name
          const agent = (CLASS[cls] && CLASS[cls].agent) || MAPPER_POOL[0]
          let files; try { files = fs.readdirSync(`${base}/${cls}`) } catch { continue }
          for (const fn of files) {
            if (!fn.endsWith('.candidates.jsonl')) continue
            const slug = fn.replace(/\.candidates\.jsonl$/, '')
            try { emitCandidatesFromFile(`${base}/${cls}/${fn}`, cls, { slug, name: slug }, agent, taskId, emitCandidate, () => {}, sourceDir, crMode) } catch {}
          }
        }
      } catch {}
    }
    _candWatch = setInterval(scan, 10000)
    if (_candWatch.unref) _candWatch.unref()
  }

  let ledger = mappingLedger.load(outDir)
  const _doneJobs = []                 // assess jobs dispatched (for re-plan)
  const _selectedFeatures = new Set()  // features SELECTED for assessment (the maxPhase2 cap counter; high-risk first)
  const _assessedFeatures = new Set()  // features actually reviewed (≥1 Phase-2 job completed) — drives p2Features
  const _featureBySlug = new Map(features.map(f => [f.slug, f])) // slug → full feature obj (+ followups) — drives allFeatures

  // Assess a set of (feature × class) jobs, streaming candidates live. Finding 3: track per-feature success
  // so a feature is "assessed" only if ≥1 of its jobs completed — a feature whose specialists ALL failed is
  // a review coverage gap → blocked (never silently counted as reviewed). Failed jobs are recorded to
  // phase2-failures.jsonl (audit trail). Shared by the main pipeline + follow-up reconciliation.
  const _phase2FailLog = `${outDir}/phase1-maps/phase2-failures.jsonl`
  async function assessBatch(considered, onProgress, concurrency) {
    const jobs = []
    for (const f of considered) for (const cls of vulnClasses) { jobs.push({ cls, feature: f }); _doneJobs.push({ cls, feature: f }) }
    // M6: persist the review queue, then group jobs into PERSISTENT specialist sessions — one session per agent
    // works through MANY (feature × class) jobs in a single call, instead of one fresh spawn per job. Each job
    // keeps its own per-job candidate/report files, so streaming + audit + per-feature accounting are unchanged.
    try { fs.mkdirSync(outDir, { recursive: true }); for (const j of jobs) fs.appendFileSync(`${outDir}/phase2-review-queue.jsonl`, JSON.stringify({ agent: CLASS[j.cls].agent, cls: j.cls, feature: j.feature.slug }) + '\n') } catch {}
    const byAgent = new Map()
    for (const j of jobs) { const a = CLASS[j.cls].agent; if (!byAgent.has(a)) byAgent.set(a, []); byAgent.get(a).push(j) }
    const sessions = [...byAgent.entries()]
    const ok = {}
    const candidatesByFeature = {}   // slug → # candidates emitted (drives candidate_found vs reviewed_no_issue)
    const agentsByFeature = {}        // slug → Set of agents that reviewed it (per-item assigned_agent)
    const reviewConcurrency = Math.max(1, Math.min(sessions.length, concurrency ? Math.min(concurrency, REVIEW_SESSION_CONCURRENCY) : REVIEW_SESSION_CONCURRENCY))
    const res = await runWaves(sessions, reviewConcurrency, async ([agent, ajobs]) => {
      if (cancelled()) return null
      emitRuntimeEvent({ session_id: `review-${agent}`, owner: agent, phase: 'review', status: 'session_start', assigned_total: ajobs.length, message: `${agent} reviewing ${ajobs.length} job(s)` })
      // M6: review sessions are rate-limit-aware — pause + resume, never sleep-block or drop coverage.
      let r = null
      for (let attempt = 0; attempt <= DEFER_MAX_RETRIES; attempt++) {
        r = await safeSpawn(() => spawnAgent(agent, taskId, reviewSessionPrompt(agent, ajobs, taskId, sourceDir, outDir), `task-${taskId}-p2rev-${agent}`, null, { deferOnRateLimit: true }),
          `phase2 ${agent} (${ajobs.length} jobs)`, (e) => { for (const j of ajobs) { try { fs.appendFileSync(_phase2FailLog, JSON.stringify({ feature: j.feature.slug, cls: j.cls, reason: (e && e.message) || String(e) }) + '\n') } catch {} } })
        if (!(r && r.retryable && r.reason === 'rate_limited')) break
        const waitMs = Math.min(DEFER_MAX_WAIT_MS, Math.max(0, new Date(r.cooldownUntil || 0).getTime() - Date.now()))
        emitRuntimeEvent({ session_id: `review-${agent}`, owner: agent, phase: 'review', status: 'rate_limit_pause', attempt: attempt + 1, message: `${agent} rate-limited — resume ${attempt + 1}/${DEFER_MAX_RETRIES} in ${Math.ceil(waitMs / 60000)} min` })
        if (cancelled()) break
        if (waitMs > 0) await sleep(waitMs + 3000)
      }
      const succeeded = !!(r && !r.retryable)
      for (const j of ajobs) {
        (agentsByFeature[j.feature.slug] || (agentsByFeature[j.feature.slug] = new Set())).add(agent)
        if (succeeded) {
          ok[j.feature.slug] = (ok[j.feature.slug] || 0) + 1
          const cf = candFileFor(outDir, j.cls, j.feature.slug)
          if (fs.existsSync(cf) && typeof emitCandidate === 'function') { try { const n = emitCandidatesFromFile(cf, j.cls, j.feature, agent, taskId, emitCandidate, log, sourceDir, crMode); if (n) candidatesByFeature[j.feature.slug] = (candidatesByFeature[j.feature.slug] || 0) + n } catch (e) { log(`  ⚠️ candidate emit [${j.cls}/${j.feature.slug}]: ${e.message}`) } }
        }
        emitRuntimeEvent({ session_id: `review-${agent}`, owner: agent, phase: 'review', feature: j.feature.slug, cls: j.cls, status: succeeded ? 'reviewed' : 'failed', message: `${agent} ${succeeded ? 'reviewed' : 'failed'} ${j.feature.slug}/${j.cls}` })
        if (onProgress) onProgress()
      }
      return r
    })
    trackCosts(res)
    // S6 (parity §4): record the REVIEW dimension — NEVER the mapping status. A failed review stays a review
    // failure; it must not clobber a `done` map. candidate_found vs reviewed_no_issue by whether any candidate
    // streamed for the feature. Per-item fields: assigned_agent(s), finished_at, vulnerability_classes.
    const _now = new Date().toISOString()
    for (const f of considered) {
      const agents = agentsByFeature[f.slug] ? [...agentsByFeature[f.slug]].join(',') : null
      if (ok[f.slug]) {
        _assessedFeatures.add(f.slug)
        const rs = candidatesByFeature[f.slug] ? 'candidate_found' : 'reviewed_no_issue'
        ledger = mappingLedger.setReview(ledger, f.slug, rs, { assigned_agent: agents, finished_at: _now, vulnerability_classes: vulnClasses })
        if (_dispatchBridge) _dispatchBridge.onFeatureReviewed(taskId, f.slug, rs, agents, vulnClasses, crMode)
      } else {
        ledger = mappingLedger.setReview(ledger, f.slug, 'failed', { assigned_agent: agents, finished_at: _now, error: 'all Phase 2 specialists failed' })
        log(`⚠️ ${f.slug}: all Phase 2 jobs failed → review_status=failed (mapping preserved, not a coverage gap)`)
      }
    }
    mappingLedger.save(outDir, ledger)
    return res
  }
  // M2: shared mapping helpers — defined at function scope so the separate reconcile `if` block reuses them.
  const mapExists = (slug) => fs.existsSync(`${outDir}/phase1-maps/features/${slug}.md`)
  // M5: append a Source Runtime event so the dashboard can render a live worker card. Fail-soft — telemetry
  // must never break the run. One line per event: {ts, taskId, session_id, phase, feature, status, ...}.
  const emitRuntimeEvent = (ev) => {
    try { fs.appendFileSync(`${__roots.INTEL_ROOT}/source-runtime-${taskId}.jsonl`, JSON.stringify({ ts: new Date().toISOString(), taskId, ...ev }) + '\n') } catch {}
  }
  // Map ONE batch and record honest per-feature status: done (map file written) · deferred_rate_limit
  // (retryable rate limit — resumes after cooldown, NEVER a coverage gap) · blocked (real miss, no map file).
  const mapAndRecord = async (batch, sessionSuffix) => {
    if (cancelled()) return null
    // Idempotent resume: if every feature in this batch already has a map on disk (e.g. a targeted re-run that
    // reuses a prior scan's mapping), mark them done and SKIP the mapper spawn entirely — no re-map, no tokens.
    if (batch.features.length && batch.features.every(f => mapExists(f.slug))) {
      for (const f of batch.features) ledger = mappingLedger.setFeature(ledger, f.slug, { status: 'done', depth: 'fast' })
      mappingLedger.save(outDir, ledger)
      emitRuntimeEvent({ session_id: batch.id, owner: batch.owner, phase: 'mapping', status: 'reused', assigned_total: batch.features.length, mapped_count: ledger.features_mapped, message: `worker ${batch.owner}: ${batch.features.length} feature(s) already mapped — reused (no re-map)` })
      updateProgress(25 + Math.round(15 * ledger.features_mapped / Math.max(1, ledger.features_total)), mappingStatusLine(ledger, ledger.features_total))
      return null
    }
    for (const f of batch.features) ledger = mappingLedger.setFeature(ledger, f.slug, { status: 'in_progress', owner: batch.owner })
    mappingLedger.save(outDir, ledger)
    emitRuntimeEvent({ session_id: batch.id, owner: batch.owner, phase: 'mapping', status: 'session_start', assigned_total: batch.features.length, message: `worker ${batch.owner} mapping ${batch.features.length} feature(s)` })
    const mr = await safeSpawn(() => spawnAgent(batch.owner, taskId, batchMapPrompt(batch.owner, batch, taskId, sourceDir, outDir, invDir), sessionSuffix, null, { deferOnRateLimit: true }), `batch-map ${batch.id}`)
    const rateLimited = !!(mr && mr.retryable && mr.reason === 'rate_limited')
    for (const f of batch.features) {
      let status
      if (mapExists(f.slug)) { ledger = mappingLedger.setFeature(ledger, f.slug, { status: 'done', depth: 'fast' }); status = 'done' }
      else if (rateLimited) { ledger = mappingLedger.setFeature(ledger, f.slug, { status: 'deferred_rate_limit', cooldownUntil: (mr && mr.cooldownUntil) || null }); status = 'deferred_rate_limit' }
      else { ledger = mappingLedger.setFeature(ledger, f.slug, { status: 'blocked' }); status = 'blocked' }
      emitRuntimeEvent({ session_id: batch.id, owner: batch.owner, phase: 'mapping', feature: f.slug, status, mapped_count: ledger.features_mapped, assigned_total: batch.features.length, message: status === 'done' ? `mapped ${f.slug}` : status === 'deferred_rate_limit' ? `rate-limited on ${f.slug} — will resume` : `no map produced for ${f.slug}` })
      if (_dispatchBridge) _dispatchBridge.onFeatureMapped(taskId, f.slug, status, batch.owner, crMode)
    }
    mappingLedger.save(outDir, ledger)
    trackCosts([mr].filter(Boolean))
    updateProgress(25 + Math.round(15 * ledger.features_mapped / Math.max(1, ledger.features_total)), mappingStatusLine(ledger, ledger.features_total))
    return mr
  }
  // Resume deferred (rate-limited) features: pause until the latest cooldown, re-map, repeat. Bounded by
  // DEFER_MAX_RETRIES; whatever is still rate-limited after that becomes a REPORTED coverage gap, never a
  // silent drop and never counted as mapped. This is the dispatcher-level "pause/resume, never block" loop.
  const drainDeferred = async (label) => {
    for (let attempt = 1; attempt <= DEFER_MAX_RETRIES; attempt++) {
      if (cancelled()) return
      const stuck = mappingLedger.deferred(ledger)
      if (!stuck.length) return
      const waitMs = Math.min(DEFER_MAX_WAIT_MS, Math.max(0, ...stuck.map(f => new Date(f.cooldownUntil || 0).getTime() - Date.now())))
      log(`⏸️ ${label}: ${stuck.length} feature(s) deferred by rate limit — resume ${attempt}/${DEFER_MAX_RETRIES} in ${Math.ceil(waitMs / 60000)} min`)
      emitRuntimeEvent({ phase: 'mapping', status: 'rate_limit_pause', deferred: stuck.length, attempt, resume_in_min: Math.ceil(waitMs / 60000), message: `${label}: ${stuck.length} deferred — resume ${attempt}/${DEFER_MAX_RETRIES} in ${Math.ceil(waitMs / 60000)} min` })
      updateProgress(25 + Math.round(15 * ledger.features_mapped / Math.max(1, ledger.features_total)), mappingStatusLine(ledger, ledger.features_total))
      if (waitMs > 0) await sleep(waitMs + 3000)
      if (cancelled()) return
      const feats = stuck.map(f => _featureBySlug.get(f.slug) || { slug: f.slug, name: (f.name || f.slug), domain: f.domain, risk_hint: f.risk }).filter(Boolean)
      const rb = featureBatching.assignBatches(featureBatching.createBatches(feats, { maxPerBatch: MAX_FEATURES_PER_BATCH }), MAPPER_POOL)
      await runWaves(rb, BATCH_CONCURRENCY, (batch) => mapAndRecord(batch, `task-${taskId}-defer${attempt}-${batch.id}`))
    }
    const left = mappingLedger.deferred(ledger)
    for (const f of left) ledger = mappingLedger.setFeature(ledger, f.slug, { status: 'blocked_coverage_gap', note: `rate-limit retries exhausted after ${DEFER_MAX_RETRIES} attempts` })
    if (left.length) { mappingLedger.save(outDir, ledger); log(`⚠️ ${left.length} feature(s) still rate-limited after ${DEFER_MAX_RETRIES} attempts → blocked_coverage_gap (coverage gap, reported)`) }
  }
  // Step 4: HOLISTIC path — profile → coherent workstreams → one holistic session each (map + all-class review +
  // authz/logic + freehand in one pass). Replaces the mapping + feature×class fan-out. Fail-soft: on any error we
  // fall through to the standard engine below.
  let _holisticDone = false
  let _holisticWsIncomplete = []   // §3: planned workstreams that did not reach a terminal 'completed' state
  // Defensive: clear any stale authoritative-board sentinel so a prior aborted run can't wrongly suppress the writers.
  try { fs.unlinkSync(`${__roots.INTEL_ROOT}/VALIDATED-AUTHORITATIVE-${taskId}.flag`) } catch {}
  if (HOLISTIC && (runPhase('mapping') || runPhase('phase2')) && !cancelled()) {
    const holistic = require('../runtime/holistic-review')
    updateProgress(30, 'Holistic review: one session per coherent workstream')
    const quotaNow = (typeof getQuotaHealth === 'function' ? getQuotaHealth() : 'healthy') || 'healthy'
    // §3: budget against the SMALLEST context window among the lead agents (resolve their real models), not 1M.
    let _leadCtx = 0
    try {
      const modelRouter = require('../routing/model-router'); const { modelContext } = require('../runtime/profiler')
      const leadPool = ['marshal', 'cipher', 'quill', 'siphon', 'breaker']
      _leadCtx = Math.min(...leadPool.map((a) => { try { return modelContext((modelRouter.getModelForAgent(a) || {}).model) } catch { return 200_000 } }))
    } catch { _leadCtx = 0 }
    // F1: ensure the ledger EXISTS before the run (was the null-ledger bug); execution ≠ bookkeeping.
    if (!ledger) { try { ledger = mappingLedger.build(taskId, [{ id: 'holistic', domain: 'app', owner: null, features }]); mappingLedger.save(outDir, ledger) } catch (e) { log(`⚠️ holistic ledger init (non-fatal): ${e.message}`) } }
    // F1: run the SECURITY ANALYSIS in its own try — a bookkeeping/UI failure must NEVER rerun it.
    let hres
    try { hres = await holistic.runHolistic({
      spawnAgent, log, trackCosts, cancelled, runWaves,
      emitFromFile: (file, ws, agent) => { try { return emitCandidatesFromFile(file, 'holistic', { slug: ws.id, name: ws.id }, agent, taskId, emitCandidate, log, sourceDir, crMode) } catch { return 0 } },
    }, { taskId, sourceDir, features, vulnClasses, outDir, quota: quotaNow, mode: crMode, model_context: _leadCtx || undefined }) }
    catch (e) { hres = { status: 'failed_before_start', errors: [e.message], plan: null, coverage: [], candidateCount: 0 }; log(`⚠️ holistic errored before start: ${e.message}`) }

    if (hres.status === 'completed' || hres.status === 'partial') {
      _holisticDone = true // F1: completed/partial ⇒ NEVER run legacy mapping/deep-map/Phase 2
      // §3: record every planned workstream's terminal state; a non-terminal shard is a completion gap.
      _holisticWsIncomplete = (hres.workstream_coverage || []).filter((w) => !w.terminal)
      try { fs.writeFileSync(`${outDir}/workstream-coverage.json`, JSON.stringify({ taskId, workstreams: hres.workstream_coverage || [], oversized: (hres.plan && hres.plan.oversized_workstreams) || [] }, null, 2)) } catch {}
      // F2: materialize per-feature coverage (candidate_found ONLY where candidates exist). Separate try — a
      // bookkeeping failure here does NOT trigger a legacy security re-run.
      try {
        for (const cov of (hres.coverage || [])) {
          // §1: a feature whose holistic session FAILED is a coverage gap → 'blocked', never a clean 'done'.
          const _failed = cov.mapping_status === 'failed' || cov.review_status === 'blocked_coverage_gap'
          ledger = mappingLedger.setFeature(ledger, cov.feature, { status: _failed ? 'blocked' : 'done', depth: cov.depth || 'holistic_complete', note: _failed ? (cov.reason || 'holistic session failed') : undefined })
          ledger = mappingLedger.setReview(ledger, cov.feature, cov.review_status, { candidate_count: cov.candidate_count, files_reviewed: cov.files_reviewed, vulnerability_classes: cov.classes_reviewed })
          if (!_failed) _assessedFeatures.add(cov.feature)
        }
        mappingLedger.save(outDir, ledger)
        // §4: a candidate the matcher could not attribute to a canonical feature is a COVERAGE_ANOMALY — persist
        // it for the UI/report; it stays a real candidate on the board and is NEVER silently reclassified.
        if (hres.anomalies && hres.anomalies.length) {
          try { fs.writeFileSync(`${outDir}/coverage-anomalies.json`, JSON.stringify({ taskId, count: hres.anomalies.length, anomalies: hres.anomalies }, null, 2)) } catch {}
          log(`⚠️ ${hres.anomalies.length} coverage anomal(ies): candidate(s) not attributable to a canonical feature (see coverage-anomalies.json)`)
        }
      } catch (e) { log(`⚠️ holistic ledger materialize (non-fatal): ${e.message}`) }
      // §8: persist the COMPLETE planner output — resolved model + context budget + every workstream's file
      // manifest + token estimate — so the UI/audit artifact reflects what was actually planned, not just counts.
      if (_dispatchBridge && hres.plan) { try { _dispatchBridge.onSessionPlan(taskId, {
        session_count: hres.plan.session_count, active_concurrency: hres.plan.active_concurrency, strategy: hres.plan.strategy,
        reason: hres.plan.reason, features_total: features.length, mode: crMode,
        lead_model: (() => { try { return (require('../routing/model-router').getModelForAgent('marshal') || {}).model } catch { return '' } })(),
        model_context: _leadCtx || (hres.profile && hres.profile.model_context) || null,
        usable_context: hres.plan.usable_context || (hres.profile && hres.profile.usable_context) || null,
        est_tokens: hres.profile && hres.profile.est_tokens, files_total: hres.profile && hres.profile.files,
        workstreams: (hres.plan.workstreams || []).map((w) => ({ id: w.id, features: w.features, files: w.files || [], est_tokens: w.est_tokens, risk: w.risk })),
      }); _dispatchBridge.onCoverage(taskId) } catch {} }
      const withFindings = (hres.coverage || []).filter((c) => c.review_status === 'candidate_found').length
      log(`🧠 Holistic review ${hres.status}: ${hres.plan ? hres.plan.session_count : '?'} session(s), ${hres.candidateCount} candidate(s), ${withFindings}/${features.length} feature(s) with findings — feature×class fan-out skipped`)
    } else {
      // F1: failed_before_start — legacy fallback ONLY if explicitly enabled (default OFF after validation).
      if (String(process.env.ARCHON_LEGACY_REVIEW_FALLBACK || '') === '1') { log(`⚠️ holistic ${hres.status} → legacy fallback (ARCHON_LEGACY_REVIEW_FALLBACK=1)`) }
      else { _holisticDone = true; log(`⚠️ holistic ${hres.status}; legacy fallback OFF → no re-run (set ARCHON_LEGACY_REVIEW_FALLBACK=1 to allow)`) }
    }
  }
  if (!_holisticDone && (runPhase('mapping') || runPhase('phase2'))) {
    // M3: Source Runtime Planner — decide how many persistent worker sessions map the queue, sharded by
    // domain/risk, adjusted for live quota health. Persisted for the UI + consumed by the M4 mapping workers.
    let runtimePlan = null
    try {
      const quota = (typeof getQuotaHealth === 'function' ? getQuotaHealth() : 'healthy') || 'healthy'
      runtimePlan = sourceRuntimePlanner.planSourceRuntime({
        features, vulnClasses, fileCount: (p0 && p0.fileCount) || 0, quota,
        maxSessions: Number.isFinite(meta.maxSessions) ? meta.maxSessions : undefined,
      })
      fs.writeFileSync(`${outDir}/source-runtime-plan.json`, JSON.stringify({ taskId, mode: deployUrl ? 'white-box' : 'static', ...runtimePlan }, null, 2))
      log(`🧭 Source Runtime Planner: ${runtimePlan.features_total} feature(s) → ${runtimePlan.mapping_sessions} mapping session(s), ${runtimePlan.max_concurrent_sessions} concurrent (${runtimePlan.strategy}; quota ${quota})`)
      logActivity('CURATOR', `🧭 Source runtime plan: ${runtimePlan.mapping_sessions} session(s), ${runtimePlan.max_concurrent_sessions} concurrent — ${runtimePlan.reason}`, { taskId, squad, projectId: projectId || '' })
      emitRuntimeEvent({ phase: 'planning', status: 'planned', mapping_sessions: runtimePlan.mapping_sessions, max_concurrent_sessions: runtimePlan.max_concurrent_sessions, strategy: runtimePlan.strategy, quota, assigned_total: runtimePlan.features_total, message: runtimePlan.reason })
      if (_dispatchBridge) _dispatchBridge.onSessionPlan(taskId, { session_count: runtimePlan.mapping_sessions, active_concurrency: runtimePlan.max_concurrent_sessions, strategy: runtimePlan.strategy, reason: runtimePlan.reason, quota_state: quota, features_total: runtimePlan.features_total, mode: crMode })
    } catch (e) { log(`⚠️ Source Runtime Planner (non-fatal): ${e.message}`) }
    // M4: the mapping UNITS are the planner's shards — FEW persistent worker sessions, each mapping a whole
    // shard of features in one long-running call (fewer, longer sessions = less rate-limit pressure). Each
    // shard is a batch object (mapAndRecord + the persistent-worker batchMapPrompt map ALL its features).
    // Fall back to the classic small-batch split only if the planner produced no sessions.
    const shardUnits = (runtimePlan && runtimePlan.sessions && runtimePlan.sessions.length)
      ? runtimePlan.sessions.map((s, i) => ({
          id: s.session_id, owner: MAPPER_POOL[i % MAPPER_POOL.length],
          domain: (s.domain_focus && s.domain_focus.join('+')) || 'misc', risk: 'mixed',
          features: (s.features || []).map((slug) => _featureBySlug.get(slug)).filter(Boolean),
        })).filter((u) => u.features.length)
      : null
    const batches = (shardUnits && shardUnits.length)
      ? shardUnits
      : featureBatching.assignBatches(featureBatching.createBatches(features, { maxPerBatch: MAX_FEATURES_PER_BATCH }), MAPPER_POOL)
    const mapConcurrency = (runtimePlan && runtimePlan.max_concurrent_sessions) || BATCH_CONCURRENCY
    ledger = mappingLedger.build(taskId, batches); mappingLedger.save(outDir, ledger)
    updateProgress(25, `Phase 1: mapping ${features.length} features → ${batches.length} worker session(s), ${mapConcurrency} concurrent`)
    logActivity('CURATOR', `🗺️ Phase 1 mapping: ${features.length} features → ${batches.length} persistent worker session(s) (${mapConcurrency} concurrent) across ${MAPPER_POOL.length} mappers`, { taskId, squad, projectId: projectId || '', details: batches.map(b => `${b.id}(${b.owner})`).join(', ') })
    const ownerOf = {}; for (const b of batches) for (const f of b.features) ownerOf[f.slug] = b.owner
    // 1a. FAST-MAP every shard first (map only) — the "map all first" barrier. mapAndRecord marks a
    // rate-limited mapper's features deferred_rate_limit; drainDeferred then pauses and resumes them so a
    // transient limit never becomes a coverage gap and never counts as mapped. Concurrency = planner's cap.
    if (runPhase('mapping')) {
      await runWaves(batches, mapConcurrency, (batch) => mapAndRecord(batch, `task-${taskId}-batch-${batch.id}`))
      await drainDeferred('fast-map')
    }
    log(`🗺️ Phase 1 fast-map complete: ${ledger.features_mapped}/${ledger.features_total} feature(s) mapped` +
      (ledger.features_deferred ? ` · ${ledger.features_deferred} deferred (rate-limit)` : '') +
      (ledger.features_blocked ? ` · ${ledger.features_blocked} blocked` : ''))
    // 1b. SELECTIVE deep mapping — high-risk features get the full UI→route→authz→service→model→sink chain
    // map, in a SEPARATE wave so deep-map never blocks fast-mapping (it used to hold a batch slot and stall
    // the normal-risk batches). Normal features stay fast (selective by design). Opt out with meta.deepMap:false.
    if (meta.deepMap !== false && runPhase('mapping') && !cancelled()) {
      // M4: shard batches carry mixed risk, so select high-risk FEATURES by their own risk_hint (not batch.risk).
      const highRisk = features.filter(f => String(f.risk_hint || f.risk || '').toLowerCase() === 'high' && mapExists(f.slug))
      if (highRisk.length) {
        for (const f of highRisk) ledger = mappingLedger.setFeature(ledger, f.slug, { depth: 'deep' })
        mappingLedger.save(outDir, ledger)
        updateProgress(40, `Phase 1: deep-mapping ${highRisk.length} high-risk feature(s)`)
        await runWaves(highRisk, MAX_PARALLEL_MAPPERS, async (f) => {
          if (cancelled()) return null
          const dr = await safeSpawn(() => spawnAgent(ownerOf[f.slug], taskId, featureMapPrompt(ownerOf[f.slug], f, taskId, sourceDir, outDir, invDir), `task-${taskId}-deep-${f.slug}`, null, { deferOnRateLimit: true }), `deep-map ${f.slug}`)
          trackCosts([dr].filter(Boolean))
          // Deep succeeded → deep_complete. A rate-limited deep-map (dr.retryable) is skipped, not retried —
          // the fast map already stands, so the feature stays mapped at fast depth (deep is enrichment, not coverage).
          if (dr && !dr.retryable) { ledger = mappingLedger.setFeature(ledger, f.slug, { depth: 'deep_complete' }); mappingLedger.save(outDir, ledger) }
          return null
        })
        log(`🔬 Deep-mapped ${highRisk.length} high-risk feature(s)`)
      }
    }
  }

  // S6: FOLLOW-UP RECONCILIATION + completion gate — nothing may remain only in followup-features.jsonl
  // (§9). Read the followups agents wrote, add genuinely-new features to the ledger + a feature-queue
  // delta, fast-map + assess them; bounded to MAX_FOLLOWUP_ROUNDS so it always terminates. Then the gate:
  // every feature must be terminal — a non-terminal one is a coverage gap marked 'blocked' (never silent, §13).
  if (!_holisticDone && ledger && (runPhase('mapping') || runPhase('phase2'))) {
    const readJsonl = (file) => { try { return fs.readFileSync(file, 'utf8').split('\n').map(l => { try { return JSON.parse(l.trim()) } catch { return null } }).filter(Boolean) } catch { return [] } }
    for (let round = 1; round <= MAX_FOLLOWUP_ROUNDS && !cancelled(); round++) {
      const { newFeatures } = mappingLedger.reconcileFollowups(readJsonl(`${outDir}/phase1-maps/followup-features.jsonl`), ledger)
      if (!newFeatures.length) break
      const fresh = featureBatching.annotate(newFeatures)
      for (const f of fresh) _featureBySlug.set(f.slug, f) // Finding 1: follow-ups join the downstream feature set
      log(`🔁 Reconcile round ${round}: +${fresh.length} new feature(s) from followups`)
      logActivity('CURATOR', `🔁 Reconcile round ${round}: +${fresh.length} follow-up feature(s) mapped`, { taskId, squad, projectId: projectId || '' })
      ledger = mappingLedger.addFeatures(ledger, fresh); mappingLedger.save(outDir, ledger)
      try { fs.writeFileSync(`${outDir}/phase1-maps/feature-queue.delta.json`, JSON.stringify({ round, features: fresh }, null, 2)) } catch {}
      const rBatches = featureBatching.assignBatches(featureBatching.createBatches(fresh, { maxPerBatch: MAX_FEATURES_PER_BATCH }), MAPPER_POOL)
      // reconcile maps only — the follow-up features join the single Phase 2 review pool below the gate.
      // mapAndRecord makes reconcile rate-limit-aware too (deferred, not blocked); drain resumes them.
      await runWaves(rBatches, BATCH_CONCURRENCY, (batch) => mapAndRecord(batch, `task-${taskId}-batchR${round}-${batch.id}`))
      await drainDeferred(`reconcile-r${round}`)
    }
    // A3: nothing may remain ONLY in followup-features.jsonl (§9). After the rounds, any followup slug not
    // in the ledger (more followups than the round budget) → a 'blocked' feature; invalid (no-slug) records
    // → a synthetic 'blocked' entry with a reason. Reported as coverage gaps, never silently dropped.
    {
      const { newFeatures: unresolved, invalid } = mappingLedger.reconcileFollowups(readJsonl(`${outDir}/phase1-maps/followup-features.jsonl`), ledger)
      for (const f of unresolved) { ledger = mappingLedger.addFeatures(ledger, featureBatching.annotate([f])); ledger = mappingLedger.setFeature(ledger, f.slug, { status: 'blocked', note: `unresolved after ${MAX_FOLLOWUP_ROUNDS} follow-up round(s)` }) }
      invalid.forEach((raw, i) => { const slug = `unresolved-followup-${i + 1}`; if (!ledger.features[slug]) { ledger = mappingLedger.addFeatures(ledger, [{ slug, name: (raw && raw.name) || slug, domain: 'misc', risk_hint: 'medium' }]); ledger = mappingLedger.setFeature(ledger, slug, { status: 'blocked', note: 'invalid follow-up record (missing slug)' }) } })
      if (unresolved.length || invalid.length) { mappingLedger.save(outDir, ledger); log(`🔁 Reconcile close-out: ${unresolved.length} unresolved + ${invalid.length} invalid follow-up(s) → blocked (reported, not dropped)`) }
    }
    // M2: the gate must NOT close over rate-limit pauses — give any still-deferred features a final
    // resume pass first (drainDeferred converts only the truly-exhausted ones to blocked_coverage_gap).
    await drainDeferred('completion-gate')
    // Completion gate (§13): any remaining non-terminal feature is a real coverage gap → 'blocked' (never a
    // silent skip). Post-drain these are queued/in-progress features that never produced a map, not rate limits.
    const stuck = mappingLedger.pending(ledger)
    for (const f of stuck) ledger = mappingLedger.setFeature(ledger, f.slug, { status: 'blocked' })
    if (stuck.length) mappingLedger.save(outDir, ledger)
    const nBlocked = mappingLedger.blockers(ledger).length
    log(`✅ Phase 1 completion gate: ${ledger.features_mapped}/${ledger.features_total} mapped · ${ledger.features_accounted}/${ledger.features_total} accounted for${nBlocked ? `, ${nBlocked} blocked (coverage gap — reported, not skipped)` : ''}`)
    // S7: deterministic completion-gate artifact from the ledger (authoritative — the CURATOR consolidation
    // also produces coverage matrices, but this one can never drift from the ledger's truth).
    try { fs.mkdirSync(`${outDir}/phase1-maps`, { recursive: true }); fs.writeFileSync(`${outDir}/phase1-maps/completion-gate.md`, mappingLedger.renderGateMd(ledger)) } catch {}
  }

  // ── PHASE 2 — REVIEW (the hard barrier) ──────────────────────────────────────────────────────────────
  // Mapping is fully complete: every feature is mapped or blocked and the completion gate is written. ONLY
  // NOW do we review — all mapped features × vulnClasses, in controlled waves — STREAMING each confirmed
  // candidate to TRIAGER so the board fills live during review. No feature is reviewed while another is still
  // unmapped; all mapping capacity went to mapping first, then review agents fan out over the completed maps.
  if (!_holisticDone && ledger && runPhase('phase2') && !cancelled()) {
    const mapped = Object.values(ledger.features)
      .filter(f => f.status === 'done' && fs.existsSync(`${outDir}/phase1-maps/features/${f.slug}.md`))
      .map(f => _featureBySlug.get(f.slug) || { slug: f.slug, name: f.name || f.slug })
    const toReview = mapped.slice(0, maxPhase2) // maxPhase2 default Infinity → full coverage
    for (const f of toReview) _selectedFeatures.add(f.slug)
    const totalJobs = toReview.length * vulnClasses.length
    let done = 0
    log(`🔬 Phase 2: reviewing ${toReview.length} mapped feature(s) × ${vulnClasses.length} class(es) = ${totalJobs} job(s)`)
    logActivity('CURATOR', `🔬 Phase 2: reviewing ${toReview.length} mapped features (${totalJobs} jobs) — streaming candidates to the board`, { taskId, squad, projectId: projectId || '' })
    updateProgress(46, `Phase 2: reviewing mapped features 0/${totalJobs}`)
    await assessBatch(toReview, () => { done++; updateProgress(46 + Math.round(30 * done / Math.max(1, totalJobs)), `Phase 2: reviewing mapped features ${done}/${totalJobs}`) }, PHASE2_CONCURRENCY)

    // M3 re-plan (self-tasking) — from the LIVE findings, after the first full review pass.
    try {
      const p2Feats = [..._assessedFeatures].map(slug => (_featureBySlug.get(slug) || { slug }))
      const extra = sourcePlanner.replanJobs(_doneJobs, readLiveFindings(taskId), p2Feats, Object.keys(CLASS))
      if (extra.length) {
        log(`🧠 Re-plan: +${extra.length} follow-up assessment(s) from live findings`)
        logActivity('CURATOR', `🧠 Re-plan: +${extra.length} follow-up job(s) from findings`, { taskId, squad, projectId: projectId || '' })
        try { decisionLog.append(taskId, { agent: 'CURATOR', decision: `re-plan: +${extra.length} follow-up assessment(s)`, reason: 'live findings surfaced feature×class pairs not yet assessed', evidence: extra.map(e => `${e.cls}/${e.feature.slug}`).join(', ').slice(0, 300), task_created: extra.map(e => `p2r-${e.cls}-${e.feature.slug}`).join(', ').slice(0, 300), confidence: 75, result: 'queued', next_recommendation: 'assess the follow-up jobs, then re-triage' }, { intelRoot: __roots.INTEL_ROOT }) } catch {}
        const more = await runWaves(extra, PHASE2_CONCURRENCY, async ({ cls, feature }) => {
          const agent = CLASS[cls].agent
          const r = await spawnAgent(agent, taskId, phase2Prompt(cls, agent, feature, taskId, sourceDir, outDir), `task-${taskId}-p2r-${cls}-${feature.slug}`, null)
          if (typeof emitCandidate === 'function') { try { emitCandidatesFromFile(candFileFor(outDir, cls, feature.slug), cls, feature, agent, taskId, emitCandidate, log, sourceDir, crMode) } catch {} }
          return r
        })
        trackCosts(more)
      }
    } catch (e) { log(`⚠️ re-plan (non-fatal): ${e.message}`) }
    log(`🔬 Phase 2 complete: reviewed ${_assessedFeatures.size} feature(s) over ${_doneJobs.length} job(s)`)
  }

  // The features that were deep-reviewed (feature × class) — what freehand, the report + the return describe.
  // Actual assessed set when Phase 2 ran; else the intended set (freehand-only / phasesOnly runs).
  // Finding 1: the authoritative feature set is the LEDGER's (includes follow-up-created features), not the
  // original discovery array — so consolidation, freehand, Auditor, SCRIBE + the return payload all see the
  // same truth as the ledger-derived counts. p2Features = the assessed subset of that.
  const allFeatures = ledger
    ? Object.keys(ledger.features).map(s => _featureBySlug.get(s) || { slug: s, name: ledger.features[s].name || s })
    : features
  const p2Features = _assessedFeatures.size ? allFeatures.filter(f => _assessedFeatures.has(f.slug)) : allFeatures.slice(0, maxPhase2)

  // Phase 1c — consolidation (AFTER the per-batch pipeline; produces the coverage matrices for the report).
  if (cancelled()) return bail('Phase 1c consolidation')
  // §2: after holistic success the ledger + deterministic completion gate are already materialized, and the
  // M5 block below builds the candidate index deterministically — the legacy CURATOR consolidation session
  // would just re-derive coverage from feature×class maps that holistic never wrote. Skip it.
  if (!_holisticDone && runPhase('consolidate')) {
    updateProgress(78, 'Phase 1c: CURATOR consolidation')
    const cRes = await safeSpawn(() => spawnAgent('curator', taskId, consolidationPrompt(taskId, outDir, allFeatures), `task-${taskId}-consolidate`, null), 'consolidation')
    trackCosts([cRes].filter(Boolean))
  }
  // A2: write the DETERMINISTIC completion gate to the path SCRIBE reads (consolidated/), AFTER consolidation,
  // so the final report can never drift from the ledger's truth (overwrites the CURATOR narrative version).
  if (ledger) {
    try { fs.mkdirSync(`${outDir}/phase1-maps/consolidated`, { recursive: true }); fs.writeFileSync(`${outDir}/phase1-maps/consolidated/phase1_completion_gate.md`, mappingLedger.renderGateMd(ledger)) } catch {}
    if (_dispatchBridge) _dispatchBridge.onCoverage(taskId) // M8-M10/M13: coverage snapshot from the ledger (fail-soft)
  }

  // Phase 3 — freehand senior-pentester review (Autonomous OS Block D, flag-gated).
  // ACTIVE ⇒ candidates land under phase2/freehand/ so the EXISTING phase2/**/*.md
  // glob routes them through AUDITOR Phase 2v + the evidence contract (NOVEL/source-
  // only ⇒ NEEDS-LIVE, never CONFIRMED) with zero verifier/reporter edits. SHADOW ⇒
  // a non-globbed sibling that AUDITOR/SCRIBE never read (report byte-stable).
  if (cancelled()) return bail('Phase 3 freehand')
  // Holistic already reviews every feature freehand-style IN its single session (buildHolisticPrompt step 3),
  // so the legacy per-feature freehand wave would re-review the whole app in N extra sessions — skip it.
  if (!_holisticDone && FH_MODE !== 'off' && runPhase('freehand')) {
    const fhDir = FH_MODE === 'active' ? `${outDir}/phase2/freehand` : `${outDir}/phase3-freehand-shadow`
    fs.mkdirSync(fhDir, { recursive: true })
    const maxFreehand = meta.maxFreehand || maxPhase2
    const fhFeatures = p2Features.slice(0, maxFreehand)
    updateProgress(78, `Phase 3 (freehand): ${fhFeatures.length} features [${FH_MODE}]`)
    logActivity('CURATOR', `🔎 Phase 3 freehand review (${FH_MODE}): ${fhFeatures.length} features`, { taskId, squad, projectId: projectId || '' })
    const fhCandidateCounts = {} // slug → # freehand candidates (applied to the ledger after the waves)
    const results = await runWaves(fhFeatures, WAVE, async (feature, idx) => {
      const agent = MAPPER_POOL[idx % MAPPER_POOL.length]
      const r = await spawnAgent(agent, taskId, freehandPrompt(agent, feature, taskId, sourceDir, outDir, fhDir, vulnClasses), `task-${taskId}-fh-${feature.slug}`, null)
      // Freehand candidates stream to the live board too (M2), through the same sink as Phase 2.
      if (typeof emitCandidate === 'function') {
        try { const n = emitCandidatesFromFile(`${fhDir}/${feature.slug}.candidates.jsonl`, 'freehand', feature, agent, taskId, emitCandidate, log, sourceDir, crMode); if (n) fhCandidateCounts[feature.slug] = (fhCandidateCounts[feature.slug] || 0) + n } catch (e) { log(`  ⚠️ freehand candidate emit [${feature.slug}]: ${e.message}`) }
      }
      return r
    })
    trackCosts(results)
    // §4/§6: freehand can surface a candidate on a feature Phase 2 marked reviewed_no_issue — reflect that on
    // the review dimension (upgrade to candidate_found) and record a separate freehand_candidates count, so the
    // ledger never shows "no issue" for a feature that actually produced one. Applied after the concurrent
    // waves to avoid racing on the shared ledger; mapping status is untouched.
    if (ledger && Object.keys(fhCandidateCounts).length) {
      for (const [slug, n] of Object.entries(fhCandidateCounts)) ledger = mappingLedger.setReview(ledger, slug, 'candidate_found', { freehand_candidates: n })
      mappingLedger.save(outDir, ledger)
    }
  }

  // Stop the mid-run candidate watcher (P2). The post-job emits already captured every file's final
  // state, so no final scan is needed here.
  if (_candWatch) { clearInterval(_candWatch); _candWatch = null }

  // Drain + stop the live streamer before the authoritative AUDITOR pass overwrites the board.
  if (_streamer) {
    try { const n = await _streamer.stop(); log(`📥 streaming triage drained — ${n} finding(s) surfaced live during the run`) }
    catch (e) { log(`⚠️ streaming-triage stop (non-fatal): ${e.message}`) }
    _streamer = null
  }

  // M5: deterministic audit artifacts from the streamed candidates — a deduped, CAND-numbered index +
  // the black-box validation queue (NEEDS-LIVE subset, keyed to CAND-ids for white-box). Fail-soft.
  try {
    const cands = readLiveFindings(taskId).filter(f => f && (f.type === 'candidate' || f.source === 'code-review'))
    if (cands.length) {
      const idx = candidateIndex.buildCandidateIndex(cands)
      const cdir = `${outDir}/phase1-maps/consolidated`
      fs.mkdirSync(cdir, { recursive: true })
      fs.writeFileSync(`${cdir}/candidate_findings_index.md`, candidateIndex.renderIndexMd(idx))
      fs.writeFileSync(`${cdir}/blackbox_validation_queue.md`, candidateIndex.renderQueueMd(candidateIndex.buildValidationQueue(idx)))
      log(`🗂️  Audit artifacts: ${idx.length} candidate(s) indexed → candidate_findings_index.md + blackbox_validation_queue.md`)
    }
  } catch (e) { log(`⚠️ audit-artifact write (non-fatal): ${e.message}`) }

  // Phase 2v — AUDITOR verify (+ PROBER runtime if deployUrl)
  if (cancelled()) return bail('Phase 2v verify')
  if (runPhase('verify')) {
    if (deployUrl) {
      updateProgress(82, 'Phase 2v: PROBER runtime validation')
      const uRes = await safeSpawn(() => spawnAgent('prober', taskId,
        `You are PROBER, runtime validator. Probe the deployed instance at ${deployUrl} (testAccounts: ${JSON.stringify(meta.testAccounts || null)}) to confirm/refute the Phase-2 candidates under ${outDir}/phase2/. Write runtime verdicts to ${outDir}/phase2/PROBER-RUNTIME.md.`,
        `task-${taskId}-prober`, null), 'PROBER runtime validation')
      trackCosts([uRes].filter(Boolean))
    }
    updateProgress(86, 'Phase 2v: AUDITOR reverse-check')
    if (_holisticDone) {
      // §4: reverse-check the ACTUAL streamed candidates (bound by candidate_id + hypothesis), not phase2/*.md.
      const _cands = (() => {
        const byCid = new Map()
        for (const c of readLiveFindings(taskId)) {
          if (!c || !(c.type === 'candidate' || c.source === 'code-review')) continue
          const cid = String(c.candidate_id || c.duplicate_key || c.id || ''); if (!cid || byCid.has(cid)) continue
          byCid.set(cid, { ...c, candidate_id: cid })
        }
        return [...byCid.values()]
      })()
      const verdictsFile = `${outDir}/phase2/AUDITOR-VERDICTS.jsonl`
      try { fs.mkdirSync(`${outDir}/phase2`, { recursive: true }); fs.unlinkSync(verdictsFile) } catch {}
      if (_cands.length) {
        const kRes = await safeSpawn(() => spawnAgent('auditor', taskId, holisticAuditorPrompt(taskId, outDir, _cands, deployUrl), `task-${taskId}-auditor`, null, { timeoutMs: 20 * 60 * 1000 }), 'AUDITOR reverse-check (holistic)')
        trackCosts([kRes].filter(Boolean))
        // §4: a candidate the auditor omitted is AUDIT_RETRYABLE — re-run the auditor for JUST the uncovered ones
        // (one bounded pass) BEFORE reconcile quarantines them, so a flaky auditor never loses a real finding.
        const _covered = () => { const s = new Set(); try { for (const l of fs.readFileSync(verdictsFile, 'utf8').split('\n')) { const t = l.trim(); if (!t) continue; let r; try { r = JSON.parse(t) } catch { r = null } if (r && r.candidate_id) s.add(String(r.candidate_id).trim().toLowerCase()) } } catch {} return s }
        let missing = _cands.filter(c => !_covered().has(String(c.candidate_id).trim().toLowerCase()))
        if (missing.length && !cancelled()) {
          log(`↩️ AUDITOR retry: ${missing.length}/${_cands.length} candidate(s) had no verdict — re-checking just those`)
          const retryFile = `${outDir}/phase2/AUDITOR-VERDICTS-retry.jsonl`
          try { fs.unlinkSync(retryFile) } catch {}
          const rRes = await safeSpawn(() => spawnAgent('auditor', taskId, holisticAuditorPrompt(taskId, outDir, missing, deployUrl, retryFile), `task-${taskId}-auditor-retry`, null, { timeoutMs: 15 * 60 * 1000 }), 'AUDITOR reverse-check retry')
          trackCosts([rRes].filter(Boolean))
          // merge the retry verdicts into the main file (append) so reconcile sees one combined set.
          try { const extra = fs.readFileSync(retryFile, 'utf8'); if (extra.trim()) fs.appendFileSync(verdictsFile, (extra.endsWith('\n') ? extra : extra + '\n')) } catch {}
          missing = _cands.filter(c => !_covered().has(String(c.candidate_id).trim().toLowerCase()))
          if (missing.length) log(`⚠️ AUDITOR retry: ${missing.length} candidate(s) STILL unverified → will be AUDIT_QUARANTINED (fail-closed, kept out of the report)`)
        }
        // §2/§3/§5: rebuild the validated board ATOMICALLY from ALL candidates + the auditor verdicts (candidate_id
        // join), with code-enforced runtime confirmation (deployUrl decides static vs white-box).
        try { reconcileBoardFromVerdicts(taskId, verdictsFile, _cands, log, deployUrl || '') } catch (e) { log(`⚠️ board reconcile (non-fatal): ${e.message}`) }
        // §5 bug#5: refresh coverage telemetry from durable state (deriveCoverage reads the VALIDATED count) so
        // the UI counters reflect the reconciled board, not the pre-triage snapshot.
        if (_dispatchBridge) { try { _dispatchBridge.onCoverage(taskId) } catch {} }
      } else { log(`⚠️ Phase 2v: no candidates to reverse-check`) }
    } else {
      const kRes = await safeSpawn(() => spawnAgent('auditor', taskId, auditorPrompt(taskId, outDir, p2Features, vulnClasses, deployUrl), `task-${taskId}-auditor`, null), 'AUDITOR reverse-check')
      trackCosts([kRes].filter(Boolean))
    }
  }

  // Live-board parity with black-box: AUDITOR verdicts now exist, so surface findings on the board
  // NOW (one phase earlier, ~86%) — the daemon's onFindingsReady hook runs the SAME normalize→triage→
  // enrich chain it would otherwise run only after SCRIBE. Fail-soft; the daemon's end-of-run chain
  // is a guarded fallback if this didn't materialize.
  if (typeof onFindingsReady === 'function' && !cancelled()) {
    try { await onFindingsReady(taskId, outDir) } catch (e) { log(`⚠️ onFindingsReady (non-fatal): ${e.message}`) }
  }

  // Phase 3 — SCRIBE report. A1: coverage is derived from the LEDGER (the single source of truth), so
  // follow-up-created + blocked features are counted correctly — not from the original `features` array.
  const coverage = ledger
    ? { mapped: ledger.features_mapped, deeplyReviewed: p2Features.length, blocked: mappingLedger.blockers(ledger).length, deferred: ledger.features_deferred, capped: Math.max(0, ledger.features_total - p2Features.length) }
    : { mapped: features.length, deeplyReviewed: p2Features.length, capped: Math.max(0, features.length - p2Features.length) }
  // ── §1/§3/§5: JUDGE (validated) → CLOSURE GATE → REPORT-ELIGIBILITY → SCRIBE (all BEFORE the report) ──────
  const _VFpath = `${__roots.INTEL_ROOT}/VALIDATED-FINDINGS-${taskId}.jsonl`
  const _JFpath = `${__roots.INTEL_ROOT}/JUDGED-FINDINGS-${taskId}.jsonl`
  const _reportableIds = () => { const s = new Set(); try { for (const l of fs.readFileSync(_VFpath, 'utf8').split('\n')) { const t = l.trim(); if (!t) continue; let r; try { r = JSON.parse(t) } catch { r = null } if (r && r.candidate_id) s.add(String(r.candidate_id).trim().toLowerCase()) } } catch {} return s }
  // §11: judge output is VALID only on EXACT set equality — every reportable id judged exactly once, with NO
  // foreign ids, NO duplicate verdicts, and NO malformed rows. Anything else is a partial/corrupt judge → BLOCK.
  const _judgeCoverage = () => {
    const want = _reportableIds()
    if (!want.size) return { ok: true, empty: true, want: 0, matched: 0, dup: 0, foreign: 0, malformed: 0 }
    const seen = new Set(); let dup = 0, foreign = 0, malformed = 0, passthrough = 0
    try {
      for (const l of fs.readFileSync(_JFpath, 'utf8').split('\n')) {
        const t = l.trim(); if (!t) continue
        let r; try { r = JSON.parse(t) } catch { r = null }
        // §1/§5/§7: identity + genuine judge_verdict (COMPLETE enum incl. intentional pass-through) + severity.
        const v = _validateJudgedRow(r)
        if (!v.ok) { malformed++; continue }
        if (!want.has(v.id)) { foreign++; continue }
        if (seen.has(v.id)) { dup++; continue }
        seen.add(v.id); if (v.passthrough) passthrough++
      }
    } catch { /* no judged file → matched 0 */ }
    const matched = seen.size
    return { ok: matched === want.size && dup === 0 && foreign === 0 && malformed === 0, empty: false, want: want.size, matched, passthrough, dup, foreign, malformed }
  }

  let _judgeOk = false, _judgeCov = { want: 0, matched: 0 }
  if (_holisticDone && typeof runJudgeForTask === 'function' && !cancelled()) {
    updateProgress(92, 'Phase 3: Judge (before report)')
    if (!_reportableIds().size) {
      // §5: a clean, zero-finding review is a successful NO_FINDINGS_TO_JUDGE no-op — never block its report.
      _judgeOk = true; _judgeCov = { want: 0, matched: 0, empty: true }
      try { fs.writeFileSync(`${__roots.INTEL_ROOT}/JUDGED-FINDINGS-${taskId}.jsonl`, '') } catch {}
      try { fs.writeFileSync(`${outDir}/judge-decision.json`, JSON.stringify({ taskId, decision: 'NO_FINDINGS_TO_JUDGE', reportable: 0 }, null, 2)) } catch {}
      log(`⚖️ No reportable findings — clean review; judge is a NO_FINDINGS_TO_JUDGE no-op (report not blocked)`)
    } else {
      for (let attempt = 1; attempt <= 2 && !_judgeOk && !cancelled(); attempt++) {
        try { await runJudgeForTask(taskId, _VFpath, deployUrl || ''); _judgeCov = _judgeCoverage(); _judgeOk = _judgeCov.ok }
        catch (e) { log(`⚠️ judge attempt ${attempt} (non-fatal): ${e.message}`); _judgeOk = false }
        if (!_judgeOk && attempt < 2) log(`↩️ Judge attempt ${attempt} invalid (matched ${_judgeCov.matched}/${_judgeCov.want}, ${_judgeCov.dup} dup, ${_judgeCov.foreign} foreign, ${_judgeCov.malformed} malformed) — retrying`)
      }
      log(_judgeOk ? `⚖️ Judge ran + exactly covered all ${_judgeCov.want} reportable findings — the report is Judge-gated` : `⛔ Judge invalid after retries (matched ${_judgeCov.matched}/${_judgeCov.want}, ${_judgeCov.dup} dup, ${_judgeCov.foreign} foreign) — final report BLOCKED`)
    }
  } else { _judgeOk = !_holisticDone }   // legacy path is judged by the daemon; not gated here

  // §3/§5: CLOSURE GATE — computed BEFORE SCRIBE so report-eligibility can act on it. A run is COMPLETE only when
  // every candidate is terminal, nothing quarantined, the judge validly covered the board, and no feature blocked.
  let _completionGate = { status: 'COMPLETE', gaps: [] }
  if (_holisticDone) {
    try {
      const _rd = (f) => { try { return fs.readFileSync(`${__roots.INTEL_ROOT}/${f}`, 'utf8').split('\n').map(l => { try { return JSON.parse(l.trim()) } catch { return null } }).filter(Boolean) } catch { return [] } }
      const _ledgerRows = _rd(`candidate-ledger-${taskId}.jsonl`)
      const _triageQ = _rd(`triage-quarantine-${taskId}.jsonl`).length
      const _auditQ = _ledgerRows.filter(r => r.terminal_status === 'AUDIT_QUARANTINED').length
      const _blocked = ledger ? mappingLedger.blockers(ledger).length : 0
      const _reportable = _judgeCov.want, _judgedCov = _judgeCov.matched
      const gaps = []
      if (!_judgeOk) gaps.push(`judge covered ${_judgedCov}/${_reportable} reportable finding(s)${_judgeCov.dup ? `, ${_judgeCov.dup} dup` : ''}${_judgeCov.foreign ? `, ${_judgeCov.foreign} foreign` : ''} — report BLOCKED`)
      if (_auditQ) gaps.push(`${_auditQ} candidate(s) AUDIT_QUARANTINED (no/ambiguous/invalid verdict)`)
      if (_triageQ) gaps.push(`${_triageQ} candidate(s) TRIAGE_QUARANTINED`)
      if (_blocked) gaps.push(`${_blocked} feature(s) blocked (coverage gap)`)
      // §3: a whole workstream (source slice) that failed/was-cancelled/oversized is a coverage gap even if it
      // owned no ledger feature — completion requires ALL planned workstreams terminal.
      if (_holisticWsIncomplete.length) gaps.push(`${_holisticWsIncomplete.length} workstream(s) not terminal (${_holisticWsIncomplete.map((w) => `${w.workstream}:${w.status}`).join(', ')})`)
      const status = !_judgeOk ? 'REPORT_BLOCKED' : (gaps.length ? 'COMPLETE_WITH_GAPS' : 'COMPLETE')
      _completionGate = { status, gaps, candidate_ledger_total: _ledgerRows.length, audit_quarantined: _auditQ, triage_quarantined: _triageQ, judge_valid: _judgeOk, judged_coverage: `${_judgedCov}/${_reportable}` }
      try { fs.writeFileSync(`${outDir}/completion-gate.json`, JSON.stringify({ taskId, ..._completionGate }, null, 2)) } catch {}
      log(status === 'COMPLETE' ? `✅ Completion gate: COMPLETE — ${_ledgerRows.length} candidate(s) terminal, judge-covered, no gaps`
        : status === 'REPORT_BLOCKED' ? `⛔ Completion gate: REPORT_BLOCKED — ${gaps.join('; ')}`
        : `⚠️ Completion gate: COMPLETE_WITH_GAPS — ${gaps.join('; ')}`)
    } catch (e) { log(`⚠️ completion gate (non-fatal): ${e.message}`) }
  }

  // §1/§2: report-eligibility. Holistic + judge invalid ⇒ do NOT publish a "final" report. White-box ⇒ this is a
  // PRELIMINARY source report (live validation runs later), never the final white-box report.
  const _reportBlocked = _holisticDone && !_judgeOk
  // §3: report KIND — PARTIAL COVERAGE has the HIGHEST precedence (an incomplete review must carry the unreviewed-
  // workstream warning even when a live target is configured). Then white-box (deployUrl) ⇒ preliminary; else final.
  const _partialCoverage = _holisticDone && _holisticWsIncomplete.length > 0
  const _reportKind = _partialCoverage ? 'partial' : (deployUrl ? 'preliminary' : 'final')
  const _reportBase = _reportKind === 'preliminary' ? `SOURCE-REVIEW-PRELIMINARY-${taskId}` : _reportKind === 'partial' ? `PARTIAL-COVERAGE-REPORT-${taskId}` : `FINAL-REPORT-${taskId}`
  const _reportPath = `${outDir}/${_reportBase}.md`
  const _wsGapText = _holisticWsIncomplete.map((w) => `${w.workstream}:${w.status}`).join(', ')
  if (cancelled()) return bail('Phase 3 report')
  // §2/§4: clear EVERY stale report variant for this taskId BEFORE evaluating report-eligibility — so a blocked
  // report (SCRIBE skipped) never leaves a prior FINAL/preliminary/partial behind for another consumer to publish,
  // and a produced report is provably from THIS attempt.
  if (_holisticDone && runPhase('report')) {
    for (const _v of [`FINAL-REPORT-${taskId}`, `SOURCE-REVIEW-PRELIMINARY-${taskId}`, `PARTIAL-COVERAGE-REPORT-${taskId}`]) {
      try { fs.unlinkSync(`${outDir}/${_v}.md`) } catch {}
      try { fs.unlinkSync(`${__roots.INTEL_ROOT}/code-review/${_v}.md`) } catch {}
    }
  }
  if (runPhase('report') && !_reportBlocked) {
    updateProgress(94, `Phase 3: SCRIBE ${_reportKind} report`)
    const vRes = await safeSpawn(() => spawnAgent('scribe', taskId, scribePrompt(taskId, projectId, squad, sourceDir, outDir, p2Features, vulnClasses, deployUrl, coverage, _holisticDone, _reportKind, _reportBase, _wsGapText), `task-${taskId}-scribe`, null, { timeoutMs: 30 * 60 * 1000 }), 'SCRIBE report')
    trackCosts([vRes].filter(Boolean))
    // §5: SCRIBE can fail (safeSpawn → null) or write nothing. Verify the report EXISTS + is non-empty before
    // calling the run complete; otherwise the completion gate becomes REPORT_BLOCKED (never a false COMPLETE).
    if (_holisticDone) {
      let _reportBytes = 0; try { _reportBytes = fs.statSync(_reportPath).size } catch {}
      const _reportOk = !!vRes && _reportBytes > 200
      _completionGate.report_kind = _reportKind
      _completionGate.report_generated = _reportOk
      _completionGate.report_path = _reportOk ? _reportPath : ''
      try { if (_reportOk) _completionGate.report_digest = require('crypto').createHash('sha256').update(fs.readFileSync(_reportPath)).digest('hex').slice(0, 16) } catch {}
      if (!_reportOk) {
        _completionGate.status = 'REPORT_BLOCKED'
        _completionGate.gaps = [...(_completionGate.gaps || []), `SCRIBE did not produce a valid report (${_reportBytes} bytes) — report BLOCKED`]
        log(`⛔ Completion gate → REPORT_BLOCKED: SCRIBE produced no valid report at ${_reportPath}`)
      }
      try { fs.writeFileSync(`${outDir}/completion-gate.json`, JSON.stringify({ taskId, ..._completionGate }, null, 2)) } catch {}
    }
  } else if (_reportBlocked) {
    log(`⛔ SCRIBE skipped — final report BLOCKED (judge did not validly cover the board). Fix/retry the judge before publishing.`)
    _completionGate.report_generated = false
  }

  // C2: run-completion invariant — no loose ends: every validated finding carries a valid confirmation
  // status + real evidence, and every ledger feature is terminal. Log violations (a clean run has none).
  try {
    const _validated = (() => { try { return fs.readFileSync(_VFpath, 'utf8').split('\n').map(l => { try { return JSON.parse(l.trim()) } catch { return null } }).filter(Boolean) } catch { return [] } })()
    const _inv = require('../pipeline/completion-invariant').runCompletionInvariant({ findings: _validated, ledger, TERMINAL: mappingLedger.TERMINAL })
    if (_inv.ok) log(`✅ Completion invariant: clean — all findings validated + tiered, all features terminal`)
    else log(`⚠️ Completion invariant: ${_inv.violations.length} issue(s) — ${_inv.violations.slice(0, 5).map(v => `${v.id}:${v.kind}`).join(', ')}`)
  } catch (e) { log(`⚠️ completion invariant (non-fatal): ${e.message}`) }

  updateProgress(100, _completionGate.status === 'COMPLETE' ? 'Complete' : _completionGate.status === 'REPORT_BLOCKED' ? 'Complete (report blocked)' : 'Complete (with gaps)')
  return {
    stack, sourceDir, fileCount: p0.fileCount,
    features: allFeatures.map(f => f.slug),
    featuresMapped: ledger ? ledger.features_mapped : features.length,
    featuresAccountedFor: ledger ? ledger.features_accounted : features.length,
    featuresDeferred: ledger ? ledger.features_deferred : 0,
    blockers: ledger ? mappingLedger.blockers(ledger).length : 0,
    phase2Features: p2Features.map(f => f.slug),
    vulnClasses,
    outputDir: outDir,
    completionGate: _completionGate,   // §3: COMPLETE | COMPLETE_WITH_GAPS (+ gap list)
  }
}

// ── Phase 0 source validation (unchanged contract) ────────────────────────────
function validateSourceDir(sourceDir) {
  if (!sourceDir) return { ok: false, reason: 'missing dispatch.meta.sourceDir' }
  if (typeof sourceDir !== 'string') return { ok: false, reason: 'dispatch.meta.sourceDir must be a string' }
  if (!path.isAbsolute(sourceDir)) return { ok: false, reason: `sourceDir must be absolute path, got: ${sourceDir}` }
  let stat
  try { stat = fs.statSync(sourceDir) } catch (e) {
    return { ok: false, reason: `sourceDir not accessible: ${String(e.message || e).slice(0, 120)}` }
  }
  if (!stat.isDirectory()) return { ok: false, reason: `sourceDir is not a directory: ${sourceDir}` }
  const CODE_EXTS = SOURCE_EXTS.map(e => '.' + e) // same any-language set the inventory grep uses
  let fileCount = 0
  function walk(dir, depth) {
    if (depth > 12) return // deep enough for Maven/Gradle (src/main/java/com/org/…) + monorepo layouts; fileCount>100 bounds the walk
    let entries
    try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      if (fileCount > 100) return
      if (e.name.startsWith('.') || e.name === 'node_modules' || e.name === 'vendor') continue
      const full = path.join(dir, e.name)
      if (e.isDirectory()) walk(full, depth + 1)
      else if (e.isFile() && CODE_EXTS.some(ext => e.name.endsWith(ext))) fileCount++
    }
  }
  walk(sourceDir, 0)
  if (fileCount === 0) {
    return { ok: false, reason: `sourceDir has no recognized code files (~50 extensions checked). Is this a source tree?` }
  }
  return { ok: true, fileCount }
}

module.exports = {
  runCodeReview,
  validateSourceDir,
  reconcileBoardFromVerdicts,
  _validateJudgedRow,
  // exported for tests/introspection
  detectStack,
  buildInventories,
  selectVulnClasses,
  toLiveCandidate,
  candidateConfirmation,
  candidateDedupeKey,
  parseCandidateLine,
  emitCandidatesFromFile,
  DEFAULT_CLASSES,
  CLASS,
  CLASS_ALIASES,
  normalizeVulnClass,
  MAPPER_POOL,
  PHASES,
  phase2Prompt,
  freehandPrompt,
  batchMapPrompt,
  FH_MODE,
}
