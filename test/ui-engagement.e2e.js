#!/usr/bin/env node
// Browser e2e for the engagement model: open an engagement → findings aggregate across
// iterations (tagged + filterable), triage on one iteration doesn't touch another, and
// "Run another test" launches a new independent iteration. Run with the daemon STOPPED.
const fs = require('fs')
const path = require('path')
const { chromium } = require('playwright')
const INTEL = process.env.KURU_INTEL_ROOT || path.join(__dirname, '..', 'var', 'intel')

const E = 'e2e-eng-' + process.pid          // engagement root / iteration 1
const IT2 = 'e2e-eng2-' + process.pid        // iteration 2
const tasksFile = path.join(INTEL, 'tasks.json')
const inboxDir = path.join(INTEL, 'inbox', 'task-actions')

let passed = 0, failed = 0
const ok = (label, cond, extra = '') => cond ? (console.log(`  ✓ ${label}`), passed++) : (console.log(`  ✗ ${label}${extra ? ' — ' + extra : ''}`), failed++)
const F = n => path.join(INTEL, n)
const seedFindings = (tid, arr) => fs.writeFileSync(F(`VALIDATED-FINDINGS-${tid}.jsonl`), arr.map(x => JSON.stringify({ taskId: tid, ...x })).join('\n') + '\n')

function seed() {
  const tasks = JSON.parse(fs.readFileSync(tasksFile, 'utf8'))
  tasks.push({ id: E, squad: 'pentest-squad', assignee: 'KRISHNA', status: 'awaiting-triage', progress: 90, title: 'E2E Engagement', goal: 'Pentest http://eng.e2e/', createdAt: '2026-01-01T00:00:00Z', lastUpdate: '2026-01-01T00:00:00Z' })
  fs.writeFileSync(tasksFile, JSON.stringify(tasks, null, 2))
  fs.writeFileSync(F(`engagement-${E}.json`), JSON.stringify({
    engagementId: E, targetUrl: 'http://eng.e2e/', inScope: ['eng.e2e'], outOfScope: [], credentials: [], severityProfile: 'comprehensive', triageGate: true,
    iterations: [{ taskId: E, label: 'XSS' }, { taskId: IT2, label: 'Access control' }],
  }, null, 2))
  seedFindings(E, [{ id: 'X-1', severity: 'High', cvss_score: 7.1, title: 'Stored XSS', url: 'http://eng.e2e/a' }])
  seedFindings(IT2, [{ id: 'AC-1', severity: 'Critical', cvss_score: 9.1, title: 'IDOR exposes orders', url: 'http://eng.e2e/b' }])
}
function cleanup() {
  try { const t = JSON.parse(fs.readFileSync(tasksFile, 'utf8')); fs.writeFileSync(tasksFile, JSON.stringify(t.filter(x => x.id !== E), null, 2)) } catch {}
  // remove the engagement + every iteration's artifacts (incl. any spawned by "Run another test")
  let iters = [E, IT2]
  try { iters = iters.concat((JSON.parse(fs.readFileSync(F(`engagement-${E}.json`), 'utf8')).iterations || []).map(i => i.taskId)) } catch {}
  for (const tid of [...new Set(iters)]) for (const f of [`VALIDATED-FINDINGS-${tid}.jsonl`, `triage-${tid}.json`, `scope-${tid}.json`, `pentest-brief-${tid}.md`]) { try { fs.unlinkSync(F(f)) } catch {} }
  try { fs.unlinkSync(F(`engagement-${E}.json`)) } catch {}
  try { for (const f of fs.readdirSync(inboxDir)) { try { const j = JSON.parse(fs.readFileSync(path.join(inboxDir, f), 'utf8')); if (iters.includes(j.taskId) || (j.meta && j.meta.engagementId === E)) fs.unlinkSync(path.join(inboxDir, f)) } catch {} } } catch {}
}

;(async () => {
  console.log('UI engagement e2e (iterations / aggregation / isolation / run-another):')
  seed()
  const b = await chromium.launch({ executablePath: '/usr/bin/chromium', args: ['--no-sandbox'] })
  const p = await b.newPage({ viewport: { width: 1440, height: 1000 } })
  const errs = []; p.on('pageerror', e => errs.push(e.message))
  try {
    await p.goto('http://localhost:4000', { waitUntil: 'networkidle' }); await p.waitForTimeout(1200)
    await p.click('button[data-view="tasks"]'); await p.waitForTimeout(1200)
    await p.$eval(`[data-taskopen="${E}"]`, el => el.click()); await p.waitForTimeout(900)
    await p.$eval(`#tdTabs button[data-td="findings"]`, el => el.click()); await p.waitForTimeout(700)

    // findings aggregate across both iterations
    ok('XSS finding present (iteration 1)', await p.$(`#fnList .finding[data-fkey$="::X-1"]`) !== null)
    ok('Access-control finding present (iteration 2)', await p.$(`#fnList .finding[data-fkey$="::AC-1"]`) !== null)
    ok('finding carries iteration tag', /Access control/.test(await p.$eval(`#fnList .finding[data-fkey$="::AC-1"]`, el => el.textContent)))
    const critCount = await p.$$eval('#fnSummary .stat', els => { const m = els.find(e => /Critical/.test(e.textContent)); return m ? +m.querySelector('.n').textContent : -1 })
    ok('summary aggregates iterations (1 Critical from iteration 2)', critCount === 1, 'got ' + critCount)

    // iteration filter chips present (2 iterations)
    ok('iteration filter chips shown', (await p.$$eval('#fnIterBar .iter-chip', els => els.length)) >= 3) // All + 2

    // filter to Access control → only AC finding visible
    await p.evaluate(() => { const chips = [...document.querySelectorAll('#fnIterBar .iter-chip')]; const ac = chips.find(c => /Access control/.test(c.textContent)); ac.click() })
    await p.waitForTimeout(300)
    ok('filter Access control → AC finding visible', await p.$(`#fnList .finding[data-fkey$="::AC-1"]`) !== null)
    ok('filter Access control → XSS finding hidden', await p.$(`#fnList .finding[data-fkey$="::X-1"]`) === null)

    // reject the AC finding → iteration 2 triage written, iteration 1 untouched
    await p.$eval(`#fnList .finding[data-fkey$="::AC-1"] .fverdict button[data-fv="rejected"]`, el => el.click()); await p.waitForTimeout(400)
    ok('reject routed to iteration 2 triage', (() => { try { return JSON.parse(fs.readFileSync(F(`triage-${IT2}.json`), 'utf8')).verdicts['AC-1'].verdict === 'rejected' } catch { return false } })())
    // iteration 1's finding must NOT be rejected by an iteration-2 action (cross-impact check)
    ok('iteration 1 finding stays confirmed (no cross-impact)', (() => { try { const v = JSON.parse(fs.readFileSync(F(`triage-${E}.json`), 'utf8')).verdicts['X-1']; return !v || v.verdict === 'confirmed' } catch { return true } })())

    // run another test → launches a 3rd independent iteration
    await p.evaluate(() => { const chips = [...document.querySelectorAll('#fnIterBar .iter-chip')]; const all = chips.find(c => /^All/.test(c.textContent)); if (all) all.click() })
    await p.waitForTimeout(200)
    await p.$eval('#fnRunAnother', el => el.click()); await p.waitForTimeout(200)
    ok('Run-another form opens', await p.$eval('#fnIterForm', el => el.style.display !== 'none'))
    await p.$eval('#itFocusClasses button[data-cls="sqli"]', el => el.click())
    await p.$eval('#itRun', el => el.click()); await p.waitForTimeout(700)
    const eng = JSON.parse(fs.readFileSync(F(`engagement-${E}.json`), 'utf8'))
    ok('new iteration appended to engagement (now 3)', eng.iterations.length === 3, 'got ' + eng.iterations.length)
    ok('new iteration label = SQLi', eng.iterations[2].label === 'SQLi', JSON.stringify(eng.iterations[2]))
    const newTid = eng.iterations[2].taskId
    ok('new iteration queued a dispatch (independent run)', (() => { try { return fs.readdirSync(inboxDir).some(f => { const j = JSON.parse(fs.readFileSync(path.join(inboxDir, f), 'utf8')); return j.action === 'dispatch' && j.taskId === newTid && j.meta.engagementId === E }) } catch { return false } })())
    ok('new iteration inherits scope (eng.e2e)', (() => { try { return JSON.parse(fs.readFileSync(F(`scope-${newTid}.json`), 'utf8')).in_scope.includes('eng.e2e') } catch { return false } })())

    ok('no uncaught page errors', errs.length === 0, errs.join(' | '))
  } catch (e) {
    ok('engagement e2e ran without throwing', false, e.message + ' | errs: ' + errs.join(' | '))
  } finally {
    await b.close(); cleanup()
  }
  console.log(`\n${passed} passed, ${failed} failed`)
  process.exit(failed ? 1 : 0)
})().catch(e => { console.error('THREW', e.stack); cleanup(); process.exit(1) })
