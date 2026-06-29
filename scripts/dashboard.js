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
    if (!OFFSEC.has(id)) continue // portal is offensive-security-only — hide stocks & non-offsec squads (presentation filter; backend logic untouched)
    out.push({
      id,
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

function daemonUp() {
  // heuristic: heartbeat or tasks file touched recently, OR a node event-bus proc
  try {
    const hb = path.join(INTEL, 'task-heartbeats.json')
    if (fs.existsSync(hb) && (Date.now() - fs.statSync(hb).mtimeMs) < 120000) return true
  } catch {}
  return false
}

function state() {
  return {
    now: new Date().toISOString(),
    intel: INTEL, agents: AGENTS,
    daemon: daemonUp(),
    tasks: tasks(),
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

// Build a code-review meta block from the form, validated.
function buildCodeReviewMeta(body) {
  const m = (body.meta && typeof body.meta === 'object') ? body.meta : {}
  const sourceDir = String(m.sourceDir || '').trim()
  if (!sourceDir) throw new Error('code-review needs a source directory (meta.sourceDir)')
  if (!path.isAbsolute(sourceDir)) throw new Error('sourceDir must be an absolute path')
  const out = { sourceDir }
  if (m.preset === 'gitlab' || m.preset === 'generic') out.preset = m.preset // omit = auto-detect
  const VALID_CLASSES = ['access-control', 'xss', 'sqli', 'ssrf', 'rce', 'account-takeover']
  if (Array.isArray(m.vulnClasses)) {
    const vc = m.vulnClasses.filter(c => VALID_CLASSES.includes(c))
    if (vc.length) out.vulnClasses = vc
  }
  if (m.deployUrl && /^https?:\/\//.test(String(m.deployUrl))) out.deployUrl = String(m.deployUrl)
  if (m.testAccounts && typeof m.testAccounts === 'object') out.testAccounts = m.testAccounts // UTTARA runtime-validation auth
  if (Number.isFinite(+m.maxFeatures) && +m.maxFeatures > 0) out.maxFeatures = Math.min(50, Math.floor(+m.maxFeatures))
  if (Number.isFinite(+m.maxPhase2) && +m.maxPhase2 > 0) out.maxPhase2 = Math.min(50, Math.floor(+m.maxPhase2))
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
  // skip-recon: go straight to authenticated functionality / specialist testing
  const skipRecon = m.skipRecon === true
  // focused scan: run only specific vuln classes instead of full A→Z (empty = full)
  const focusClasses = cleanFocus(m.focusClasses)
  // custom focus: free-text directive for vulns/areas not in the chip list
  // (e.g. cache poisoning, request smuggling, OAuth abuse). Steers recon + testing.
  const customFocus = String(m.customFocus || '').trim().slice(0, 600)
  return { targetUrl, testType, ...(featureFocus ? { featureFocus } : {}), inScope, outOfScope, credentials, triageGate, severityProfile, skipRecon, focusClasses, ...(customFocus ? { customFocus } : {}) }
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
${meta.customFocus ? `
## ⭐ PRIORITY FOCUS (operator directive — test this first and thoroughly)
${meta.customFocus}

This is a specific, operator-requested focus that may not map to a standard specialist lane. During recon AND testing, prioritise it: research the technique, find the relevant surface, and attempt it before/alongside standard coverage. Report results for it explicitly.
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
  const meta = {
    targetUrl: eng.targetUrl, inScope: eng.inScope || [], outOfScope: eng.outOfScope || [], credentials: eng.credentials || [],
    testType, ...(testType === 'feature' ? { featureFocus } : {}),
    triageGate: eng.triageGate !== false, severityProfile: eng.severityProfile || 'comprehensive',
    skipRecon: body.skipRecon === true, focusClasses: cleanFocus(body.focusClasses), engagementId: E,
  }
  meta.iterationLabel = deriveIterationLabel(meta)
  const taskId = 't-' + Date.now() + '-' + crypto.randomBytes(2).toString('hex')
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
  let fallbackTitle = goal
  if (isCodeReview) fallbackTitle = `Code review: ${path.basename(meta.sourceDir)}`
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
      crMeta.engagementId = taskId
      // scope config so the code-review iteration's live (PROBER) hits pass Phase 0.0
      try {
        fs.writeFileSync(path.join(INTEL, `scope-${crTaskId}.json`),
          JSON.stringify({ in_scope: meta.inScope, out_of_scope: meta.outOfScope, infra_dependencies: {} }, null, 2))
      } catch {}
      iterations.push({ taskId: crTaskId, label: 'White-box (source)', createdAt: new Date().toISOString(), squad: 'code-review', kind: 'whitebox' })
    }

    writeEngagement(taskId, {
      engagementId: taskId, targetUrl: meta.targetUrl, inScope: meta.inScope, outOfScope: meta.outOfScope,
      credentials: meta.credentials, severityProfile: meta.severityProfile, triageGate: meta.triageGate,
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
function titleSev(s) {
  const v = String(s || '').toLowerCase()
  if (v.startsWith('crit')) return 'Critical'
  if (v.startsWith('high')) return 'High'
  if (v.startsWith('med')) return 'Medium'
  if (v.startsWith('low')) return 'Low'
  return 'Info'
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
  // 1) AUDITOR-validated findings (the trusted set).
  for (const f of validated.filter(f => !f.taskId || String(f.taskId) === id)) {
    const d = detail[f.id] || {}
    const poc = d.poc || f.reproduction_method || f.reproduction || ''
    if (f.url) seenUrls.add(_normUrl(f.url))
    const cvss = typeof d.cvss_score === 'number' ? d.cvss_score : (typeof f.cvss_score === 'number' ? f.cvss_score : (f.cvss || null))
    out.push({
      key: id + '::' + f.id, srcTask: id, iteration: label || '',
      id: f.id, severity: titleSev(f.severity), title: f.title || f.id,
      cvss,
      cvssVector: d.cvss_vector || f.cvss_vector || '',
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
      rawRequest: d.raw_request || f.raw_request || f.http_request || synthRawRequest(f.method, f.url, poc),
      judge: (judgeBy[f.id] && (judgeBy[f.id].verdict || judgeBy[f.id].judgement)) || '',
      enriched: !!detail[f.id], triage: triage[f.id] || null, source: 'validated',
    })
  }
  // 2) Raw agent findings (live-findings) not already covered by a validated entry.
  let n = 0
  for (const f of live) {
    const u = _normUrl(f.url)
    if (u && seenUrls.has(u)) continue
    n++
    const fid = `LF-${n}`
    out.push({
      key: id + '::' + fid, srcTask: id, iteration: label || '',
      id: fid, severity: titleSev(f.severity), title: _liveTitle(f),
      cvss: null, cvssVector: '', cwe: f.cwe || '', testSteps: [],
      // lifecycle: the finding agent's own claim — NOT yet validator-confirmed (amber, not green)
      stage: _liveStatus(f) === 'CONFIRMED' ? 'agent-confirmed' : 'suspected',
      agent: f.agent || '', status: _liveStatus(f) === 'CONFIRMED' ? 'AGENT-CONFIRMED' : 'SUSPECTED',
      url: f.url || '', method: '',
      description: f.details || '', poc: f.reproduction || '', validation: '',
      impact: f.impact || '', remediation: '',
      rawRequest: synthRawRequest('GET', f.url, f.reproduction),
      judge: '', enriched: false, triage: triage[fid] || null, source: 'live',
    })
  }
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
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' })
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
    if (req.method === 'GET' && p === '/api/findings') {
      return json(res, 200, findingsForTask(url.searchParams.get('taskId') || ''))
    }
    if (req.method === 'GET' && p === '/api/iterations') {
      return json(res, 200, iterationsForTask(url.searchParams.get('taskId') || ''))
    }
    if (req.method === 'GET' && p === '/api/logs') {
      return json(res, 200, logsForTask(url.searchParams.get('taskId') || ''))
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
