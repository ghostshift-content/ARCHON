#!/usr/bin/env node
// Browser e2e: the combined white-box + black-box dispatch. Fills the pentest form
// with a URL AND a source dir, submits via the real form, and asserts the engagement
// sidecar holds two iterations (black-box live + white-box source) with the source
// dispatch bridged to the live URL. Run with the daemon STOPPED (don't consume inbox).
const fs = require('fs')
const path = require('path')
const { chromium } = require('playwright')
const INTEL = process.env.KURU_INTEL_ROOT || path.join(__dirname, '..', 'var', 'intel')

let passed = 0, failed = 0
const ok = (label, cond, extra = '') => cond ? (console.log(`  ✓ ${label}`), passed++) : (console.log(`  ✗ ${label}${extra ? ' — ' + extra : ''}`), failed++)
const F = n => path.join(INTEL, n)
const SRC = path.resolve(__dirname, '..') // guaranteed-absolute existing dir
let rootId = null, crId = null
function cleanup() {
  const ids = [rootId, crId].filter(Boolean)
  for (const id of ids) for (const f of [`engagement-${id}.json`, `scope-${id}.json`, `pentest-brief-${id}.md`]) { try { fs.unlinkSync(F(f)) } catch {} }
  try { for (const f of fs.readdirSync(F('inbox/task-actions'))) { try { const j = JSON.parse(fs.readFileSync(F('inbox/task-actions/' + f), 'utf8')); if (ids.includes(j.taskId)) fs.unlinkSync(F('inbox/task-actions/' + f)) } catch {} } } catch {}
}

;(async () => {
  console.log('UI white-box + black-box combined dispatch e2e:')
  const b = await chromium.launch({ executablePath: '/usr/bin/chromium', args: ['--no-sandbox'] })
  const p = await b.newPage({ viewport: { width: 1440, height: 1000 } })
  const errs = []; p.on('pageerror', e => errs.push(e.message))
  try {
    await p.goto('http://localhost:4000', { waitUntil: 'networkidle' }); await p.waitForTimeout(1000)
    await p.click('button[data-view="dispatch"]'); await p.waitForTimeout(300)
    await p.selectOption('#fSquad', 'pentest'); await p.waitForTimeout(300)
    // White-box mode (source review + live pentest) → combined engagement (source group hidden until this mode)
    ok('source group hidden in default black-box', await p.$eval('#ptSourceGroup', el => el.style.display === 'none'))
    await p.$eval('#ptMode button[data-v="whitebox"]', el => el.click()); await p.waitForTimeout(200)
    ok('source group shown in White-box mode', await p.$eval('#ptSourceGroup', el => el.style.display !== 'none'))
    await p.fill('#ptUrl', 'http://wb.e2e/')
    await p.fill('#ptSourceDir', SRC)
    await p.fill('#ptInScope', 'wb.e2e')
    const before = new Set(fs.readdirSync(F('inbox/task-actions')))
    await p.$eval('#fSubmit', el => el.click()); await p.waitForTimeout(900)

    // find the engagement sidecar created by this dispatch
    const engFiles = fs.readdirSync(INTEL).filter(f => /^engagement-.*\.json$/.test(f))
      .map(f => ({ f, j: JSON.parse(fs.readFileSync(path.join(INTEL, f), 'utf8')) }))
      .filter(x => x.j.targetUrl === 'http://wb.e2e/')
    ok('engagement sidecar created', engFiles.length === 1, 'got ' + engFiles.length)
    if (engFiles.length === 1) {
      const eng = engFiles[0].j; rootId = eng.engagementId
      ok('engagement has 2 iterations (white + black)', eng.iterations.length === 2)
      const bb = eng.iterations.find(i => i.kind === 'blackbox'); const wb = eng.iterations.find(i => i.kind === 'whitebox')
      ok('black-box iteration is pentest root', bb && bb.squad === 'pentest' && bb.taskId === rootId)
      ok('white-box iteration is code-review', !!(wb && wb.squad === 'code-review')); crId = wb && wb.taskId
      ok('engagement records the source dir', eng.sourceDir === SRC)
      // two NEW inbox dispatches: pentest + code-review(sourceDir, deployUrl)
      const fresh = fs.readdirSync(F('inbox/task-actions')).filter(f => !before.has(f))
        .map(f => JSON.parse(fs.readFileSync(F('inbox/task-actions/' + f), 'utf8')))
      const ptD = fresh.find(j => j.squad === 'pentest-squad' && j.taskId === rootId)
      const crD = fresh.find(j => j.squad === 'code-review-squad' && j.taskId === crId)
      ok('pentest (black-box) dispatch queued', !!ptD)
      ok('code-review (white-box) dispatch queued with source + deployUrl', !!crD && crD.meta.sourceDir === SRC && crD.meta.deployUrl === 'http://wb.e2e/')
    }
    ok('no page errors', errs.length === 0, errs.join(' | '))
  } catch (e) {
    ok('combined dispatch e2e ran without throwing', false, e.message + ' | ' + errs.join(' | '))
  } finally {
    await b.close(); cleanup()
  }
  console.log(`\n${passed} passed, ${failed} failed`)
  process.exit(failed ? 1 : 0)
})().catch(e => { console.error('THREW', e.stack); cleanup(); process.exit(1) })
