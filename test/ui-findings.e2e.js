#!/usr/bin/env node
// Browser e2e for the findings / triage / finding-page UI — catches functional
// bugs the pure unit tests can't (DOM state, per-finding isolation, severity clobber).
// Seeds a temp task + findings, drives the real portal, asserts, cleans up.
// Requires the dashboard running on :4000. Run: node test/ui-findings.e2e.js
const fs = require('fs')
const path = require('path')
const { chromium } = require('playwright')
const INTEL = process.env.KURU_INTEL_ROOT || path.join(__dirname, '..', 'var', 'intel')

const TID = 'e2e-ui-' + process.pid
const tasksFile = path.join(INTEL, 'tasks.json')
const vfFile = path.join(INTEL, `VALIDATED-FINDINGS-${TID}.jsonl`)
const triageFile = path.join(INTEL, `triage-${TID}.json`)

let passed = 0, failed = 0
const ok = (label, cond, extra = '') => cond ? (console.log(`  ✓ ${label}`), passed++) : (console.log(`  ✗ ${label}${extra ? ' — ' + extra : ''}`), failed++)

function seed() {
  const tasks = JSON.parse(fs.readFileSync(tasksFile, 'utf8'))
  tasks.push({ id: TID, squad: 'pentest-squad', assignee: 'ATLAS', status: 'awaiting-triage', progress: 90, title: 'E2E UI Test', goal: 'e2e', createdAt: '2026-01-01T00:00:00Z', lastUpdate: '2026-01-01T00:00:00Z' })
  fs.writeFileSync(tasksFile, JSON.stringify(tasks, null, 2))
  fs.writeFileSync(vfFile, [
    // High WITH a vector (8.8) — severity should render High
    JSON.stringify({ id: 'F-VEC', taskId: TID, severity: 'High', cvss_score: 8.8, cvss_vector: 'CVSS:3.1/AV:N/AC:L/PR:L/UI:N/S:U/C:H/I:H/A:H', title: 'Finding with vector', url: 'http://t/a', method: 'GET' }),
    // High WITHOUT a vector — THE BUG CASE: opening must show High, never Info
    JSON.stringify({ id: 'F-NOVEC', taskId: TID, severity: 'High', cvss_score: 7.5, title: 'High finding no vector', url: 'http://t/b', method: 'GET' }),
    // Info
    JSON.stringify({ id: 'F-INFO', taskId: TID, severity: 'Info', cvss_score: 0, title: 'Info finding' }),
  ].join('\n') + '\n')
}
function cleanup() {
  try { const tasks = JSON.parse(fs.readFileSync(tasksFile, 'utf8')); fs.writeFileSync(tasksFile, JSON.stringify(tasks.filter(t => t.id !== TID), null, 2)) } catch {}
  for (const f of [vfFile, triageFile]) { try { fs.unlinkSync(f) } catch {} }
}

;(async () => {
  console.log('UI findings/triage e2e:')
  seed()
  const b = await chromium.launch({ executablePath: '/usr/bin/chromium', args: ['--no-sandbox'] })
  const p = await b.newPage({ viewport: { width: 1440, height: 1000 } })
  const pageErrors = []
  p.on('pageerror', e => pageErrors.push(e.message))
  try {
    await p.goto('http://localhost:4000', { waitUntil: 'networkidle' }); await p.waitForTimeout(1200)
    await p.click('button[data-view="tasks"]'); await p.waitForTimeout(1500)
    await p.$eval(`[data-taskopen="${TID}"]`, el => el.click()); await p.waitForTimeout(900)
    const openFinding = async (fid) => { await p.$eval(`#tdTabs button[data-td="findings"]`, el => el.click()); await p.waitForTimeout(500); await p.$eval(`#fnList .finding[data-fkey$="::${fid}"]`, el => el.click()); await p.waitForTimeout(500) }

    // ── BUG FIX: open a High finding with NO vector → must show High, not Info ──
    await openFinding('F-NOVEC')
    let sev = await p.$eval('#fdSev', el => el.value)
    let badge = await p.$eval('#fdSevBadge', el => el.textContent.trim())
    ok('open no-vector High finding → severity shows High (not Info)', sev === 'High', 'got ' + sev)
    ok('  header badge matches (High)', badge === 'High', 'got ' + badge)
    let score = await p.$eval('#fdScore', el => el.textContent)
    ok('  shows stored CVSS 7.5 (not calc 0.0)', score === '7.5', 'got ' + score)

    // save WITHOUT touching the calc → must persist High + 7.5, not Info/0
    await p.$eval('#fdSave', el => el.click()); await p.waitForTimeout(900)
    const tri = JSON.parse(fs.readFileSync(triageFile, 'utf8')).verdicts['F-NOVEC']
    ok('save preserves severity High (no clobber to Info)', tri.severity === 'High', JSON.stringify(tri))
    ok('save preserves cvss 7.5 (no clobber to 0)', tri.cvss === 7.5, JSON.stringify(tri))

    // ── vector finding renders its severity ──
    await openFinding('F-VEC')
    sev = await p.$eval('#fdSev', el => el.value)
    ok('open vector finding → severity High', sev === 'High', 'got ' + sev)
    score = await p.$eval('#fdScore', el => el.textContent)
    ok('  vector → computed score 8.8', score === '8.8', 'got ' + score)

    // ── per-finding ISOLATION: open Info after editing another → shows Info ──
    await openFinding('F-INFO')
    sev = await p.$eval('#fdSev', el => el.value)
    ok('open Info finding shows Info (not the previously-opened value)', sev === 'Info', 'got ' + sev)

    // ── calc drives severity only when used: change a metric on F-VEC ──
    await openFinding('F-VEC')
    await p.evaluate(() => { const s = document.querySelector('#fdCvssCalc select[data-m="C"]'); s.value = 'N'; s.dispatchEvent(new Event('change')); const i = document.querySelector('#fdCvssCalc select[data-m="I"]'); i.value = 'N'; i.dispatchEvent(new Event('change')); const a = document.querySelector('#fdCvssCalc select[data-m="A"]'); a.value = 'N'; a.dispatchEvent(new Event('change')) })
    await p.waitForTimeout(300)
    const sevAfter = await p.$eval('#fdSev', el => el.value)
    ok('changing CVSS metrics drives severity down (no-impact → Info)', sevAfter === 'Info', 'got ' + sevAfter)

    // ── list: quick-reject ONE finding isolates to that finding + updates summary ──
    await p.$eval('#fdBack', el => el.click()); await p.waitForTimeout(500)
    const infoBefore = await p.$$eval('#fnSummary .stat', els => { const m = els.find(e => /Info/.test(e.textContent)); return m ? +m.querySelector('.n').textContent : -1 })
    await p.$eval(`#fnList .finding[data-fkey$="::F-INFO"] .fverdict button[data-fv="rejected"]`, el => el.click()); await p.waitForTimeout(300)
    const infoRejected = await p.$eval(`#fnList .finding[data-fkey$="::F-INFO"]`, el => el.classList.contains('rejected'))
    const vecRejected = await p.$eval(`#fnList .finding[data-fkey$="::F-VEC"]`, el => el.classList.contains('rejected'))
    ok('reject F-INFO marks only F-INFO rejected', infoRejected === true)
    ok('reject F-INFO does NOT reject F-VEC (isolation)', vecRejected === false)
    const infoAfter = await p.$$eval('#fnSummary .stat', els => { const m = els.find(e => /Info/.test(e.textContent)); return m ? +m.querySelector('.n').textContent : -1 })
    ok('summary Info count drops on reject', infoAfter === infoBefore - 1, `${infoBefore}→${infoAfter}`)

    // ── REGRESSION: reject → open the finding → it shows rejected → back → STILL rejected ──
    await p.$eval(`#fnList .finding[data-fkey$="::F-INFO"]`, el => el.click()); await p.waitForTimeout(500)
    const rejOn = await p.$eval('#fdVerdict button[data-fv="rejected"]', el => el.classList.contains('on'))
    ok('opening a rejected finding shows Reject selected (not reset to Confirm)', rejOn === true)
    await p.$eval('#fdBack', el => el.click()); await p.waitForTimeout(500)
    const stillRejected = await p.$eval(`#fnList .finding[data-fkey$="::F-INFO"]`, el => el.classList.contains('rejected'))
    ok('finding stays rejected after open→back (no un-reject)', stillRejected === true)
    ok('reject auto-persisted to triage file', (() => { try { return JSON.parse(fs.readFileSync(triageFile, 'utf8')).verdicts['F-INFO'].verdict === 'rejected' } catch { return false } })())

    ok('no uncaught page JS errors during the run', pageErrors.length === 0, pageErrors.join('; '))
  } catch (e) {
    ok('e2e ran without throwing', false, e.message)
  } finally {
    await b.close()
    cleanup()
  }
  console.log(`\n${passed} passed, ${failed} failed`)
  process.exit(failed ? 1 : 0)
})().catch(e => { console.error('THREW', e.stack); cleanup(); process.exit(1) })
