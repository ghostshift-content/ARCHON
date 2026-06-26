#!/usr/bin/env node
// Browser e2e: the pentest Test-type selector (Black-box / White-box / White+Black).
// Asserts the form reshapes per mode AND each mode routes the dispatch correctly:
//   black-box → pentest (no source) · white-box → code-review · both → combined engagement.
// Run with the daemon STOPPED (don't consume the queued dispatches).
const fs = require('fs')
const path = require('path')
const { chromium } = require('playwright')
const INTEL = process.env.KURU_INTEL_ROOT || path.join(__dirname, '..', 'var', 'intel')
const SRC = path.resolve(__dirname, '..')
const inboxDir = path.join(INTEL, 'inbox', 'task-actions')

let passed = 0, failed = 0
const ok = (label, cond, extra = '') => cond ? (console.log(`  ✓ ${label}`), passed++) : (console.log(`  ✗ ${label}${extra ? ' — ' + extra : ''}`), failed++)
const before = new Set(fs.existsSync(inboxDir) ? fs.readdirSync(inboxDir) : [])
const freshDispatches = () => fs.readdirSync(inboxDir).filter(f => !before.has(f)).map(f => { try { return JSON.parse(fs.readFileSync(path.join(inboxDir, f), 'utf8')) } catch { return {} } }).filter(j => j.action === 'dispatch')
const created = []
function cleanup() {
  try {
    for (const f of fs.readdirSync(inboxDir)) { if (before.has(f)) continue; try { const j = JSON.parse(fs.readFileSync(path.join(inboxDir, f), 'utf8')); created.push(j.taskId); fs.unlinkSync(path.join(inboxDir, f)) } catch {} }
  } catch {}
  for (const id of created) for (const f of [`engagement-${id}.json`, `scope-${id}.json`, `pentest-brief-${id}.md`]) { try { fs.unlinkSync(path.join(INTEL, f)) } catch {} }
  // also engagement sidecars for combined (root + cr child) + their scope files
  try { for (const f of fs.readdirSync(INTEL)) { if (/^engagement-.*\.json$/.test(f)) { const e = JSON.parse(fs.readFileSync(path.join(INTEL, f), 'utf8')); if ((e.iterations || []).some(it => created.includes(it.taskId))) { (e.iterations || []).forEach(it => { try { fs.unlinkSync(path.join(INTEL, `scope-${it.taskId}.json`)) } catch {}; try { fs.unlinkSync(path.join(INTEL, `pentest-brief-${it.taskId}.md`)) } catch {} }); fs.unlinkSync(path.join(INTEL, f)) } } } } catch {}
}

;(async () => {
  console.log('UI test-type mode selector e2e:')
  const b = await chromium.launch({ executablePath: '/usr/bin/chromium', args: ['--no-sandbox'] })
  const p = await b.newPage({ viewport: { width: 1440, height: 1000 } })
  const errs = []; p.on('pageerror', e => errs.push(e.message))
  const setMode = async (m) => { await p.$eval(`#ptMode button[data-v="${m}"]`, el => el.click()); await p.waitForTimeout(200) }
  const vis = (sel) => p.$eval(sel, el => el.style.display !== 'none')
  try {
    await p.goto('http://localhost:4000', { waitUntil: 'networkidle' }); await p.waitForTimeout(1000)
    await p.click('button[data-view="dispatch"]'); await p.waitForTimeout(300)
    await p.selectOption('#fSquad', 'pentest'); await p.waitForTimeout(300)

    // default = black-box
    ok('default black-box: source hidden, black shown', !(await vis('#ptSourceGroup')) && (await vis('#ptBlackGroup')))
    ok('default black-box: URL required marker shown', await vis('#ptUrlReq'))

    // white-box reshapes
    await setMode('whitebox')
    ok('white-box: source group shown', await vis('#ptSourceGroup'))
    ok('white-box: black group hidden', !(await vis('#ptBlackGroup')))
    ok('white-box: scan-strategy hidden', !(await vis('#ptStrategyField')))
    ok('white-box: URL required marker hidden', !(await vis('#ptUrlReq')))
    ok('white-box: URL relabeled "Deployed URL"', /Deployed URL/.test(await p.$eval('#ptUrlLabel', el => el.textContent)))

    // both reshapes
    await setMode('both')
    ok('both: source + black both shown', (await vis('#ptSourceGroup')) && (await vis('#ptBlackGroup')))

    // ── routing: WHITE-BOX → code-review dispatch ──
    await setMode('whitebox')
    await p.fill('#ptSourceDir', SRC)
    await p.fill('#ptUrl', 'https://wbonly.test')
    await p.$eval('#fSubmit', el => el.click()); await p.waitForTimeout(800)
    let d = freshDispatches()
    const wb = d.find(j => j.squad === 'code-review-squad')
    ok('white-box → code-review dispatch', !!wb && wb.meta.sourceDir === SRC)
    ok('white-box → deployUrl bridged from URL', wb && wb.meta.deployUrl === 'https://wbonly.test')
    ok('white-box → NOT a pentest dispatch', !d.some(j => j.squad === 'pentest-squad'))

    // reset form state (success resets to black-box). Re-open dispatch.
    await p.click('button[data-view="dispatch"]'); await p.waitForTimeout(300)
    ok('after dispatch, mode reset to black-box', !(await vis('#ptSourceGroup')))

    // ── routing: BLACK-BOX → pentest dispatch, no source ──
    await p.fill('#ptUrl', 'https://bbonly.test'); await p.fill('#ptInScope', 'bbonly.test')
    await p.$eval('#fSubmit', el => el.click()); await p.waitForTimeout(800)
    d = freshDispatches()
    const bb = d.find(j => j.squad === 'pentest-squad' && j.meta.targetUrl === 'https://bbonly.test')
    ok('black-box → pentest dispatch', !!bb)
    ok('black-box → no sourceDir in meta', bb && !bb.meta.sourceDir)

    // ── routing: BOTH → combined engagement (pentest + code-review iterations) ──
    await p.click('button[data-view="dispatch"]'); await p.waitForTimeout(300)
    await setMode('both')
    await p.fill('#ptUrl', 'https://bothx.test'); await p.fill('#ptSourceDir', SRC); await p.fill('#ptInScope', 'bothx.test')
    await p.$eval('#fSubmit', el => el.click()); await p.waitForTimeout(800)
    d = freshDispatches()
    const root = d.find(j => j.squad === 'pentest-squad' && j.meta.targetUrl === 'https://bothx.test')
    const child = d.find(j => j.squad === 'code-review-squad' && j.meta.deployUrl === 'https://bothx.test')
    ok('both → pentest (black-box) dispatch on the live URL', !!root && root.meta.engagementId === root.taskId)
    ok('both → paired code-review (white-box) dispatch with source', !!child && child.meta.sourceDir === SRC)
    // the engagement sidecar ties them together as one combined run
    const engFile = fs.existsSync(path.join(INTEL, `engagement-${root && root.taskId}.json`))
    ok('both → engagement sidecar links the two iterations', engFile)

    ok('no page errors', errs.length === 0, errs.join(' | '))
  } catch (e) {
    ok('mode e2e ran without throwing', false, e.message + ' | ' + errs.join(' | '))
  } finally {
    await b.close(); cleanup()
  }
  console.log(`\n${passed} passed, ${failed} failed`)
  process.exit(failed ? 1 : 0)
})().catch(e => { console.error('THREW', e.stack); cleanup(); process.exit(1) })
