#!/usr/bin/env node
const __roots = require('../paths') // portable roots (KURU_*_ROOT) — see paths.js
// Integration test for code-review-dispatcher — phase1-maps methodology.
// Mocks spawnAgent (no real LLM) to assert the full pipeline wiring:
//   Phase 0 validate → 0a inventories → 0b feature queue → 1 per-feature mapping
//   → 1c consolidation → 2 per-feature×class assessment → 2v AUDITOR verify → 3 SCRIBE.
// Run: node test/code-review-dispatcher-integration.test.js

const assert = require('assert')
const fs = require('fs')
const path = require('path')
const os = require('os')
const cr = require('../src/dispatch/code-review-dispatcher')

let passed = 0, failed = 0
function ok(label, cond, extra = '') {
  if (cond) { console.log(`  ✓ ${label}`); passed++ }
  else { console.log(`  ✗ ${label}${extra ? ' — ' + extra : ''}`); failed++ }
}

function makeSourceDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codereview-'))
  fs.writeFileSync(path.join(dir, 'app.rb'), 'get "/users" do\n  current_user\nend\n')
  fs.writeFileSync(path.join(dir, 'service.rb'), 'class FooService\n  def execute; end\nend\n')
  return dir
}
function stubDeps(spawnCalls) {
  return {
    spawnAgent: async (agentName, taskId, prompt, sessionSuffix) => {
      spawnCalls.push({ agentName, sessionSuffix, promptLen: prompt.length })
      if (sessionSuffix && sessionSuffix.includes('discovery')) {
        return { code: 0, agentName, cost: { totalCost: 0.1, model: 'm', tokens: { total: 1 } },
          output: JSON.stringify([{ slug: 'auth', name: 'Auth', keywords: 'login,token' }, { slug: 'uploads', name: 'Uploads', keywords: 'upload,file' }]) }
      }
      return { code: 0, agentName, cost: { totalCost: 0.2, model: 'm', tokens: { total: 1 } }, output: '{}' }
    },
    trackCosts: () => {}, updateProgress: () => {}, log: () => {}, logActivity: () => {},
  }
}

;(async () => {
  console.log('code-review-dispatcher integration (phase1-maps methodology):')

  // ── Test 1: explicit features, no deployUrl ──
  {
    const srcDir = makeSourceDir()
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crout-'))
    const calls = []
    const res = await cr.runCodeReview(
      { taskId: 'cr-test-1', squad: 'code-review-squad', projectId: '',
        meta: { sourceDir: srcDir, preset: 'generic', features: ['auth', 'uploads', 'admin'],
                vulnClasses: ['access-control', 'xss'], maxPhase2: 2, outputDir: outDir } },
      stubDeps(calls))

    ok('returns no error', !res.error, JSON.stringify(res).slice(0, 120))
    ok('preset=generic', res.preset === 'generic')
    ok('3 features mapped', res.featuresMapped === 3, 'got ' + res.featuresMapped)
    ok('inventories written to disk', fs.existsSync(path.join(outDir, 'phase1-maps/inventories/00_MANIFEST.md')))
    ok('phase2 class dirs created', fs.existsSync(path.join(outDir, 'phase2/access-control')) && fs.existsSync(path.join(outDir, 'phase2/xss')))

    const mapCalls = calls.filter(c => c.sessionSuffix.includes('-map-'))
    ok('one mapping agent per feature (3)', mapCalls.length === 3, 'got ' + mapCalls.length)
    ok('mapping agents drawn from specialist pool', mapCalls.every(c => cr.MAPPER_POOL.includes(c.agentName)))
    ok('CURATOR consolidates', calls.some(c => c.sessionSuffix.includes('consolidate') && c.agentName === 'curator'))

    const p2 = calls.filter(c => c.sessionSuffix.includes('-p2-'))
    ok('phase2 = maxPhase2(2) × classes(2) = 4 calls', p2.length === 4, 'got ' + p2.length)
    ok('access-control routed to MARSHAL', p2.some(c => c.sessionSuffix.includes('p2-access-control') && c.agentName === 'marshal'))
    ok('xss routed to CIPHER', p2.some(c => c.sessionSuffix.includes('p2-xss') && c.agentName === 'cipher'))
    ok('AUDITOR verifies', calls.some(c => c.agentName === 'auditor'))
    ok('PROBER skipped (no deployUrl)', !calls.some(c => c.agentName === 'prober'))
    ok('SCRIBE reports last', calls[calls.length - 1].agentName === 'scribe')
  }

  // ── Test 2: generic discovery path ──
  {
    const srcDir = makeSourceDir()
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crout-'))
    const calls = []
    await cr.runCodeReview(
      { taskId: 'cr-test-2', squad: 'code-review-squad', projectId: '',
        meta: { sourceDir: srcDir, preset: 'generic', vulnClasses: ['access-control'], outputDir: outDir } },
      stubDeps(calls))
    ok('discovery ran (CURATOR)', calls.some(c => c.sessionSuffix.includes('discovery') && c.agentName === 'curator'))
    ok('discovered 2 features → 2 mapping agents', calls.filter(c => c.sessionSuffix.includes('-map-')).length === 2, 'got ' + calls.filter(c => c.sessionSuffix.includes('-map-')).length)
  }

  // ── Test 3: gitlab preset loads 43; phasesOnly gates ──
  {
    const srcDir = makeSourceDir()
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crout-'))
    const calls = []
    const res = await cr.runCodeReview(
      { taskId: 'cr-test-3', squad: 'code-review-squad', projectId: '',
        meta: { sourceDir: srcDir, preset: 'gitlab', phasesOnly: ['inventories'], outputDir: outDir } },
      stubDeps(calls))
    ok('gitlab preset → 43 features', res.featuresMapped === 43, 'got ' + res.featuresMapped)
    ok('phasesOnly=[inventories] → no agents spawned', calls.length === 0, 'got ' + calls.length)
  }

  // ── Test 4: Phase 0 rejects bad sourceDir ──
  {
    const res = await cr.runCodeReview({ taskId: 'cr-test-4', squad: 'code-review-squad', meta: { sourceDir: '/nonexistent-xyz' } }, stubDeps([]))
    ok('Phase 0 rejects missing sourceDir', res.error && res.phase === 0)
  }

  console.log(`\n${passed} passed, ${failed} failed`)
  process.exit(failed ? 1 : 0)
})().catch(e => { console.error('THREW:', e.stack); process.exit(1) })
