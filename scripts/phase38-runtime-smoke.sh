#!/bin/bash
# /root/agents/scripts/phase38-runtime-smoke.sh
#
# Synthetic Phase 3.8 runtime smoke test. Loads the PRODUCTION-installed
# browser-verifier and runs it against two test fixtures:
#   - dom-xss-fires.html (vulnerable, must produce browser_fired=true CONFIRMED)
#   - dom-xss-blocked.html (safe textContent, must produce browser_fired=false KILLED)
#
# Use this after daemon updates / Chromium upgrades to verify the Phase 3.8
# Playwright runtime is functional WITHOUT spending money on a pentest dispatch.
#
# Exit codes:
#   0 = both verdicts correct (FIRE path proven)
#   1 = wrong verdicts
#   2 = crash before verdict
#
# Run: bash /root/agents/scripts/phase38-runtime-smoke.sh

set -e
cd "$(dirname "$0")/.."

node <<'JS'
const path = require('path')

;(async () => {
  const browserVerifier = require('./agents/browser-verifier')
  const FIXTURE_DIR = path.resolve(__dirname, 'test/fixtures/browser-validator')

  async function run(name, fixture, payload, expectedFired) {
    const recipe = {
      finding_id: `PROD-SMOKE-${name}`,
      finding_type: 'dom-xss',
      description: `prod runtime smoke (${name})`,
      steps: [
        { action: 'navigate', url: `file://${path.join(FIXTURE_DIR, fixture)}#${payload}` },
        { action: 'wait_for', timeout_ms: 1000 },
        { action: 'evaluate', expression: 'window.__xss_fired__ === true' }
      ],
      verdict_rule: { expected_evaluation_results: [{ step_index: 2, equals: true }] }
    }
    const r = await browserVerifier.verifyRecipe(recipe, { allowFileUrls: true })
    const ok = r.executed && r.browser_fired === expectedFired
    const sym = ok ? '✅' : '❌'
    console.log(`${sym} ${name}: browser_fired=${r.browser_fired} verdict=${r.verdict} (expected fired=${expectedFired})`)
    return ok
  }

  const payload = '%3Cimg%20src=x%20onerror=window.__xss_fired__=true%3E'

  const results = await Promise.all([])  // sequential — see below
  const r1 = await run('vulnerable', 'dom-xss-fires.html', payload, true)
  const r2 = await run('safe',       'dom-xss-blocked.html', payload, false)

  if (r1 && r2) {
    console.log('\n✅ PROD-SMOKE PASSED — Phase 3.8 Playwright runtime is functional')
    process.exit(0)
  }
  console.log('\n❌ PROD-SMOKE FAILED')
  process.exit(1)
})().catch(e => {
  console.error('FATAL:', e.message)
  process.exit(2)
})
JS
