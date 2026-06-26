#!/usr/bin/env node

const __roots = require('../paths') // portable roots (KURU_*_ROOT) — see paths.js
// Unit tests for /root/agents/model-router.js
// No external deps — uses Node's built-in `assert`. Run: node /root/agents/test/model-router.test.js
// Exit 0 = all pass. Non-zero = regression.

const assert = require('assert')
const fs = require('fs')
const path = require('path')

const r = require('../src/routing/model-router')

// Back up + override model-config.json for deterministic tests
const CFG_PATH = (__roots.INTEL_ROOT + '/model-config.json')
const BACKUP_PATH = CFG_PATH + '.test-backup'
const realCfg = fs.readFileSync(CFG_PATH, 'utf-8')
fs.writeFileSync(BACKUP_PATH, realCfg)

let restored = false
function restore() {
  if (restored) return
  restored = true
  try {
    if (fs.existsSync(BACKUP_PATH)) {
      fs.writeFileSync(CFG_PATH, fs.readFileSync(BACKUP_PATH, 'utf-8'))
      fs.unlinkSync(BACKUP_PATH)
    }
  } catch {}
  r.resetCache()
}
process.on('exit', restore)
process.on('uncaughtException', (e) => { restore(); console.error(e); process.exit(1) })

let failures = 0
let passed = 0
function test(name, fn) {
  try {
    fn()
    console.log(`  ✓ ${name}`)
    passed++
  } catch (e) {
    console.log(`  ✗ ${name}`)
    console.log(`    ${e.message}`)
    failures++
  }
}

console.log('model-router tests:')

r.resetCache()

test('resolveFamily returns correct model IDs', () => {
  assert.strictEqual(r.resolveFamily('fast'), 'claude-haiku-4-5')
  assert.strictEqual(r.resolveFamily('balanced'), 'claude-sonnet-4-6')
  assert.strictEqual(r.resolveFamily('powerful'), 'claude-opus-4-8')
})

test('resolveFamily throws on unknown family', () => {
  assert.throws(() => r.resolveFamily('nonexistent'), /Unknown family/)
})

test('recon agents stay on fast (Haiku) at all complexity levels', () => {
  for (const score of [0, 3, 5, 8]) {
    const scout = r.getModelForAgent('scout', { complexityScore: score })
    const ranger = r.getModelForAgent('ranger', { complexityScore: score })
    assert.strictEqual(scout.family, 'fast', `scout should stay fast at complexity=${score}, got ${scout.family}`)
    assert.strictEqual(ranger.family, 'fast', `ranger should stay fast at complexity=${score}, got ${ranger.family}`)
  }
})

test('vuln specialists on balanced at simple target, effort bumps on complex', () => {
  const drill_simple = r.getModelForAgent('drill', { complexityScore: 0 })
  const drill_complex = r.getModelForAgent('drill', { complexityScore: 8 })
  assert.strictEqual(drill_simple.family, 'balanced')
  assert.strictEqual(drill_simple.effort, 'high')
  assert.strictEqual(drill_complex.family, 'balanced')
  assert.strictEqual(drill_complex.effort, 'xhigh', `expected effort bump high→xhigh on complex target`)
})

test('chain_analysis leader (atlas) is on opus-4-8/xhigh', () => {
  const atlas = r.getModelForAgent('atlas', { complexityScore: 0 })
  assert.strictEqual(atlas.family, 'powerful')
  assert.strictEqual(atlas.model, 'claude-opus-4-8')
  assert.strictEqual(atlas.effort, 'xhigh')
})

test('protected agents never downgrade even with override', () => {
  // Write an override trying to downgrade auditor
  const overrides = {
    version: 2,
    overrides: { auditor: { family: 'fast', effort: 'low' } }
  }
  fs.writeFileSync((__roots.INTEL_ROOT + '/agent-model-overrides.json'), JSON.stringify(overrides))
  r.resetCache()

  const auditor = r.getModelForAgent('auditor', { complexityScore: 0 })
  assert.strictEqual(auditor.family, 'balanced', 'auditor family should stay balanced (protected)')
  // Effort override is allowed even on protected agents
  assert.strictEqual(auditor.effort, 'low', 'effort override should still apply')

  // Restore empty overrides
  fs.writeFileSync((__roots.INTEL_ROOT + '/agent-model-overrides.json'), JSON.stringify({ version: 2, overrides: {} }))
  r.resetCache()
})

test('rollback mode falls back all agents to balanced/high', () => {
  const cfg = JSON.parse(realCfg)
  cfg.enabled = false
  fs.writeFileSync(CFG_PATH, JSON.stringify(cfg))
  r.resetCache()

  for (const agent of ['scout', 'drill', 'atlas', 'chanakya', 'scribe']) {
    const res = r.getModelForAgent(agent, { complexityScore: 8 })
    assert.strictEqual(res.family, 'balanced', `${agent} should fall back to balanced in rollback mode`)
    assert.strictEqual(res.effort, 'high', `${agent} should fall back to high effort in rollback mode`)
    assert.ok(res.reason.startsWith('rollback:'), `reason should indicate rollback, got ${res.reason}`)
  }

  // Restore enabled
  fs.writeFileSync(CFG_PATH, realCfg)
  r.resetCache()
})

test('computeComplexityScore fires all signals for hrconnect-like target', () => {
  const result = r.computeComplexityScore({
    authType: 'azure-ad oauth',
    waf: 'cloudflare',
    tech: 'aspnet',
    subdomains: ['hrapp.azurewebsites.net', 'hr-api.azurewebsites.net', 'launcher.myapps.microsoft.com'],
  })
  assert.strictEqual(result.score, 8, `expected score 8, got ${result.score}`)
  assert.strictEqual(result.tier, 'complex')
  const signalIds = result.signals.map(s => s.id).sort()
  assert.deepStrictEqual(signalIds, ['azure_ad', 'dynamic_app', 'multi_backend', 'waf_detected'])
})

test('computeComplexityScore simple static site scores 0', () => {
  const result = r.computeComplexityScore({ tech: 'html', subdomains: ['www'] })
  assert.strictEqual(result.score, 0)
  assert.strictEqual(result.tier, 'simple')
})

test('unknown agent falls back to vuln_specialist role', () => {
  const res = r.getModelForAgent('nonexistent_agent_xyz', { complexityScore: 0 })
  assert.strictEqual(res.role, 'vuln_specialist')
  assert.strictEqual(res.family, 'balanced')
})

test('stocks agents route correctly', () => {
  const chanakya = r.getModelForAgent('chanakya', { complexityScore: 0 })
  assert.strictEqual(chanakya.family, 'powerful')
  assert.strictEqual(chanakya.role, 'stock_leader')

  // (2026-04-21) stock_analyst upgraded from fast→balanced for content depth
  const agni = r.getModelForAgent('agni', { complexityScore: 0 })
  assert.strictEqual(agni.family, 'balanced')
  assert.strictEqual(agni.role, 'stock_analyst')
})

test('squad-aware routing: dual-use agents resolve per squad', () => {
  // veteran is in both pentest and stocks. Under squad context, it should
  // pick up the squad-specific role from squad_agent_roles. Without squad,
  // falls back to flat agent_roles (vuln_specialist by default).
  const veteranStocks = r.getModelForAgent('veteran', { squad: 'stocks-squad' })
  assert.strictEqual(veteranStocks.role, 'stock_analyst', 'veteran in stocks-squad → stock_analyst')
  // (2026-04-21) stock_analyst now on balanced (sonnet) for content depth
  assert.strictEqual(veteranStocks.family, 'balanced', 'stock_analyst → balanced family (sonnet, upgraded from haiku)')

  const veteranPentest = r.getModelForAgent('veteran', { squad: 'pentest-squad' })
  assert.strictEqual(veteranPentest.role, 'vuln_specialist', 'veteran in pentest-squad → vuln_specialist (no squad override, falls to flat)')
  assert.strictEqual(veteranPentest.family, 'balanced', 'vuln_specialist → balanced family (sonnet)')

  // SHAKUNI, VIDURA, VISHNU: unmapped in flat agent_roles — should default to
  // vuln_specialist. With stocks-squad context, they override to stock_challenger.
  // Challengers stay on fast (haiku) — short pointed challenges, breadth beats depth.
  const shakuniStocks = r.getModelForAgent('shakuni', { squad: 'stocks-squad' })
  assert.strictEqual(shakuniStocks.role, 'stock_challenger')
  assert.strictEqual(shakuniStocks.family, 'fast')

  const shakuniNoSquad = r.getModelForAgent('shakuni', {})
  assert.strictEqual(shakuniNoSquad.role, 'vuln_specialist', 'unmapped agent without squad → default')

  // CHANAKYA: same role regardless of squad context (stock_leader in both maps)
  const chanakyaStocks = r.getModelForAgent('chanakya', { squad: 'stocks-squad' })
  assert.strictEqual(chanakyaStocks.role, 'stock_leader')
  assert.strictEqual(chanakyaStocks.family, 'powerful')

  // (2026-04-23) Dual-use cloud/network specialists: stock_analyst in stocks,
  // vuln_specialist in pentest/red-team. Bug fix — these used to route as
  // stock_analyst in pentest context because flat agent_roles only had the
  // stocks mapping and there was no pentest-squad override.
  for (const agent of ['agni', 'kubera', 'mitra', 'soma', 'indra']) {
    const inStocks = r.getModelForAgent(agent, { squad: 'stocks-squad' })
    assert.strictEqual(inStocks.role, 'stock_analyst', `${agent} in stocks-squad → stock_analyst`)
    const inPentest = r.getModelForAgent(agent, { squad: 'pentest-squad' })
    assert.strictEqual(inPentest.role, 'vuln_specialist', `${agent} in pentest-squad → vuln_specialist (override)`)
    const inRedTeam = r.getModelForAgent(agent, { squad: 'red-team' })
    assert.strictEqual(inRedTeam.role, 'vuln_specialist', `${agent} in red-team → vuln_specialist (override)`)
  }
})

console.log(`\n${passed} passed, ${failures} failed`)
restore()
process.exit(failures > 0 ? 1 : 0)
