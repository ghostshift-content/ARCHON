#!/usr/bin/env node
// Unit tests for the engagement model — N independent iterations per dispatch,
// findings aggregation, per-iteration triage routing, and non-breaking standalone behaviour.
const assert = require('assert')
const fs = require('fs')
const path = require('path')
const d = require('../scripts/dashboard')

let passed = 0, failed = 0
const ok = (label, cond, extra = '') => cond ? (console.log(`  ✓ ${label}`), passed++) : (console.log(`  ✗ ${label}${extra ? ' — ' + extra : ''}`), failed++)
const F = n => path.join(d.INTEL, n)
const seedFindings = (tid, arr) => fs.writeFileSync(F(`VALIDATED-FINDINGS-${tid}.jsonl`), arr.map(x => JSON.stringify({ taskId: tid, ...x })).join('\n') + '\n')
const created = []
function track(tid) { created.push(tid); return tid }
function cleanup() {
  for (const tid of created) for (const f of [`scope-${tid}.json`, `pentest-brief-${tid}.md`, `VALIDATED-FINDINGS-${tid}.jsonl`, `triage-${tid}.json`, `engagement-${tid}.json`]) { try { fs.unlinkSync(F(f)) } catch {} }
  try { for (const f of fs.readdirSync(F('inbox/task-actions'))) { try { const j = JSON.parse(fs.readFileSync(F('inbox/task-actions/' + f), 'utf8')); if (created.includes(j.taskId)) fs.unlinkSync(F('inbox/task-actions/' + f)) } catch {} } } catch {}
}

;(async () => {
  console.log('engagement model (N iterations):')
  cleanup()
  // ── iteration 1 (root) via createDispatch ──
  const r1 = d.createDispatch({ squad: 'pentest', meta: { targetUrl: 'https://eng.test', inScope: ['eng.test'], credentials: [{ username: 'admin', password: 'p', role: 'admin' }], focusClasses: ['xss'] } })
  const E = track(r1.taskId)
  const eng = d.readEngagement(E)
  ok('engagement sidecar created', !!eng && eng.engagementId === E)
  ok('iteration 1 label = XSS', eng.iterations[0].label === 'XSS', JSON.stringify(eng.iterations))

  // ── iteration 2 via iterateDispatch (access-control) ──
  const r2 = d.iterateDispatch({ engagementId: E, focusClasses: ['access-control'] })
  track(r2.taskId)
  ok('iteration 2 created with engagement link', r2.engagementId === E && r2.iterationLabel === 'Access control')
  const eng2 = d.readEngagement(E)
  ok('engagement now has 2 iterations', eng2.iterations.length === 2)
  ok('iteration 2 inherits scope', (() => { const s = JSON.parse(fs.readFileSync(F(`scope-${r2.taskId}.json`), 'utf8')); return s.in_scope.includes('eng.test') })())
  ok('iteration 2 inherits credentials (brief)', fs.readFileSync(F(`pentest-brief-${r2.taskId}.md`), 'utf8').includes('admin'))
  ok('resolveEngagementId(iteration2) → root', d.resolveEngagementId(r2.taskId) === E)

  // ── seed findings on each iteration, aggregate ──
  seedFindings(E, [{ id: 'X-1', severity: 'High', cvss_score: 7.1, title: 'Stored XSS', url: 'http://eng.test/a' }])
  seedFindings(r2.taskId, [{ id: 'AC-1', severity: 'Critical', cvss_score: 9.1, title: 'IDOR', url: 'http://eng.test/b' }, { id: 'AC-2', severity: 'Medium', cvss_score: 5.0, title: 'Missing authz', url: 'http://eng.test/c' }])
  const agg = d.findingsForTask(E)
  ok('aggregates findings across both iterations (3 total)', agg.total === 3, 'got ' + agg.total)
  ok('counts span iterations (1 Crit, 1 High, 1 Med)', agg.counts.Critical === 1 && agg.counts.High === 1 && agg.counts.Medium === 1, JSON.stringify(agg.counts))
  ok('each finding tagged with its iteration label', agg.findings.find(f => f.id === 'X-1').iteration === 'XSS' && agg.findings.find(f => f.id === 'AC-1').iteration === 'Access control')
  ok('unique composite keys (no collision across iterations)', new Set(agg.findings.map(f => f.key)).size === 3)
  ok('iteration breakdown counts', agg.iterations.find(i => i.taskId === E).count === 1 && agg.iterations.find(i => i.taskId === r2.taskId).count === 2)
  // opening from an ITERATION resolves to the same aggregated engagement
  ok('findingsForTask(iteration2) aggregates the whole engagement', d.findingsForTask(r2.taskId).total === 3)

  // ── byTask triage routing: reject in iteration 2 must NOT touch iteration 1 ──
  d.saveTriage({ byTask: { [r2.taskId]: { 'AC-2': { verdict: 'rejected' } } } })
  ok('triage routed to iteration 2 file', JSON.parse(fs.readFileSync(F(`triage-${r2.taskId}.json`), 'utf8')).verdicts['AC-2'].verdict === 'rejected')
  ok('iteration 1 triage file untouched (no cross-impact)', !fs.existsSync(F(`triage-${E}.json`)))
  const agg2 = d.findingsForTask(E)
  ok('rejected finding reflected on reload', agg2.findings.find(f => f.id === 'AC-2').triage.verdict === 'rejected')
  ok('other iteration findings unaffected', agg2.findings.find(f => f.id === 'X-1').triage === null)

  // ── standalone task (no engagement) stays single-iteration / non-breaking ──
  const solo = track('eng-solo-' + process.pid)
  seedFindings(solo, [{ id: 'S-1', severity: 'Low', cvss_score: 3.0, title: 'solo' }])
  const sres = d.findingsForTask(solo)
  ok('standalone task → engagementId = itself', sres.engagementId === solo)
  ok('standalone task → single iteration', sres.iterations.length === 1 && sres.total === 1)
  ok('standalone finding still gets a composite key', sres.findings[0].key === solo + '::S-1')

  // ── COMBINED white-box + black-box engagement (sourceDir + URL) ──
  const srcDir = path.resolve(__dirname, '..')   // guaranteed-absolute existing dir
  const rc = d.createDispatch({ squad: 'pentest', meta: { targetUrl: 'https://combo.test', inScope: ['combo.test'], credentials: [{ username: 'u', password: 'p', role: 'admin' }], sourceDir: srcDir } })
  const CE = track(rc.taskId)
  const ceng = d.readEngagement(CE)
  ok('combined: engagement has 2 iterations', ceng.iterations.length === 2)
  ok('combined: root is black-box pentest', ceng.iterations[0].squad === 'pentest' && ceng.iterations[0].kind === 'blackbox' && ceng.iterations[0].label === 'Black-box (live)')
  const cr = ceng.iterations[1]; track(cr.taskId)
  ok('combined: 2nd is white-box code-review', cr.squad === 'code-review' && cr.kind === 'whitebox' && cr.label === 'White-box (source)')
  ok('combined: cr taskId distinct from root', cr.taskId !== CE)
  ok('combined: engagement records sourceDir', ceng.sourceDir === srcDir)
  ok('combined: scope-<crTaskId>.json written (Phase 0.0 for UTTARA)', fs.existsSync(F(`scope-${cr.taskId}.json`)))
  // two inbox dispatches: pentest-squad + code-review-squad(meta.sourceDir, deployUrl=URL)
  const inbox = fs.readdirSync(F('inbox/task-actions')).map(f => { try { return JSON.parse(fs.readFileSync(F('inbox/task-actions/' + f), 'utf8')) } catch { return {} } })
  const ptD = inbox.find(j => j.taskId === CE && j.squad === 'pentest-squad')
  const crD = inbox.find(j => j.taskId === cr.taskId && j.squad === 'code-review-squad')
  ok('combined: pentest dispatch queued', !!ptD)
  ok('combined: code-review dispatch queued with sourceDir', !!crD && crD.meta && crD.meta.sourceDir === srcDir)
  ok('combined: code-review deployUrl bridged to live URL', crD && crD.meta && crD.meta.deployUrl === 'https://combo.test')

  // mixed-squad aggregation: a black-box live finding + a white-box source finding
  seedFindings(CE, [{ id: 'BB-1', severity: 'High', cvss_score: 7.4, title: 'Reflected XSS (live)', url: 'http://combo.test/q' }])
  seedFindings(cr.taskId, [{ id: 'WB-1', severity: 'Critical', cvss_score: 9.1, title: 'IDOR (source)', url: '', file: 'app/controllers/orders.rb', line: 42 }])
  const cagg = d.findingsForTask(CE)
  ok('combined: aggregates across mixed squads (2 total)', cagg.total === 2, 'got ' + cagg.total)
  ok('combined: iteration labels carried onto findings', cagg.findings.find(f => f.id === 'BB-1').iteration === 'Black-box (live)' && cagg.findings.find(f => f.id === 'WB-1').iteration === 'White-box (source)')
  ok('combined: unique composite keys across squads', new Set(cagg.findings.map(f => f.key)).size === 2)
  ok('combined: opening from white-box iteration aggregates whole engagement', d.findingsForTask(cr.taskId).total === 2)

  // byTask triage across squads: reject the white-box finding → only its triage file
  d.saveTriage({ byTask: { [cr.taskId]: { 'WB-1': { verdict: 'rejected' } } } })
  ok('combined: triage routed to white-box iteration', JSON.parse(fs.readFileSync(F(`triage-${cr.taskId}.json`), 'utf8')).verdicts['WB-1'].verdict === 'rejected')
  ok('combined: black-box iteration finding stays confirmed (no cross-impact)', (() => { try { const v = JSON.parse(fs.readFileSync(F(`triage-${CE}.json`), 'utf8')).verdicts['BB-1']; return !v || v.verdict === 'confirmed' } catch { return true } })())
  ok('combined: rejection reflected on reload', d.findingsForTask(CE).findings.find(f => f.id === 'WB-1').triage.verdict === 'rejected')

  cleanup()
  console.log(`\n${passed} passed, ${failed} failed`)
  process.exit(failed ? 1 : 0)
})().catch(e => { console.error('THREW', e.stack); cleanup(); process.exit(1) })
