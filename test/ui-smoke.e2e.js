#!/usr/bin/env node
// Broad UI smoke e2e — drives every view, the dispatch forms (all squads), and the
// key interactions, asserting ZERO uncaught page errors. Catches runtime/state bugs
// across the whole portal. Read-only (no dispatch submitted). Needs dashboard on :4000.
const { chromium } = require('playwright')

let passed = 0, failed = 0
const ok = (label, cond, extra = '') => cond ? (console.log(`  ✓ ${label}`), passed++) : (console.log(`  ✗ ${label}${extra ? ' — ' + extra : ''}`), failed++)

;(async () => {
  console.log('UI smoke e2e (all views + dispatch forms):')
  const b = await chromium.launch({ executablePath: '/usr/bin/chromium', args: ['--no-sandbox'] })
  const p = await b.newPage({ viewport: { width: 1440, height: 1000 } })
  const errs = []
  p.on('pageerror', e => errs.push('pageerror: ' + e.message))
  p.on('console', m => { if (m.type() === 'error') errs.push('console.error: ' + m.text()) })
  const errsAt = () => errs.slice()
  try {
    await p.goto('http://localhost:4000', { waitUntil: 'networkidle' }); await p.waitForTimeout(1500)
    ok('boots with no page errors', errs.length === 0, errsAt().join(' | '))
    ok('daemon pill rendered', await p.$eval('#daemonText', el => !!el.textContent))
    ok('stats rendered', await p.$$eval('#stats .stat', els => els.length >= 4))
    ok('squad selector populated', await p.$$eval('#fSquad option', els => els.length >= 1))

    // ── every nav view ──
    for (const v of ['overview', 'tasks', 'findings-not-a-nav', 'dispatch', 'squads', 'reports', 'activity']) {
      const btn = await p.$(`button[data-view="${v}"]`)
      if (!btn) continue
      const before = errs.length
      await btn.click(); await p.waitForTimeout(400)
      const active = await p.$eval(`#view-${v}`, el => el.classList.contains('active')).catch(() => false)
      ok(`nav → ${v} activates + no errors`, active && errs.length === before, errsAt().slice(before).join(' | '))
    }

    // ── dispatch form: each squad shows the right fields, no errors ──
    await p.click('button[data-view="dispatch"]'); await p.waitForTimeout(300)
    const squads = await p.$$eval('#fSquad option', els => els.map(o => o.value))
    for (const sq of squads) {
      const before = errs.length
      await p.selectOption('#fSquad', sq); await p.waitForTimeout(250)
      const cr = await p.$eval('#crFields', el => el.style.display !== 'none')
      const pt = await p.$eval('#ptFields', el => el.style.display !== 'none')
      const goal = await p.$eval('#fGoalField', el => el.style.display !== 'none')
      const correct = sq === 'code-review' ? (cr && !pt && !goal)
        : sq === 'pentest' ? (pt && !cr && !goal)
        : (goal && !cr && !pt)
      ok(`squad "${sq}" → correct fields + no errors`, correct && errs.length === before, `cr=${cr} pt=${pt} goal=${goal} ${errsAt().slice(before).join('|')}`)
    }

    // ── pentest form interactions ──
    await p.selectOption('#fSquad', 'pentest'); await p.waitForTimeout(250)
    const before = errs.length
    // feature toggle reveals focus field
    await p.$eval('#ptType button[data-v="feature"]', el => el.click()); await p.waitForTimeout(150)
    ok('feature mode reveals focus field', await p.$eval('#ptFocusField', el => el.style.display !== 'none'))
    await p.$eval('#ptType button[data-v="full"]', el => el.click()); await p.waitForTimeout(150)
    ok('full mode hides focus field', await p.$eval('#ptFocusField', el => el.style.display === 'none'))
    // focus chip toggle
    await p.$eval('#ptFocusClasses button[data-cls="xss"]', el => el.click()); await p.waitForTimeout(100)
    ok('focus chip toggles on', await p.$eval('#ptFocusClasses button[data-cls="xss"]', el => el.classList.contains('on')))
    await p.$eval('#ptFocusClasses button[data-cls="xss"]', el => el.click()); await p.waitForTimeout(100)
    ok('focus chip toggles off', await p.$eval('#ptFocusClasses button[data-cls="xss"]', el => !el.classList.contains('on')))
    // skip-recon checkbox
    await p.$eval('#ptSkipRecon', el => el.click())
    ok('skip-recon checkbox toggles', await p.$eval('#ptSkipRecon', el => el.checked === true))
    // credential rows add/remove
    const rows0 = await p.$$eval('#ptCreds .credrow', els => els.length)
    await p.$eval('#ptAddCred', el => el.click()); await p.waitForTimeout(100)
    const rows1 = await p.$$eval('#ptCreds .credrow', els => els.length)
    ok('add credential row', rows1 === rows0 + 1, `${rows0}→${rows1}`)
    await p.$eval('#ptCreds .credrow:last-child .cx', el => el.click()); await p.waitForTimeout(100)
    ok('remove credential row', (await p.$$eval('#ptCreds .credrow', els => els.length)) === rows0)
    ok('pentest interactions raised no errors', errs.length === before, errsAt().slice(before).join(' | '))

    // ── validation: empty pentest URL → error toast, no crash, stays on dispatch ──
    await p.fill('#ptUrl', '')
    const beforeV = errs.length
    await p.$eval('#fSubmit', el => el.click()); await p.waitForTimeout(400)
    const stillDispatch = await p.$eval('#view-dispatch', el => el.classList.contains('active'))
    ok('empty-URL submit blocked (stays on dispatch, no crash)', stillDispatch && errs.length === beforeV, errsAt().slice(beforeV).join(' | '))

    // ── test-type mode selector reshapes the pentest form (black-box / static / white-box) ──
    await p.selectOption('#fSquad', 'pentest'); await p.waitForTimeout(250)
    ok('default black-box: source group hidden', await p.$eval('#ptSourceGroup', el => el.style.display === 'none'))
    await p.$eval('#ptMode button[data-v="static"]', el => el.click()); await p.waitForTimeout(150)
    ok('static-analysis mode: source group shown', await p.$eval('#ptSourceGroup', el => el.style.display !== 'none'))
    ok('static-analysis mode: black group hidden', await p.$eval('#ptBlackGroup', el => el.style.display === 'none'))
    await p.$eval('#ptMode button[data-v="whitebox"]', el => el.click()); await p.waitForTimeout(150)
    ok('white-box mode: source AND black both shown', await p.$eval('#ptSourceGroup', el => el.style.display !== 'none') && await p.$eval('#ptBlackGroup', el => el.style.display !== 'none'))
    await p.$eval('#ptMode button[data-v="blackbox"]', el => el.click()); await p.waitForTimeout(150)
    ok('back to black-box: source group hidden again', await p.$eval('#ptSourceGroup', el => el.style.display === 'none'))

    ok('TOTAL: zero uncaught errors across the whole sweep', errs.length === 0, errs.join(' | '))
  } catch (e) {
    ok('smoke ran without throwing', false, e.message + ' | errs: ' + errs.join(' | '))
  } finally {
    await b.close()
  }
  console.log(`\n${passed} passed, ${failed} failed`)
  process.exit(failed ? 1 : 0)
})().catch(e => { console.error('THREW', e.stack); process.exit(1) })
