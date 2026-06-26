#!/usr/bin/env node
// Browser e2e for the remaining portal flows: per-run tabs (Overview/Findings/Report),
// report open+back, amend, generate-report, navigation back-targets, polling survival.
// Seeds a task + findings + report, drives the real UI, asserts, cleans up.
// IMPORTANT: run with the daemon STOPPED (it would consume the queued inbox actions).
const fs = require('fs')
const path = require('path')
const { chromium } = require('playwright')
const INTEL = process.env.KURU_INTEL_ROOT || path.join(__dirname, '..', 'var', 'intel')

const TID = 'e2e-flow-' + process.pid
const tasksFile = path.join(INTEL, 'tasks.json')
const vfFile = path.join(INTEL, `VALIDATED-FINDINGS-${TID}.jsonl`)
const reportFile = path.join(INTEL, 'reports', `${TID}.md`)
const triageFile = path.join(INTEL, `triage-${TID}.json`)

let passed = 0, failed = 0
const ok = (label, cond, extra = '') => cond ? (console.log(`  ✓ ${label}`), passed++) : (console.log(`  ✗ ${label}${extra ? ' — ' + extra : ''}`), failed++)
const inboxDir = path.join(INTEL, 'inbox', 'task-actions')
const inboxActionsFor = (action) => { try { return fs.readdirSync(inboxDir).map(f => { try { return JSON.parse(fs.readFileSync(path.join(inboxDir, f), 'utf8')) } catch { return {} } }).filter(j => j.action === action && j.taskId === TID) } catch { return [] } }

function seed() {
  const tasks = JSON.parse(fs.readFileSync(tasksFile, 'utf8'))
  tasks.push({ id: TID, squad: 'pentest-squad', assignee: 'KRISHNA', status: 'awaiting-triage', progress: 90, title: 'E2E Flow Test', goal: 'Pentest http://flow.test/ — verify flows', costByAgent: { KRISHNA: 0.5, ARJUN: 0.3 }, costs: [{ agent: 'KRISHNA', model: 'opus', totalCost: 0.5 }, { agent: 'ARJUN', model: 'haiku', totalCost: 0.3 }], totalCost: 0.8, createdAt: '2026-01-01T00:00:00Z', lastUpdate: '2026-01-01T00:00:00Z' })
  fs.writeFileSync(tasksFile, JSON.stringify(tasks, null, 2))
  fs.writeFileSync(vfFile, JSON.stringify({ id: 'FL-1', taskId: TID, severity: 'Medium', cvss_score: 5.3, cvss_vector: 'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:L/I:N/A:N', title: 'Flow finding', url: 'http://flow.test/x', method: 'GET' }) + '\n')
  fs.mkdirSync(path.dirname(reportFile), { recursive: true })
  fs.writeFileSync(reportFile, '# Flow Test Report\n\n## Executive Summary\n\nThis is the seeded report body.\n\n## Findings\n\n- FL-1 Medium\n')
}
function cleanup() {
  try { const t = JSON.parse(fs.readFileSync(tasksFile, 'utf8')); fs.writeFileSync(tasksFile, JSON.stringify(t.filter(x => x.id !== TID), null, 2)) } catch {}
  for (const f of [vfFile, reportFile, triageFile]) { try { fs.unlinkSync(f) } catch {} }
  try { for (const f of fs.readdirSync(inboxDir)) { try { const j = JSON.parse(fs.readFileSync(path.join(inboxDir, f), 'utf8')); if (j.taskId === TID) fs.unlinkSync(path.join(inboxDir, f)) } catch {} } } catch {}
}

;(async () => {
  console.log('UI flows e2e (tabs / report / amend / generate / nav / polling):')
  seed()
  const b = await chromium.launch({ executablePath: '/usr/bin/chromium', args: ['--no-sandbox'] })
  const p = await b.newPage({ viewport: { width: 1440, height: 1000 } })
  const errs = []; p.on('pageerror', e => errs.push(e.message))
  const openTask = async () => { await p.click('button[data-view="tasks"]'); await p.waitForTimeout(900); await p.$eval(`[data-taskopen="${TID}"]`, el => el.click()); await p.waitForTimeout(700) }
  const sub = async (s) => { await p.$eval(`#tdTabs button[data-td="${s}"]`, el => el.click()); await p.waitForTimeout(500) }
  try {
    await p.goto('http://localhost:4000', { waitUntil: 'networkidle' }); await p.waitForTimeout(1200)

    // ── per-run page tabs ──
    await openTask()
    ok('task page opens', await p.$eval('#view-task', el => el.classList.contains('active')))
    await sub('overview')
    const ovText = await p.$eval('#td-overview', el => el.textContent)
    ok('Overview renders run info (squad)', /pentest/.test(ovText))
    ok('Overview renders the goal', /verify flows/.test(ovText))
    ok('Overview shows cost table (agents)', /KRISHNA/.test(ovText) && /ARJUN/.test(ovText))
    ok('Overview shows Amend button (awaiting-triage)', !!(await p.$('#tdAmend')))
    await sub('report')
    const repText = await p.$eval('#tdReportBody', el => el.textContent)
    ok('Report tab renders the report body', /Executive Summary/.test(repText) && /seeded report body/.test(repText))
    await sub('findings')
    ok('Findings tab renders the finding', await p.$(`#fnList .finding[data-fkey$="::FL-1"]`) !== null)

    // ── back nav from task page → tasks ──
    await p.$eval('#tdBack', el => el.click()); await p.waitForTimeout(400)
    ok('task Back → tasks view', await p.$eval('#view-tasks', el => el.classList.contains('active')))

    // ── Reports tab → open report → back ──
    await p.click('button[data-view="reports"]'); await p.waitForTimeout(700)
    const repRow = await p.$(`#reportList [data-ropen="reports/${TID}.md"]`)
    ok('seeded report appears in Reports list', repRow !== null)
    if (repRow) {
      await repRow.click(); await p.waitForTimeout(700)
      ok('report opens full page', await p.$eval('#view-report', el => el.classList.contains('active')))
      ok('report page shows body', /seeded report body/.test(await p.$eval('#repBody', el => el.textContent).catch(() => '')))
      await p.$eval('#repBack', el => el.click()); await p.waitForTimeout(400)
      ok('report Back → reports view', await p.$eval('#view-reports', el => el.classList.contains('active')))
    }

    // ── amend flow ──
    await openTask(); await sub('overview')
    await p.$eval('#tdAmend', el => el.click()); await p.waitForTimeout(500)
    ok('Amend opens amend page', await p.$eval('#view-amend', el => el.classList.contains('active')))
    await p.fill('#amInstr', 'also test the /admin export endpoint')
    await p.fill('#amScope', 'api2.flow.test')
    await p.$eval('#amApply', el => el.click()); await p.waitForTimeout(600)
    ok('Amend apply queues an amend inbox action', inboxActionsFor('amend').length >= 1)
    ok('Amend apply returns to task page', await p.$eval('#view-task', el => el.classList.contains('active')))

    // ── generate-report flow ──
    await sub('findings')
    await p.$eval('#fnGen', el => el.click()); await p.waitForTimeout(700)
    ok('Generate report queues a generate-report inbox action', inboxActionsFor('generate-report').length >= 1)
    ok('Generate report switches to the Report tab', await p.$eval('#td-report', el => el.style.display !== 'none'))

    // ── triage persistence: save then reload reflects it ──
    await sub('findings')
    await p.$eval(`#fnList .finding[data-fkey$="::FL-1"] .fverdict button[data-fv="rejected"]`, el => el.click()); await p.waitForTimeout(150)
    await p.$eval('#fnSave', el => el.click()); await p.waitForTimeout(500)
    ok('triage save persists rejected verdict', (() => { try { return JSON.parse(fs.readFileSync(triageFile, 'utf8')).verdicts['FL-1'].verdict === 'rejected' } catch { return false } })())

    // ── polling survival: finding page survives the 2.5s poll ──
    await p.$eval(`#fnList .finding[data-fkey$="::FL-1"]`, el => el.click()); await p.waitForTimeout(500)
    ok('finding page open', await p.$eval('#view-finding', el => el.classList.contains('active')))
    await p.waitForTimeout(3000) // let the 2.5s poll fire
    ok('finding page still active after poll (not clobbered)', await p.$eval('#view-finding', el => el.classList.contains('active')))
    ok('finding severity field intact after poll', !!(await p.$eval('#fdSev', el => el.value)))

    ok('no uncaught page errors across all flows', errs.length === 0, errs.join(' | '))
  } catch (e) {
    ok('flows ran without throwing', false, e.message + ' | errs: ' + errs.join(' | '))
  } finally {
    await b.close(); cleanup()
  }
  console.log(`\n${passed} passed, ${failed} failed`)
  process.exit(failed ? 1 : 0)
})().catch(e => { console.error('THREW', e.stack); cleanup(); process.exit(1) })
