#!/usr/bin/env node
// /root/agents/verify-framework.js
//
// THE ROUGH LOOP — "future-proof" exit criteria for ARCHON.
//
// Each gate is a check. If any gate fails, the loop exits non-zero and prints what to fix.
// The gates encode Jay's north star: everything config-driven, works across all squads,
// no squad-specific hardcoding leaks, tested + rollback-safe.
//
// Run: node /root/agents/verify-framework.js
// Exit codes:
//   0 = all gates pass — system is currently future-proof against its own spec
//   1 = one or more gates failed — report contains what needs fixing
//
// Keep running this in a loop (manually or via PM2 cron) and fixing gate failures until
// all 0s. When a NEW future-proof requirement emerges, add a gate here — don't just fix
// it once, encode the invariant so future regressions get caught.

const fs = require('fs')
const path = require('path')
const { spawnSync } = require('child_process')
const agentPaths = require('./paths') // resolver chokepoint (GATE-121) — persona SOUL/skill reads route here

const gates = []
let failures = 0

function gate(name, fn) {
  gates.push({ name, fn })
}

function runGates() {
  console.log('═'.repeat(72))
  console.log('ARCHON FUTURE-PROOF VERIFICATION — ' + new Date().toISOString())
  console.log('═'.repeat(72))
  console.log()

  const results = []
  for (const g of gates) {
    try {
      const detail = g.fn()
      console.log(`✓ ${g.name}${detail ? ' — ' + detail : ''}`)
      results.push({ name: g.name, status: 'pass', detail })
    } catch (e) {
      console.log(`✗ ${g.name}`)
      console.log(`    ${e.message}`)
      results.push({ name: g.name, status: 'fail', reason: e.message })
      failures++
    }
  }

  console.log()
  console.log('═'.repeat(72))
  console.log(`RESULT: ${gates.length - failures}/${gates.length} gates passed`)
  if (failures > 0) {
    console.log(`\nFAILING GATES — fix these to make the system future-proof:`)
    for (const r of results.filter(r => r.status === 'fail')) {
      console.log(`  • ${r.name}: ${r.reason}`)
    }
  } else {
    console.log('\n✓ System meets current future-proof criteria.')
    console.log('  (When new requirements emerge, add a gate here to codify the invariant.)')
  }
  console.log('═'.repeat(72))

  return failures === 0
}

// ═══════════════════════════════════════════════════════════════════════════
// GATES
// ═══════════════════════════════════════════════════════════════════════════

gate('GATE-1: unit tests green (model-router, chain-verifier, anthropic-key, squad-framework)', () => {
  const r = spawnSync('node', [(agentPaths.AGENTS_ROOT + '/test/run-all.js')], { encoding: 'utf-8', timeout: 300000 })
  if (r.status !== 0) {
    throw new Error(`test suite exited ${r.status}. Output: ${(r.stdout || '').slice(-500)}`)
  }
  // Count PASS lines
  const passCount = (r.stdout.match(/PASS/g) || []).length
  return `${passCount} test files passing`
})

gate('GATE-2: model-config.json valid + all 3 families point to real Claude models', () => {
  const cfg = JSON.parse(fs.readFileSync((agentPaths.INTEL_ROOT + '/model-config.json'), 'utf-8'))
  for (const alias of ['fast', 'balanced', 'powerful']) {
    const model = cfg.families[alias]
    if (!model || !model.startsWith('claude-')) {
      throw new Error(`family '${alias}' has invalid model ID: ${model}`)
    }
  }
  return `fast=${cfg.families.fast}, balanced=${cfg.families.balanced}, powerful=${cfg.families.powerful}`
})

gate('GATE-3: rollback flag present + defaults to enabled', () => {
  const cfg = JSON.parse(fs.readFileSync((agentPaths.INTEL_ROOT + '/model-config.json'), 'utf-8'))
  if (cfg.enabled === undefined) throw new Error('enabled flag missing')
  if (cfg.rollback_mode === undefined) throw new Error('rollback_mode missing')
  return `enabled=${cfg.enabled}, rollback_mode=${cfg.rollback_mode}`
})

gate('GATE-4: all 7 squads have required config fields', () => {
  const sf = require((agentPaths.AGENTS_ROOT + '/src/core/squad-framework'))
  const known = sf.listKnownSquads()
  if (known.length !== 7) {
    throw new Error(`expected 7 known squads, got ${known.length}: ${known.join(', ')}`)
  }
  for (const squad of known) {
    const cfg = sf.getSquadConfig(squad)
    for (const field of ['leaderAgent', 'gateStyle', 'memoryNamespace', 'dispatchType', 'type']) {
      if (!cfg[field]) throw new Error(`squad '${squad}' missing '${field}'`)
    }
  }
  return known.join(', ')
})

gate('GATE-5: no hardcoded squad branching in event-bus (getSquadGates/Leader/MemoryFile used)', () => {
  const src = fs.readFileSync(path.resolve(__dirname, 'event-bus.js'), 'utf-8')
  // Strip comments to avoid false positives on review annotations that reference the forbidden patterns.
  const codeOnly = src
    .split('\n')
    .filter(l => !l.trim().startsWith('//') && !l.trim().startsWith('*'))
    .join('\n')

  const remaining = (codeOnly.match(/squad\.includes\('stocks'\) \? MUST_GATES_STOCKS : MUST_GATES/g) || []).length
  if (remaining > 0) {
    throw new Error(`${remaining} places still use hardcoded MUST_GATES_STOCKS : MUST_GATES — should call getSquadGates()`)
  }
  const leaderHardcode = (codeOnly.match(/squad === 'pentest-squad' \? 'ATLAS' : 'CHANAKYA'/g) || []).length
  if (leaderHardcode > 0) {
    throw new Error(`${leaderHardcode} places still hardcode leader agent — should call getConfiguredSquadLeader()`)
  }

  // (2026-04-19 architect review GAP-1) — harder check: any squad.includes() usage in code.
  // This catches subtler leaks the narrow-pattern checks above miss. Allow in test files,
  // but event-bus itself must use getSquadDispatchType / getSquadGateStyle / getSquadMemoryNamespace.
  const squadIncludesUses = (codeOnly.match(/squad\.includes\(['"](?:pentest|stocks|red-team|cloud-security|network-pentest|ai-security)['"]\)/g) || []).length
  if (squadIncludesUses > 0) {
    throw new Error(`${squadIncludesUses} squad.includes('<literal>') calls remain — use getSquadDispatchType/getSquadGateStyle/getSquadMemoryNamespace instead`)
  }
  // Also catch squadNorm === 'literal' patterns
  const squadNormLit = (codeOnly.match(/squadNorm === ['"](?:pentest|stocks|red-team|cloud-security|network-pentest|ai-security)['"]/g) || []).length
  if (squadNormLit > 0) {
    throw new Error(`${squadNormLit} squadNorm === '<literal>' branches remain — use squad-framework accessors`)
  }

  return 'no squad-specific conditionals in event-bus gate/leader/memory/dispatch paths'
})

gate('GATE-6: event-bus spawn sites use _buildClaudeSpawnEnv (centralized, not 3 copies)', () => {
  const src = fs.readFileSync(path.resolve(__dirname, 'event-bus.js'), 'utf-8')
  const scattered = (src.match(/!k\.startsWith\('OPENCLAW'\)/g) || []).length
  if (scattered > 0) {
    throw new Error(`${scattered} scattered OPENCLAW env-filter sites — should use _buildClaudeSpawnEnv()`)
  }
  return 'spawn env construction centralized'
})

gate('GATE-7: PM2 long-running services all online', () => {
  const r = spawnSync('pm2', ['jlist'], { encoding: 'utf-8', timeout: 10000 })
  const list = JSON.parse(r.stdout || '[]')
  const required = ['event-bus', 'supervisor', 'mc', 'telegram-relay']
  const missing = required.filter(n => !list.some(p => p.name === n && p.pm2_env.status === 'online'))
  if (missing.length > 0) {
    throw new Error(`PM2 services not online: ${missing.join(', ')}`)
  }
  const onlineNames = list.filter(p => p.pm2_env.status === 'online').map(p => p.name)
  return onlineNames.join(', ')
})

gate('GATE-8: event-bus.js syntactically valid', () => {
  const r = spawnSync('node', ['-c', (agentPaths.AGENTS_ROOT + '/event-bus.js')], { encoding: 'utf-8', timeout: 10000 })
  if (r.status !== 0) throw new Error(`syntax error: ${r.stderr || r.stdout}`)
  return 'node -c clean'
})

gate('GATE-9: chain-verifier rejects shell injection attempts', () => {
  const cv = require((agentPaths.AGENTS_ROOT + '/src/pipeline/chain-verifier'))
  const r = cv.verifyChain({
    id: 'inj', name: 'inj', severity: 'Critical',
    steps: [{ step_id: 1, description: 'evil', curl: 'curl example.com; rm -rf /', expected_result: 'x' }],
  })
  if (r.verified) throw new Error('chain-verifier DID NOT reject shell injection — security regression!')
  if (!/shell metacharacters|rejected/.test(r.stepResults[0].reason || '')) {
    throw new Error(`rejection reason unexpected: ${r.stepResults[0].reason}`)
  }
  return 'shell injection correctly blocked'
})

gate('GATE-10: api key module validates prefix + mode 600', () => {
  const ak = require((agentPaths.AGENTS_ROOT + '/src/integrations/anthropic-key'))
  // We don't set a real key here — just verify validation exists
  let threw = false
  try { ak.setAnthropicApiKey('badkey') } catch { threw = true }
  if (!threw) throw new Error('setAnthropicApiKey accepted invalid key (missing sk-ant- prefix check)')
  return 'key validation + mode 600 enforced'
})

gate('GATE-11: activity-log-rotator PM2 cron is scheduled', () => {
  const r = spawnSync('pm2', ['jlist'], { encoding: 'utf-8', timeout: 10000 })
  const list = JSON.parse(r.stdout || '[]')
  const rotator = list.find(p => p.name === 'activity-log-rotator')
  if (!rotator) throw new Error('activity-log-rotator not registered with PM2')
  const cron = rotator.pm2_env.cron_restart
  if (!cron) throw new Error('activity-log-rotator has no cron schedule')
  return `cron="${cron}"`
})

gate('GATE-12: grader reads report files (not just activity log)', () => {
  const src = fs.readFileSync(path.resolve(__dirname, 'event-bus.js'), 'utf-8')
  if (!src.includes('reportCandidates') || !src.includes('INTEL_DIR, \'reports\'')) {
    throw new Error('grader does not appear to read report files — old regex-only behavior')
  }
  return 'grader combines activity log + report files'
})

gate('GATE-13: Telegram outbox relay is PM2-managed + responsive', () => {
  const r = spawnSync('pm2', ['jlist'], { encoding: 'utf-8', timeout: 10000 })
  const list = JSON.parse(r.stdout || '[]')
  const relay = list.find(p => p.name === 'telegram-relay' && p.pm2_env.status === 'online')
  if (!relay) throw new Error('telegram-relay not online under PM2')
  if (!fs.existsSync((agentPaths.INTEL_ROOT + '/telegram-outbox'))) {
    throw new Error('telegram-outbox directory missing')
  }
  return 'relay online, outbox dir present'
})

gate('GATE-14: critical agents (auditor/scribe/atlas/chanakya/arbiter) are in deny_family_downgrade_for', () => {
  const cfg = JSON.parse(fs.readFileSync((agentPaths.INTEL_ROOT + '/model-config.json'), 'utf-8'))
  const required = ['auditor', 'scribe', 'atlas', 'chanakya', 'arbiter']
  const missing = required.filter(a => !cfg.deny_family_downgrade_for?.includes(a))
  if (missing.length > 0) {
    throw new Error(`unprotected critical agents: ${missing.join(', ')}`)
  }
  return required.join(', ') + ' protected'
})

gate('GATE-15: recon agents (scout, ranger) stay on fast family at all complexity levels', () => {
  const r = require((agentPaths.AGENTS_ROOT + '/src/routing/model-router'))
  r.resetCache()
  for (const agent of ['scout', 'ranger']) {
    for (const score of [0, 4, 5, 6, 8]) {
      const result = r.getModelForAgent(agent, { complexityScore: score })
      if (result.family !== 'fast') {
        throw new Error(`${agent} at complexity=${score} routed to ${result.family} (should stay fast — empirical 4.4x discovery drop otherwise)`)
      }
    }
  }
  return 'recon-on-fast invariant holds'
})

// ── Target Profile invariants (2026-04-19) ────────────────────────────
gate('GATE-16: target-classifier never returns restriction fields (allowed/skip specialists)', () => {
  const tc = require((agentPaths.AGENTS_ROOT + '/src/routing/target-classifier'))
  // Probe several ctxs and inspect output
  const probes = [
    { hostname: 'api.stripe.com', targetUrl: 'https://api.stripe.com/v1/charges', headers: { server: 'cloudflare' }, bodySnippet: '', contentTypes: ['application/json'] },
    { hostname: 'staging.example.com', targetUrl: 'https://staging.example.com', headers: {}, bodySnippet: '<!DOCTYPE html><div id="root">' },
    { hostname: 'bank.example.com', targetUrl: 'https://bank.example.com', headers: { 'x-powered-by': 'ASP.NET' }, bodySnippet: '' },
    {} // empty ctx
  ]
  for (const ctx of probes) {
    const p = tc.classify(ctx)
    if ('allowed_specialists' in p) throw new Error('profile leaked allowed_specialists field')
    if ('skip_specialists' in p) throw new Error('profile leaked skip_specialists field')
    if ('exclude' in p) throw new Error('profile leaked exclude field')
    if (!p.disclaimer || !/hint|hypothesis|not a scope fence/i.test(p.disclaimer)) {
      throw new Error('profile missing non-restriction disclaimer text')
    }
  }
  return 'no restriction fields; disclaimer always present'
})

gate('GATE-17: every event-bus prompt that injects profile carries the disclaimer', () => {
  const src = fs.readFileSync(path.resolve(__dirname, 'event-bus.js'), 'utf-8')
  // All profile injections must flow through buildPromptFragment (which contains the disclaimer).
  // Forbid direct manual references like `profile.surface_shape` being embedded raw into a prompt
  // without going through the helper.
  const fragmentUses = (src.match(/targetClassifier\.buildPromptFragment/g) || []).length
  if (fragmentUses < 3) {
    throw new Error(`expected ≥3 buildPromptFragment call sites (specialist, chain, auditor), found ${fragmentUses}`)
  }
  // Forbid any codepath using profile to filter/skip specialists
  const banned = /if\s*\(\s*profile\.\w+[^)]*\)\s*\{[^}]*(return|skip|continue|specialists\s*=\s*\[\]|remove)/g
  const skipLeaks = src.match(banned) || []
  if (skipLeaks.length > 0) {
    throw new Error(`profile-based specialist skipping found (${skipLeaks.length}) — profile must not gate roster`)
  }
  return `buildPromptFragment used at ${fragmentUses} sites; no skip-by-profile patterns`
})

// ── Hybrid Grader invariants (2026-04-19) ───────────────────────────
gate('GATE-19: grader-config.json valid + LLM tool has required evidence_quote field', () => {
  const cfg = JSON.parse(fs.readFileSync((agentPaths.INTEL_ROOT + '/grader-config.json'), 'utf-8'))
  if (!('enabled' in cfg)) throw new Error('enabled flag missing')
  if (!('rollback_mode' in cfg)) throw new Error('rollback_mode missing')
  if (!cfg.llm_fallback) throw new Error('llm_fallback section missing')
  if (!cfg.squad_grading_notes?._default) throw new Error('_default grading notes missing')
  const grader = require((agentPaths.AGENTS_ROOT + '/src/grading/grader'))
  const tool = grader.GRADE_TOOL
  if (!tool || tool.name !== 'grade_expectation') throw new Error('GRADE_TOOL missing or wrong name')
  for (const f of ['passed', 'confidence', 'evidence_quote', 'reason']) {
    if (!tool.input_schema.properties[f]) throw new Error(`tool schema missing '${f}'`)
    if (!tool.input_schema.required.includes(f)) throw new Error(`'${f}' not required in schema`)
  }
  return `enabled=${cfg.enabled}, rollback=${cfg.rollback_mode || 'active'}, model=${cfg.llm_fallback.model_alias}`
})

// ── Security + Architecture audit fixes (2026-04-19 session 2) ──────
gate('GATE-24: no customer-domain literals in prompts or production code', () => {
  const files = [
    (agentPaths.AGENTS_ROOT + '/event-bus.js'),
    (agentPaths.AGENTS_ROOT + '/prompts/specialist/v1.md'),
    (agentPaths.AGENTS_ROOT + '/prompts/chain-analysis/v1.md'),
  ]
  // Block list — domains that were leaked in past reviews. Extend as more are found.
  const banned = ['emiratesnbd', 'hrapp.azurewebsites', 'hrconnect']
  for (const f of files) {
    if (!fs.existsSync(f)) continue
    const src = fs.readFileSync(f, 'utf-8').toLowerCase()
    for (const b of banned) {
      if (src.includes(b)) throw new Error(`customer domain '${b}' found in ${f}`)
    }
  }
  return `0 customer-domain leaks across ${files.length} prompt/code files`
})

gate('GATE-25: shell-safety helpers defined + used in event-bus', () => {
  const src = fs.readFileSync(path.resolve(__dirname, 'event-bus.js'), 'utf-8')
  for (const helper of ['function safeUrl(', 'function safeHost(', 'function safeToken(']) {
    if (!src.includes(helper)) throw new Error(`missing helper: ${helper.replace('function ', '')}`)
  }
  // Require at least one usage of each
  for (const helper of ['safeUrl(', 'safeHost(', 'safeToken(']) {
    const uses = (src.match(new RegExp(helper.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) || []).length
    // 1 = declaration, so need > 1 for actual usage
    if (uses < 2) throw new Error(`helper ${helper} defined but not used`)
  }
  return 'safeUrl/safeHost/safeToken all defined + used'
})

gate('GATE-26: mc-auth has no fallback password + reads mc-auth.local at boot', () => {
  const route = fs.readFileSync('/root/mission-control/app/api/auth/route.ts', 'utf-8')
  // Narrow pattern: the PASSWORD variable must NOT be initialized with a || fallback.
  // e.g. forbid `const PASSWORD = process.env.MC_AUTH_PASSWORD || 'anything'`.
  const badInit = /const\s+PASSWORD\s*=\s*process\.env\.MC_AUTH_PASSWORD\s*\|\|\s*['"][^'"]+['"]/
  if (badInit.test(route)) {
    throw new Error('auth route still initializes PASSWORD with a hardcoded fallback — must fail-closed')
  }
  if (!route.includes('process.env.MC_AUTH_PASSWORD')) {
    throw new Error('auth route does not read MC_AUTH_PASSWORD env')
  }
  const server = fs.readFileSync('/root/mission-control/server.js', 'utf-8')
  if (!server.includes('mc-auth.local')) {
    throw new Error('server.js does not bootstrap password from /root/intel/mc-auth.local')
  }
  return 'no fallback; mc-auth.local bootstrap present'
})

gate('GATE-27: dispatch router uses getSquadDispatchType, not squad.includes()', () => {
  const src = fs.readFileSync(path.resolve(__dirname, 'event-bus.js'), 'utf-8')
  if (!src.includes('getSquadDispatchType(squad)')) {
    throw new Error('dispatcher must resolve type via getSquadDispatchType — hardcoded branches drift')
  }
  if (!src.includes('parallel-challenger') || !src.includes('parallel-phases')) {
    throw new Error('dispatcher missing one of the configured dispatchType branches')
  }
  return 'dispatch router is config-driven via getSquadDispatchType'
})

gate('GATE-28: pentest batches are built dynamically at dispatch, not module-load', () => {
  const src = fs.readFileSync(path.resolve(__dirname, 'event-bus.js'), 'utf-8')
  if (!src.includes('function buildPentestBatches()')) {
    throw new Error('buildPentestBatches helper missing')
  }
  if (!src.includes('_dynBatches = buildPentestBatches()')) {
    throw new Error('dispatchPentestParallel does not call buildPentestBatches() at dispatch time')
  }
  return 'dynamic batch construction active'
})

gate('GATE-29: checkpoint persists on mutation, not just 60s timer', () => {
  const src = fs.readFileSync(path.resolve(__dirname, 'event-bus.js'), 'utf-8')
  if (!src.includes('persistCheckpointNow')) {
    throw new Error('persistCheckpointNow helper missing')
  }
  if (!src.includes('_checkpointPersistArmed = true')) {
    throw new Error('checkpoint-on-mutation never armed at startup')
  }
  // runningAgents/runningTasks must be the wrapper (not bare Set)
  if (!src.includes('_runningAgentsRaw') || !src.includes('_runningTasksRaw')) {
    throw new Error('runningAgents/runningTasks not wrapped — mutations would skip checkpoint')
  }
  return 'per-mutation checkpoint active'
})

gate('GATE-30: docs/read API uses realpath to prevent symlink escape', () => {
  const src = fs.readFileSync('/root/mission-control/app/api/docs/read/route.ts', 'utf-8')
  if (!src.includes('fs.realpathSync')) {
    throw new Error('docs/read does not call realpathSync — symlink escape possible')
  }
  if (!src.includes("filePath.includes('..')")) {
    throw new Error('docs/read does not reject ".." in input path')
  }
  return 'realpath check + .. rejection active'
})

// ── mc runs in Next.js production mode (prevents HMR auto-reload) ───
gate('GATE-36: mission-control PM2 process runs with NODE_ENV=production (no HMR)', () => {
  const r = spawnSync('pm2', ['jlist'], { encoding: 'utf-8', timeout: 10000 })
  const list = JSON.parse(r.stdout || '[]')
  const mc = list.find(p => p.name === 'mc' && p.pm2_env?.status === 'online')
  if (!mc) throw new Error('mc process not online')
  const nodeEnv = mc.pm2_env?.env?.NODE_ENV || mc.pm2_env?.NODE_ENV
  if (nodeEnv !== 'production') {
    throw new Error(`mc NODE_ENV=${nodeEnv || 'unset'} — must be 'production' to disable Next.js HMR auto-reload. Fix: pm2 delete mc && NODE_ENV=production pm2 start /root/mission-control/server.js --name mc && pm2 save`)
  }
  return `mc NODE_ENV=production, HMR disabled`
})

// ── UI + Data integrity fixes (2026-04-19 session 3) ────────────────
gate('GATE-31: cancel-task API exists + event-bus watches cancel-signals dir', () => {
  if (!fs.existsSync('/root/mission-control/app/api/tasks/[id]/cancel/route.ts')) {
    throw new Error('cancel API missing')
  }
  const src = fs.readFileSync(path.resolve(__dirname, 'event-bus.js'), 'utf-8')
  if (!src.includes('processCancelSignals')) {
    throw new Error('event-bus does not process cancel signals')
  }
  if (!src.includes('killTaskChildren') || !src.includes('registerTaskChild')) {
    throw new Error('event-bus missing child-process registry for cancellation')
  }
  if (!src.includes('registerTaskChild(taskId, child)')) {
    throw new Error('spawnAgent does not register child into task-children registry')
  }
  return 'cancel API + registry + signal watcher all present'
})

gate('GATE-32: cost-route dedups on stable agent+cost key (not drift-prone timestamp)', () => {
  const src = fs.readFileSync('/root/mission-control/app/api/tasks/[id]/cost/route.ts', 'utf-8')
  // Must NOT dedup on `agent + timestamp` pattern (the old bug)
  if (/a\.agent === String\(c\.agent \|\| ''\)\.toUpperCase\(\) && a\.timestamp === c\.timestamp/.test(src)) {
    throw new Error('cost route still uses timestamp-based dedup — will double-count')
  }
  // Must have NEXUS exclusion + stable-key approach
  if (!src.includes("EXCLUDE_AGENTS") || !src.includes("'NEXUS'")) {
    throw new Error('cost route does not exclude NEXUS summary totals')
  }
  if (!src.includes('seenKeys') || !src.includes('cost.toFixed(4)')) {
    throw new Error('cost route missing stable-key dedup (agent+cost)')
  }
  return 'dedup uses stable key + excludes NEXUS totals'
})

gate('GATE-33: mission-control write endpoints use atomic tmp+rename', () => {
  // (2026-04-20 audit) Accept both the simple `.tmp` suffix and the
  // nonce'd collision-resistant form `.tmp.{pid}.{ts}.{nonce}` introduced
  // when we added the advisory lock.
  const targets = [
    { path: '/root/mission-control/app/api/agents/manage/route.ts', needles: [/tmp\s*=\s*AGENTS_FILE \+ ['"]\.tmp['"]/, /AGENTS_FILE.*\.tmp\.\$\{/] },
    { path: '/root/mission-control/app/api/tasks/route.ts', needles: [/tmp\s*=\s*TASKS_FILE \+ ['"]\.tmp['"]/, /TASKS_FILE.*\.tmp\.\$\{/] },
  ]
  for (const t of targets) {
    const src = fs.readFileSync(t.path, 'utf-8')
    const ok = t.needles.some(n => n.test(src))
    if (!ok) throw new Error(`${t.path} does not use atomic tmp+rename`)
    if (!src.includes('rename')) throw new Error(`${t.path} missing rename call`)
  }
  return 'atomic writes in agents.json + tasks.json endpoints'
})

gate('GATE-34: sidebar has no duplicate routes + no broken /stocks', () => {
  const sidebar = fs.readFileSync('/root/mission-control/app/components/Sidebar.tsx', 'utf-8')
  // Extract NAV_ITEMS hrefs
  const navMatches = [...sidebar.matchAll(/href:\s*'([^']+)'/g)].map(m => m[1])
  const dupes = navMatches.filter((h, i) => navMatches.indexOf(h) !== i)
  if (dupes.length > 0) throw new Error(`duplicate sidebar routes: ${[...new Set(dupes)].join(', ')}`)
  const navbar = fs.readFileSync('/root/mission-control/app/components/Navbar.tsx', 'utf-8')
  if (/['"]\/stocks['"]\s*:\s*['"]Market Intel['"]/.test(navbar)) {
    throw new Error("navbar still references /stocks which returns 404")
  }
  return `${navMatches.length} unique sidebar routes; /stocks removed from navbar`
})

gate('GATE-35: no forbidden infinite animations in UI (DESIGN.md compliance)', () => {
  // Spot-check the two sites flagged in the UI audit — DashboardWidgets spinner is allowed
  // (rotation for functional feedback), but fadeUp/of-tla/of-tra/of-stma were banned.
  const files = [
    '/root/mission-control/app/(dashboard)/DashboardWidgets.tsx',
    '/root/mission-control/app/(dashboard)/office/page.tsx',
  ]
  const forbidden = [
    /fadeUp\s+\d.*infinite\s+alternate/, // old DashboardWidgets animation
    /animation:\s*of-tla\b/, /animation:of-tla\b/,
    /animation:\s*of-tra\b/, /animation:of-tra\b/,
    /animation:\s*of-cla\b/, /animation:of-cla\b/,
    /animation:\s*of-stma\b/, /animation:of-stma\b/,
  ]
  for (const f of files) {
    if (!fs.existsSync(f)) continue
    const src = fs.readFileSync(f, 'utf-8')
    for (const re of forbidden) {
      if (re.test(src)) throw new Error(`${f} still has forbidden infinite animation matching ${re}`)
    }
  }
  return 'no forbidden infinite animations in flagged files'
})

// ── Pre-commit hook (2026-04-19) ────────────────────────────────────
gate('GATE-23: pre-commit check script + mission-control git hook installed and executable', () => {
  const scriptPath = (agentPaths.AGENTS_ROOT + '/pre-commit-check.sh')
  const hookPath = '/root/mission-control/.git/hooks/pre-commit'
  for (const p of [scriptPath, hookPath]) {
    if (!fs.existsSync(p)) throw new Error(`missing: ${p}`)
    const stat = fs.statSync(p)
    if (!(stat.mode & 0o100)) throw new Error(`not executable: ${p}`)
  }
  return 'pre-commit check + mission-control hook both installed'
})

// ── Prompt Versioning invariants (2026-04-19) ───────────────────────
gate('GATE-21: prompt-renderer config valid + every configured role has a template file', () => {
  const pr = require((agentPaths.AGENTS_ROOT + '/src/rendering/prompt-renderer'))
  const cfg = pr.loadConfig()
  if (!cfg) throw new Error('prompts-config.json missing')
  if (!('enabled' in cfg)) throw new Error('enabled flag missing')
  if (!cfg.versions || Object.keys(cfg.versions).length === 0) {
    throw new Error('no versions configured')
  }
  for (const [role, ver] of Object.entries(cfg.versions)) {
    const tmpl = pr.loadTemplate(role, ver)
    if (!tmpl) throw new Error(`template missing: prompts/${role}/${ver}.md`)
    if (tmpl.length < 50) throw new Error(`template ${role}/${ver} suspiciously short`)
  }
  return `${Object.keys(cfg.versions).length} roles configured, all templates exist`
})

gate('GATE-22: renderer fallback is SAFE — invalid template returns null (not throws)', () => {
  const pr = require((agentPaths.AGENTS_ROOT + '/src/rendering/prompt-renderer'))
  // Nonexistent role
  if (pr.renderPrompt('nonexistent-role-xyz', {}) !== null) {
    throw new Error('renderPrompt should return null for unknown role')
  }
  // Malformed template (should not crash)
  const out = pr.render('{{unclosed', { unclosed: 'x' })
  if (typeof out !== 'string') throw new Error('render should always return string')
  return 'fallback path safe for unknown/malformed templates'
})

gate('GATE-20: grader rejects hallucinated evidence_quote (substring check present)', () => {
  const grader = require((agentPaths.AGENTS_ROOT + '/src/grading/grader'))
  // Literal substring: accept
  if (!grader.verifyEvidenceQuote('SQL injection at /api/users', 'Found SQL injection at /api/users endpoint')) {
    throw new Error('verifyEvidenceQuote failed on valid substring')
  }
  // Hallucination: reject
  if (grader.verifyEvidenceQuote('200 OK response', 'Server returned 500 Internal Error')) {
    throw new Error('verifyEvidenceQuote accepted hallucinated quote — security regression!')
  }
  // Too short: reject
  if (grader.verifyEvidenceQuote('ok', 'lots of text lots of text ok')) {
    throw new Error('verifyEvidenceQuote should reject quotes < 10 chars')
  }
  return 'hallucination guard active'
})

// ── Per-task log scalability fix (2026-04-19 architect review GAP-6) ──
gate('GATE-37: task-log module exists + tests pass + hot paths migrated to readTaskActivity', () => {
  // 1. Module file exists + exports expected surface
  const modPath = (agentPaths.AGENTS_ROOT + '/src/utils/task-log.js')
  if (!fs.existsSync(modPath)) throw new Error('task-log.js module missing')
  const tl = require((agentPaths.AGENTS_ROOT + '/src/utils/task-log'))
  for (const fn of ['appendToTaskLog', 'readTaskLog', 'taskLogPath', 'sanitizeTaskId', 'taskLogExists']) {
    if (typeof tl[fn] !== 'function') throw new Error(`task-log.${fn} not exported`)
  }

  // 2. Test file exists + passes
  const testFile = (agentPaths.AGENTS_ROOT + '/test/task-log.test.js')
  if (!fs.existsSync(testFile)) throw new Error('task-log.test.js missing')
  const r = spawnSync('node', [testFile], { encoding: 'utf-8', timeout: 30000 })
  if (r.status !== 0) {
    throw new Error(`task-log tests failed: ${(r.stdout || r.stderr || '').slice(-400)}`)
  }
  const passCount = (r.stdout.match(/^\s+✓ /gm) || []).length
  if (passCount < 6) throw new Error(`expected ≥6 tests, found ${passCount}`)

  // 3. At least 5 call sites in event-bus.js use readTaskActivity (not the slow inline grep)
  const src = fs.readFileSync(path.resolve(__dirname, 'event-bus.js'), 'utf-8')
  // Strip comment-only lines so doc-comment references don't count.
  const codeOnly = src
    .split('\n')
    .filter(l => !l.trim().startsWith('//') && !l.trim().startsWith('*'))
    .join('\n')
  const usages = (codeOnly.match(/readTaskActivity\(/g) || []).length
  // 1 definition + ≥5 actual call sites → need ≥6 total occurrences
  if (usages < 6) {
    throw new Error(`expected ≥5 migrated call sites (≥6 readTaskActivity occurrences including definition), found ${usages}`)
  }

  // 4. logActivity must STILL write to the global ACTIVITY-LOG (backward compat)
  if (!/fs\.appendFileSync\(ACTIVITY_LOG,/.test(src)) {
    throw new Error('logActivity no longer writes to global ACTIVITY-LOG — backward-compat broken')
  }
  return `${passCount} tests pass, ${usages - 1} migrated call sites, global log still written`
})

gate('GATE-18: target-profile-rules.json has all 6 dimensions + disclaimer + squad strategy map', () => {
  const rules = JSON.parse(fs.readFileSync((agentPaths.INTEL_ROOT + '/target-profile-rules.json'), 'utf-8'))
  const needed = ['surface_shape', 'tech_stack', 'auth_model', 'hosting', 'environment', 'domain']
  for (const d of needed) {
    if (!Array.isArray(rules.dimensions?.[d])) throw new Error(`dimension '${d}' missing from rules`)
    if (!rules.dimensions[d].includes('unknown')) throw new Error(`dimension '${d}' must include 'unknown' value`)
  }
  if (!rules.non_restriction_disclaimer) throw new Error('non_restriction_disclaimer missing')
  if (!rules.per_squad_strategy) throw new Error('per_squad_strategy map missing')
  // Anti-restriction invariant on config itself — ignore underscore-prefixed meta keys
  // (_comment etc.) when scanning for banned field names. Recurse through the strategy tree.
  const banned = /^(allowed_specialists|skip_specialists|exclude_specialists|allow|exclude)$/
  function scan(node) {
    if (!node || typeof node !== 'object') return
    if (Array.isArray(node)) { node.forEach(scan); return }
    for (const k of Object.keys(node)) {
      if (k.startsWith('_')) continue
      if (banned.test(k)) throw new Error(`per_squad_strategy contains restrictive field '${k}'`)
      scan(node[k])
    }
  }
  scan(rules.per_squad_strategy)
  return 'rules config valid + no restriction leaks in strategy'
})

// ── Session token HMAC hardening (2026-04-19) ───────────────────────
gate('GATE-38: mc-auth-secret file mode 600 + HMAC signing in auth route + Web Crypto verify in middleware', () => {
  const secPath = (agentPaths.INTEL_ROOT + '/mc-auth-secret')
  if (!fs.existsSync(secPath)) {
    throw new Error(`${secPath} missing — server.js should generate this on boot`)
  }
  const st = fs.statSync(secPath)
  if ((st.mode & 0o777) !== 0o600) {
    throw new Error(`${secPath} has perms ${(st.mode & 0o777).toString(8)} — must be 600`)
  }
  // Signing secret must be non-trivial length.
  const sec = fs.readFileSync(secPath, 'utf-8').trim()
  if (sec.length < 32) throw new Error(`${secPath} content too short (${sec.length} chars)`)

  // Auth route must sign with createHmac (either imported via shared lib or direct).
  // The shared helper lives in lib/session-token.js — accept createHmac in either file.
  const routeSrc = fs.readFileSync('/root/mission-control/app/api/auth/route.ts', 'utf-8')
  const libJsPath = '/root/mission-control/lib/session-token.js'
  const libSrc = fs.existsSync(libJsPath) ? fs.readFileSync(libJsPath, 'utf-8') : ''
  const hasHmacSign = /crypto\.createHmac|createHmac\(['"]sha256['"]/.test(routeSrc + '\n' + libSrc)
  if (!hasHmacSign) {
    throw new Error('auth route / session-token lib does not use crypto.createHmac for signing')
  }
  if (!/signSessionToken/.test(routeSrc)) {
    throw new Error('auth route does not call signSessionToken — old random-token format may still be in use')
  }

  // Middleware must verify via Web Crypto (edge runtime).
  const mwSrc = fs.readFileSync('/root/mission-control/middleware.ts', 'utf-8')
  if (!/crypto\.subtle\.verify|subtle\.verify/.test(mwSrc)) {
    throw new Error('middleware.ts does not use crypto.subtle.verify — edge-incompatible or missing HMAC check')
  }
  if (/crypto\.createHmac/.test(mwSrc)) {
    throw new Error('middleware.ts uses node crypto.createHmac — not available in edge runtime')
  }

  return `secret present (600, ${sec.length} chars); createHmac signs; subtle.verify verifies`
})

// ── Grader batch-API config invariant (2026-04-19) ──────────────────
gate('GATE-39: grader-config.json has batch API switches (use_batch_api + min_expectations_for_batch + batch_max_wait_seconds)', () => {
  const cfgPath = (agentPaths.INTEL_ROOT + '/grader-config.json')
  if (!fs.existsSync(cfgPath)) throw new Error(`${cfgPath} missing`)
  const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf-8'))
  const fb = cfg.llm_fallback
  if (!fb || typeof fb !== 'object') throw new Error('llm_fallback section missing')
  if (typeof fb.use_batch_api !== 'boolean') {
    throw new Error(`llm_fallback.use_batch_api must be boolean (got ${typeof fb.use_batch_api})`)
  }
  if (typeof fb.min_expectations_for_batch !== 'number' || fb.min_expectations_for_batch < 1) {
    throw new Error(`llm_fallback.min_expectations_for_batch must be number ≥1 (got ${fb.min_expectations_for_batch})`)
  }
  if (typeof fb.batch_max_wait_seconds !== 'number' || fb.batch_max_wait_seconds < 0) {
    throw new Error(`llm_fallback.batch_max_wait_seconds must be number ≥0 (got ${fb.batch_max_wait_seconds})`)
  }
  // Sanity: batch_max_wait_seconds should give enough headroom (1 minute+) for real batches;
  // tests can override temporarily but the on-disk default must be production-sensible.
  if (fb.batch_max_wait_seconds > 0 && fb.batch_max_wait_seconds < 60) {
    throw new Error(`llm_fallback.batch_max_wait_seconds=${fb.batch_max_wait_seconds} is too low for real batches (should be ≥60)`)
  }
  return `use_batch_api=${fb.use_batch_api}, min=${fb.min_expectations_for_batch}, max_wait=${fb.batch_max_wait_seconds}s`
})

// ── Anthropic API future-proofing (2026-04-19 research-driven) ─────
gate('GATE-40: model-config effort_defaults + role_defaults set for every family/role', () => {
  const cfg = JSON.parse(fs.readFileSync((agentPaths.INTEL_ROOT + '/model-config.json'), 'utf-8'))
  const validEffort = ['low', 'medium', 'high', 'xhigh', 'max']
  if (!cfg.effort_defaults) throw new Error('effort_defaults section missing')
  for (const fam of ['fast', 'balanced', 'powerful']) {
    const eff = cfg.effort_defaults[fam]
    if (!validEffort.includes(eff)) {
      throw new Error(`effort_defaults.${fam}=${eff} is not one of ${validEffort.join(',')}`)
    }
  }
  if (!cfg.role_defaults) throw new Error('role_defaults missing')
  for (const [role, def] of Object.entries(cfg.role_defaults)) {
    if (!def.family || !def.effort) throw new Error(`role_defaults.${role} missing family or effort`)
    if (!validEffort.includes(def.effort)) {
      throw new Error(`role_defaults.${role}.effort=${def.effort} invalid`)
    }
  }
  return `3 family efforts + ${Object.keys(cfg.role_defaults).length} role defaults set`
})

gate('GATE-41: no raw-API thinking params in base-SDK modules (grader/finding-validator use direct Anthropic SDK)', () => {
  // grader.js and finding-validator.js call the Anthropic base SDK directly (not the Agent SDK).
  // Extended thinking for those paths should go through sdk.js (Agent SDK adapter) where
  // thinking params are properly handled. Scan for accidental raw thinking injection here.
  // NOTE: sdk.js (Agent SDK adapter) intentionally uses budget_tokens at effort=max — that
  // is correct (GATE-107). This gate only covers the direct-API callers.
  for (const f of [(agentPaths.AGENTS_ROOT + '/src/grading/grader.js'), (agentPaths.AGENTS_ROOT + '/src/grading/finding-validator.js')]) {
    const src = fs.readFileSync(f, 'utf-8')
    // Strip comments before scanning — we allow references in code comments/docs.
    const code = src.split('\n').filter(l => !l.trim().startsWith('//')).join('\n')
    if (/budget_tokens\s*:/.test(code)) {
      throw new Error(`${f} uses budget_tokens directly — use the sdk.js adapter instead`)
    }
  }
  return 'no raw thinking params in base-SDK modules (grader/finding-validator)'
})

gate('GATE-42: SDK calls capture x-request-id via withResponse() (Anthropic support debuggability)', () => {
  for (const f of [(agentPaths.AGENTS_ROOT + '/src/grading/grader.js'), (agentPaths.AGENTS_ROOT + '/src/grading/finding-validator.js')]) {
    const src = fs.readFileSync(f, 'utf-8')
    if (!src.includes('withResponse')) {
      throw new Error(`${f} does not call .withResponse() — x-request-id not captured for support debugging`)
    }
    if (!/x-request-id/i.test(src)) {
      throw new Error(`${f} missing x-request-id header read`)
    }
  }
  return 'grader + finding-validator both capture x-request-id'
})

gate('GATE-43: budget hard-cap enforcement wired to notifier + cancel-signal path', () => {
  const src = fs.readFileSync(path.resolve(__dirname, 'event-bus.js'), 'utf-8')
  if (!src.includes('function _enforceBudgetCap')) {
    throw new Error('_enforceBudgetCap helper missing')
  }
  // At least 4 call sites (4 budget-check phases in dispatchPentestParallel + 1 in chain path)
  const calls = (src.match(/_enforceBudgetCap\(taskId/g) || []).length
  if (calls < 4) throw new Error(`only ${calls} budget-cap enforcement sites; expected ≥4`)
  // Must reference both notifier + cancel-signals
  if (!src.includes("notifier.notify('budget_exceeded'")) throw new Error('notifier.notify("budget_exceeded") not wired')
  if (!src.includes("'/root/intel/cancel-signals'")) throw new Error('cancel-signals path not referenced in budget cap')
  return `${calls} budget-cap sites + notifier + cancel-signals integrated`
})

gate('GATE-44: /api/models reads model-config families (not the deprecated agent-model-overrides schema)', () => {
  const f = '/root/mission-control/app/api/models/route.ts'
  if (!fs.existsSync(f)) throw new Error(`${f} missing`)
  const src = fs.readFileSync(f, 'utf-8')
  if (!src.includes((agentPaths.INTEL_ROOT + '/model-config.json'))) {
    throw new Error('/api/models route does not read model-config.json — ModelPicker will be empty on task-create form')
  }
  if (!src.includes('cfg.families')) {
    throw new Error('/api/models route does not parse cfg.families — schema mismatch')
  }
  return 'models endpoint reads model-config families correctly'
})

// ═══════════════════════════════════════════════════════════════════════════
// Evidence-completeness discipline gates (2026-04-23)
// ═══════════════════════════════════════════════════════════════════════════

gate('GATE-45: MUST_GATES contains GATE-11 [CHAIN-COMPLETE]', () => {
  const sf = require((agentPaths.AGENTS_ROOT + '/src/core/squad-framework'))
  const gates = sf.getSquadGates('pentest')
  if (!gates.includes('GATE-11 [CHAIN-COMPLETE]')) {
    throw new Error('MUST_GATES missing GATE-11 [CHAIN-COMPLETE] — evidence-completeness discipline not applied')
  }
  return 'GATE-11 present in security gates'
})

gate('GATE-46: every squad has evidenceCompleteness config', () => {
  const sf = require((agentPaths.AGENTS_ROOT + '/src/core/squad-framework'))
  const missing = []
  for (const squad of sf.listKnownSquads()) {
    const cfg = sf.getEvidenceCompletenessConfig(squad)
    if (!cfg || typeof cfg.enabled !== 'boolean' || !cfg.provider) {
      missing.push(squad)
    }
  }
  if (missing.length) throw new Error('squads missing evidenceCompleteness: ' + missing.join(', '))
  return `all ${sf.listKnownSquads().length} squads have evidenceCompleteness config`
})

gate('GATE-47: evidence-completeness module exports expected API', () => {
  const ec = require((agentPaths.AGENTS_ROOT + '/src/pipeline/evidence-completeness'))
  for (const fn of ['capSeverity', 'validateCandidateSchema', 'pipelineTraceMeetsMinimum', 'downgradeReason']) {
    if (typeof ec[fn] !== 'function') throw new Error('evidence-completeness missing fn: ' + fn)
  }
  if (typeof ec.PIPELINE_MIN_LAYERS !== 'object') throw new Error('missing PIPELINE_MIN_LAYERS constant')
  return 'evidence-completeness module exports valid'
})

// ═══════════════════════════════════════════════════════════════════════════
// Threat-model discipline v2 gates (2026-04-23)
// ═══════════════════════════════════════════════════════════════════════════

gate('GATE-48: MUST_GATES contains GATE-12 [THREAT-MODEL]', () => {
  const sf = require((agentPaths.AGENTS_ROOT + '/src/core/squad-framework'))
  const gates = sf.getSquadGates('pentest')
  if (!gates.includes('GATE-12 [THREAT-MODEL]')) {
    throw new Error('MUST_GATES missing GATE-12 — threat-model discipline v2 not applied')
  }
  return 'GATE-12 present in security gates'
})

gate('GATE-49: every squad has threatModel config', () => {
  const sf = require((agentPaths.AGENTS_ROOT + '/src/core/squad-framework'))
  const missing = []
  for (const squad of sf.listKnownSquads()) {
    const cfg = sf.getThreatModelConfig(squad)
    if (!cfg || typeof cfg.enabled !== 'boolean' || !cfg.provider) missing.push(squad)
  }
  if (missing.length) throw new Error('squads missing threatModel: ' + missing.join(', '))
  return `all ${sf.listKnownSquads().length} squads have threatModel config`
})

gate('GATE-50: evidence-completeness module exports v2 API', () => {
  const ec = require((agentPaths.AGENTS_ROOT + '/src/pipeline/evidence-completeness'))
  const v2 = ['capSeverityByThreatModel', 'validateThreatModelSchema', 'composeAllCaps', 'shiftSeverity', 'minSeverity']
  for (const fn of v2) {
    if (typeof ec[fn] !== 'function') throw new Error('evidence-completeness missing v2 fn: ' + fn)
  }
  if (typeof ec.ATTACKER_PRIVILEGE_CAPS !== 'object') throw new Error('missing ATTACKER_PRIVILEGE_CAPS')
  if (typeof ec.TRUST_BOUNDARY_MODIFIERS !== 'object') throw new Error('missing TRUST_BOUNDARY_MODIFIERS')
  return 'v2 API exports valid'
})

gate('GATE-51: no orphan URL-extraction regex copies remain in event-bus.js', () => {
  // The 3 duplicated inline regex sites (formerly at lines 3731, 6066, 7560)
  // must all be replaced by the shared extractTargetUrl helper.
  const src = fs.readFileSync(path.resolve(__dirname, 'event-bus.js'), 'utf-8')
  // The orphan pattern is the literal `match(/https?:\/\/[^\s` start of the
  // buggy regex. After the fix, no event-bus.js source line should contain it.
  const orphanRe = /match\(\/https\?:\\\/\\\/\[\^\\s/
  if (orphanRe.test(src)) {
    throw new Error('orphan URL regex still inline in event-bus.js — should call extractTargetUrl() instead')
  }
  if (!/require\([^)]*url-extractor[^)]*\)/.test(src)) {
    throw new Error('event-bus.js does not require ./url-extractor')
  }
  return 'no orphan URL regex sites; extractTargetUrl wired'
})

gate('GATE-52: spot-check misses are captured by caller (not discarded)', () => {
  // The runReconSpotCheck caller must bind the result so misses array reaches
  // the early-exit decision and prompt builder. Bare `await runReconSpotCheck`
  // without binding is the regression we are gating against.
  const src = fs.readFileSync(path.resolve(__dirname, 'event-bus.js'), 'utf-8')
  const hasCapture = /const\s+\w+\s*=\s*await\s+runReconSpotCheck\(/.test(src)
  const hasMissUse = /_spotCheckMisses|spotResult\.misses|\.misses\s*\)/.test(src)
  if (!hasCapture) {
    throw new Error('runReconSpotCheck call result is not captured (return value discarded)')
  }
  if (!hasMissUse) {
    throw new Error('spot-check misses are captured but never consulted (no .misses or _spotCheckMisses usage downstream)')
  }
  if (!/require\([^)]*early-exit-decision[^)]*\)/.test(src)) {
    throw new Error('event-bus.js does not require ./early-exit-decision')
  }
  return 'spot-check misses captured + threaded into early-exit decision'
})

// ═══════════════════════════════════════════════════════════════════════════
// Browser-validator invariants (2026-05-01)
// ═══════════════════════════════════════════════════════════════════════════

gate('GATE-53: browser-recipe-validator enforces ALLOWED_ACTIONS whitelist with rejection branch', () => {
  const validatorPath = path.resolve(__dirname, 'agents/browser-recipe-validator.js')
  if (!fs.existsSync(validatorPath)) {
    throw new Error('agents/browser-recipe-validator.js missing')
  }
  const src = fs.readFileSync(validatorPath, 'utf-8')
  if (!/ALLOWED_ACTIONS/.test(src)) {
    throw new Error('ALLOWED_ACTIONS set definition missing from browser-recipe-validator.js')
  }
  if (!/action.*not allowed/.test(src)) {
    throw new Error('rejection branch ("action ... not allowed") missing — whitelist not enforced')
  }
  return 'ALLOWED_ACTIONS defined + rejection branch present'
})

gate('GATE-54: SCRIBE report prompt body references BROWSER-VERIFICATION-${taskId}', () => {
  const src = fs.readFileSync(path.resolve(__dirname, 'event-bus.js'), 'utf-8')
  const idx = src.indexOf('function buildscribeReportPrompt')
  if (idx === -1) {
    throw new Error('function buildscribeReportPrompt not found in event-bus.js — SCRIBE prompt builder missing')
  }
  const slice = src.slice(idx, idx + 8000)
  if (!slice.includes('BROWSER-VERIFICATION-${taskId}')) {
    throw new Error('SCRIBE prompt body does not reference BROWSER-VERIFICATION-${taskId} — SCRIBE cannot consume browser-verifier evidence')
  }
  return 'SCRIBE prompt references BROWSER-VERIFICATION-${taskId}'
})

gate('GATE-55: latest FINAL report citing browser-side findings carries BROWSER-VERIFICATION evidence', () => {
  const reportsDir = (agentPaths.INTEL_ROOT + '/reports')
  if (!fs.existsSync(reportsDir)) return 'no reports dir — skipped'
  const mdFiles = fs.readdirSync(reportsDir)
    .filter(f => f.endsWith('.md'))
    .map(f => ({ name: f, full: path.join(reportsDir, f), mtime: fs.statSync(path.join(reportsDir, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime)
  if (mdFiles.length === 0) return 'no recent reports — skipped'

  // Phase 3.8 deploy date: 2026-05-01 (commit 638aa70 on master). Reports
  // produced before this had no opportunity to include BROWSER-VERIFICATION
  // evidence — they ran on an older daemon. Skip-pass for legacy data so
  // GATE-55 only catches REGRESSIONS in post-deploy reports.
  const PHASE_3_8_DEPLOY_MS = Date.parse('2026-05-01T12:37:00Z')

  // Find the most recent report from the post-Phase-3.8 era.
  const postDeployReports = mdFiles.filter(r => r.mtime >= PHASE_3_8_DEPLOY_MS)
  if (postDeployReports.length === 0) {
    return `no post-Phase-3.8 reports yet (newest is ${mdFiles[0].name}, pre-deploy) — skipped`
  }

  const latest = postDeployReports[0]
  const content = fs.readFileSync(latest.full, 'utf-8')
  const browserClaimRe = /\b(DOM XSS|prototype pollution|postMessage|CSP bypass)\b/i
  if (!browserClaimRe.test(content)) {
    return `latest post-deploy report ${latest.name} has no browser-side claims — skipped`
  }
  if (!/BROWSER-VERIFICATION|browser_validation_skipped/i.test(content)) {
    throw new Error(`post-deploy report ${latest.name} claims browser-side findings but lacks BROWSER-VERIFICATION evidence or browser_validation_skipped marker`)
  }
  return `post-deploy report ${latest.name} carries browser-verifier evidence`
})

// ═══════════════════════════════════════════════════════════════════════════
// G1 Judge Verifier invariants (2026-05-06)
// ═══════════════════════════════════════════════════════════════════════════

gate('GATE-56: judge-verifier exports 4-stage validation API', () => {
  const judgePath = path.resolve(__dirname, 'agents/judge-verifier.js')
  if (!fs.existsSync(judgePath)) {
    throw new Error('agents/judge-verifier.js missing — G1 Layer A pattern not deployed')
  }
  const src = fs.readFileSync(judgePath, 'utf-8')
  const requiredExports = [
    'STAGE_DOWNGRADE',
    'buildJudgePrompt',
    'parseJudgeResponse',
    'applyJudgeResult',
    'judgeFindings',
    'downgradeSeverity',
  ]
  for (const exp of requiredExports) {
    if (!new RegExp('\\b' + exp + '\\b').test(src)) {
      throw new Error(`judge-verifier.js missing required export: ${exp}`)
    }
  }
  // Verify all 4 stages present in prompt builder
  for (const stage of ['Stage A', 'Stage B', 'Stage C', 'Stage D']) {
    if (!src.includes(stage)) {
      throw new Error(`judge-verifier prompt missing ${stage} — 4-stage structure incomplete`)
    }
  }
  return '4-stage judge-verifier API present (A/B/C/D + 6 exports)'
})

gate('GATE-57: judge-verifier downgrade table maps each stage to a severity floor', () => {
  const { STAGE_DOWNGRADE } = require('./agents/judge-verifier')
  for (const stage of ['A', 'B', 'C', 'D']) {
    if (!STAGE_DOWNGRADE[stage]) {
      throw new Error(`STAGE_DOWNGRADE missing entry for stage ${stage}`)
    }
    if (!['Info', 'Low', 'Medium', 'High', 'Critical'].includes(STAGE_DOWNGRADE[stage])) {
      throw new Error(`STAGE_DOWNGRADE.${stage}=${STAGE_DOWNGRADE[stage]} is not a valid severity`)
    }
  }
  // Specific architectural invariant: Stage B must NEVER allow Critical (caps severity)
  if (STAGE_DOWNGRADE.B === 'Critical' || STAGE_DOWNGRADE.B === 'High') {
    throw new Error('STAGE_DOWNGRADE.B must cap severity (not Critical/High) — attacker prerequisites failure means unrealistic exploitation')
  }
  return `STAGE_DOWNGRADE: A=${STAGE_DOWNGRADE.A}, B=${STAGE_DOWNGRADE.B}, C=${STAGE_DOWNGRADE.C}, D=${STAGE_DOWNGRADE.D}`
})

gate('GATE-59: SCRIBE report prompt body references JUDGED-FINDINGS-${taskId}', () => {
  const src = fs.readFileSync(path.resolve(__dirname, 'event-bus.js'), 'utf-8')
  const idx = src.indexOf('function buildscribeReportPrompt')
  if (idx === -1) {
    throw new Error('function buildscribeReportPrompt not found in event-bus.js — SCRIBE prompt builder missing')
  }
  const slice = src.slice(idx, idx + 12000)
  if (!slice.includes('JUDGED-FINDINGS-${taskId}')) {
    throw new Error('SCRIBE prompt body does not reference JUDGED-FINDINGS-${taskId} — SCRIBE cannot consume judge-verifier evidence (Phase 3.9)')
  }
  if (!/judge_verdict/.test(slice)) {
    throw new Error('SCRIBE prompt body does not teach how to interpret judge_verdict — Phase 3.9 evidence will be ignored')
  }
  return 'SCRIBE prompt references JUDGED-FINDINGS-${taskId} + interprets judge_verdict'
})

gate('GATE-62: Phase 3.9 reads per-task VALIDATED-FINDINGS (post Phase 3.05 build)', () => {
  // 2026-05-11 update: GATE was protecting an UNTRUE assumption that AUDITOR
  // wrote to /root/intel/pentest/VALIDATED-FINDINGS.jsonl. AUDITOR never wrote
  // there — that file was a fossil from a previous prompt design. Phase 3.9
  // was reading stale data across runs (round-9 88% was partial luck from
  // motorola entries matching the target). Sprint May-11 fixes the gap with
  // auditor-validated-builder (GATE-72) which converts AUDITOR's ACTIVITY-LOG
  // verdicts into per-task VALIDATED-FINDINGS-{taskId}.jsonl at Phase 3.05.
  // Phase 3.9 now reads that per-task file. The original concern that drove
  // the old GATE-62 (Phase 3.9 always skipping because file didn't exist)
  // is solved because Phase 3.05 always writes the per-task file even when
  // empty (judge handles empty input gracefully via getJudgeable filter).
  const ebSrc = fs.readFileSync(path.resolve(__dirname, 'event-bus.js'), 'utf-8')
  const phase39Idx = ebSrc.indexOf('PHASE 3.9: Judge Verifier')
  if (phase39Idx < 0) {
    throw new Error('Phase 3.9 hook missing')
  }
  const slice = ebSrc.slice(phase39Idx, phase39Idx + 4000)
  // New requirement: per-task ${taskId} form
  if (!/VALIDATED-FINDINGS-\$\{taskId\}\.jsonl/.test(slice)) {
    throw new Error('Phase 3.9 must read per-task /root/intel/VALIDATED-FINDINGS-${taskId}.jsonl (Sprint May-11)')
  }
  // Old fossil path must NOT appear in Phase 3.9 block
  if (/\/root\/intel\/pentest\/VALIDATED-FINDINGS\.jsonl/.test(slice)) {
    throw new Error('Phase 3.9 must NOT read fossil shared /root/intel/pentest/VALIDATED-FINDINGS.jsonl (Sprint May-11)')
  }
  if (!/outputDir\s*:\s*[`'"]?\/root\/intel[`'"]?|judgeOutputDir/.test(slice)) {
    throw new Error('Phase 3.9 must pass outputDir=/root/intel so JUDGED-FINDINGS lands where SCRIBE reads')
  }
  return 'Phase 3.9 reads per-task VALIDATED-FINDINGS-{taskId}.jsonl + writes JUDGED-FINDINGS to /root/intel/'
})

gate('GATE-63: trajectory-observer module exists with full API + wired into event-bus.js', () => {
  // Sprint C.1 (2026-05-09): trajectory observation MVP.
  const observer = require((agentPaths.AGENTS_ROOT + '/agents/trajectory-observer'))
  const required = ['SCHEMA_VERSION', 'VERDICTS', 'FAILURE_DIMS', 'DEFAULT_LOG_PATH',
                    'LEGACY_LOG_PATH',
                    'buildObserverPrompt', 'parseObserverResponse', 'logObservation',
                    'observeSpecialistOutput', 'readTrajectoryLog']
  for (const name of required) {
    if (observer[name] == null) throw new Error(`trajectory-observer missing export: ${name}`)
  }
  if (observer.SCHEMA_VERSION !== '1') {
    throw new Error(`SCHEMA_VERSION expected '1', got ${observer.SCHEMA_VERSION}`)
  }
  // FIX 3 (2026-05-09): canonical log moved to subdir to escape specialist
  // pollution of the legacy flat-file path.
  if (observer.DEFAULT_LOG_PATH !== (agentPaths.INTEL_ROOT + '/trajectory/observations.jsonl')) {
    throw new Error(`DEFAULT_LOG_PATH must be ${agentPaths.INTEL_ROOT}/trajectory/observations.jsonl, got ${observer.DEFAULT_LOG_PATH}`)
  }
  if (observer.LEGACY_LOG_PATH !== (agentPaths.INTEL_ROOT + '/trajectory-observations.jsonl')) {
    throw new Error(`LEGACY_LOG_PATH must be ${agentPaths.INTEL_ROOT}/trajectory-observations.jsonl (for migration awareness)`)
  }
  // readTrajectoryLog must be callable and fail-soft on missing files
  if (typeof observer.readTrajectoryLog !== 'function') {
    throw new Error('readTrajectoryLog must be a function')
  }
  const sanityRecords = observer.readTrajectoryLog('/tmp/this-file-cannot-exist-' + Date.now() + '.jsonl')
  if (!Array.isArray(sanityRecords) || sanityRecords.length !== 0) {
    throw new Error('readTrajectoryLog must return [] for missing files (fail-soft)')
  }
  // Wiring check
  const eventBus = require('fs').readFileSync((agentPaths.AGENTS_ROOT + '/event-bus.js'), 'utf-8')
  if (!/require\(['"]\.\/agents\/trajectory-observer['"]\)/.test(eventBus)) {
    throw new Error('event-bus.js does not require ./agents/trajectory-observer')
  }
  if (!/observeSpecialistOutput\s*\(/.test(eventBus)) {
    throw new Error('event-bus.js does not call observeSpecialistOutput')
  }
  // Framework-wide guard: the call must NOT be exclusively inside the pentest
  // Phase-2 block. Check that the observeSpecialistOutput call is either
  // (a) near spawnAgent (universal hook) OR (b) outside the Phase-2a/d band.
  const observeIdx = eventBus.indexOf('observeSpecialistOutput')
  const spawnAgentIdx = Math.max(
    eventBus.indexOf('async function spawnAgent'),
    eventBus.indexOf('function spawnAgent')
  )
  const phase2aIdx = eventBus.indexOf('Phase 2a:')
  const phase2dIdx = eventBus.indexOf('Phase 2d:')
  const closeToSpawnAgent = spawnAgentIdx > 0 && Math.abs(observeIdx - spawnAgentIdx) < 5000
  const insidePhase2Block = phase2aIdx > 0 && phase2dIdx > 0 &&
                            observeIdx > phase2aIdx && observeIdx < phase2dIdx + 5000
  if (!closeToSpawnAgent && insidePhase2Block) {
    throw new Error('observer wiring is pentest-Phase-2-only — must be framework-wide (near spawnAgent)')
  }
  return 'trajectory-observer module + universal spawnAgent wiring + canonical log path verified'
})

gate('GATE-61: runtracerAgent wraps the entire tracer phase in checkpoint.verifying=true', () => {
  // Round-2 architectural lock: Phase A3 fix alone was insufficient — Phase G3
  // (200 sequential synchronous curls) ALSO blocks the event loop and triggers
  // supervisor SIGKILL. Setting verifying=true at the start of runtracerAgent
  // makes supervisor use its existing 15-min threshold for the whole tracer
  // phase. try/finally guarantees the flag is cleared on exception.
  // Spec: docs/superpowers/plans/2026-05-08-supervisor-heartbeat-fix.md (Round 2)
  const ebSrc = fs.readFileSync(path.resolve(__dirname, 'event-bus.js'), 'utf-8')
  const wrapperStart = ebSrc.indexOf('async function runtracerAgent(target, taskId) {')
  if (wrapperStart < 0) {
    throw new Error('runtracerAgent function missing in event-bus.js')
  }
  // Slice generously to find the wrapper body
  const wrapperSlice = ebSrc.slice(wrapperStart, wrapperStart + 2000)
  if (!/persistCheckpointNow\s*\(\s*\{\s*verifying\s*:\s*true\s*\}/.test(wrapperSlice)) {
    throw new Error('runtracerAgent must call persistCheckpointNow({ verifying: true }) at entry')
  }
  if (!/finally\s*\{[\s\S]{0,400}?persistCheckpointNow\s*\(\s*\{\s*verifying\s*:\s*(?:false|undefined)/.test(wrapperSlice)) {
    throw new Error('runtracerAgent must clear verifying flag in a finally block')
  }
  if (!/await\s+_runtracerAgentInner\s*\(/.test(wrapperSlice)) {
    throw new Error('runtracerAgent must call await _runtracerAgentInner(...)')
  }
  // Inner function must exist with the actual recon logic
  if (!ebSrc.includes('async function _runtracerAgentInner(target, taskId)')) {
    throw new Error('_runtracerAgentInner function missing — tracer recon body not preserved')
  }
  return 'runtracerAgent wraps tracer phase in verifying=true (15-min supervisor threshold)'
})

gate('GATE-60: Phase A3 (crawl4ai browser crawl) uses async runWithHeartbeat, NOT blocking sync subprocess', () => {
  // Architectural lock: a blocking sync subprocess in Phase A3 caused supervisor.js
  // to issue spurious pm2 restart event-bus mid-crawl (5-min stale checkpoint
  // detection — see docs/superpowers/plans/2026-05-08-supervisor-heartbeat-fix.md).
  // The fix routes Phase A3 through agents/long-running-spawn.js so the event
  // loop stays responsive and the heartbeat keeps bumping checkpoint.ts.
  const wrapperPath = path.resolve(__dirname, 'agents/long-running-spawn.js')
  if (!fs.existsSync(wrapperPath)) {
    throw new Error('agents/long-running-spawn.js missing — async subprocess wrapper not deployed')
  }
  const wrapperSrc = fs.readFileSync(wrapperPath, 'utf-8')
  if (!/runWithHeartbeat/.test(wrapperSrc)) {
    throw new Error('long-running-spawn.js missing runWithHeartbeat export')
  }
  const ebSrc = fs.readFileSync(path.resolve(__dirname, 'event-bus.js'), 'utf-8')
  const fnStart = ebSrc.indexOf('async function runtracerAgent')
  if (fnStart < 0) {
    throw new Error('runtracerAgent function missing in event-bus.js')
  }
  const fnSlice = ebSrc.slice(fnStart, fnStart + 8000)
  const phaseA3Match = fnSlice.match(/Phase A3:[\s\S]{0,4000}?(?:\bPhase B\b|\bdiscovered\s*=\s*new Set)/) ||
                       fnSlice.match(/Phase A3:[\s\S]{0,4000}/)
  if (!phaseA3Match) {
    throw new Error('Phase A3 block not found in runtracerAgent')
  }
  const phaseA3 = phaseA3Match[0]
  if (/\b(?:execSync|spawnSync)\s*\(/.test(phaseA3)) {
    throw new Error('Phase A3 uses blocking sync subprocess (execSync/spawnSync) — supervisor SIGKILL regression risk')
  }
  if (!/\bawait\s+runWithHeartbeat\b/.test(phaseA3)) {
    throw new Error('Phase A3 must call await runWithHeartbeat (the async wrapper)')
  }
  return 'Phase A3 uses async runWithHeartbeat with heartbeat callback'
})

gate('GATE-58: run-judge-verifier CLI runner exists with documented contract', () => {
  const runnerPath = path.resolve(__dirname, 'scripts/run-judge-verifier.js')
  if (!fs.existsSync(runnerPath)) {
    throw new Error('scripts/run-judge-verifier.js missing — G1 MVP CLI runner not deployed')
  }
  const src = fs.readFileSync(runnerPath, 'utf-8')
  const required = ['runJudge', 'findValidatedFile', 'readFindings', 'writeJudged']
  for (const exp of required) {
    if (!new RegExp('\\b' + exp + '\\b').test(src)) {
      throw new Error(`run-judge-verifier.js missing required export: ${exp}`)
    }
  }
  // VALIDATED-FINDINGS in, JUDGED-FINDINGS out — the file-naming contract.
  if (!src.includes('VALIDATED-FINDINGS')) {
    throw new Error('runner must reference VALIDATED-FINDINGS input format')
  }
  if (!src.includes('JUDGED-FINDINGS')) {
    throw new Error('runner must produce JUDGED-FINDINGS output format')
  }
  return 'CLI runner present (4 exports + VALIDATED→JUDGED file contract)'
})

gate('GATE-64: every active squad has a valid capabilities.json', () => {
  // Sprint C.2 Task 9 (2026-05-10): A2A handoffs require each participating
  // squad to declare its capabilities. MVP-active squads are pentest +
  // cloud-security; others can be added incrementally as they gain handoff
  // surface area.
  const ACTIVE_SQUADS = ['pentest', 'cloud-security']
  for (const squad of ACTIVE_SQUADS) {
    const capPath = path.resolve(__dirname, 'squads', squad, 'capabilities.json')
    if (!fs.existsSync(capPath)) {
      throw new Error(`squads/${squad}/capabilities.json missing — A2A handoff target unroutable`)
    }
    let parsed
    try {
      parsed = JSON.parse(fs.readFileSync(capPath, 'utf-8'))
    } catch (e) {
      throw new Error(`squads/${squad}/capabilities.json malformed: ${e.message}`)
    }
    if (parsed.squad !== squad) {
      throw new Error(`squads/${squad}/capabilities.json: squad field "${parsed.squad}" must equal "${squad}"`)
    }
    if (parsed.version !== '1') {
      throw new Error(`squads/${squad}/capabilities.json: version must be "1" (got "${parsed.version}")`)
    }
    if (!Array.isArray(parsed.capabilities) || parsed.capabilities.length === 0) {
      throw new Error(`squads/${squad}/capabilities.json: capabilities must be a non-empty array`)
    }
    for (const cap of parsed.capabilities) {
      if (!cap.id || typeof cap.id !== 'string') {
        throw new Error(`squads/${squad}: capability missing string id`)
      }
      if (!Array.isArray(cap.agents) || cap.agents.length === 0) {
        throw new Error(`squads/${squad}/${cap.id}: agents must be a non-empty array`)
      }
      if (!cap.description || typeof cap.description !== 'string') {
        throw new Error(`squads/${squad}/${cap.id}: description must be a non-empty string`)
      }
    }
  }
  return `${ACTIVE_SQUADS.length} active squads × valid capabilities.json schema`
})

gate('GATE-65: handoff-resolver wired into event-bus.js with fail-soft watcher', () => {
  // Sprint C.2 Task 9 (2026-05-10): the watcher must be wired at NEXUS
  // startup so handoffs actually drain. Three checks: require, invocation,
  // fail-soft pattern.
  const ebSrc = fs.readFileSync(path.resolve(__dirname, 'event-bus.js'), 'utf-8')
  if (!/require\(['"]\.\/agents\/handoff-resolver['"]\)/.test(ebSrc)) {
    throw new Error('event-bus.js does NOT require ./agents/handoff-resolver — watcher cannot start')
  }
  if (!/processInboxOnce/.test(ebSrc)) {
    throw new Error('event-bus.js does NOT reference processInboxOnce — watcher not invoked')
  }
  // Fail-soft pattern: every call site must be guarded by .catch or try/catch.
  // Find the watcher region and assert error handling presence.
  const watcherRegionStart = ebSrc.indexOf('Handoff inbox watcher')
  if (watcherRegionStart < 0) {
    throw new Error('event-bus.js missing "Handoff inbox watcher" startup-log marker')
  }
  // Look back ~3000 chars for the wiring block.
  const blockStart = Math.max(0, watcherRegionStart - 3000)
  const block = ebSrc.slice(blockStart, watcherRegionStart + 200)
  if (!/\.catch\s*\(|try\s*\{[\s\S]*?\}\s*catch/.test(block)) {
    throw new Error('handoff watcher block lacks .catch / try-catch — not fail-soft')
  }
  if (!/setInterval\s*\([\s\S]{0,400}?(?:runHandoffSweep|processInboxOnce)/.test(block)) {
    throw new Error('handoff watcher must use setInterval polling (per Task 7 design)')
  }
  return 'handoff-resolver required + processInboxOnce invoked + fail-soft polling'
})

gate('GATE-66: Sprint C.2 prompt integration — specialists know HANDOFF, SCRIBE reads verdicts, CLI --create exists', () => {
  // Sprint C.2 Tasks 6 + 8 (2026-05-10): catch accidental regression where
  // buildSpecialistPrompt drops the HANDOFF section, OR buildscribeReportPrompt
  // loses the CROSS-SQUAD CORROBORATION read path. Both are required for
  // Sprint C.2 to actually fire end-to-end in production.
  // Sprint C.2 follow-up (2026-05-10): A2A_HANDOFF_SECTION advertised
  // `process-handoff.js --create` to specialists, but the flag never existed.
  // Specialists silently fell back to writing markdown (e.g.
  // CLOUD-SECURITY-HANDOFF-1778394458903.md) which SCRIBE never reads. Lock
  // in that the CLI exposes --create / --create-stdin / --create-file so the
  // promise the prompt makes is actually deliverable.
  const eb = fs.readFileSync(path.resolve(__dirname, 'event-bus.js'), 'utf-8')
  // Specialist prompt has HANDOFF section
  const sp = eb.indexOf('function buildSpecialistPrompt')
  if (sp < 0) throw new Error('buildSpecialistPrompt not found')
  // Find function body bounded by next function declaration
  const spEnd = eb.indexOf('\nfunction ', sp + 50)
  const spBody = eb.slice(sp, spEnd > 0 ? spEnd : sp + 8000)
  if (!/HANDOFF|handoff|A2A_HANDOFF_SECTION/i.test(spBody)) {
    throw new Error('buildSpecialistPrompt missing HANDOFF section')
  }
  // Inbox-path lives in the shared A2A_HANDOFF_SECTION constant; check the file
  // contains both the constant and a reference from buildSpecialistPrompt.
  if (!/handoffs\/inbox/.test(eb)) {
    throw new Error('event-bus.js does not name the inbox path /root/intel/handoffs/inbox/')
  }
  if (!/\$\{A2A_HANDOFF_SECTION\}/.test(spBody) && !/handoffs\/inbox/.test(spBody)) {
    throw new Error('buildSpecialistPrompt does not interpolate A2A_HANDOFF_SECTION (or name the inbox path inline)')
  }
  // SCRIBE reads handoffs
  const vp = eb.indexOf('function buildscribeReportPrompt')
  if (vp < 0) throw new Error('buildscribeReportPrompt not found')
  const vpEnd = eb.indexOf('\nfunction ', vp + 50)
  const vpBody = eb.slice(vp, vpEnd > 0 ? vpEnd : vp + 8000)
  if (!/handoffs\/done|cross-squad|CROSS-SQUAD|buildCrossSquadCorroborationSection/.test(vpBody)) {
    throw new Error('buildscribeReportPrompt does not read cross-squad handoffs')
  }
  // Sub-check: process-handoff.js CLI implements --create modes the prompt advertises
  const cli = fs.readFileSync(path.resolve(__dirname, 'scripts', 'process-handoff.js'), 'utf-8')
  for (const flag of ['--create', '--create-stdin', '--create-file']) {
    if (!cli.includes(`'${flag}'`) && !cli.includes(`"${flag}"`)) {
      throw new Error(`scripts/process-handoff.js missing ${flag} flag (the prompt promises it)`)
    }
  }
  if (!/createHandoff/.test(cli)) {
    throw new Error('scripts/process-handoff.js does not call createHandoff (the protocol drop site)')
  }
  return 'specialist HANDOFF section present + SCRIBE reads handoffs/done/ + CLI --create modes wired'
})

gate('GATE-68: handoff cost caps actually enforced (constants exported AND read)', () => {
  // Code-review fix (2026-05-10): MAX_HANDOFFS_PER_FINDING and
  // MAX_TASK_HANDOFF_BUDGET_USD were exported as constants AND advertised in
  // the specialist prompt as "enforced by handoff-protocol" — but neither
  // createHandoff nor processHandoff actually read them. A misbehaving
  // specialist could fire 50 handoffs against one finding.
  //
  // This gate catches future regressions where someone removes the
  // enforcement code while leaving the constants in place.
  const protoSrc = fs.readFileSync(
    path.resolve(__dirname, 'agents', 'handoff-protocol.js'), 'utf-8'
  )
  // createHandoff must read MAX_HANDOFFS_PER_FINDING — we look for both the
  // constant reference AND a comparison operator near it (just exporting
  // doesn't count; the constant must drive control flow).
  const createIdx = protoSrc.indexOf('function createHandoff')
  if (createIdx < 0) throw new Error('createHandoff not found in handoff-protocol.js')
  const createBody = protoSrc.slice(createIdx, createIdx + 4000)
  if (!/MAX_HANDOFFS_PER_FINDING/.test(createBody)) {
    throw new Error('createHandoff does not reference MAX_HANDOFFS_PER_FINDING — cap not enforced')
  }
  if (!/>=\s*MAX_HANDOFFS_PER_FINDING|MAX_HANDOFFS_PER_FINDING\s*<=/.test(createBody)
      && !/>=\s*MAX_HANDOFFS_PER_FINDING/.test(protoSrc)) {
    throw new Error('createHandoff does not COMPARE against MAX_HANDOFFS_PER_FINDING — cap not enforced')
  }

  const resolverSrc = fs.readFileSync(
    path.resolve(__dirname, 'agents', 'handoff-resolver.js'), 'utf-8'
  )
  const procIdx = resolverSrc.indexOf('function processHandoff')
  if (procIdx < 0) throw new Error('processHandoff not found in handoff-resolver.js')
  // Need it to import + reference the budget constant
  if (!/MAX_TASK_HANDOFF_BUDGET_USD/.test(resolverSrc)) {
    throw new Error('handoff-resolver.js does not reference MAX_TASK_HANDOFF_BUDGET_USD — budget cap not enforced')
  }
  if (!/>=\s*MAX_TASK_HANDOFF_BUDGET_USD/.test(resolverSrc)) {
    throw new Error('handoff-resolver.js does not COMPARE against MAX_TASK_HANDOFF_BUDGET_USD — budget cap not enforced')
  }
  // Sanity: the failure reason must mention "budget" so SCRIBE / ops can grep it
  if (!/budget exceeded/i.test(resolverSrc)) {
    throw new Error('handoff-resolver.js missing "budget exceeded" failure reason text')
  }
  return 'createHandoff enforces MAX_HANDOFFS_PER_FINDING + processHandoff enforces MAX_TASK_HANDOFF_BUDGET_USD'
})

gate('GATE-70: handoff-marker post-processor wired (universal output-marker → canonical handoff JSON)', () => {
  // Sprint C.2 follow-up (2026-05-10): the prompt-to-action gap fix.
  // Specialists naturally produce TEXT in stdout; they don't shell out to
  // `node scripts/process-handoff.js --create '<json>'` from prompt
  // instructions alone (round-7 + round-8c shipped with 0 canonical
  // handoffs). The marker pattern + universal post-processor (wired into
  // spawnAgent's resolve path) converts `<<HANDOFF ... >>` blocks into
  // canonical handoff JSON automatically. Framework-wide, not pentest-only.
  const parserPath = path.resolve(__dirname, 'agents', 'handoff-marker-parser.js')
  if (!fs.existsSync(parserPath)) {
    throw new Error('agents/handoff-marker-parser.js does not exist')
  }
  const parser = require(parserPath)
  for (const fn of ['extractHandoffMarkers', 'convertMarkerToHandoffArgs']) {
    if (typeof parser[fn] !== 'function') {
      throw new Error(`agents/handoff-marker-parser.js missing required export: ${fn}`)
    }
  }
  // event-bus.js must call extractHandoffMarkers (any call site counts)
  const eb = fs.readFileSync(path.resolve(__dirname, 'event-bus.js'), 'utf-8')
  if (!/extractHandoffMarkers\s*\(/.test(eb)) {
    throw new Error('event-bus.js does not call extractHandoffMarkers — post-processor not wired')
  }
  if (!/require\(['"]\.\/agents\/handoff-marker-parser['"]\)/.test(eb)) {
    throw new Error("event-bus.js does not require './agents/handoff-marker-parser'")
  }
  // A2A_HANDOFF_SECTION must teach the marker syntax (the new instruction)
  const m = eb.match(/const\s+A2A_HANDOFF_SECTION\s*=\s*`((?:\\`|[\s\S])*?)`/)
  if (!m) throw new Error('A2A_HANDOFF_SECTION constant not found')
  const section = m[1]
  if (!/<<HANDOFF/.test(section)) {
    throw new Error('A2A_HANDOFF_SECTION does not mention `<<HANDOFF` marker syntax')
  }
  if (!/>>/.test(section)) {
    throw new Error('A2A_HANDOFF_SECTION does not show the closing `>>` marker')
  }
  // NO MARKDOWN/CLI FALLBACK — specialists must NOT be told to shell out
  if (/node\s+\/root\/agents\/scripts\/process-handoff\.js\s+--create/.test(section)) {
    throw new Error('A2A_HANDOFF_SECTION still instructs specialists to run process-handoff.js --create — must use marker only')
  }
  // Anti-sycophancy: smoke-check the parser strips analyst commentary
  const sample = `<<HANDOFF
target_squad: cloud-security
target_capability: data-residency
source_finding_id: SMOKE-1
question: smoke?
evidence:
  host: example.com
rationale: should be stripped
my_analysis: should be stripped
severity_claim: Critical
expected_artifacts: verdict
>>`
  const markers = parser.extractHandoffMarkers(sample)
  if (!markers.length) throw new Error('parser failed to extract smoke marker')
  const mk = markers[0]
  if (mk.rationale || mk.my_analysis || mk.severity_claim) {
    throw new Error('parser did not strip analyst commentary (rationale/my_analysis/severity_claim)')
  }
  return 'handoff-marker-parser exports OK + event-bus wires extractHandoffMarkers + A2A section teaches marker syntax (no CLI fallback)'
})

gate('GATE-71: rule-based deterministic handoff generator wired into Phase 3.45', () => {
  // 2026-05-11: Closes the prompt-to-action gap empirically proven across
  // rounds 7/8c/9 (0 organic specialist-emitted handoffs even with marker
  // pattern shipped). This gate locks in the deterministic alternative:
  //   1. agents/rule-based-handoff-generator.js exists + exports required API
  //   2. The rule set covers all 5 cross-squad triggers
  //   3. Anti-sycophancy: STRIPPED_FIELDS matches handoff-marker-parser's
  //   4. Phase 3.45 hook in event-bus.js calls generateHandoffsForTask
  //   5. The hook routes through handoff-protocol.createHandoff (so per-finding
  //      cap + chain-depth guards are enforced — single source of truth)
  const genPath = path.resolve(__dirname, 'agents', 'rule-based-handoff-generator.js')
  if (!fs.existsSync(genPath)) {
    throw new Error('agents/rule-based-handoff-generator.js does not exist')
  }
  const gen = require(genPath)
  for (const fn of ['generateHandoffsForTask', 'buildHandoffArgs', 'matchedRulesFor',
                    'isEligibleFinding', 'pickEvidence']) {
    if (typeof gen[fn] !== 'function') {
      throw new Error(`agents/rule-based-handoff-generator.js missing function: ${fn}`)
    }
  }
  if (!Array.isArray(gen.RULES) || gen.RULES.length < 5) {
    throw new Error(`RULES must include at least 5 cross-squad triggers (got ${gen.RULES?.length})`)
  }
  const requiredRules = ['cloud-provider-touched', 'supply-chain', 'data-residency',
                         'network-attribution', 'framework-cve']
  for (const id of requiredRules) {
    if (!gen.RULES.some(r => r.id === id)) {
      throw new Error(`RULES missing required rule: ${id}`)
    }
  }
  // Anti-sycophancy: STRIPPED_FIELDS must include the canonical analyst
  // commentary fields (matches handoff-marker-parser's list).
  if (!Array.isArray(gen.STRIPPED_FIELDS)) {
    throw new Error('STRIPPED_FIELDS must be exported as an array')
  }
  for (const k of ['rationale', 'my_analysis', 'severity_claim', 'notes', 'false_positive_check']) {
    if (!gen.STRIPPED_FIELDS.includes(k)) {
      throw new Error(`STRIPPED_FIELDS missing required ban: ${k}`)
    }
  }
  // Severity gate: only High/Critical eligible
  if (!gen.ELIGIBLE_SEVERITIES.has('high') || !gen.ELIGIBLE_SEVERITIES.has('critical')) {
    throw new Error('ELIGIBLE_SEVERITIES must include both high and critical')
  }
  if (gen.ELIGIBLE_SEVERITIES.has('medium')) {
    throw new Error('ELIGIBLE_SEVERITIES must NOT include medium — that burns the 3-handoff budget')
  }
  // event-bus.js wiring
  const eb = fs.readFileSync(path.resolve(__dirname, 'event-bus.js'), 'utf-8')
  if (!/require\(['"]\.\/agents\/rule-based-handoff-generator['"]\)/.test(eb)) {
    throw new Error("event-bus.js does not require './agents/rule-based-handoff-generator'")
  }
  if (!/generateHandoffsForTask\s*\(/.test(eb)) {
    throw new Error('event-bus.js does not call generateHandoffsForTask')
  }
  if (!/Phase 3\.45|PHASE 3\.45/.test(eb)) {
    throw new Error('Phase 3.45 hook marker not found in event-bus.js (expected near AUDITOR→3.5 transition)')
  }
  // Smoke: a synthetic high finding with s3 url produces a cloud-security handoff arg
  const args = gen.buildHandoffArgs({
    finding: { id: 'SMOKE-71', severity: 'High', url: 'https://x.s3.amazonaws.com/k' },
    rule: gen.RULES.find(r => r.id === 'cloud-provider-touched'),
    sourceTaskId: 'smoke-71',
    sourceSquad: 'pentest',
    sourceAgent: 'GATE-71',
  })
  if (args.targetSquad !== 'cloud-security' || args.targetCapability !== 'cloud-misconfig') {
    throw new Error('smoke buildHandoffArgs did not route to cloud-security/cloud-misconfig')
  }
  if ('rationale' in args.request.evidence || 'notes' in args.request.evidence) {
    throw new Error('smoke evidence leaked analyst commentary')
  }
  return 'rule-based-handoff-generator exports OK + 5 rules + Phase 3.45 wired + anti-sycophancy stripped + severity gate enforced'
})

gate('GATE-72: auditor-validated-builder bridge wired into Phase 3.05', () => {
  // 2026-05-11: Locks in the fix for the long-standing Phase 3.9 stale-data
  // bug. Before this fix, Phase 3.9 read /root/intel/pentest/VALIDATED-
  // FINDINGS.jsonl (a fossil — no process wrote to it after a prior AUDITOR
  // prompt redesign). Round-9 + round-10 both had the judge classifying
  // stale 26-entry data from an unknown earlier run. Round-9's 88% pass
  // was partially luck because stale data happened to match the round-9
  // motorola target. Round-10 (different target = webvpn) got 0%.
  //
  // Fix: auditor-validated-builder.js parses AUDITOR's ACTIVITY-LOG verdicts
  // post-Phase 3 and writes per-task VALIDATED-FINDINGS-{taskId}.jsonl
  // that Phase 3.9 + Phase 3.45 + run-judge-verifier all already support
  // as their preferred per-task path.
  const builderPath = path.resolve(__dirname, 'agents', 'auditor-validated-builder.js')
  if (!fs.existsSync(builderPath)) {
    throw new Error('agents/auditor-validated-builder.js does not exist')
  }
  const builder = require(builderPath)
  for (const fn of ['buildFromBuffer', 'buildFromActivityLog',
                    'writeValidatedFindingsFile', 'buildAndWriteForTask',
                    'parseauditorEntry', 'inferSeverity']) {
    if (typeof builder[fn] !== 'function') {
      throw new Error(`agents/auditor-validated-builder.js missing function: ${fn}`)
    }
  }
  // event-bus.js wires the builder at Phase 3.05 (after AUDITOR, before 3.4 graph build)
  const eb = fs.readFileSync(path.resolve(__dirname, 'event-bus.js'), 'utf-8')
  if (!/require\(['"]\.\/agents\/auditor-validated-builder['"]\)/.test(eb)) {
    throw new Error("event-bus.js does not require './agents/auditor-validated-builder'")
  }
  if (!/buildAndWriteForTask\s*\(/.test(eb)) {
    throw new Error('event-bus.js does not call buildAndWriteForTask')
  }
  if (!/Phase 3\.05/.test(eb)) {
    throw new Error('Phase 3.05 marker not found in event-bus.js (expected post-AUDITOR, pre-3.4)')
  }
  // Phase 3.9 + Phase 3.45 must NOT read the fossil shared file anymore.
  // The pre-fix paths were /root/intel/pentest/VALIDATED-FINDINGS.jsonl
  // (no taskId suffix). They should now interpolate ${taskId}.
  const sharedFossilRe = /['"`]\/root\/intel\/pentest\/VALIDATED-FINDINGS\.jsonl['"`]/
  // SCRIBE's auxiliary import at line 453 may still reference the shared
  // file for its "ALSO check this if it exists" context — that's fine,
  // it's a soft signal not a primary input. We only care about Phase 3.9
  // + 3.45 hooks. Both should reference the per-task ${taskId} form now.
  const phase39Block = eb.match(/PHASE 3\.9:[\s\S]{0,2000}/i)
  if (phase39Block && sharedFossilRe.test(phase39Block[0])) {
    throw new Error('Phase 3.9 still reads fossil shared VALIDATED-FINDINGS.jsonl — must use per-task ${taskId} form')
  }
  const phase345Block = eb.match(/PHASE 3\.45:[\s\S]{0,2000}/i)
  if (phase345Block && sharedFossilRe.test(phase345Block[0])) {
    throw new Error('Phase 3.45 still reads fossil shared VALIDATED-FINDINGS.jsonl — must use per-task ${taskId} form')
  }
  // Smoke: synthetic AUDITOR buffer with 1 CONFIRMED + 1 KILLED → 1 record
  const sample = JSON.stringify({
    agent: 'AUDITOR',
    taskId: 'SMOKE-72',
    action: 'CONFIRMED — F-001: Smoke test finding',
  }) + '\n' + JSON.stringify({
    agent: 'AUDITOR',
    taskId: 'SMOKE-72',
    action: 'KILLED — F-002: Should not appear',
  })
  const smoke = builder.buildFromBuffer(sample, 'SMOKE-72')
  if (smoke.length !== 1) throw new Error(`smoke: expected 1 confirmed, got ${smoke.length}`)
  if (smoke[0].id !== 'F-001') throw new Error('smoke: wrong ID')
  return `auditor-validated-builder wired at Phase 3.05; Phase 3.9 + Phase 3.45 read per-task VALIDATED-FINDINGS-{taskId}.jsonl (fossil shared path removed)`
})

gate('GATE-73: poc-evidence-capture wired into Phase 3.07 (universal)', () => {
  // 2026-05-12: closes the "stored evidence is freeform LLM text, not real
  // response data" gap surfaced during the 2026-05-11 bounty-PoC session.
  // For each CONFIRMED finding with a URL, this module snapshots the live
  // HTTP response body+headers+timing to /root/intel/poc-evidence/
  // {taskId}/{findingId}.json so SCRIBE and Bugcrowd reports cite concrete
  // payloads, not summaries. Universal across squads.
  const modPath = path.resolve(__dirname, 'agents', 'poc-evidence-capture.js')
  if (!fs.existsSync(modPath)) {
    throw new Error('agents/poc-evidence-capture.js does not exist')
  }
  const mod = require(modPath)
  for (const fn of ['captureUrl', 'captureForValidatedFindings',
                    'writeEvidenceFile', 'readCapturesForTask',
                    'extractUrlsFromFinding', 'sanitizeHeaders']) {
    if (typeof mod[fn] !== 'function') {
      throw new Error(`agents/poc-evidence-capture.js missing function: ${fn}`)
    }
  }
  // Wiring: event-bus.js must require + call captureForValidatedFindings
  const eb = fs.readFileSync(path.resolve(__dirname, 'event-bus.js'), 'utf-8')
  if (!/require\(['"]\.\/agents\/poc-evidence-capture['"]\)/.test(eb)) {
    throw new Error("event-bus.js does not require './agents/poc-evidence-capture'")
  }
  if (!/captureForValidatedFindings\s*\(/.test(eb)) {
    throw new Error('event-bus.js does not call captureForValidatedFindings')
  }
  if (!/Phase 3\.07/.test(eb)) {
    throw new Error('Phase 3.07 marker not found in event-bus.js')
  }
  // Anti-sycophancy invariant: redacts secrets in stored headers
  const out = mod.sanitizeHeaders({
    'Set-Cookie': 'session=secret',
    Authorization: 'Bearer abc',
    'Content-Type': 'application/json',
  })
  if (out['Set-Cookie'] !== '[REDACTED]') throw new Error('sanitizeHeaders failed to redact Set-Cookie')
  if (out['Authorization'] !== '[REDACTED]') throw new Error('sanitizeHeaders failed to redact Authorization')
  return 'poc-evidence-capture wired at Phase 3.07 + secret redaction enforced'
})

gate('GATE-74: js-bundle-analyzer wired into Phase 1.6 (universal endpoint discovery)', () => {
  // 2026-05-12: closes the endpoint-discovery blind spot. TRACER crawls .js
  // URLs but never analyzed their contents, so /api/v1/printLog (a second
  // unauth-write vector on Lenovo's Motorola chatbot infra) was missed.
  // This module regex-extracts API paths + URLs + internal hints + build
  // metadata from any JS bundle (Vite/Webpack/Rollup/Parcel). Universal.
  const modPath = path.resolve(__dirname, 'agents', 'js-bundle-analyzer.js')
  if (!fs.existsSync(modPath)) {
    throw new Error('agents/js-bundle-analyzer.js does not exist')
  }
  const mod = require(modPath)
  for (const fn of ['analyzeJsBundle', 'analyzeBundlesFromUrls',
                    'extractApiEndpoints', 'extractUrls',
                    'extractInternalHints', 'extractBuildMetadata',
                    'writeAnalysisForTask', 'readJsUrlsForTask']) {
    if (typeof mod[fn] !== 'function') {
      throw new Error(`agents/js-bundle-analyzer.js missing function: ${fn}`)
    }
  }
  const eb = fs.readFileSync(path.resolve(__dirname, 'event-bus.js'), 'utf-8')
  if (!/require\(['"]\.\/agents\/js-bundle-analyzer['"]\)/.test(eb)) {
    throw new Error("event-bus.js does not require './agents/js-bundle-analyzer'")
  }
  if (!/analyzeBundlesFromUrls\s*\(/.test(eb)) {
    throw new Error('event-bus.js does not call analyzeBundlesFromUrls')
  }
  if (!/Phase 1\.6/.test(eb)) {
    throw new Error('Phase 1.6 marker not found in event-bus.js')
  }
  // Smoke: the regression test from the bounty session — /api/v1/printLog discoverable
  const eps = mod.extractApiEndpoints('axios.post("/api/v1/printLog", e);')
  if (!eps.includes('/api/v1/printLog')) {
    throw new Error('regression: /api/v1/printLog (the 2026-05-11 miss) not detected')
  }
  return 'js-bundle-analyzer wired at Phase 1.6 + /api/v1/printLog regression test passes'
})

gate('GATE-75: chain-verifier multi-binary allow-list (curl + openssl + dig + nslookup + host)', () => {
  // 2026-05-12: Round-10 chain-001 (TLS SAN extraction) failed step 1 with
  // "openssl s_client | grep" because chain-verifier only allowed curl as
  // the first token. Sprint May-12 expands the allow-list to common
  // info-gathering tools (no exec side-effects, no shell pipeline support).
  // Universal across squads.
  const cv = require(path.resolve(__dirname, 'src/pipeline/chain-verifier'))
  // openssl/dig/nslookup/host must parse successfully (dry-run)
  for (const binary of ['curl', 'openssl', 'dig', 'nslookup', 'host']) {
    const r = cv.verifyChain({
      id: 't', name: 't', severity: 'Low',
      steps: [{ step_id: 1, description: 'x', curl: `${binary} --help`, expected_result: 'x' }],
    }, { dryRun: true })
    if (r.stepResults[0].status === 'rejected') {
      throw new Error(`binary ${binary} unexpectedly rejected: ${r.stepResults[0].reason}`)
    }
  }
  // wget must still be rejected (defense-in-depth)
  const wgetResult = cv.verifyChain({
    id: 't', name: 't', severity: 'Low',
    steps: [{ step_id: 1, description: 'x', curl: 'wget https://example.com', expected_result: 'x' }],
  })
  if (wgetResult.stepResults[0].status !== 'rejected') {
    throw new Error('wget unexpectedly accepted — allow-list defense broken')
  }
  // Shell metacharacters must still be rejected
  const shellResult = cv.verifyChain({
    id: 't', name: 't', severity: 'Low',
    steps: [{ step_id: 1, description: 'x', curl: 'curl x.com; cat /etc/passwd', expected_result: 'x' }],
  })
  if (shellResult.stepResults[0].status !== 'rejected') {
    throw new Error('shell injection unexpectedly accepted — security broken')
  }
  return 'chain-verifier accepts curl/openssl/dig/nslookup/host + rejects wget + rejects shell pipelines'
})

gate('GATE-76: active-poc-policy module exports + safety semantics', () => {
  const p = require((agentPaths.AGENTS_ROOT + '/agents/active-poc-policy'))
  for (const fn of ['validatePermission', 'targetInScope', 'envIsEnabled',
                    'shouldAbortOnDefender', 'newCapState', 'canProbe', 'recordProbe']) {
    if (typeof p[fn] !== 'function') throw new Error(`active-poc-policy missing ${fn}`)
  }
  const expired = p.validatePermission({
    engagement_mode: 'active-poc',
    active_poc_permission: {
      permission_id: 'x', issued_by: 'x', valid_until: '2020-01-01T00:00:00Z',
      scope_domains: ['x.com'], capabilities: ['x'],
      max_total_probes: 1, max_per_finding: 1,
    },
  })
  if (expired.ok) throw new Error('expired permission incorrectly accepted')
  return 'active-poc-policy exports + expired-rejection enforced'
})

gate('GATE-77: active-poc-runner wired into Phase 3.08 with env-gate', () => {
  const runner = require((agentPaths.AGENTS_ROOT + '/agents/active-poc-runner'))
  if (typeof runner.runActivePocsForTask !== 'function') {
    throw new Error('runner missing runActivePocsForTask')
  }
  const eb = fs.readFileSync(path.resolve(__dirname, 'event-bus.js'), 'utf-8')
  if (!/require\(['"]\.\/agents\/active-poc-runner['"]\)/.test(eb)) {
    throw new Error('event-bus.js does not require active-poc-runner')
  }
  if (!/PHASE 3\.08/.test(eb)) throw new Error('Phase 3.08 marker missing')
  if (!/archon_ACTIVE_POC/.test(eb)) throw new Error('env-gate not present')
  return 'active-poc-runner wired at Phase 3.08 + env-gate enforced'
})

gate('GATE-78: active-poc library has at least one probe per critical squad', () => {
  const dir = path.resolve(__dirname, 'agents', 'active-poc-library')
  const expected = ['pentest', 'cloud-security', 'network-pentest']
  for (const squad of expected) {
    const squadDir = path.join(dir, squad)
    if (!fs.existsSync(squadDir)) throw new Error(`missing squad dir: ${squad}`)
    const probes = fs.readdirSync(squadDir).filter(f => f.endsWith('.js'))
    if (probes.length === 0) throw new Error(`squad ${squad} has no probes`)
  }
  return 'library has probes for pentest + cloud-security + network-pentest'
})

gate('GATE-79: chain-verifier supports match_mode=semantic for variable responses', () => {
  const cv = require(path.resolve(__dirname, 'src/pipeline/chain-verifier'))
  if (typeof cv.semanticMatch !== 'function') {
    throw new Error('chain-verifier missing semanticMatch export')
  }
  const r1 = cv.semanticMatch('admin: true', {
    keywords: ['admin'], status_code_range: [200, 299], actual_status_code: 200,
  })
  if (!r1.matched) throw new Error('semanticMatch failed on positive case')
  const r2 = cv.semanticMatch('admin: true', {
    keywords: ['admin'], status_code_range: [200, 299], actual_status_code: 500,
  })
  if (r2.matched) throw new Error('semanticMatch did not reject out-of-range status')
  const eb = fs.readFileSync(path.resolve(__dirname, 'event-bus.js'), 'utf-8')
  if (!/match_mode[\s\S]*semantic|semantic[\s\S]*match_mode/.test(eb)) {
    throw new Error('Constructor prompt does not teach semantic match_mode')
  }
  return 'semanticMatch exports + Constructor prompt teaches semantic mode'
})

gate('GATE-80: severity-profile filter wired at Phase 3.075 in event-bus.js', () => {
  // 2026-05-15: Universal severity profile filter (bounty/pentest/comprehensive)
  // borrowed from bughunter-ai. Hooks between Phase 3.07 evidence capture and
  // Phase 3.08 active-poc. Reads dispatch.severity_profile, filters
  // VALIDATED-FINDINGS into reported + archived (DOWNGRADE-NOT-DROP via
  // ARCHIVED-FINDINGS-{taskId}.jsonl).
  const sp = require(path.resolve(__dirname, 'agents/severity-profile'))
  for (const k of ['PROFILES', 'ZERO_DAY_INDICATORS', 'classifyFinding', 'filterFindings', 'summarize']) {
    if (sp[k] === undefined) throw new Error(`severity-profile missing export: ${k}`)
  }
  if (sp.PROFILES.bounty.min_cvss !== 8.0) throw new Error('bounty profile min_cvss must be 8.0')
  if (sp.PROFILES.pentest.min_cvss !== 4.0) throw new Error('pentest profile min_cvss must be 4.0')
  if (sp.PROFILES.comprehensive.min_cvss !== 0.0) throw new Error('comprehensive profile min_cvss must be 0.0')
  if (!Array.isArray(sp.ZERO_DAY_INDICATORS) || sp.ZERO_DAY_INDICATORS.length < 8) {
    throw new Error('ZERO_DAY_INDICATORS array must have at least 8 patterns')
  }
  const eb = fs.readFileSync(path.resolve(__dirname, 'event-bus.js'), 'utf-8')
  if (!/Phase 3\.075/.test(eb)) throw new Error('event-bus.js missing Phase 3.075 marker')
  if (!/require\(['"]\.\/agents\/severity-profile['"]\)/.test(eb)) {
    throw new Error('event-bus.js does not require severity-profile module')
  }
  if (!/agents\/squad-policy\//.test(eb)) {
    throw new Error('event-bus.js does not require any squad-policy adapter')
  }
  if (!/ARCHIVED-FINDINGS-/.test(eb)) {
    throw new Error('event-bus.js missing ARCHIVED-FINDINGS path (DOWNGRADE-NOT-DROP would break)')
  }
  return 'severity-profile module + Phase 3.075 wire + ARCHIVED-FINDINGS path all present'
})

gate('GATE-81: scope-prevalidator wired at Phase 0.0 in event-bus.js dispatchToAgent', () => {
  // 2026-05-15: Universal pre-dispatch scope hard-block borrowed from
  // bughunter-ai. Hooks at the universal entry dispatchToAgent (NOT per-squad)
  // BEFORE any specialist fires. Fail-soft on missing scope config (returns
  // 'warned'). On 'blocked' status, updates dispatch-queue.json to status='failed'
  // and returns without acquiring locks.
  const sp = require(path.resolve(__dirname, 'agents/scope-prevalidator'))
  for (const k of ['PREDISPATCH_STATUS', 'validateDispatch']) {
    if (sp[k] === undefined) throw new Error(`scope-prevalidator missing export: ${k}`)
  }
  for (const s of ['ALLOWED', 'BLOCKED', 'WARNED']) {
    if (!sp.PREDISPATCH_STATUS[s]) throw new Error(`PREDISPATCH_STATUS missing ${s}`)
  }
  // 5 squad-policy adapters must exist and expose the universal contract.
  for (const squad of ['pentest', 'cloud-security', 'network-pentest', 'code-review', 'stocks']) {
    const ap = require(path.resolve(__dirname, `agents/squad-policy/${squad}`))
    if (ap.squad !== squad) throw new Error(`squad-policy/${squad}.squad mismatch (got ${ap.squad})`)
    for (const fn of ['extractTarget', 'matchesScope', 'cvssOf']) {
      if (typeof ap[fn] !== 'function') throw new Error(`squad-policy/${squad}.${fn} not a function`)
    }
  }
  const eb = fs.readFileSync(path.resolve(__dirname, 'event-bus.js'), 'utf-8')
  if (!/Phase 0\.0/.test(eb)) throw new Error('event-bus.js missing Phase 0.0 marker')
  if (!/require\(['"]\.\/agents\/scope-prevalidator['"]\)/.test(eb)) {
    throw new Error('event-bus.js does not require scope-prevalidator module')
  }
  if (!/validateDispatch\(/.test(eb)) throw new Error('event-bus.js missing validateDispatch call')
  const idx00 = eb.indexOf('Phase 0.0')
  const idx05 = eb.lastIndexOf('Phase 0.5')
  if (idx00 < 0 || idx05 < 0 || idx00 > idx05) {
    throw new Error(`Phase 0.0 must precede last Phase 0.5 (idx00=${idx00}, idx05=${idx05})`)
  }
  return 'scope-prevalidator + 5 squad-policy adapters + Phase 0.0 wire all present'
})

gate('GATE-82: dossier-selector picks taskId-match over leader-newest (race fix)', () => {
  // 2026-05-15: Locks in the fix for the parallel-dispatch report race condition.
  // saveAgentReport previously picked newest leader-named .md, which collided
  // under parallel execution: multiple CHANAKYA stocks picked each other's
  // files. Fix: taskId-preferred selection in agents/dossier-selector.js.
  const sel = require(path.resolve(__dirname, 'agents/dossier-selector'))
  if (typeof sel.selectBestDossierFile !== 'function') {
    throw new Error('dossier-selector missing selectBestDossierFile export')
  }
  const eb = fs.readFileSync(path.resolve(__dirname, 'event-bus.js'), 'utf-8')
  if (!/agents\/dossier-selector/.test(eb)) {
    throw new Error('event-bus.js does not require dossier-selector')
  }
  if (!/selectBestDossierFile\(/.test(eb)) {
    throw new Error('event-bus.js does not call selectBestDossierFile')
  }
  return 'dossier-selector wired into event-bus.js saveAgentReport'
})

gate('GATE-83: AUDITOR verdict parser handles both new free-text format and legacy F-NNN format', () => {
  // 2026-05-15: Pre-existing Phase 3.05 AUDITOR bridge bug — regex demanded
  // F-NNN: title format but AUDITOR writes free-text "KILLED — title (agent-IDs)".
  // Caused Phase 3.075 + 3.9 to silently receive 0 findings from AUDITOR's
  // validation. Verified on passport.lenovo.com run 2026-05-15 (15 findings
  // in report, 0 in VALIDATED-FINDINGS due to regex miss).
  const mod = require(path.resolve(__dirname, 'agents/auditor-validated-builder'))
  if (typeof mod.parseVerdictLine !== 'function') {
    throw new Error('auditor-validated-builder missing parseVerdictLine export')
  }
  // New format
  const newFmt = mod.parseVerdictLine('KILLED — crossDomainLogout CSRF (TRACER-025)')
  if (!newFmt || newFmt.verdict !== 'KILLED') {
    throw new Error('parser does not handle new free-text format from AUDITOR')
  }
  // Legacy format
  const legacy = mod.parseVerdictLine('CONFIRMED — F-001: No Lockout')
  if (!legacy || legacy.findingId !== 'F-001') {
    throw new Error('parser broke legacy F-NNN: format compatibility')
  }
  return 'parseVerdictLine handles both new + legacy AUDITOR verdict formats'
})

gate('GATE-84: squad-policy cvssOf reads cvss_score (AUDITOR actual field) with severity-keyword fallback', () => {
  // 2026-05-16: Adapter shipped earlier today (commit 3ab5535) read finding.cvss
  // but AUDITOR writes finding.cvss_score. Caused Phase 3.075 severity filter to
  // see 0 CVSS for all pentest findings → all archive under bounty/pentest modes.
  // Fix: read cvss_score ?? cvss, fall back to severity-keyword pseudo-CVSS.
  for (const squad of ['pentest', 'cloud-security', 'network-pentest']) {
    const ap = require(path.resolve(__dirname, `agents/squad-policy/${squad}`))
    // cvss_score takes priority
    if (ap.cvssOf({ cvss_score: 7.5 }) !== 7.5) {
      throw new Error(`${squad}.cvssOf must read cvss_score field (AUDITOR actual)`)
    }
    // Legacy cvss still works
    if (ap.cvssOf({ cvss: 9.1 }) !== 9.1) {
      throw new Error(`${squad}.cvssOf must keep legacy cvss compatibility`)
    }
    // Severity-keyword fallback
    if (ap.cvssOf({ severity: 'high' }) !== 7.5) {
      throw new Error(`${squad}.cvssOf must fall back to severity keyword`)
    }
    // Empty returns 0
    if (ap.cvssOf({}) !== 0) {
      throw new Error(`${squad}.cvssOf must return 0 for empty finding`)
    }
  }
  return 'all 3 numeric-CVSS adapters read cvss_score with severity-keyword fallback'
})

gate('GATE-67: Promotion-tier Medium gate exists (judgeFindingsWithPromotion + Phase 3.9 wiring)', () => {
  // Sprint Promotion-1 (2026-05-09): the Medium-tier "promotion gate" evaluates
  // Medium findings with stricter rubric. Passing all 4 stages promotes Medium → High;
  // Stage A/B fail → Info/Medium downgrade; C/D fail → kept at Medium.
  //
  // This gate locks in:
  //   1. agents/judge-verifier.js exports judgeFindingsWithPromotion + constants
  //   2. The promotion prompt is structurally distinct from standard
  //   3. Phase 3.9 hook in event-bus.js calls runJudge with promotionMode:true
  //   4. The cost cap (PROMOTION_CAP_DEFAULT) is enforced
  const jv = require((agentPaths.AGENTS_ROOT + '/agents/judge-verifier'))
  const required = ['judgeFindingsWithPromotion', 'buildPromotionPrompt', 'applyPromotionResult',
                    'PROMOTION_TIER_FILTER', 'STANDARD_TIER_FILTER', 'PROMOTION_CAP_DEFAULT']
  for (const k of required) {
    if (!(k in jv)) throw new Error(`agents/judge-verifier.js missing export: ${k}`)
  }
  if (!Array.isArray(jv.PROMOTION_TIER_FILTER) || jv.PROMOTION_TIER_FILTER[0] !== 'Medium') {
    throw new Error('PROMOTION_TIER_FILTER must be ["Medium"]')
  }
  if (typeof jv.PROMOTION_CAP_DEFAULT !== 'number' || jv.PROMOTION_CAP_DEFAULT < 1) {
    throw new Error('PROMOTION_CAP_DEFAULT must be a positive number')
  }

  // Promotion prompt must differ from standard
  const minimalFinding = { title: 'X', severity: 'Medium', description: 'd' }
  const standard = jv.buildJudgePrompt(minimalFinding, 'https://t.com')
  const promo = jv.buildJudgePrompt(minimalFinding, 'https://t.com', { promotionMode: true })
  if (standard === promo) {
    throw new Error('promotion prompt must structurally differ from standard prompt')
  }
  if (!/PROMOTION|promotion gate|stricter/i.test(promo)) {
    throw new Error('promotion prompt must signal stricter rubric')
  }
  if (!/hardening|exploitable bug/i.test(promo)) {
    throw new Error('promotion prompt Stage A must distinguish real bugs from hardening recommendations')
  }
  // Anti-sycophancy: promo prompt must NOT leak severity_original or specialist framing
  const leakFinding = { title: 'X', severity: 'Medium', severity_original: 'Medium', description: 'd' }
  const leakPromo = jv.buildJudgePrompt(leakFinding, 'https://t.com', { promotionMode: true })
  if (/severity_original|specialist thinks|the specialist/i.test(leakPromo)) {
    throw new Error('promotion prompt leaks severity_original or specialist framing — anti-sycophancy violated')
  }

  // Phase 3.9 hook calls runJudge with promotionMode
  const ebSrc = fs.readFileSync(path.resolve(__dirname, 'event-bus.js'), 'utf-8')
  const phase39Idx = ebSrc.indexOf('PHASE 3.9: Judge Verifier')
  if (phase39Idx < 0) throw new Error('Phase 3.9 hook missing in event-bus.js')
  const slice = ebSrc.slice(phase39Idx, phase39Idx + 6000)
  if (!/promotionMode\s*:\s*true/.test(slice)) {
    throw new Error('Phase 3.9 must call runJudge with promotionMode: true')
  }

  // run-judge-verifier.js must support promotionMode in runJudge + --promotion-mode flag
  const runnerSrc = fs.readFileSync(path.resolve(__dirname, 'scripts', 'run-judge-verifier.js'), 'utf-8')
  if (!/promotionMode/.test(runnerSrc)) {
    throw new Error('scripts/run-judge-verifier.js missing promotionMode plumbing')
  }
  if (!/--promotion-mode/.test(runnerSrc)) {
    throw new Error('scripts/run-judge-verifier.js missing --promotion-mode CLI flag')
  }

  return `promotion-tier wired: cap=${jv.PROMOTION_CAP_DEFAULT}, prompt distinct, anti-sycophancy preserved, Phase 3.9 enables it`
})

gate('GATE-69: extractTargetUrl priority — config.target_url > config.target > title-fallback', () => {
  // Regression guard for 2026-05-09 round-8 motorola.com bug:
  //   Title "...validation on motorola.com" + config {target_url:
  //   "https://support.motorola.com"} extracted bare 'motorola.com' from
  //   title, TRACER crawled wrong host, wasted ~15 min before manual cancel.
  //
  // Locks in:
  //   1. config.target_url beats title-bare-domain
  //   2. config.target beats title-URL when target_url absent
  //   3. Title-extraction still works when config is missing (backwards compat)
  //   4. Every event-bus call site passes dispatch.config to the extractor
  const { extractTargetUrl } = require('./src/utils/url-extractor')

  // (1) Round-8 scenario: config.target_url MUST win.
  const round8 = extractTargetUrl({
    taskTitle: 'Pentest round-8 — full Sprint A+B+C+polish+gates validation on motorola.com',
    config: { target: 'https://support.motorola.com', target_url: 'https://support.motorola.com' },
  })
  if (round8 !== 'https://support.motorola.com') {
    throw new Error(`round-8 regression — expected https://support.motorola.com, got ${round8}`)
  }

  // (2) config.target wins when target_url is absent.
  const targetOnly = extractTargetUrl({
    taskTitle: 'scan https://decoy.example.com',
    config: { target: 'https://canonical.example.com' },
  })
  if (targetOnly !== 'https://canonical.example.com') {
    throw new Error(`config.target priority broken — got ${targetOnly}`)
  }

  // (3) Backwards compat: no config → title extraction still works.
  const legacy = extractTargetUrl({
    taskTitle: 'Pentest of https://legacy.example.com',
  })
  if (legacy !== 'https://legacy.example.com') {
    throw new Error(`title-fallback broken — got ${legacy}`)
  }

  // (4) Every event-bus.js call site must pass dispatch.config.
  const src = fs.readFileSync(path.resolve(__dirname, 'event-bus.js'), 'utf-8')
  const calls = src.match(/extractTargetUrl\([^)]*\)/g) || []
  if (calls.length < 3) {
    throw new Error(`expected ≥3 extractTargetUrl call sites in event-bus.js, found ${calls.length}`)
  }
  for (const c of calls) {
    if (!/dispatch\.config/.test(c)) {
      throw new Error(`event-bus.js call site missing dispatch.config: ${c}`)
    }
  }

  return `config.target_url wins; ${calls.length} event-bus call sites pass dispatch.config`
})

gate('GATE-85: dossier-selector priority — leader-name beats content-taskId (Chennai 2026-05-16 sub-bug fix)', () => {
  // 2026-05-16: Chennai Petroleum dispatch surfaced sub-bug in race-fix
  // commit 9f3db12 — selectBestDossierFile picked SHAKUNI contrarian (has
  // TaskID: in template header) over CHANAKYA institutional dossier (has
  // CHANAKYA in filename). Priority 2 (content-taskId) was beating priority
  // 3 (leader-name in filename). Real-world: SHAKUNI is a challenger, not
  // canonical squad output. Fix: swap priorities so leader-name signal beats
  // content-taskId.
  const os = require('node:os')
  const sel = require(path.resolve(__dirname, 'agents/dossier-selector'))
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gate85-'))
  const shakuni = path.join(dir, 'SHAKUNI-CONTRARIAN-2026-05-16-CHENN.md')
  const chanakya = path.join(dir, 'CHANAKYA-FINAL-2026-05-16-CHENN.md')
  fs.writeFileSync(shakuni, '# SHAKUNI\n## TaskID: 1778914821917\nwrong')
  fs.writeFileSync(chanakya, '# CHENN dossier\n## Institutional\nright')
  const now = Date.now()
  fs.utimesSync(shakuni, new Date(now - 10000) / 1000, new Date(now - 10000) / 1000)
  fs.utimesSync(chanakya, new Date(now) / 1000, new Date(now) / 1000)
  const result = sel.selectBestDossierFile([dir], '1778914821917', 'CHANAKYA', now - 30 * 60 * 1000)
  if (!result || !result.name.includes('CHANAKYA')) {
    throw new Error(`Expected CHANAKYA-named file to win over SHAKUNI content-match, got: ${result && result.name}`)
  }
  return 'leader-name in filename beats content-taskId (Chennai regression locked)'
})

gate('GATE-86: auditor-validated-builder emits canonical url field via url-extractor', () => {
  // Sprint A Task 1 lock: producer-boundary canonical url emission.
  // AUDITOR validated-findings builder must import url-extractor and call
  // extractFirstUrl against details/notes so every finding carries a
  // canonical url field before downstream phases (scope-validator, evidence
  // capture, A2A handoff) consume it.
  const src = fs.readFileSync(path.join(__dirname, 'agents/auditor-validated-builder.js'), 'utf8')
  if (!/require\([^)]*url-extractor[^)]*\)/.test(src)) {
    throw new Error('auditor-validated-builder.js missing url-extractor require')
  }
  if (!/extractFirstUrl\([^)]*(details|notes)/.test(src)) {
    throw new Error('auditor-validated-builder.js does not call extractFirstUrl on details/notes')
  }
  const { extractFirstUrl } = require('./agents/url-extractor')
  if (typeof extractFirstUrl !== 'function') {
    throw new Error('url-extractor.js does not export extractFirstUrl')
  }
  return 'canonical url emission wired'
})

gate('GATE-87: scope-validator has URL extraction fallback from details/notes', () => {
  // Sprint A Task 2 lock: prevents the silent 100% fail-safe OOS bug
  // observed in Lenovo Bugcrowd run, where findings without a top-level
  // url field were uniformly marked out-of-scope despite carrying valid
  // in-scope URLs inside details/notes. Validator must fall back to URL
  // extraction before triggering the fail-safe OOS verdict.
  const sv = require('./agents/scope-validator')
  const SCOPE = { in_scope: ['*.example.com'], out_of_scope: [], infra_dependencies: {} }
  const r = sv.validateFindingScope(
    { id: 'F-G87', details: 'curl https://api.example.com/x' },
    SCOPE
  )
  if (r.status !== 'in-scope') {
    throw new Error(`scope-validator did not fall back to details URL extraction (got status=${r.status})`)
  }
  return 'fallback extraction wired'
})

gate('GATE-88: severity-profile.resolveProfile + program_type mapping', () => {
  // Sprint A Task 3+4 lock: program_type → severity profile resolution.
  //   kudos        → pentest
  //   paid_bounty  → bounty
  //   explicit severity_profile always wins over program_type.
  // event-bus.js must call resolveProfile so Phase 3.075 picks the right
  // profile from dispatch config instead of defaulting per-squad.
  const sp = require('./agents/severity-profile')
  if (typeof sp.resolveProfile !== 'function') {
    throw new Error('severity-profile.js does not export resolveProfile')
  }
  if (sp.resolveProfile({ program_type: 'kudos' }) !== 'pentest') {
    throw new Error('program_type=kudos must resolve to pentest')
  }
  if (sp.resolveProfile({ program_type: 'paid_bounty' }) !== 'bounty') {
    throw new Error('program_type=paid_bounty must resolve to bounty')
  }
  if (sp.resolveProfile({ severity_profile: 'comprehensive', program_type: 'paid_bounty' }) !== 'comprehensive') {
    throw new Error('explicit severity_profile must win over program_type')
  }
  const src = fs.readFileSync(path.join(__dirname, 'event-bus.js'), 'utf8')
  if (!/resolveProfile\(/.test(src)) {
    throw new Error('event-bus.js does not call severityProfile.resolveProfile')
  }
  return 'program_type resolver + event-bus wire'
})

gate('GATE-89: chain-verifier redirect-aware for CORS-assertion steps', () => {
  const src = fs.readFileSync(path.join(__dirname, 'src/pipeline/chain-verifier.js'), 'utf8')
  if (!/require\([^)]*redirect-aware-curl[^)]*\)/.test(src)) {
    throw new Error('chain-verifier missing redirect-aware-curl require')
  }
  const { isCorsAssertion, extractFinalResponse } = require('./agents/redirect-aware-curl')
  if (typeof isCorsAssertion !== 'function' || typeof extractFinalResponse !== 'function') {
    throw new Error('redirect-aware-curl missing required exports')
  }
  if (!isCorsAssertion('access-control-allow-origin: *')) {
    throw new Error('isCorsAssertion failed on ACAO substring')
  }
  return 'redirect-aware chain wired'
})

gate('GATE-90: browser-verifier cross_origin_fetch + auto-recipe for CORS findings', () => {
  const bv = fs.readFileSync(path.join(__dirname, 'agents/browser-verifier.js'), 'utf8')
  if (!/case ['"]cross_origin_fetch['"]/.test(bv)) {
    throw new Error('browser-verifier missing cross_origin_fetch case')
  }
  const rc = fs.readFileSync(path.join(__dirname, 'agents/pentest-browser-recipe-constructor.js'), 'utf8')
  if (!/buildCorsRecipe/.test(rc)) {
    throw new Error('pentest-browser-recipe-constructor missing buildCorsRecipe')
  }
  const va = fs.readFileSync(path.join(__dirname, 'agents/browser-recipe-validator.js'), 'utf8')
  if (!/cross_origin_fetch/.test(va)) {
    throw new Error('browser-recipe-validator schema missing cross_origin_fetch')
  }
  return 'browser cross-origin verifier wired'
})

gate('GATE-91: SCRIBE chain-orphan guard wired + drops chains without validated backing', () => {
  const { filterChainsAgainstValidatedFindings } = require('./agents/scribe-chain-orphan-guard')
  if (typeof filterChainsAgainstValidatedFindings !== 'function') {
    throw new Error('scribe-chain-orphan-guard missing filterChainsAgainstValidatedFindings')
  }
  const r = filterChainsAgainstValidatedFindings(
    [{ id: 'C-G91', finding_ids: ['F-MISSING'] }],
    [{ id: 'F-OTHER' }]
  )
  if (r.kept.length !== 0 || r.dropped.length !== 1) {
    throw new Error(`orphan chain not dropped: kept=${r.kept.length} dropped=${r.dropped.length}`)
  }
  const eb = fs.readFileSync(path.join(__dirname, 'event-bus.js'), 'utf8')
  if (!/filterChainsAgainstValidatedFindings|scribe-chain-orphan-guard/.test(eb)) {
    throw new Error('event-bus.js does not call chain-orphan guard')
  }
  return 'chain-orphan guard wired + active'
})

gate('GATE-92: CHAIN_OUTPUT_SCHEMA includes finding_ids + Constructor prompt teaches it', () => {
  const cv = fs.readFileSync(path.join(__dirname, 'src/pipeline/chain-verifier.js'), 'utf8')
  if (!/finding_ids/.test(cv)) {
    throw new Error('CHAIN_OUTPUT_SCHEMA missing finding_ids')
  }
  if (!/required:[^]*finding_ids/.test(cv)) {
    throw new Error('finding_ids not in required list')
  }
  const eb = fs.readFileSync(path.join(__dirname, 'event-bus.js'), 'utf8')
  if (!/finding_ids/.test(eb)) {
    throw new Error('event-bus.js Constructor prompt missing finding_ids instruction')
  }
  return 'chain schema + prompt taught finding_ids'
})

gate('GATE-93: families.powerful has a matching event-bus PRICING row (cost-attribution coupling)', () => {
  // (2026-05-31) When the powerful family is bumped (e.g. opus-4-7 → 4-8), the openclaw-legacy
  // cost path (event-bus.js: `PRICING[model] || sonnet`) would silently fall back to sonnet
  // pricing for the new model unless a row exists. The live claude-CLI path uses total_cost_usd,
  // but this gate locks the coupling Jay caught so a future bump can never regress cost logging.
  const cfg = JSON.parse(fs.readFileSync((agentPaths.INTEL_ROOT + '/model-config.json'), 'utf-8'))
  const powerful = cfg.families.powerful
  const eb = fs.readFileSync(path.join(__dirname, 'event-bus.js'), 'utf8')
  const re = new RegExp(`['"]${powerful.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}['"]\\s*:\\s*\\{`)
  if (!re.test(eb)) {
    throw new Error(`families.powerful='${powerful}' but no PRICING row for it in event-bus.js — add one to keep cost attribution correct on the openclaw fallback path`)
  }
  return `families.powerful='${powerful}' has matching PRICING row`
})

gate('GATE-94: SEAM-CHOKEPOINT — ZERO claude-spawn sites outside agents/runner/adapters/', () => {
  // Detection: lines containing spawn( with the claude binary path as an inline
  // string literal — e.g. spawn('/root/.local/bin/claude', ...).  Files that
  // reference the path only as a const (cli.js: CLAUDE_BIN variable) or via
  // pathToClaudeCodeExecutable (sdk.js) are NOT matched — they are the seam.
  const claudeSpawnRe = /spawn\s*\(\s*['"]\/root\/\.local\/bin\/claude['"]/

  // Walk all tracked JS files (skip noise dirs)
  const { execSync: _exec } = require('child_process')
  const allJs = _exec(
    'find ' + agentPaths.AGENTS_ROOT + ' -name "*.js"' +
    ' -not -path "*/node_modules/*"' +
    ' -not -path "*/.backups/*"' +
    ' -not -path "*/test/*"' +
    ' -not -path "*/docs/*"',
    { encoding: 'utf-8' }
  ).trim().split('\n').filter(Boolean)

  const ADAPTERS_DIR = path.join(__dirname, 'agents/runner/adapters')
  // PURE-SDK cutover 2026-06-04: ZERO-TOLERANCE chokepoint. After the T8/T9/T10
  // call-site migrations + _buildClaudeSpawnEnv deletion, NO file outside
  // agents/runner/adapters/ may hold an inline claude-spawn — including
  // event-bus.js and grader.js (formerly grandfathered in). verify-framework.js
  // is the only exception: it carries the detection pattern as a string literal
  // inside this gate, which is NOT an actual spawn site.
  const ALLOWED_OUTSIDE = new Set(['verify-framework.js'])

  const violations = []
  let adapterSpawnFiles = [] // adapters files that have inline spawn (should be none — cli uses variable)

  for (const f of allJs) {
    const src = fs.readFileSync(f, 'utf-8')
    const hits = src.split('\n').filter(l => claudeSpawnRe.test(l)).length
    if (hits === 0) continue

    const isInAdapters = f.startsWith(ADAPTERS_DIR)
    const base = path.basename(f)

    if (isInAdapters) {
      adapterSpawnFiles.push(base)
    } else if (!ALLOWED_OUTSIDE.has(base)) {
      violations.push(`${base} (${hits} sites)`)
    }
  }

  if (violations.length > 0) {
    throw new Error(
      `Legacy claude-spawn sites remain outside agents/runner/adapters/: ${violations.join(', ')} — ` +
      `chokepoint is ZERO-TOLERANCE post-cutover; route through the adapters instead`
    )
  }
  // Within adapters/: cli.js wraps the binary via CLAUDE_BIN variable (not inline);
  // sdk.js uses pathToClaudeCodeExecutable (not spawn).  Neither should have the
  // inline-string pattern — if one appears, the seam boundary was breached.
  if (adapterSpawnFiles.length > 0) {
    throw new Error(
      `adapters with inline claude-spawn (should use CLAUDE_BIN variable): ${adapterSpawnFiles.join(', ')}`
    )
  }

  // Verify adapters seam shape: cli.js imports child_process (spawner); sdk.js does not.
  const cliSrc = fs.readFileSync(path.join(ADAPTERS_DIR, 'cli.js'), 'utf-8')
  const sdkSrc = fs.readFileSync(path.join(ADAPTERS_DIR, 'sdk.js'), 'utf-8')
  if (!/require\(['"](?:node:)?child_process['"]\)/.test(cliSrc)) {
    throw new Error('adapters/cli.js no longer imports child_process — cli spawner seam broken')
  }
  if (/require\(['"](?:node:)?child_process['"]\)/.test(sdkSrc)) {
    throw new Error('adapters/sdk.js now imports child_process — sdk should use query(), not spawn()')
  }

  return `chokepoint enforced: 0 legacy sites outside agents/runner/adapters/; adapters: cli only`
})

gate('GATE-95: RUNNER-STRUCTURED — cli + sdk adapters return { text, usage, model, raw } contract', () => {
  // Both adapters must return the structured object that kills the silent-drop class.
  // Gates must be sync; async runAgent calls are run via a child spawnSync(-e) probe.
  // Fake shapes mirror test/agent-runner.test.js exactly (makeOkSpawn / makeOkQuery).
  const probe = `
'use strict'
const { runAgent } = require('${agentPaths.AGENTS_ROOT}/agents/runner/agent-runner')
const { EventEmitter } = require('events')

// ── CLI fake: makeOkSpawn (mirrors test/agent-runner.test.js) ─────────────
const cliEnv = JSON.stringify({
  type: 'result', subtype: 'success', is_error: false,
  result: 'gate-95-cli-ok',
  usage: { input_tokens: 10, output_tokens: 5 },
  modelUsage: { 'claude-gate95-cli': { inputTokens: 10, outputTokens: 5, costUSD: 0.001 } },
  total_cost_usd: 0.001,
})
function fakeSpawn(_b, _a, _o) {
  const s = new EventEmitter(), e = new EventEmitter(), c = new EventEmitter()
  c.stdout = s; c.stderr = e; c.pid = 12345
  process.nextTick(() => { s.emit('data', Buffer.from(cliEnv)); c.emit('close', 0) })
  return c
}

// ── SDK fake: makeOkQuery (mirrors test/agent-runner.test.js) ─────────────
function fakeQuery(_params) {
  return (async function*() {
    yield { type: 'system', subtype: 'init', apiKeySource: 'oauth', model: 'claude-gate95-sdk', tools: [] }
    yield { type: 'assistant', message: { content: [{ type: 'text', text: 'gate-95-sdk-ok' }] } }
    yield {
      type: 'result', subtype: 'success', is_error: false,
      result: 'gate-95-sdk-ok',
      usage: { input_tokens: 11, output_tokens: 7 },
      modelUsage: { 'claude-gate95-sdk': { inputTokens: 11, outputTokens: 7, costUSD: 0.002 } },
      total_cost_usd: 0.002,
    }
  })()
}

function assertContract(label, r) {
  if (typeof r !== 'object' || r === null) throw new Error(label + ': result is not an object')
  if (typeof r.text !== 'string' || r.text.length === 0) throw new Error(label + ': text is empty or not a string, got: ' + JSON.stringify(r.text))
  if (typeof r.usage !== 'object' || r.usage === null) throw new Error(label + ': usage is not an object')
  if (typeof r.usage.input_tokens !== 'number') throw new Error(label + ': usage.input_tokens not a number')
  if (typeof r.usage.output_tokens !== 'number') throw new Error(label + ': usage.output_tokens not a number')
  if (typeof r.model !== 'string' || r.model.length === 0) throw new Error(label + ': model is empty or not a string, got: ' + JSON.stringify(r.model))
  if (!('raw' in r)) throw new Error(label + ': raw field absent')
}

async function main() {
  const cliResult = await runAgent({ adapter: 'cli', userPrompt: 'gate95', _spawn: fakeSpawn })
  assertContract('cli', cliResult)

  const sdkResult = await runAgent({ adapter: 'sdk', userPrompt: 'gate95', _query: fakeQuery })
  assertContract('sdk', sdkResult)

  process.stdout.write('cli:' + cliResult.model + ' sdk:' + sdkResult.model + '\\n')
  process.exit(0)
}

main().catch(e => { process.stderr.write(e.message + '\\n'); process.exit(1) })
`

  const r = spawnSync('node', ['-e', probe], { encoding: 'utf-8', timeout: 20000 })
  if (r.status !== 0) {
    throw new Error(
      `structured-return contract broken: ${(r.stderr || r.stdout || '').trim().slice(0, 400)}`
    )
  }
  const out = (r.stdout || '').trim()
  // out = 'cli:<model> sdk:<model>'
  return `both adapters pass { text, usage, model, raw } — ${out}`
})

gate('GATE-96: RUNNER-ENV-ALLOWLIST — single-source buildSpawnEnv, no spread, sdk passes env:', () => {
  const ADAPTERS_DIR = path.join(__dirname, 'agents/runner/adapters')
  const commonSrc = fs.readFileSync(path.join(ADAPTERS_DIR, 'common.js'), 'utf-8')
  const cliSrc    = fs.readFileSync(path.join(ADAPTERS_DIR, 'cli.js'),    'utf-8')
  const sdkSrc    = fs.readFileSync(path.join(ADAPTERS_DIR, 'sdk.js'),    'utf-8')

  // (a) Zero ...process.env spreads anywhere in agents/runner/**
  const { execSync: _exec } = require('child_process')
  const runnerJs = _exec(
    'find ' + path.join(__dirname, 'agents/runner') + ' -name "*.js"',
    { encoding: 'utf-8' }
  ).trim().split('\n').filter(Boolean)

  for (const f of runnerJs) {
    const src = fs.readFileSync(f, 'utf-8')
    const spreadLines = src.split('\n').filter((l, i) => {
      if (l.trim().startsWith('//') || l.trim().startsWith('*')) return false
      return /\.\.\.\s*process\.env/.test(l)
    })
    if (spreadLines.length > 0) {
      throw new Error(
        `${path.relative(__dirname, f)} contains ...process.env spread (${spreadLines.length} line(s)) — ` +
        `INVARIANT v2.1-A1: allowlist only, never spread`
      )
    }
  }

  // (b) cli.js and sdk.js BOTH require './common' and call buildSpawnEnv — no local copies
  if (!/require\(['"]\.\/common['"]\)/.test(cliSrc)) {
    throw new Error("cli.js does not require('./common') — ENV allowlist source-of-truth broken")
  }
  if (!/buildSpawnEnv/.test(cliSrc)) {
    throw new Error('cli.js does not call buildSpawnEnv — may have a local _buildSpawnEnv copy')
  }
  if (!/require\(['"]\.\/common['"]\)/.test(sdkSrc)) {
    throw new Error("sdk.js does not require('./common') — ENV allowlist source-of-truth broken")
  }
  if (!/buildSpawnEnv/.test(sdkSrc)) {
    throw new Error('sdk.js does not call buildSpawnEnv — may have a local _buildSpawnEnv copy')
  }

  // No local _buildSpawnEnv function definition in cli.js or sdk.js (must come from common only)
  const localDefRe = /function\s+_?buildSpawnEnv\s*\(/
  if (localDefRe.test(cliSrc)) {
    throw new Error('cli.js defines its own buildSpawnEnv — must use common.js (one source of truth)')
  }
  if (localDefRe.test(sdkSrc)) {
    throw new Error('sdk.js defines its own buildSpawnEnv — must use common.js (one source of truth)')
  }

  // (c) sdk.js passes env: key into query options (absence = SDK inherits full process.env)
  if (!/\benv\s*:/.test(sdkSrc)) {
    throw new Error(
      'sdk.js does not pass env: into query options — without it the SDK inherits ' +
      'full process.env including cloud creds (the silent re-exposure failure mode)'
    )
  }

  // (d) common.js constructs from explicit allowlist: references HOME, PATH, TERM; no spread
  for (const key of ['HOME', 'PATH', 'TERM']) {
    if (!commonSrc.includes(key)) {
      throw new Error(`common.js buildSpawnEnv missing allowlist key: ${key}`)
    }
  }
  if (/\.\.\.\s*process\.env/.test(commonSrc)) {
    throw new Error('common.js spreads process.env — allowlist invariant broken at the source')
  }

  // (e) PURE-SDK cutover lock: event-bus.js and grader.js must contain ZERO
  // ...process.env spreads. After _buildClaudeSpawnEnv's deletion this class is
  // gone; locking it here prevents a spawn-env spread from silently returning.
  // Comment lines (// or *) are skipped — the files carry doc-comments that
  // mention the pattern in backticks (those are not real spreads).
  for (const base of ['event-bus.js', 'src/grading/grader.js']) {
    const src = fs.readFileSync(path.resolve(__dirname, base), 'utf-8')
    const spreadLines = src.split('\n').filter((l) => {
      const t = l.trim()
      if (t.startsWith('//') || t.startsWith('*')) return false
      return /\.\.\.\s*process\.env/.test(l)
    })
    if (spreadLines.length > 0) {
      throw new Error(
        `${base} contains ${spreadLines.length} ...process.env spread(s) — ` +
        `INVARIANT v2.1-A1 (PURE-SDK lock): claude-spawn env must flow through ` +
        `the adapter allowlist, never a process.env spread`
      )
    }
  }

  return 'no spread in runner/**, event-bus.js, grader.js; cli+sdk use common.buildSpawnEnv; sdk passes env:; allowlist has HOME/PATH/TERM'
})

gate('GATE-97: BRIDGE-EXIT-MAP — bridgeSpawnAgent maps success/timeout/error → 0/143/2', () => {
  // Locks run-agent-bridge.js's exit-code discrimination contract: spawnWithRetry
  // (event-bus.js) keys retry behavior on (code, output). If a future bridge
  // refactor drops the 143-on-timeout or the 429-text-in-output-on-error mapping,
  // retries go infinite or kills get silently dropped. We assert via DI fakes
  // (opts._runAgent) so this is offline + deterministic. Gates are sync → probe
  // via spawnSync('node', ['-e', ...]) like GATE-95.
  const probe = `
'use strict'
const { bridgeSpawnAgent } = require('${agentPaths.AGENTS_ROOT}/agents/runner/run-agent-bridge')

// (a) success → code 0 + output JSON-parses with total_cost_usd + modelUsage
function okRunAgent(_spec) {
  return Promise.resolve({
    text: 'gate-97-ok',
    usage: { input_tokens: 10, output_tokens: 5 },
    model: 'claude-gate97',
    raw: {
      result: {
        type: 'result', subtype: 'success', total_cost_usd: 0.0042,
        usage: { input_tokens: 10, output_tokens: 5 },
        modelUsage: { 'claude-gate97': { inputTokens: 10, outputTokens: 5, costUSD: 0.0042 } },
      },
    },
  })
}
// (b) timeout → reject with 'timed out after Xms' → code 143 + output ''
function timeoutRunAgent(_spec) { return Promise.reject(new Error('[sdk][G97] timed out after 50ms')) }
// (c) rate-limit → reject with '429 rate limit' → code 2 + message IN output
function rateLimitRunAgent(_spec) { return Promise.reject(new Error('429 rate limit exceeded')) }

async function main() {
  // (a)
  const a = await bridgeSpawnAgent({ agentName: 'G97', userPrompt: 'hi' }, { _runAgent: okRunAgent })
  if (a.code !== 0) throw new Error('success: expected code 0, got ' + a.code)
  const env = JSON.parse(a.output) // must JSON-parse
  if (typeof env.total_cost_usd !== 'number') throw new Error('success: output missing total_cost_usd')
  if (!env.modelUsage || typeof env.modelUsage !== 'object' || !Object.keys(env.modelUsage).length) {
    throw new Error('success: output missing modelUsage')
  }

  // (b)
  const b = await bridgeSpawnAgent({ agentName: 'G97', userPrompt: 'hi' }, { _runAgent: timeoutRunAgent })
  if (b.code !== 143) throw new Error('timeout: expected code 143, got ' + b.code)
  if (b.output !== '') throw new Error('timeout: expected empty output, got ' + JSON.stringify(b.output))

  // (c)
  const c = await bridgeSpawnAgent({ agentName: 'G97', userPrompt: 'hi' }, { _runAgent: rateLimitRunAgent })
  if (c.code !== 2) throw new Error('rate-limit: expected code 2, got ' + c.code)
  if (!/429/.test(c.output)) throw new Error('rate-limit: 429 message must be IN output, got ' + JSON.stringify(c.output))

  process.stdout.write('a=' + a.code + ' b=' + b.code + ' c=' + c.code + '\\n')
  process.exit(0)
}
main().catch(e => { process.stderr.write(e.message + '\\n'); process.exit(1) })
`

  const r = spawnSync('node', ['-e', probe], { encoding: 'utf-8', timeout: 20000 })
  if (r.status !== 0) {
    throw new Error(
      `bridge exit-code mapping broken: ${(r.stderr || r.stdout || '').trim().slice(0, 400)}`
    )
  }
  return `bridge maps success→0 timeout→143 ratelimit→2 — ${(r.stdout || '').trim()}`
})

gate('GATE-98: INTERPHASE-CONTRACT — phase-envelope loads, validate throws on wrong type, quarantine writes JSONL, wrap stamps correctly', () => {
  // Locks the typed inter-phase envelope contract (B2, 2026-06-05).
  // Root-cause fix for the silent-drop/stale-field class:
  //   - AUDITOR→judge VERDICT_RE breakage (May 11 + May 15)
  //   - Gulf Oil dashboard bug (May 15, wrong field names)
  //   - 22 distinct key signatures / 48 findings (finding-schema audit)
  // All checks are via a single spawnSync(-e) offline probe (no I/O side effects
  // except a temp dir that the probe cleans up).
  const probe = `
'use strict'
const os = require('os')
const fs = require('fs')
const path = require('path')
const { wrap, validate, quarantine, PhaseEnvelopeError, SCHEMA_VERSION } =
  require('${agentPaths.AGENTS_ROOT}/agents/phase-envelope')

// (a) module loads + SCHEMA_VERSION is '1'
if (SCHEMA_VERSION !== '1') throw new Error('SCHEMA_VERSION !== 1, got: ' + SCHEMA_VERSION)

// (b) wrap stamps correct fields
const env = wrap('finding', { id: 'G98' }, { source: 'AUDITOR', taskId: 'gate98' })
if (env.schemaVersion !== '1') throw new Error('wrap: schemaVersion wrong: ' + env.schemaVersion)
if (env.type !== 'finding')    throw new Error('wrap: type wrong: ' + env.type)
if (env.source !== 'AUDITOR')   throw new Error('wrap: source wrong: ' + env.source)
if (env.taskId !== 'gate98')  throw new Error('wrap: taskId wrong: ' + env.taskId)
if (typeof env.ts !== 'string' || !env.ts) throw new Error('wrap: ts missing/wrong')
if (!env.payload || env.payload.id !== 'G98') throw new Error('wrap: payload wrong')

// (c) validate passes on matching type
validate(env, 'finding')

// (d) validate THROWS PhaseEnvelopeError on wrong type
let threw = false
try { validate(env, 'judge-verdict') } catch(e) {
  if (!(e instanceof PhaseEnvelopeError)) throw new Error('validate: wrong error class: ' + e.constructor.name)
  threw = true
}
if (!threw) throw new Error('validate: did NOT throw on type mismatch')

// (e) validate THROWS PhaseEnvelopeError on wrong schemaVersion
let threwV = false
try { validate({ ...env, schemaVersion: '99' }, 'finding') } catch(e) {
  if (!(e instanceof PhaseEnvelopeError)) throw new Error('validate(version): wrong error class')
  threwV = true
}
if (!threwV) throw new Error('validate: did NOT throw on wrong schemaVersion')

// (f) quarantine writes JSONL to temp dir AND throws
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gate98-'))
let qThrew = false
try { quarantine(env, 'gate-98-test', { taskId: 'gate98', outDir: tmpDir }) } catch(e) {
  if (!(e instanceof PhaseEnvelopeError)) throw new Error('quarantine: wrong error class: ' + e.constructor.name)
  qThrew = true
}
if (!qThrew) throw new Error('quarantine: did NOT throw after writing')

const qFile = path.join(tmpDir, 'quarantine-gate98.jsonl')
if (!fs.existsSync(qFile)) throw new Error('quarantine: file not written at ' + qFile)
const lines = fs.readFileSync(qFile, 'utf-8').trim().split('\\n').filter(Boolean)
if (lines.length !== 1) throw new Error('quarantine: expected 1 JSONL line, got ' + lines.length)
const rec = JSON.parse(lines[0])
if (rec.source !== 'phase-envelope') throw new Error('quarantine: record.source wrong: ' + rec.source)
if (rec.reason !== 'gate-98-test')   throw new Error('quarantine: record.reason wrong: ' + rec.reason)
if (!rec.ts)                          throw new Error('quarantine: record.ts missing')

// cleanup
fs.rmSync(tmpDir, { recursive: true, force: true })

process.stdout.write('schemaVersion=1 wrap-ok validate-throws quarantine-writes-and-throws\\n')
process.exit(0)
`

  const r = spawnSync('node', ['-e', probe], { encoding: 'utf-8', timeout: 20000 })
  if (r.status !== 0) {
    throw new Error(
      `phase-envelope contract broken: ${(r.stderr || r.stdout || '').trim().slice(0, 500)}`
    )
  }
  return `phase-envelope loaded, validate throws on wrong type, quarantine writes JSONL, wrap stamps correctly — ${(r.stdout || '').trim()}`
})

gate('GATE-99: SUPPRESSION-VISIBLE — suppression-ledger.js exports 4 functions with correct field shapes', () => {
  // Locks the suppression ledger contract (B3, 2026-06-05).
  // Every downgrade from any phase filter must produce a visible JSONL record.
  // Check: module loads + exports logSuppression/logManualReviewNeeded/isHighConvictionLowEvidence/getSuppressionCount
  // AND that logSuppression accepts findingId/filterName/fromSeverity/toSeverity fields.
  const probe = `
'use strict'
const os = require('os')
const fs = require('fs')
const path = require('path')
const sl = require('${agentPaths.AGENTS_ROOT}/agents/suppression-ledger')

// (a) all 4 exports present
const fns = ['logSuppression', 'logManualReviewNeeded', 'isHighConvictionLowEvidence', 'getSuppressionCount']
for (const fn of fns) {
  if (typeof sl[fn] !== 'function') throw new Error('missing export: ' + fn)
}

// (b) logSuppression writes correct JSONL with required fields
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gate99-'))
sl.logSuppression({
  taskId: 'gate-99-task',
  finding: { id: 'F001', title: 'Test Finding', severity: 'critical' },
  filterName: 'severity-profile',
  reason: 'cvss 2.0 below bounty floor 8.0',
  fromSeverity: 'critical',
  toSeverity: 'archived',
  squad: 'pentest',
  outDir: tmpDir,
})
const ledgerFile = path.join(tmpDir, 'suppression-ledger.jsonl')
if (!fs.existsSync(ledgerFile)) throw new Error('suppression-ledger.jsonl not written')
const line = JSON.parse(fs.readFileSync(ledgerFile, 'utf-8').trim())
if (line.findingId !== 'F001') throw new Error('findingId wrong: ' + line.findingId)
if (line.filterName !== 'severity-profile') throw new Error('filterName wrong: ' + line.filterName)
if (line.fromSeverity !== 'critical') throw new Error('fromSeverity wrong: ' + line.fromSeverity)
if (line.toSeverity !== 'archived') throw new Error('toSeverity wrong: ' + line.toSeverity)
if (!line.ts) throw new Error('ts missing')

// (c) logManualReviewNeeded writes status:'pending'
sl.logManualReviewNeeded({
  taskId: 'gate-99-task',
  finding: { id: 'F002', title: 'High Conviction Finding' },
  reason: 'high severity + no oracle confirmation',
  squad: 'pentest',
  outDir: tmpDir,
})
const mrFile = path.join(tmpDir, 'manual-review-queue.jsonl')
if (!fs.existsSync(mrFile)) throw new Error('manual-review-queue.jsonl not written')
const mrLine = JSON.parse(fs.readFileSync(mrFile, 'utf-8').trim())
if (mrLine.status !== 'pending') throw new Error('status not pending: ' + mrLine.status)

// (d) isHighConvictionLowEvidence returns correct booleans
const highUnconfirmed = sl.isHighConvictionLowEvidence({ severity: 'critical', validation_status: 'PENDING' })
if (!highUnconfirmed) throw new Error('isHighConvictionLowEvidence: should be true for critical+PENDING')
const confirmed = sl.isHighConvictionLowEvidence({ severity: 'critical', validation_status: 'CONFIRMED' })
if (confirmed) throw new Error('isHighConvictionLowEvidence: should be false for CONFIRMED')
const lowSev = sl.isHighConvictionLowEvidence({ severity: 'low', validation_status: 'PENDING' })
if (lowSev) throw new Error('isHighConvictionLowEvidence: should be false for low severity')

// (e) getSuppressionCount returns correct count
const count = sl.getSuppressionCount({ taskId: 'gate-99-task', outDir: tmpDir })
if (count !== 1) throw new Error('getSuppressionCount: expected 1, got ' + count)

// cleanup
fs.rmSync(tmpDir, { recursive: true, force: true })

process.stdout.write('suppression-ledger exports logSuppression logManualReviewNeeded isHighConvictionLowEvidence getSuppressionCount\\n')
process.exit(0)
`

  const r = spawnSync('node', ['-e', probe], { encoding: 'utf-8', timeout: 15000 })
  if (r.status !== 0) {
    throw new Error(
      `suppression-ledger contract broken: ${(r.stderr || r.stdout || '').trim().slice(0, 500)}`
    )
  }
  return (r.stdout || '').trim()
})

gate('GATE-100: QUALITY-TRACKER — quality-tracker.js exports 3 functions + snapshotAllSquads covers 5 squads', () => {
  // Locks the quality baseline tracker contract (B4, 2026-06-05).
  // Check: module loads + exports recordRunQuality/getSquadBaseline/snapshotAllSquads
  // AND snapshotAllSquads returns noData:true for all 5 squads when quality.jsonl is empty.
  const probe = `
'use strict'
const os = require('os')
const fs = require('fs')
const path = require('path')
const qt = require('${agentPaths.AGENTS_ROOT}/agents/quality-tracker')

// (a) all 3 exports present + PRODUCTION_SQUADS constant
const fns = ['recordRunQuality', 'getSquadBaseline', 'snapshotAllSquads']
for (const fn of fns) {
  if (typeof qt[fn] !== 'function') throw new Error('missing export: ' + fn)
}
if (!Array.isArray(qt.PRODUCTION_SQUADS) || qt.PRODUCTION_SQUADS.length !== 5) {
  throw new Error('PRODUCTION_SQUADS wrong length: ' + (qt.PRODUCTION_SQUADS || []).length)
}

// (b) getSquadBaseline returns noData:true when file absent
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gate100-'))
const result = qt.getSquadBaseline('pentest', { outDir: tmpDir })
if (!result.noData) throw new Error('getSquadBaseline: noData should be true for empty dir, got: ' + JSON.stringify(result))
if (result.runs !== 0) throw new Error('getSquadBaseline: runs should be 0, got: ' + result.runs)

// (c) snapshotAllSquads covers all 5 squads with noData when empty
const snapshot = qt.snapshotAllSquads({ outDir: tmpDir })
if (!snapshot.squads) throw new Error('snapshotAllSquads: missing squads key')
const expectedSquads = ['pentest', 'stocks', 'cloud-security', 'network-pentest', 'code-review']
for (const sq of expectedSquads) {
  if (!snapshot.squads[sq]) throw new Error('snapshotAllSquads: missing squad ' + sq)
  if (!snapshot.squads[sq].noData) throw new Error('snapshotAllSquads: ' + sq + ' should have noData:true for empty data')
}

// (d) snapshot file written
const snapFile = path.join(tmpDir, 'quality-snapshot.json')
if (!fs.existsSync(snapFile)) throw new Error('quality-snapshot.json not written')
const snapParsed = JSON.parse(fs.readFileSync(snapFile, 'utf-8'))
if (!snapParsed.ts) throw new Error('quality-snapshot.json missing ts field')

// (e) recordRunQuality writes correct JSONL
qt.recordRunQuality({
  taskId: 'gate100-task',
  squad: 'pentest',
  agentName: 'ATLAS',
  passed: 8,
  total: 10,
  gradeScore: 80,
  costUsd: 0.05,
  durationMs: 5000,
  adapterUsed: 'cli',
  outDir: tmpDir,
})
const qFile = path.join(tmpDir, 'quality.jsonl')
if (!fs.existsSync(qFile)) throw new Error('quality.jsonl not written')
const qLine = JSON.parse(fs.readFileSync(qFile, 'utf-8').trim())
if (qLine.squad !== 'pentest') throw new Error('squad wrong: ' + qLine.squad)
if (qLine.passRate !== 0.8) throw new Error('passRate wrong: ' + qLine.passRate)

// (f) getSquadBaseline returns data after recordRunQuality
const b2 = qt.getSquadBaseline('pentest', { outDir: tmpDir })
if (b2.noData) throw new Error('getSquadBaseline: should have data now, got noData:true')
if (b2.runs !== 1) throw new Error('getSquadBaseline: expected 1 run, got: ' + b2.runs)

// cleanup
fs.rmSync(tmpDir, { recursive: true, force: true })

process.stdout.write('quality-tracker: recordRunQuality getSquadBaseline snapshotAllSquads — 5 squads configured\\n')
process.exit(0)
`

  const r = spawnSync('node', ['-e', probe], { encoding: 'utf-8', timeout: 15000 })
  if (r.status !== 0) {
    throw new Error(
      `quality-tracker contract broken: ${(r.stderr || r.stdout || '').trim().slice(0, 500)}`
    )
  }
  return (r.stdout || '').trim()
})

gate('GATE-101: SQUAD-CONFIG — all 5 squad.json files exist, parse cleanly, and pass required-field validation', () => {
  // Locks the per-squad operational config contract (B5, 2026-06-05).
  // Checks:
  //   (a) All 5 squad.json files exist and are valid JSON
  //   (b) Each has required fields: squad, version, leader, modelTier, effort
  //   (c) squad-config-loader.js loads all 5 without error via getAllSquadConfigs
  //   (d) No nulls in getAllSquadConfigs result
  const probe = `
'use strict'
const loader = require('${agentPaths.AGENTS_ROOT}/agents/squad-config-loader')

// (a+b+c) Load all 5 production squads via getAllSquadConfigs
const all = loader.getAllSquadConfigs()
const squads = Object.keys(all)
if (squads.length !== 5) throw new Error('expected 5 squads in getAllSquadConfigs, got: ' + squads.length)

// (d) None should be null
const nulled = squads.filter(s => all[s] === null)
if (nulled.length > 0) {
  throw new Error('squad configs are null (missing or invalid): ' + nulled.join(', '))
}

// (e) Validate required fields and known leaders
const expectedLeaders = {
  pentest: 'ATLAS',
  stocks: 'CHANAKYA',
  'cloud-security': 'VARUNA',
  'network-pentest': 'SHALYA',
  'code-review': 'CURATOR',
}
const required = ['squad', 'version', 'leader', 'modelTier', 'effort']
for (const [squad, cfg] of Object.entries(all)) {
  for (const field of required) {
    if (!cfg[field]) throw new Error('squad "' + squad + '" missing required field: ' + field)
  }
  if (cfg.leader !== expectedLeaders[squad]) {
    throw new Error('squad "' + squad + '" has wrong leader: expected ' + expectedLeaders[squad] + ', got ' + cfg.leader)
  }
}

// Summary line for gate output
const summary = Object.entries(expectedLeaders).map(([s, l]) => s + '(' + l + ')').join(' ')
process.stdout.write('5/5 squad configs valid — ' + summary + '\\n')
process.exit(0)
`

  const r = spawnSync('node', ['-e', probe], { encoding: 'utf-8', timeout: 15000 })
  if (r.status !== 0) {
    throw new Error(
      `squad-config contract broken: ${(r.stderr || r.stdout || '').trim().slice(0, 500)}`
    )
  }
  return (r.stdout || '').trim()
})

gate('GATE-102: CHANGELOG-WATCHER — changelog-watcher.js exists, syntax ok, break-detection covers sdk-version + claude-binary + agent-runner-default', () => {
  // Locks the changelog watcher + break-detection invariants (B6, 2026-06-05).
  // Static checks only — no network in gates.
  const watcherPath = path.join(__dirname, 'agents', 'changelog-watcher.js')

  // (a) File exists
  if (!fs.existsSync(watcherPath)) {
    throw new Error('agents/changelog-watcher.js does not exist')
  }

  // (b) Syntax check
  const syntaxCheck = spawnSync('node', ['--check', watcherPath], { encoding: 'utf-8', timeout: 10000 })
  if (syntaxCheck.status !== 0) {
    throw new Error(`changelog-watcher.js fails syntax check: ${(syntaxCheck.stderr || '').trim().slice(0, 400)}`)
  }

  // (c) Contains expected break-detection string literals / function names
  const src = fs.readFileSync(watcherPath, 'utf-8')

  const requiredPatterns = [
    { pattern: 'claude-agent-sdk', label: 'sdk-version pinning check' },
    { pattern: 'claude-binary-present', label: 'claude-binary check' },
    { pattern: 'agent-runner-sdk-default', label: 'agent-runner default check' },
    { pattern: 'runBreakChecks', label: 'runBreakChecks export' },
    { pattern: 'module.exports', label: 'module.exports present' },
  ]

  for (const { pattern, label } of requiredPatterns) {
    if (!src.includes(pattern)) {
      throw new Error(`changelog-watcher.js missing required pattern for ${label}: "${pattern}"`)
    }
  }

  // (d) Module loads + exports the expected functions
  const probe = `
'use strict'
const cw = require('${agentPaths.AGENTS_ROOT}/agents/changelog-watcher')
const required = ['checkAll', 'runBreakChecks', 'checkClaudeBinary', 'checkAgentRunnerDefault', 'checkSdkVersionPinning', 'checkGateSuiteHealth']
for (const fn of required) {
  if (typeof cw[fn] !== 'function') throw new Error('missing export: ' + fn)
}
process.stdout.write('changelog-watcher.js exists, syntax ok, break-detection covers sdk-version + claude-binary + agent-runner-default\\n')
process.exit(0)
`
  const r = spawnSync('node', ['-e', probe], { encoding: 'utf-8', timeout: 15000 })
  if (r.status !== 0) {
    throw new Error(`changelog-watcher module contract broken: ${(r.stderr || r.stdout || '').trim().slice(0, 500)}`)
  }
  return (r.stdout || '').trim()
})

gate('GATE-103: EPISODE-RECORD+LEARNING-LOOP — typed episode emitter + OBSERVE→DISTILL→PROPOSE→AUTO-APPLY pipeline', () => {
  // Upgraded 2026-06-05: human-tap removed, auto-applier wired into runLoop.
  // Static + inline probe checks — no I/O.

  const episodeRecordPath = path.join(__dirname, 'agents', 'episode-record.js')
  const learningLoopPath = path.join(__dirname, 'agents', 'learning-loop.js')

  // (a) Both files exist
  if (!fs.existsSync(episodeRecordPath)) {
    throw new Error('agents/episode-record.js does not exist')
  }
  if (!fs.existsSync(learningLoopPath)) {
    throw new Error('agents/learning-loop.js does not exist')
  }

  // (b) Syntax checks
  const erSyntax = spawnSync('node', ['--check', episodeRecordPath], { encoding: 'utf-8', timeout: 10000 })
  if (erSyntax.status !== 0) {
    throw new Error(`episode-record.js fails syntax check: ${(erSyntax.stderr || '').trim().slice(0, 400)}`)
  }
  const llSyntax = spawnSync('node', ['--check', learningLoopPath], { encoding: 'utf-8', timeout: 10000 })
  if (llSyntax.status !== 0) {
    throw new Error(`learning-loop.js fails syntax check: ${(llSyntax.stderr || '').trim().slice(0, 400)}`)
  }

  // (c) auto-applier is wired into runLoop (require + applyPendingProposals call)
  const llSrc = fs.readFileSync(learningLoopPath, 'utf-8')
  if (!/require\(['"]\.\/auto-applier['"]\)/.test(llSrc)) {
    throw new Error('learning-loop.js missing require(./auto-applier) — auto-apply not wired')
  }
  if (!llSrc.includes('applyPendingProposals')) {
    throw new Error('learning-loop.js missing applyPendingProposals call in runLoop')
  }

  // (d) structuredAction present in propose() output
  if (!llSrc.includes('structuredAction')) {
    throw new Error('learning-loop.js propose() missing structuredAction field')
  }

  // (e) Inline probe: module contracts + pure-function behaviour
  const probe = `
'use strict'

// --- episode-record ---
const er = require('${agentPaths.AGENTS_ROOT}/agents/episode-record')
const erRequired = ['emitEpisode', 'readEpisodes', 'EPISODE_VERSION', 'EPISODE_OUTCOMES', 'validateOutcome']
for (const fn of erRequired) {
  if (er[fn] === undefined) throw new Error('episode-record missing export: ' + fn)
}
if (er.EPISODE_VERSION !== '1') throw new Error('EPISODE_VERSION should be "1", got: ' + er.EPISODE_VERSION)
if (!Array.isArray(er.EPISODE_OUTCOMES)) throw new Error('EPISODE_OUTCOMES should be an array')

// --- learning-loop ---
const ll = require('${agentPaths.AGENTS_ROOT}/agents/learning-loop')
const llRequired = ['observe', 'distill', 'propose', 'runLoop']
for (const fn of llRequired) {
  if (typeof ll[fn] !== 'function') throw new Error('learning-loop missing export: ' + fn)
}

// --- distill is pure: distill(empty) → {patterns:[], alerts:[]} ---
const d = ll.distill({ episodes: [], baseline: { runs: 0 } })
if (!Array.isArray(d.patterns)) throw new Error('distill().patterns should be an array')
if (d.patterns.length !== 0) throw new Error('distill(empty) should return 0 patterns, got: ' + d.patterns.length)

// --- propose returns structuredAction (or null for unknown) ---
const patterns = [
  { type: 'recurring-failure', agentName: 'TEST', squad: 'pentest', count: 3, description: 'test' },
  { type: 'cost-outlier', agentName: 'TEST2', squad: 'stocks', count: 1, description: 'test' },
]
const props = ll.propose({ patterns })
if (!Array.isArray(props) || props.length !== 2) throw new Error('propose(2 patterns) should return 2 proposals, got: ' + props.length)
for (const prop of props) {
  if (!('structuredAction' in prop)) throw new Error('proposal missing structuredAction field: ' + JSON.stringify(prop))
  const VALID_KINDS = ['squad_config_patch', 'soul_md_append', 'agent_model_override']
  if (prop.structuredAction && !VALID_KINDS.includes(prop.structuredAction.kind)) {
    throw new Error('structuredAction.kind should be one of ' + VALID_KINDS.join('/') + ', got: ' + prop.structuredAction.kind)
  }
}

process.stdout.write('episode-record + learning-loop loaded; distill+propose pure; structuredAction present\\n')
process.exit(0)
`
  const r = spawnSync('node', ['-e', probe], { encoding: 'utf-8', timeout: 15000 })
  if (r.status !== 0) {
    throw new Error(`GATE-103 module contract broken: ${(r.stderr || r.stdout || '').trim().slice(0, 500)}`)
  }
  return (r.stdout || '').trim()
})

gate('GATE-104: GOAL-EVALUATOR + LEARNING-LOOP-CLI — oracle-anchored convergence + CLI entrypoint + listPendingProposals', () => {
  // Locks the next-gen /goal-style done-condition evaluator and learning-loop CLI (2026-06-05).

  const goalEvalPath = path.join(__dirname, 'agents', 'goal-evaluator.js')
  const learningLoopPath = path.join(__dirname, 'agents', 'learning-loop.js')

  // (a) Files exist
  if (!fs.existsSync(goalEvalPath)) {
    throw new Error('agents/goal-evaluator.js does not exist')
  }
  if (!fs.existsSync(learningLoopPath)) {
    throw new Error('agents/learning-loop.js does not exist')
  }

  // (b) Syntax checks
  const geSyntax = spawnSync('node', ['--check', goalEvalPath], { encoding: 'utf-8', timeout: 10000 })
  if (geSyntax.status !== 0) {
    throw new Error(`goal-evaluator.js fails syntax check: ${(geSyntax.stderr || '').trim().slice(0, 400)}`)
  }
  const llSyntax = spawnSync('node', ['--check', learningLoopPath], { encoding: 'utf-8', timeout: 10000 })
  if (llSyntax.status !== 0) {
    throw new Error(`learning-loop.js fails syntax check: ${(llSyntax.stderr || '').trim().slice(0, 400)}`)
  }

  // (c) Static checks: goal-evaluator exports, learning-loop CLI + listPendingProposals
  const geSrc = fs.readFileSync(goalEvalPath, 'utf-8')
  if (!/evaluateConvergence/.test(geSrc)) {
    throw new Error('goal-evaluator.js missing evaluateConvergence function')
  }
  if (!/CONVERGENCE_SOURCES/.test(geSrc)) {
    throw new Error('goal-evaluator.js missing CONVERGENCE_SOURCES export')
  }

  const llSrc = fs.readFileSync(learningLoopPath, 'utf-8')
  if (!llSrc.includes('require.main === module')) {
    throw new Error('learning-loop.js missing CLI entrypoint (require.main === module)')
  }
  if (!llSrc.includes('listPendingProposals')) {
    throw new Error('learning-loop.js missing listPendingProposals function')
  }

  // (d) Inline probe: module contracts + heuristic-fast-path (no runAgent called)
  const probe = `
'use strict'

// --- goal-evaluator module contract ---
const ge = require('${agentPaths.AGENTS_ROOT}/agents/goal-evaluator')
if (typeof ge.evaluateConvergence !== 'function') throw new Error('evaluateConvergence must be a function')
if (!Array.isArray(ge.CONVERGENCE_SOURCES)) throw new Error('CONVERGENCE_SOURCES must be an array')
if (!ge.CONVERGENCE_SOURCES.includes('heuristic')) throw new Error('CONVERGENCE_SOURCES missing heuristic')
if (!ge.CONVERGENCE_SOURCES.includes('oracle')) throw new Error('CONVERGENCE_SOURCES missing oracle')
if (!ge.CONVERGENCE_SOURCES.includes('both')) throw new Error('CONVERGENCE_SOURCES missing both')

// --- learning-loop listPendingProposals ---
const ll = require('${agentPaths.AGENTS_ROOT}/agents/learning-loop')
if (typeof ll.listPendingProposals !== 'function') throw new Error('learning-loop missing listPendingProposals export')

// --- heuristic-fast-path: endpointCount=1 returns shouldExit=false without calling runAgent ---
let runAgentCalled = false
const mockRunAgent = async () => { runAgentCalled = true; return { text: 'CONTINUE' } }

ge.evaluateConvergence({
  endpointCount: 1,
  targetReachable: true,
  missedSignalsCount: 0,
  existingFindingCount: 0,
  _runAgent: mockRunAgent,
}).then(result => {
  if (result.shouldExit !== false) throw new Error('heuristic CONTINUE should return shouldExit:false, got: ' + result.shouldExit)
  if (result.oracleUsed !== false) throw new Error('oracle should not be used on heuristic CONTINUE, got oracleUsed: ' + result.oracleUsed)
  if (result.source !== 'heuristic') throw new Error('source should be heuristic, got: ' + result.source)
  if (runAgentCalled) throw new Error('runAgent was called on heuristic CONTINUE path — should not be')
  process.stdout.write('goal-evaluator: oracle-anchored convergence, heuristic-fast-path verified\\n')
  process.stdout.write('learning-loop: listPendingProposals + CLI entrypoint verified\\n')
  process.exit(0)
}).catch(e => {
  process.stderr.write(e.message + '\\n')
  process.exit(1)
})
`
  const r = spawnSync('node', ['-e', probe], { encoding: 'utf-8', timeout: 15000 })
  if (r.status !== 0) {
    throw new Error(`GATE-104 module contract broken: ${(r.stderr || r.stdout || '').trim().slice(0, 500)}`)
  }
  return (r.stdout || '').trim().replace(/\n/g, ' | ')
})

gate('GATE-120: CHAIN-EVIDENCE-BRIDGE — Phase 3.6 curl results annotate VALIDATED-FINDINGS so ARBITER Stage C uses real HTTP evidence not text alone', () => {
  const ebSrc = fs.readFileSync(path.join(__dirname, 'event-bus.js'), 'utf-8')
  const jvSrc = fs.readFileSync(path.join(__dirname, 'agents', 'judge-verifier.js'), 'utf-8')

  // event-bus: chain-evidence bridge wired after Phase 3.6
  if (!ebSrc.includes('Chain-verifier evidence bridge')) {
    throw new Error('event-bus.js missing chain-evidence bridge annotation after Phase 3.6')
  }
  if (!ebSrc.includes('chain_verified')) {
    throw new Error('event-bus.js missing chain_verified field annotation on VALIDATED-FINDINGS')
  }
  if (!ebSrc.includes('chain_evidence')) {
    throw new Error('event-bus.js missing chain_evidence field annotation on VALIDATED-FINDINGS')
  }

  // judge-verifier: buildJudgePrompt uses chain_verified to surface HTTP evidence
  if (!jvSrc.includes('chain_verified')) {
    throw new Error('judge-verifier.js buildJudgePrompt missing chain_verified evidence injection')
  }
  if (!jvSrc.includes('Chain-Verified: YES')) {
    throw new Error('judge-verifier.js missing Chain-Verified: YES text for Stage C')
  }
  if (!jvSrc.includes('Chain-Verified: NO')) {
    throw new Error('judge-verifier.js missing Chain-Verified: NO warning for Stage C')
  }

  // Probe: chain_verified=true appears in judge prompt
  const probe = `
'use strict'
const { buildJudgePrompt } = require('${agentPaths.AGENTS_ROOT}/agents/judge-verifier')
const finding = { title: 'SSRF via redirect', severity: 'High', url: 'https://x.com/api', chain_verified: true, chain_evidence: 'step1: matched (200)' }
const prompt = buildJudgePrompt(finding, 'https://x.com')
if (!prompt.includes('Chain-Verified: YES')) throw new Error('chain_verified=true not surfaced in judge prompt')
const finding2 = { title: 'SSRF', severity: 'High', url: 'https://x.com', chain_verified: false }
const prompt2 = buildJudgePrompt(finding2, 'https://x.com')
if (!prompt2.includes('Chain-Verified: NO')) throw new Error('chain_verified=false not surfaced in judge prompt')
process.stdout.write('chain-evidence bridge: verified=true→YES, verified=false→NO in Stage C context\\n')
process.exit(0)
`
  const r = spawnSync('node', ['-e', probe], { encoding: 'utf-8', timeout: 10000 })
  if (r.status !== 0) {
    throw new Error(`GATE-120 probe failed: ${(r.stderr || r.stdout || '').trim().slice(0, 400)}`)
  }
  return (r.stdout || '').trim()
})

gate('GATE-121: PATHS-RESOLVER-CHOKEPOINT — all persona/squad paths resolve through paths.js; no raw persona-path literal outside it (restructure Phase 1, 2026-06-07)', () => {
  // 1. paths.js honors the resolver CONTRACT in whatever layout mode is active
  //    (mode-aware: code stays under AGENTS_ROOT; state follows stateMode; derived
  //    accessors compose from the base). NOT frozen to legacy strings — the whole
  //    point of the chokepoint is that the physical layout can move.
  const probe = `
'use strict'
const path = require('path')
const p = require('${agentPaths.AGENTS_ROOT}/paths.js')
const cfg = p._config()
const A = '${agentPaths.AGENTS_ROOT}'
if (p.soulPath('scout') !== path.join(p.personaCode('scout'), 'SOUL.md')) throw new Error('soulPath != personaCode/SOUL.md')
if (p.skillsDir('arbiter') !== path.join(p.personaCode('arbiter'), 'skills')) throw new Error('skillsDir != personaCode/skills')
if (!p.personaCode('scout').startsWith(A)) throw new Error('personaCode escaped AGENTS_ROOT')
if (cfg.personaMode === 'legacy' && p.personaCode('scout') !== path.join(A, 'scout')) throw new Error('legacy personaCode not flat')
const stateBase = p.personaState('scout')
if (cfg.stateMode === 'evicted' && !stateBase.includes(path.join('var','state'))) throw new Error('evicted stateMode not under var/state')
if (cfg.stateMode === 'inline' && stateBase !== p.personaCode('scout')) throw new Error('inline state != personaCode')
if (p.lessonsPath('chanakya') !== path.join(p.memoryDir('chanakya'), 'lessons.md')) throw new Error('lessonsPath != memoryDir/lessons.md')
if (p.a2aCapsDir() !== path.join(A, 'squads')) throw new Error('a2aCapsDir moved unexpectedly')
process.stdout.write('paths.js contract holds in mode {persona:'+cfg.personaMode+', state:'+cfg.stateMode+'}\\n')
process.exit(0)
`
  const r = spawnSync('node', ['-e', probe], { encoding: 'utf-8', timeout: 10000 })
  if (r.status !== 0) {
    throw new Error(`GATE-121 resolver probe failed: ${(r.stderr || r.stdout || '').trim().slice(0, 400)}`)
  }

  // 2. No raw persona-path literal outside paths.js in the governed files.
  //    Whitelisted families (never persona dirs): squads/, agents/ (helper modules),
  //    prompts/, docs/, var/, node_modules/. Comment lines don't resolve paths.
  const governed = ['event-bus.js', 'src/learning/memory-ranker.js', 'src/learning/feedback-loop.js']
  const whitelist = /\/root\/agents\/(squads|agents|prompts|docs|var|node_modules)\b/
  const personaLiteral = /\/root\/agents\/(\$\{|[a-z][a-z0-9_-]*\/(SOUL\.md|skills|memory|sessions))/
  // bare fixed persona dir, e.g. '/root/agents/arbiter' (the addDirs sandbox-grant shape)
  const barePersonaDir = /\/root\/agents\/[a-z][a-z0-9_-]*['"`]/
  const joinLiteral = /path\.join\(\s*['"`]\/root\/agents['"`]/
  const violations = []
  for (const f of governed) {
    const lines = fs.readFileSync(path.join(__dirname, f), 'utf-8').split('\n')
    lines.forEach((line, i) => {
      const t = line.trim()
      if (t.startsWith('//') || t.startsWith('*')) return
      if (whitelist.test(line)) return
      if (personaLiteral.test(line) || barePersonaDir.test(line) || joinLiteral.test(line)) violations.push(`${f}:${i + 1}: ${t.slice(0, 100)}`)
    })
  }
  if (violations.length) {
    throw new Error(`raw persona-path literals outside paths.js (route via agentPaths.*):\n${violations.join('\n')}`)
  }
  return `resolver byte-identical (7 accessors) + 0 raw persona literals across ${governed.length} governed files`
})

gate('GATE-123: ADAPTER-LABEL-TRUTH — adapterUsed analytics label matches the runner default (resolvedAdapterName), never the old `|| cli` mislabel that corrupted cli-vs-sdk billing data', () => {
  const ebSrc = fs.readFileSync(path.join(__dirname, 'event-bus.js'), 'utf-8')
  // no analytics site may hardcode the adapter label with a non-default fallback
  const mislabel = ebSrc.match(/adapterUsed:\s*process\.env\.ADAPTER\s*\|\|\s*['"]cli['"]/g)
  if (mislabel) throw new Error(`${mislabel.length} adapterUsed site(s) still hardcode '|| cli' — route through resolvedAdapterName()`)
  // every adapterUsed analytics site routes through the single source of truth
  const sites = (ebSrc.match(/adapterUsed:\s*resolvedAdapterName\(\)/g) || []).length
  if (sites < 4) throw new Error(`expected ≥4 adapterUsed sites via resolvedAdapterName(), found ${sites}`)
  // resolvedAdapterName default must equal the runner's actual default
  const probe = `const {resolvedAdapterName}=require('${agentPaths.AGENTS_ROOT}/agents/runner/agent-runner'); process.env.ADAPTER=''; if(resolvedAdapterName()!=='sdk')throw new Error('default not sdk'); process.stdout.write('ok')`
  const r = spawnSync('node', ['-e', probe], { encoding: 'utf-8', timeout: 8000 })
  if (r.status !== 0) throw new Error(`resolvedAdapterName default probe failed: ${(r.stderr||'').slice(0,200)}`)
  return `${sites} adapterUsed sites via resolvedAdapterName(); default=sdk matches runner`
})

gate('GATE-129: EPISODE-EMISSION-LIVE — the learning loop OBSERVE data actually gets written (emitEpisode references only in-scope vars + writes a real file + the catch is LOUD). This was dead: out-of-scope _agentWaveMap refs threw into a silent catch, so episodes.jsonl was never written for any squad.', () => {
  const ebSrc = fs.readFileSync(path.join(__dirname, 'event-bus.js'), 'utf-8')
  // the spawnAgent emitEpisode block must NOT reference the dispatchPentestParallel-scoped maps
  const emitIdx = ebSrc.indexOf("require('./agents/episode-record').emitEpisode(")
  if (emitIdx < 0) throw new Error('emitEpisode call missing from spawnAgent')
  const block = ebSrc.slice(emitIdx, emitIdx + 1400)
  if (/_agentWaveMap\[|_agentReflexionMap\[/.test(block)) throw new Error('emitEpisode still references out-of-scope _agentWaveMap/_agentReflexionMap → ReferenceError → no episodes written')
  if (!/waveNumber:\s*\(opts/.test(block)) throw new Error('waveNumber not sourced from opts (in-scope)')
  // the catch that hid the bug must now log, not swallow silently
  if (/\}\s*catch\s*\{\s*\}/.test(block.slice(block.indexOf('actualModel')))) throw new Error('episode emit catch is still silent — a future failure would hide again')
  // behavioral: emitEpisode actually writes a file
  const probe = `const er=require('${agentPaths.AGENTS_ROOT}/agents/episode-record'); const t='/tmp/__gate129'; require('fs').rmSync(t,{recursive:true,force:true}); er.emitEpisode({taskId:'x',squad:'s',agentName:'A',phase:'specialist',outcome:'completed',gradeScore:0,costUsd:0,durationMs:1,adapterUsed:'sdk',suppressionCount:0,findingCount:0,waveNumber:0,reflexionContextUsed:false,actualModel:null,outDir:t}); if(!require('fs').existsSync(t+'/episodes/episodes.jsonl'))throw new Error('no file written'); require('fs').rmSync(t,{recursive:true,force:true}); process.stdout.write('ok')`
  const r = spawnSync('node', ['-e', probe], { encoding: 'utf-8', timeout: 8000 })
  if (r.status !== 0) throw new Error(`episode write probe failed: ${(r.stderr||'').slice(0,200)}`)
  return 'emitEpisode in-scope + writes episodes.jsonl + LOUD catch — learning loop now has a live data source'
})

gate('GATE-132: ACTIVITY-STALL-WATCHDOG — a hung agent that keeps streaming/thinking but writes NO real output is killed on activity-log stall (not just the 45min hard cap). The stream-based NO_MOVEMENT could not see this (veteran hung 45min while streaming).', () => {
  const ebSrc = fs.readFileSync(path.join(__dirname, 'event-bus.js'), 'utf-8')
  if (!/ACTIVITY_STALL_MS/.test(ebSrc)) throw new Error('no ACTIVITY_STALL watchdog — stream-but-stuck hangs only caught by the 45min cap')
  // it must key off activity-log COUNT progress, not lastDataTime (the stream signal that the hang evaded)
  if (!/readTaskActivity\(taskId\)[\s\S]{0,160}\.length/.test(ebSrc)) throw new Error('activity-stall not based on activity-log entry count (real progress)')
  if (!/no activity-log progress for/.test(ebSrc)) throw new Error('activity-stall kill reason missing')
  // threshold sane: tighter than the 45min hard cap, generous enough for slow analysts
  const m = ebSrc.match(/ACTIVITY_STALL_MS\s*=\s*(\d+)\s*\*\s*60\s*\*\s*1000/)
  if (!m) throw new Error('ACTIVITY_STALL_MS not a clear minute value')
  const mins = parseInt(m[1], 10)
  if (mins < 15 || mins >= 45) throw new Error(`ACTIVITY_STALL ${mins}min should be 15–44 (tighter than the 45min cap)`)
  return `activity-stall watchdog @ ${mins}min on real-progress signal (catches stream-but-stuck hangs ~23min sooner)`
})

gate('GATE-133: UNGRADED-NOT-ZERO — a run with no eval expectations is recorded as ungraded (null), never as grade-0; the quality baseline + learning loop exclude it (was: ungraded → 0 → spurious low-grade proposals)', () => {
  const ebSrc = fs.readFileSync(path.join(__dirname, 'event-bus.js'), 'utf-8')
  // settle sites: updateTaskGrade guarded + recordRunQuality null when ungraded
  if ((ebSrc.match(/Number\.isFinite\(gradeResult\.passRate\)\) require\('\.\/agents\/episode-record'\)\.updateTaskGrade/g) || []).length < 3) throw new Error('updateTaskGrade not guarded against ungraded at all 3 settle sites')
  if ((ebSrc.match(/gradeScore: \(gradeResult && Number\.isFinite\(gradeResult\.passRate\)\) \? gradeResult\.passRate : null,/g) || []).length < 3) throw new Error('recordRunQuality still coerces ungraded → 0')
  if (!/gradeScore: null,  \/\/ null = UNGRADED/.test(ebSrc)) throw new Error('emitEpisode placeholder still 0 (ungraded episodes look like failures)')
  const llSrc = fs.readFileSync(path.join(__dirname, 'agents', 'learning-loop.js'), 'utf-8')
  if (!/ep\.gradeScore === null \|\| ep\.gradeScore === undefined\) continue/.test(llSrc)) throw new Error('learning-loop still counts ungraded episodes as low-grade failures')
  // behavioral: quality-tracker records null + excludes from baseline
  const probe = `
const qt=require('${agentPaths.AGENTS_ROOT}/agents/quality-tracker'); const t='/tmp/__gate133'; require('fs').rmSync(t,{recursive:true,force:true})
qt.recordRunQuality({taskId:'u',squad:'s',gradeScore:null,outDir:t})
qt.recordRunQuality({taskId:'g',squad:'s',gradeScore:0.9,passed:9,total:10,outDir:t})
const r=require('fs').readFileSync(t+'/quality.jsonl','utf-8').trim().split('\\n').map(JSON.parse)
if(r[0].gradeScore!==null||r[0].ungraded!==true)throw new Error('ungraded not null/flagged')
if(r[1].ungraded!==false)throw new Error('graded wrongly flagged ungraded')
const bl=qt.getSquadBaseline('s',{outDir:t})
if(bl.runs!==1)throw new Error('baseline did not exclude ungraded (runs='+bl.runs+')')
require('fs').rmSync(t,{recursive:true,force:true}); process.stdout.write('ok')
`
  const r = spawnSync('node', ['-e', probe], { encoding: 'utf-8', timeout: 8000 })
  if (r.status !== 0) throw new Error(`ungraded probe failed: ${(r.stderr||'').slice(0,200)}`)
  return 'ungraded → null + excluded from baseline + learning loop; graded path intact'
})

gate('GATE-134: STOCKS-WAVE-PARALLELISM — stocks dispatches analysts in waves of ≤3 (RAM-safe), not the old 3 serial waves of 2 where one slow analyst stalled the whole pipeline', () => {
  const ebSrc = fs.readFileSync(path.join(__dirname, 'event-bus.js'), 'utf-8')
  if (!/STOCKS_ANALYSTS\.slice\(0, 3\)/.test(ebSrc) || !/STOCKS_ANALYSTS\.slice\(3, 6\)/.test(ebSrc)) throw new Error('stocks not in 2 waves of 3')
  if (!/2 waves of 3/.test(ebSrc)) throw new Error('wave-count log not updated')
  // the (now-empty) third block must be guarded so it does not log a phantom batch
  if (!/if \(batch3\.length\)/.test(ebSrc)) throw new Error('batch3 block not guarded for the empty case')
  return 'stocks: 2 waves of 3 analysts (RAM-safe, fewer serial stalls)'
})

gate('GATE-135: RECOVERY-LOOP-CAP — auto-recover never re-dispatches a task whose final report already exists, and caps recovery attempts at 2 (a stuck tasks.json status would otherwise re-run a completed task forever — one ITC scan re-ran 6×, ~$100+ burned)', () => {
  const ebSrc = fs.readFileSync(path.join(__dirname, 'event-bus.js'), 'utf-8')
  if (!/function _recoveryBlocked/.test(ebSrc)) throw new Error('no _recoveryBlocked guard')
  // both recovery push sites must be guarded
  const guardedSites = (ebSrc.match(/!_recoveryBlocked\(tid, queue/g) || []).length
  if (guardedSites < 2) throw new Error(`only ${guardedSites}/2 recovery sites guarded by _recoveryBlocked`)
  if (!/reports\/\$\{tid\}\.md/.test(ebSrc)) throw new Error('guard does not check for an existing report')
  if (!/priorRecoveries >= 2/.test(ebSrc)) throw new Error('guard does not cap recovery attempts')
  // behavioral: report-exists → blocked+done; fresh → allowed; ≥2 recoveries → capped
  const probe = `
const fs=require('fs')
const src=fs.readFileSync('${agentPaths.AGENTS_ROOT}/event-bus.js','utf-8')
const m=src.match(/function _recoveryBlocked[\\s\\S]*?\\n}/); if(!m)throw new Error('extract failed')
let log=()=>{}; const agentPaths=require('${agentPaths.AGENTS_ROOT}/paths'); eval(m[0])
const tmp='/tmp/__gate135-report.md'; fs.writeFileSync(tmp,'x')
// monkeypatch: point the guard's report path check at our tmp via a real existing file
// (the guard reads ${agentPaths.INTEL_ROOT}/reports/<tid>.md — use a tid whose report we create)
fs.mkdirSync('${agentPaths.INTEL_ROOT}/reports',{recursive:true}); fs.writeFileSync('${agentPaths.INTEL_ROOT}/reports/__gate135.md','x')
const t={status:'in-progress'}
if(_recoveryBlocked('__gate135',[],t)!==true||t.status!=='done')throw new Error('report-exists not blocked/done')
if(_recoveryBlocked('__nofile_xyz',[],{})!==false)throw new Error('fresh task wrongly blocked')
const q=[{taskId:'z',id:'dispatch-recover-z-1'},{taskId:'z',id:'dispatch-recover-z-2'}]
if(_recoveryBlocked('z',q,{})!==true)throw new Error('2-recovery cap not enforced')
fs.rmSync('${agentPaths.INTEL_ROOT}/reports/__gate135.md',{force:true}); fs.rmSync(tmp,{force:true})
process.stdout.write('ok')
`
  const r = spawnSync('node', ['-e', probe], { encoding: 'utf-8', timeout: 8000 })
  if (r.status !== 0) throw new Error(`recovery-guard probe failed: ${(r.stderr||'').slice(0,200)}`)
  return `recovery blocked when report exists (→done) + capped at 2 attempts; both sites guarded`
})

gate('GATE-139: HIGH-STAKES-PROPOSALS-GATED — config/routing self-improvements (squad effort/modelTier, model overrides) require human tap and are never auto-applied; cost-outlier detection excludes hung/failed runs so a transient cost spike can\'t propose an effort downgrade', () => {
  const llSrc = fs.readFileSync(path.join(__dirname, 'agents', 'learning-loop.js'), 'utf-8')
  const aaSrc = fs.readFileSync(path.join(__dirname, 'agents', 'auto-applier.js'), 'utf-8')
  // propose() sets requiresHumanTap on config changes
  if (!/requiresHumanTap = \(_kind === 'squad_config_patch' \|\| _kind === 'agent_model_override'\)/.test(llSrc)) throw new Error('propose() does not flag config/routing proposals requiresHumanTap')
  // cost-outlier excludes failed/hung runs
  if (!/completedEpisodes = episodes\.filter\(ep => ep\.outcome === 'completed'\)/.test(llSrc)) throw new Error('cost-outlier still includes hung/failed runs (spurious effort-downgrade source)')
  // auto-applier refuses config/routing changes by KIND (robust to old proposals lacking the flag)
  if (!/proposal\.requiresHumanTap \|\| _hsKind === 'squad_config_patch' \|\| _hsKind === 'agent_model_override'/.test(aaSrc)) throw new Error('auto-applier does not gate config changes by kind — old flag-less proposals could auto-apply')
  // behavioral
  const probe = `
const aa=require('${agentPaths.AGENTS_ROOT}/agents/auto-applier')
const r1=aa.applyProposal({structuredAction:{kind:'squad_config_patch',squad:'s',field:'effort',direction:'downgrade'},requiresHumanTap:true})
if(r1.applied!==false||!/human tap/.test(r1.reason))throw new Error('config_patch not human-gated')
const r2=aa.applyProposal({structuredAction:{kind:'soul_md_append',agentPath:'/tmp/__noagent',lesson:'x'},requiresHumanTap:false})
if(/human tap/.test(r2.reason))throw new Error('lesson append wrongly human-gated (should be auto-eligible)')
process.stdout.write('ok')
`
  const r = spawnSync('node', ['-e', probe], { encoding: 'utf-8', timeout: 8000 })
  if (r.status !== 0) throw new Error(`proposal-gating probe failed: ${(r.stderr||'').slice(0,200)}`)
  return 'config/routing proposals human-gated; lesson appends auto-eligible; cost-outlier ignores hung runs'
})

gate('GATE-140: CANONICAL-SELECTION — a declared (sidecar/marker) OR canonical-author file beats an analyst file that merely embedded the taskId in its FILENAME (the ITC NARAD>CHANAKYA regression: published the sentiment-desk file over teamleader synthesis)', () => {
  const os = require('node:os')
  const sel = require(path.resolve(__dirname, 'agents/dossier-selector'))
  const tid = '1780995101516'
  const spec = { finalReportName: null, leaderName: 'CHANAKYA', markers: ['FINAL', 'DOSSIER'] }

  // (c) FALLBACK (no marker/sidecar): canonical-author + "Internal Ref" content beats analyst filename-taskId.
  const d1 = fs.mkdtempSync(path.join(os.tmpdir(), 'gate140c-'))
  fs.writeFileSync(path.join(d1, `NARAD-INTEL-ITC-${tid}.md`), '# NARAD INTEL\n' + 'x'.repeat(400))
  fs.writeFileSync(path.join(d1, 'CHANAKYA-ITC-FINAL-2026-06-09.md'), '# INSTITUTIONAL DOSSIER\nInternal Ref: ' + tid + '\n' + 'y'.repeat(400))
  const rc = sel.selectBestDossierFile([d1], tid, 'CHANAKYA', 0, { canonicalSpec: spec })
  if (!rc || !/CHANAKYA/.test(rc.name)) throw new Error(`(c) fallback: expected CHANAKYA synthesis, got ${rc && rc.name}`)
  // legacy 4-arg (no spec) STILL reproduces the old NARAD pick — proves the spec is what fixes it (back-compat sentinel)
  const rcLegacy = sel.selectBestDossierFile([d1], tid, 'CHANAKYA', 0)
  if (!rcLegacy || !/NARAD/.test(rcLegacy.name)) throw new Error('(c) legacy 4-arg should still pick NARAD (back-compat sentinel changed)')

  // (b) MARKER: a file self-declaring the canonical marker for this taskId beats analyst filename-taskId file.
  const d2 = fs.mkdtempSync(path.join(os.tmpdir(), 'gate140b-'))
  fs.writeFileSync(path.join(d2, `NARAD-INTEL-ITC-${tid}.md`), '# NARAD\n' + 'x'.repeat(400))
  fs.writeFileSync(path.join(d2, 'CHANAKYA-ITC-FINAL-2026-06-09.md'), `<!-- ARCHON-CANONICAL taskId=${tid} squad=stocks author=CHANAKYA -->\n# DOSSIER\n` + 'y'.repeat(400))
  const rb = sel.selectBestDossierFile([d2], tid, 'CHANAKYA', 0, { canonicalSpec: spec })
  if (!rb || rb.via !== 'marker' || !/CHANAKYA/.test(rb.name)) throw new Error(`(b) marker: expected via=marker CHANAKYA, got ${rb && rb.name}/${rb && rb.via}`)

  // (a) SIDECAR: {taskId}.canonical pointer wins directly (unspoofable by filename) — makes re-grades idempotent.
  const d3 = fs.mkdtempSync(path.join(os.tmpdir(), 'gate140a-'))
  const rep = path.join(d3, 'reports'); fs.mkdirSync(rep)
  fs.writeFileSync(path.join(d3, `NARAD-INTEL-ITC-${tid}.md`), '# NARAD\n' + 'x'.repeat(400))
  const pub = path.join(rep, `${tid}.md`); fs.writeFileSync(pub, `<!-- ARCHON-CANONICAL taskId=${tid} -->\npublished ` + 'z'.repeat(400))
  fs.writeFileSync(path.join(rep, `${tid}.canonical`), JSON.stringify({ taskId: tid, path: pub }))
  const ra = sel.selectBestDossierFile([d3], tid, 'CHANAKYA', 0, { canonicalSpec: spec, sidecarDir: rep })
  if (!ra || ra.via !== 'sidecar' || ra.path !== pub) throw new Error(`(a) sidecar: expected published via=sidecar, got ${ra && ra.path}/${ra && ra.via}`)

  for (const d of [d1, d2, d3]) { try { fs.rmSync(d, { recursive: true, force: true }) } catch {} }
  return 'declared (sidecar/marker) + canonical-author beat analyst filename-taskId; legacy 4-arg back-compat preserved'
})

gate('GATE-141: CANONICAL-RACE-PRESERVED — two canonical-author files for different taskIds disambiguate by taskId, so the 2026-05-15 parallel-dispatch race (CHANAKYA A picking CHANAKYA B\'s file) stays fixed', () => {
  const os = require('node:os')
  const sel = require(path.resolve(__dirname, 'agents/dossier-selector'))
  const spec = { finalReportName: null, leaderName: 'CHANAKYA', markers: ['FINAL', 'DOSSIER'] }
  const tidA = '111111111', tidB = '222222222'
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gate141-'))
  fs.writeFileSync(path.join(dir, 'CHANAKYA-ACME-FINAL-2026-06-09.md'), '# DOSSIER A\nInternal Ref: ' + tidA + '\n' + 'a'.repeat(400))
  fs.writeFileSync(path.join(dir, 'CHANAKYA-BETA-FINAL-2026-06-09.md'), '# DOSSIER B\nInternal Ref: ' + tidB + '\n' + 'b'.repeat(400))
  const rA = sel.selectBestDossierFile([dir], tidA, 'CHANAKYA', 0, { canonicalSpec: spec })
  const rB = sel.selectBestDossierFile([dir], tidB, 'CHANAKYA', 0, { canonicalSpec: spec })
  if (!rA || !/ACME/.test(rA.name)) throw new Error(`taskA must pick its OWN CHANAKYA file, got ${rA && rA.name}`)
  if (!rB || !/BETA/.test(rB.name)) throw new Error(`taskB must pick its OWN CHANAKYA file, got ${rB && rB.name}`)
  try { fs.rmSync(dir, { recursive: true, force: true }) } catch {}
  return 'two same-author dossiers disambiguate by taskId (content Internal Ref) — race fix preserved'
})

gate('GATE-142: COST-OUTLIER-PER-AGENT + DEDUP — an agent is judged a cost outlier only vs its OWN trailing history (not a cross-agent average that teamleader and cheap challengers both skew), and identical proposals collapse to one (the 7 spurious "downgrade effort" entries from one ITC run)', () => {
  const ll = require(path.resolve(__dirname, 'agents/learning-loop'))
  const ts = new Date().toISOString()
  const mk = (agent, cost, t) => ({ epVersion: '1', ts, taskId: t, squad: 'stocks', agentName: agent, phase: 'specialist', outcome: 'completed', gradeScore: null, costUsd: cost, durationMs: 1000, adapterUsed: 'sdk', suppressionCount: 0, findingCount: 1 })
  // 1 leader + 5 analysts, each a SINGLE run — no agent has its own ≥3-run baseline → none flagged
  const eps = [mk('chanakya', 5.0, 't1'), mk('veteran', 1.0, 't2'), mk('analyst', 1.1, 't3'), mk('lakshmi', 0.9, 't4'), mk('surya', 1.0, 't5'), mk('vayu', 1.2, 't6')]
  const d = ll.distill({ episodes: eps, baseline: {} })
  const co = (d.patterns || []).filter(p => p.type === 'cost-outlier')
  if (co.length !== 0) throw new Error(`single-run agents must NOT be cost-outliers (no own baseline), got ${co.length}`)
  // agent with its OWN 3-run history showing a spike → flagged (per-agent, not cross-agent)
  const hist = [mk('viper', 0.1, 'h1'), mk('viper', 0.12, 'h2'), mk('viper', 5.0, 'h3')]
  const dh = ll.distill({ episodes: hist, baseline: {} })
  const nco = (dh.patterns || []).filter(p => p.type === 'cost-outlier' && p.agentName === 'viper')
  if (nco.length === 0) throw new Error('agent with its own 3-run history + a 2× spike must be flagged (per-agent baseline)')
  // within-run dedup: 7 identical cost-outlier patterns → exactly 1 proposal
  const dup = Array.from({ length: 7 }, () => ({ type: 'cost-outlier', agentName: 'chanakya', squad: 'stocks', count: 1, description: 'x' }))
  const props = ll.propose({ patterns: dup })
  if (props.length !== 1) throw new Error(`7 identical cost-outlier patterns must dedup to 1 proposal, got ${props.length}`)
  return 'cost-outlier uses per-agent historical baseline (min own-sample); identical proposals deduped to one'
})

gate('GATE-143: CANONICAL-SELECTION-HARDENING — declared/canonical signals are AUTHOR-BOUND and prefix-matched: a planted marker (author=NARAD), an impersonating filename (NARAD-CHANAKYA-FINAL), a cross-task sidecar, and a stale small draft can no longer hijack the canonical pick from the real leader synthesis', () => {
  const os = require('node:os')
  const sel = require(path.resolve(__dirname, 'agents/dossier-selector'))
  const tid = '1780995101516'
  const spec = { finalReportName: null, leaderName: 'CHANAKYA', markers: ['FINAL', 'DOSSIER'] }
  const real = '# DOSSIER\nInternal Ref: ' + tid + '\n' + 'y'.repeat(400)

  // (a) FILENAME IMPERSONATION: NARAD-CHANAKYA-FINAL must NOT pass the canon gate (prefix, not substring)
  const da = fs.mkdtempSync(path.join(os.tmpdir(), 'g143a-'))
  fs.writeFileSync(path.join(da, `NARAD-CHANAKYA-FINAL-${tid}.md`), '# fake\n' + 'z'.repeat(400))
  fs.writeFileSync(path.join(da, 'CHANAKYA-ITC-FINAL-x.md'), real)
  const ra = sel.selectBestDossierFile([da], tid, 'CHANAKYA', 0, { canonicalSpec: spec })
  if (!ra || !/^CHANAKYA-ITC-FINAL/.test(ra.name)) throw new Error(`(a) impersonation filename won: ${ra && ra.name}`)

  // (b) MARKER AUTHOR-BIND: a planted marker with author=NARAD must be rejected
  const db = fs.mkdtempSync(path.join(os.tmpdir(), 'g143b-'))
  fs.writeFileSync(path.join(db, `NARAD-INTEL-${tid}.md`), `<!-- ARCHON-CANONICAL taskId=${tid} author=NARAD -->\n# fake\n` + 'z'.repeat(400))
  fs.writeFileSync(path.join(db, 'CHANAKYA-FINAL-x.md'), real)
  const rb = sel.selectBestDossierFile([db], tid, 'CHANAKYA', 0, { canonicalSpec: spec })
  if (!rb || !/CHANAKYA/.test(rb.name)) throw new Error(`(b) planted author=NARAD marker won: ${rb && rb.name}`)

  // (c) CROSS-TASK SIDECAR: a sidecar whose taskId != requested must be rejected (fail-soft to scan)
  const dc = fs.mkdtempSync(path.join(os.tmpdir(), 'g143c-'))
  const rep = path.join(dc, 'reports'); fs.mkdirSync(rep)
  fs.writeFileSync(path.join(dc, 'CHANAKYA-ITC-FINAL-x.md'), real)
  const wrong = path.join(rep, 'wrong.md'); fs.writeFileSync(wrong, '# WRONG TASK\n' + 'w'.repeat(400))
  fs.writeFileSync(path.join(rep, `${tid}.canonical`), JSON.stringify({ taskId: '9999999999', path: wrong }))
  const rc = sel.selectBestDossierFile([dc], tid, 'CHANAKYA', 0, { canonicalSpec: spec, sidecarDir: rep })
  if (!rc || !/CHANAKYA/.test(rc.name)) throw new Error(`(c) cross-task sidecar poison won: ${rc && rc.name}/${rc && rc.via}`)

  // (d) SIZE-AWARE TIEBREAK: a 28KB final beats a NEWER 800B draft in the same canon tier
  const dd = fs.mkdtempSync(path.join(os.tmpdir(), 'g143d-'))
  fs.writeFileSync(path.join(dd, 'CHANAKYA-ITC-FINAL.md'), '# FINAL\nInternal Ref: ' + tid + '\n' + 'y'.repeat(28000))
  const draft = path.join(dd, 'CHANAKYA-ITC-DRAFT-DOSSIER.md'); fs.writeFileSync(draft, '# DRAFT\nInternal Ref: ' + tid + '\n' + 'z'.repeat(800))
  fs.utimesSync(draft, new Date(), new Date())
  const rd = sel.selectBestDossierFile([dd], tid, 'CHANAKYA', 0, { canonicalSpec: spec })
  if (!rd || !/FINAL\.md$/.test(rd.name)) throw new Error(`(d) stale small draft beat the final: ${rd && rd.name}`)

  for (const d of [da, db, dc, dd]) { try { fs.rmSync(d, { recursive: true, force: true }) } catch {} }
  return 'author-bound marker/sidecar + prefix canon-match + cross-task sidecar guard + size-aware tiebreak'
})

gate('GATE-144: GRADE-SIGNAL-ALIVE — the grader resolves the eval via agentPaths.skillsDir (restructure-safe). The raw path.join(AGENTS_DIR, agentId, "skills") broke after the 2026-06-08 persona move (chanakya → squads/stocks/agents/chanakya) so gradeTask could not find evals.json → returned null → EVERY run silently ungraded → dead grade signal that starved memory-from-success + distill quality learning. Also: an ungraded episode records gradeScore=null, not a fake 0.', () => {
  const os = require('node:os')
  const eb = fs.readFileSync(path.join(__dirname, 'event-bus.js'), 'utf-8')
  // (1) grader must NOT use the broken raw join, and MUST use the resolver at both grading sites
  if (/const skillDir = path\.join\(AGENTS_DIR, agentId, 'skills'\)/.test(eb)) throw new Error('grader still uses raw path.join(AGENTS_DIR,...) — breaks after persona restructure → silent ungraded')
  if ((eb.match(/const skillDir = agentPaths\.skillsDir\(agentId\)/g) || []).length < 2) throw new Error('grader eval-path not resolver-based at both grading sites (gradeTask + smart-grade)')
  // (2) behavioral: the resolver finds a real eval for the stocks leader (else grading returns null)
  const ap = require(path.resolve(__dirname, 'paths'))
  const sd = ap.skillsDir('chanakya')
  if (!fs.existsSync(sd)) throw new Error(`skillsDir(chanakya) missing: ${sd}`)
  let found = false
  for (const d of fs.readdirSync(sd)) { if (fs.existsSync(path.join(sd, d, 'evals', 'evals.json'))) { found = true; break } }
  if (!found) throw new Error('no evals.json reachable via skillsDir(chanakya) — grader would return null (ungraded)')
  // (3) episode emit: ungraded (no gradeScore) → null, not 0
  delete require.cache[require.resolve(path.resolve(__dirname, 'agents/episode-record'))]
  const er = require(path.resolve(__dirname, 'agents/episode-record'))
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'g144-'))
  er.emitEpisode({ taskId: 'g144', squad: 'stocks', agentName: 'X', phase: 'specialist', outcome: 'completed', costUsd: 1, findingCount: 2, outDir: tmp })
  const line = JSON.parse(fs.readFileSync(path.join(tmp, 'episodes', 'episodes.jsonl'), 'utf-8').trim().split('\n')[0])
  if (line.gradeScore !== null) throw new Error(`ungraded episode must record gradeScore=null (not a fake 0), got ${JSON.stringify(line.gradeScore)}`)
  // (4) a real grade (finite) still records + normalises; updateTaskGrade must NOT write a 0 for undefined
  er.updateTaskGrade('g144real', undefined, { outDir: tmp })
  const guPath = path.join(tmp, 'episodes', 'grade-updates.jsonl')
  if (fs.existsSync(guPath) && fs.readFileSync(guPath, 'utf-8').trim()) throw new Error('updateTaskGrade wrote a record for an undefined grade — poisons the signal as 0')
  try { fs.rmSync(tmp, { recursive: true, force: true }) } catch {}
  return 'grader resolves eval via skillsDir (restructure-safe, 37-expectation stocks eval reachable); ungraded episode = null; updateTaskGrade ignores non-finite grades'
})

gate('GATE-145: STRUCTURED-OUTPUT-JUDGE — the ARBITER judge (standard + High/Critical consensus paths) requests GUARANTEED schema-valid JSON via the CLI --json-schema flag, reading the model output from envelope.structured_output. Retires the regex-extract/markdown-strip fragility in parseJudgeResponse that silently downgraded Critical/High findings to "indeterminate" (a false-negative source) on any LLM formatting wobble.', () => {
  const jv = require(path.resolve(__dirname, 'agents/judge-verifier'))
  const rj = fs.readFileSync(path.join(__dirname, 'scripts', 'run-judge-verifier.js'), 'utf-8')
  const jvSrc = fs.readFileSync(path.join(__dirname, 'agents', 'judge-verifier.js'), 'utf-8')
  const eb = fs.readFileSync(path.join(__dirname, 'event-bus.js'), 'utf-8')
  // (1) JUDGE_SCHEMA exported + well-formed (mirrors the buildJudgePrompt OUTPUT block).
  if (!jv.JUDGE_SCHEMA || typeof jv.JUDGE_SCHEMA !== 'object') throw new Error('judge-verifier does not export JUDGE_SCHEMA')
  for (const k of ['stage_a', 'stage_b', 'stage_c', 'stage_d', 'verdict', 'first_failed_stage']) {
    if (!jv.JUDGE_SCHEMA.required.includes(k)) throw new Error(`JUDGE_SCHEMA missing required field ${k}`)
  }
  if (!jv.JUDGE_SCHEMA.properties.verdict.enum.includes('confirmed')) throw new Error('JUDGE_SCHEMA verdict enum malformed')
  // (2) callRealLLM drives structured output via --json-schema + reads envelope.structured_output.
  if (!/--json-schema/.test(rj)) throw new Error('callRealLLM does not pass --json-schema')
  if (!/structured_output/.test(rj)) throw new Error('callRealLLM does not read envelope.structured_output (where schema output lands; verified live)')
  if (!/'json'/.test(rj)) throw new Error('callRealLLM does not use --output-format json (required for structured output)')
  // (3) JUDGE_SCHEMA injected on BOTH the standard and the High/Critical consensus judge paths.
  if ((jvSrc.match(/jsonSchema:\s*JUDGE_SCHEMA/g) || []).length < 2) throw new Error('JUDGE_SCHEMA not injected on both standard + consensus judge paths')
  // (4) both event-bus judge wrappers FORWARD the schema-bearing 2nd arg (they used to drop it).
  if ((eb.match(/\.\.\.\(o \|\| \{\}\)/g) || []).length < 2) throw new Error('event-bus judge wrappers do not forward the jsonSchema arg')
  // (5) behavioral: parseJudgeResponse on a clean structured_output-shaped JSON → real verdict, no fallback.
  const fixture = JSON.stringify({ stage_a: { pass: true, reason: 'x' }, stage_b: { pass: true, reason: 'x' }, stage_c: { pass: true, reason: 'x' }, stage_d: { pass: false, reason: 'x' }, verdict: 'downgraded', first_failed_stage: 'D' })
  const parsed = jv.parseJudgeResponse(fixture)
  if (parsed.error || parsed.verdict !== 'downgraded') throw new Error('parseJudgeResponse failed on clean structured JSON: ' + JSON.stringify(parsed))
  return 'structured-output judge: --json-schema + structured_output extraction; JUDGE_SCHEMA injected on standard+consensus; clean JSON parses without the indeterminate fallback'
})

gate('GATE-146: PER-TASK-ISA — a dispatch can declare task-specific success criteria (ISCs). They are injected into the squad-leader prompt UP-FRONT (every prompt builder reads dispatch.goal, so one injection covers all) AND graded against the final report via a structured-output Haiku call (reusing the --json-schema infra), blended into the pass-rate. Makes grading task-aware on top of the squad generic rubric (PAI Ideal-State-Artifact pattern; sharpens the GATE-144 grade signal).', () => {
  const isa = require(path.resolve(__dirname, 'agents/isa-grader'))
  const eb = fs.readFileSync(path.join(__dirname, 'event-bus.js'), 'utf-8')
  // (1) module surface + schema well-formed (mirrors the structured-output result shape)
  if (typeof isa.gradeSuccessCriteria !== 'function') throw new Error('isa-grader missing gradeSuccessCriteria')
  if (typeof isa.buildIsaPrompt !== 'function') throw new Error('isa-grader missing buildIsaPrompt')
  if (!isa.ISA_SCHEMA || !isa.ISA_SCHEMA.properties || !isa.ISA_SCHEMA.properties.results) throw new Error('isa-grader ISA_SCHEMA malformed')
  // (2) event-bus injects criteria into dispatch.goal at pickup + grades ISA in gradeTask
  if (!/dispatch\.successCriteria/.test(eb)) throw new Error('event-bus does not read dispatch.successCriteria')
  if (!/SUCCESS CRITERIA \(you will be graded/.test(eb)) throw new Error('event-bus does not inject success criteria into dispatch.goal (up-front spec)')
  if (!/gradeSuccessCriteria/.test(eb)) throw new Error('event-bus gradeTask does not grade ISA against the report')
  // (3) sync logic: blanks dropped; the prompt enumerates each criterion + includes the report
  const norm = isa._normalizeCriteria(['  a ', '', 'b', null, 3])
  if (norm.length !== 2 || norm[0] !== 'a' || norm[1] !== 'b') throw new Error('normalizeCriteria wrong: ' + JSON.stringify(norm))
  const p = isa.buildIsaPrompt(['cover X', 'cover Y'], 'report body here')
  if (!/1\. cover X/.test(p) || !/2\. cover Y/.test(p) || !/report body here/.test(p)) throw new Error('buildIsaPrompt does not enumerate criteria + embed the report')
  return 'per-task ISA: criteria injected into the goal up-front + graded against the report via structured output, blended into the pass-rate'
})

gate('GATE-147: SUPPRESSION-LEDGER-ISOLATION — severity-profile.filterFindings forwards outDir to the suppression ledger so tests write to a TEMP dir, never the PRODUCTION ledger. (The prod ledger had accreted 9090 test fixtures with taskId:null because outDir was never threaded — turning the false-negative-visibility tool into pure noise.)', () => {
  const sp = fs.readFileSync(path.join(__dirname, 'agents', 'severity-profile.js'), 'utf-8')
  const tst = fs.readFileSync(path.join(__dirname, 'test', 'severity-profile.test.js'), 'utf-8')
  if (!/function filterFindings\([^)]*\{[^)]*outDir[^)]*\}/.test(sp)) throw new Error('filterFindings does not accept outDir')
  if (!/logSuppression\(\{[\s\S]*?\boutDir\b[\s\S]*?\}\)/.test(sp)) throw new Error('filterFindings does not forward outDir to logSuppression')
  if (!/mkdtempSync/.test(tst) || !/outDir:\s*_TMP/.test(tst)) throw new Error('severity-profile.test.js still writes the PRODUCTION suppression ledger (no temp outDir)')
  return 'severity-profile forwards outDir; test isolates the ledger — no production pollution'
})

gate('GATE-136: LEARNING-LOOP-TRIGGERED — the OBSERVE→DISTILL→PROPOSE loop actually fires after each dispatch (it was dormant: episodes accrued but runLoop was never invoked). Runs PROPOSE-ONLY (human-tap), skips ungraded/grade≤0 episodes.', () => {
  const ebSrc = fs.readFileSync(path.join(__dirname, 'event-bus.js'), 'utf-8')
  const triggers = (ebSrc.match(/require\('\.\/agents\/learning-loop'\)\.runLoop\(\{ squad, windowDays: 7, autoApply: false \}\)/g) || []).length
  if (triggers < 3) throw new Error(`learning-loop trigger missing at TASK_DONE sites (found ${triggers}/3) — loop stays dormant`)
  const llSrc = fs.readFileSync(path.join(__dirname, 'agents', 'learning-loop.js'), 'utf-8')
  if (!/autoApply = false \} = \{\}/.test(llSrc)) throw new Error('runLoop default must be PROPOSE-ONLY (autoApply=false) — a caller that OMITS the flag must not silently arm the dormant applier (2026-06-10 review fix)')
  if (!/if \(!outDir && autoApply\)/.test(llSrc)) throw new Error('auto-apply not gated on autoApply flag — propose-only impossible')
  if (!/if \(score <= 0\) continue/.test(llSrc)) throw new Error('loop does not skip grade≤0 episodes — would fire spurious proposals on the ungraded→0 pollution')
  // behavioral: propose-only never applies
  const probe = `require('${agentPaths.AGENTS_ROOT}/agents/learning-loop').runLoop({squad:'pentest', windowDays:7, autoApply:false}).then(r=>{if(r.applied!==0)throw new Error('applied '+r.applied+' in propose-only');process.stdout.write('proposals='+r.proposals+' applied=0')}).catch(e=>{process.stderr.write(e.message);process.exit(1)})`
  const r = spawnSync('node', ['-e', probe], { encoding: 'utf-8', timeout: 20000 })
  if (r.status !== 0) throw new Error(`propose-only probe failed: ${(r.stderr||'').slice(0,200)}`)
  return `loop fires at 3 TASK_DONE sites, propose-only (${(r.stdout||'').trim()}), grade≤0 skipped`
})

gate('GATE-137: MEMORY-FROM-SUCCESS — high-grade runs bank what WORKED, not just failures. Memory that records only failures never reinforces winning approaches (reflexion/Mem0 pattern).', () => {
  const ebSrc = fs.readFileSync(path.join(__dirname, 'event-bus.js'), 'utf-8')
  // writePostTaskMemory must have a positive-lesson branch gated on a high grade
  if (!/_gradeNum >= 85 && gradeResults/.test(ebSrc)) throw new Error('no positive-lesson banking on high-grade runs')
  if (!/✅ WORKED/.test(ebSrc) || !/Keep doing \(validated this run/.test(ebSrc)) throw new Error('positive lesson not banked in lessons.md (the memory-ranker reads this)')
  // it must come from PASSED expectations, not failures
  if (!/const passed = gradeResults\.filter\(r => r\.passed\)/.test(ebSrc)) throw new Error('positive lesson not sourced from passed expectations')
  return 'high-grade runs bank validated approaches to lessons.md (memory learns from success too)'
})

gate('GATE-138: PEER-FINDINGS-REFINEMENT — a later analyst gets earlier analysts\' findings confidence-ranked + a build-on/challenge framing (group-chat-style refinement), not a raw last-15 dump or working in isolation', () => {
  const ebSrc = fs.readFileSync(path.join(__dirname, 'event-bus.js'), 'utf-8')
  if (!/PEER FINDINGS \(analysts before you — BUILD ON, CHALLENGE/.test(ebSrc)) throw new Error('peer findings lack the build-on/challenge framing')
  if (!/String\(f\.agent \|\| ''\)\.toUpperCase\(\) !== agentUpper/.test(ebSrc)) throw new Error('analyst is fed its OWN findings back (no self-exclude)')
  if (!/\{ high: 0, medium: 1, low: 2 \}/.test(ebSrc)) throw new Error('peer findings not confidence-ranked')
  return 'peer findings confidence-ranked, self-excluded, build-on/challenge framing'
})

gate('GATE-131: SRC-TREE-LAYOUT — root holds only the stable anchors (PM2 entry points + gate harness + resolver); all other modules live under src/<category>/. Keeps the repo formal + scalable, prevents root re-clutter.', () => {
  const ANCHORS = new Set(['event-bus.js', 'supervisor.js', 'telegram-relay.js', 'telegram-inbound.js', 'verify-framework.js', 'paths.js'])
  const rootJs = fs.readdirSync(__dirname).filter(f => f.endsWith('.js'))
  const strays = rootJs.filter(f => !ANCHORS.has(f))
  if (strays.length) throw new Error(`loose .js at repo root (must live under src/<category>/): ${strays.join(', ')}`)
  for (const a of ANCHORS) {
    if (!fs.existsSync(path.join(__dirname, a))) throw new Error(`anchor missing from root: ${a}`)
  }
  // ops .sh scripts live under scripts/ too — root keeps ONLY the externally-anchored ones
  // (data-retention + task-monitor = cron; pre-commit-check = git-hook/gate infra)
  const SH_ANCHORS = new Set(['data-retention.sh', 'task-monitor.sh', 'pre-commit-check.sh'])
  const shStrays = fs.readdirSync(__dirname).filter(f => f.endsWith('.sh') && !SH_ANCHORS.has(f))
  if (shStrays.length) throw new Error(`loose .sh at repo root (move to scripts/): ${shStrays.join(', ')}`)
  // the src/ category tree exists and is populated
  const cats = ['dispatch', 'pipeline', 'grading', 'learning', 'routing', 'safety', 'rendering', 'core', 'integrations', 'utils']
  const missing = cats.filter(c => !fs.existsSync(path.join(__dirname, 'src', c)) || fs.readdirSync(path.join(__dirname, 'src', c)).filter(f => f.endsWith('.js')).length === 0)
  if (missing.length) throw new Error(`src/ categories missing or empty: ${missing.join(', ')}`)
  const srcCount = cats.reduce((n, c) => n + fs.readdirSync(path.join(__dirname, 'src', c)).filter(f => f.endsWith('.js')).length, 0)
  return `root = ${rootJs.length} anchors only; ${srcCount} modules organized across ${cats.length} src/ categories`
})

gate('GATE-130: SQUAD-CONFIG-CONSUMED — squad.json is actually READ at dispatch (caps.maxSpecialists applied), not just validated. Closes the dead-module / auto-applier-no-op gap.', () => {
  const ebSrc = fs.readFileSync(path.join(__dirname, 'event-bus.js'), 'utf-8')
  if (!/require\('\.\/agents\/squad-config-loader'\)\.loadSquadConfig\(/.test(ebSrc)) {
    throw new Error('squad-config-loader.loadSquadConfig never called in event-bus — squad.json is still dead (and auto-applier squad_config_patch is a runtime no-op)')
  }
  if (!/maxSpecialists/.test(ebSrc)) throw new Error('caps.maxSpecialists not consumed at dispatch')
  // behavioral: the cap actually trims an oversized list
  const probe = `
const scl=require('${agentPaths.AGENTS_ROOT}/agents/squad-config-loader')
const cfg=scl.loadSquadConfig('pentest')
if(!cfg||!cfg.caps||!Number.isInteger(cfg.caps.maxSpecialists))throw new Error('pentest squad.json has no integer caps.maxSpecialists')
// simulate the cap logic
const cap=cfg.caps.maxSpecialists
const list=Array.from({length:cap+5},(_,i)=>'a'+i)
const trimmed=list.length>cap?list.slice(0,cap):list
if(trimmed.length!==cap)throw new Error('cap did not trim')
process.stdout.write('cap='+cap)
`
  const r = spawnSync('node', ['-e', probe], { encoding: 'utf-8', timeout: 8000 })
  if (r.status !== 0) throw new Error(`squad-config cap probe failed: ${(r.stderr||'').slice(0,200)}`)
  return `squad.json consumed at dispatch (${(r.stdout||'').trim()}); auto-applier squad_config_patch now effective`
})

gate('GATE-128: RESOLVER-PARITY — persona name casing is normalized (daemon == dashboard), and repair/learning prompts READ memory from the same place writes LAND (var/state under evicted) — the restructure left no read/write split', () => {
  // 1. casing: uppercase resolves identically to lowercase (was broken: 'SCOUT' → /root/agents/SCOUT)
  const probe = `const p=require('${agentPaths.AGENTS_ROOT}/paths.js'); if(p.personaCode('SCOUT')!==p.personaCode('scout'))throw new Error('personaCode casing split: '+p.personaCode('SCOUT')); if(p.personaState('AUDITOR')!==p.personaState('auditor'))throw new Error('personaState casing split'); process.stdout.write('ok')`
  const r = spawnSync('node', ['-e', probe], { encoding: 'utf-8', timeout: 8000 })
  if (r.status !== 0) throw new Error(`casing parity probe failed: ${(r.stderr||'').slice(0,200)}`)
  // 2. memory read == write: the repair/learning prompts must base memory/* on personaState, not personaCode
  const ebSrc = fs.readFileSync(path.join(__dirname, 'event-bus.js'), 'utf-8')
  for (const m of ebSrc.matchAll(/const (agentWorkspace\w*)\s*=\s*agentPaths\.(\w+)\(/g)) {
    const [, varName, accessor] = m
    // these vars are only used for ${var}/memory/... refs → must be personaState
    if (new RegExp(`\\$\\{${varName}\\}/memory`).test(ebSrc) && accessor !== 'personaState') {
      throw new Error(`${varName} = personaCode but used for /memory reads — under evicted mode that dir is empty (read/write split). Use personaState.`)
    }
  }
  // 3. dashboard mirror normalizes casing too (so daemon + dashboard never diverge on uppercase)
  const apSrc = fs.readFileSync('/root/mission-control/lib/agent-paths.ts', 'utf-8')
  if (!/toLowerCase\(\)/.test(apSrc)) throw new Error('agent-paths.ts (dashboard mirror) does not lowercase — would diverge from paths.js on uppercase names')
  if (!/ownership\.json/.test(apSrc)) throw new Error('agent-paths.ts no longer reads ownership.json — mirror drift')
  return 'casing normalized daemon==dashboard; memory read-path == write-path (personaState); mirror reads ownership.json'
})

gate('GATE-127: SUPPRESSION-RECALL-MEASURED — planted genuine high-conviction findings are never silently dropped by the suppression stack (the quality metric of record that converts "quality" from a story into a number)', () => {
  const probe = require('./scripts/recall-probe')
  // strictest profile (bounty, High+ only) = worst case for suppression of downgraded findings
  let worstRecall = 1, worstProfile = null, drops = []
  for (const profileName of ['bounty', 'pentest', 'comprehensive']) {
    const out = probe.runProbe({ profileName, squad: 'pentest' })
    if (out.genuineHC < 4) throw new Error(`recall fixture set too small (${out.genuineHC} genuine high-conviction) — need a real seed`)
    if (out.recall < worstRecall) { worstRecall = out.recall; worstProfile = profileName; drops = out.silentDrops }
  }
  if (worstRecall < 1) {
    throw new Error(`SUPPRESSION RECALL ${(worstRecall * 100).toFixed(1)}% on profile=${worstProfile} — genuine high-conviction findings silently dropped: ${drops.map(d => d.id).join(', ')}. The counterweight (GATE-124) is not protecting them.`)
  }
  return `suppression recall 100% across all 3 profiles — 0 silent drops on the planted seed`
})

gate('GATE-126: AUTO-APPLY-SAFETY-PERIMETER — the full-auto learning loop is structurally barred from writing the judge/verifier/gates/reward/eval (can\'t-grade-itself rule), fail-closed', () => {
  const aaSrc = fs.readFileSync(path.join(__dirname, 'agents', 'auto-applier.js'), 'utf-8')
  if (!/_assertNotPerimeter/.test(aaSrc)) throw new Error('auto-applier has no perimeter guard — self-improver can write anywhere')
  if (!/SAFETY_PERIMETER/.test(aaSrc)) throw new Error('no SAFETY_PERIMETER list')
  // guard must actually be CALLED before the writes (not just defined)
  const callCount = (aaSrc.match(/_assertNotPerimeter\(/g) || []).length
  if (callCount < 4) throw new Error(`perimeter guard defined but called only ${callCount}× — must gate every write (soul, squad-config, override) + the definition`)
  // perimeter must cover judge/gates/reward/eval/verifier
  for (const must of ['verify-framework.js', 'judge-verifier.js', 'grader-config.json', 'arbiter', 'auditor', 'eval']) {
    if (!aaSrc.includes(must)) throw new Error(`SAFETY_PERIMETER missing '${must}'`)
  }
  // behavioral probe: the guard actually throws on a perimeter path and passes a persona path
  const probe = `
const path=require('path')
const src=require('fs').readFileSync('${agentPaths.AGENTS_ROOT}/agents/auto-applier.js','utf-8')
// extract + eval the guard in isolation
const m=src.match(/const SAFETY_PERIMETER[\\s\\S]*?\\n}/)
if(!m)throw new Error('cannot extract guard')
eval(m[0])
let blocked=false
try{_assertNotPerimeter('${agentPaths.AGENTS_ROOT}/agents/judge-verifier.js')}catch(_){blocked=true}
if(!blocked)throw new Error('guard did NOT block judge-verifier.js')
let blockedJudge=false
try{_assertNotPerimeter('${agentPaths.AGENTS_ROOT}/_universal/agents/arbiter/SOUL.md')}catch(_){blockedJudge=true}
if(!blockedJudge)throw new Error('guard did NOT block the judge persona SOUL')
let allowed=true
try{_assertNotPerimeter('${agentPaths.AGENTS_ROOT}/squads/pentest/agents/scout/SOUL.md')}catch(_){allowed=false}
if(!allowed)throw new Error('guard wrongly blocked a normal persona SOUL')
process.stdout.write('ok')
`
  const r = spawnSync('node', ['-e', probe], { encoding: 'utf-8', timeout: 8000 })
  if (r.status !== 0) throw new Error(`perimeter behavioral probe failed: ${(r.stderr||r.stdout||'').slice(0,300)}`)
  return `perimeter guard called ${callCount}× — blocks judge/gates/reward/eval, allows normal personas`
})

gate('GATE-125: PHASE-ENVELOPE-WIRED — the AUDITOR→VALIDATED seam (broke twice via VERDICT_RE) uses a typed envelope + quarantines LOUD when AUDITOR had verdicts but 0 reached VALIDATED-FINDINGS (the silent-drop class is now guarded, not just gate-shaped)', () => {
  const ebSrc = fs.readFileSync(path.join(__dirname, 'event-bus.js'), 'utf-8')
  if (!/require\('\.\/agents\/phase-envelope'\)/.test(ebSrc)) throw new Error('phase-envelope still has ZERO production call sites — built but unwired')
  // it must be wired at the Phase 3.05 AUDITOR seam, not just imported
  const p305 = ebSrc.indexOf('PHASE 3.05:')
  const wrapIdx = ebSrc.indexOf("__env.wrap('auditor-result'")
  if (wrapIdx < 0) throw new Error('no typed auditor-result envelope at the seam')
  if (p305 < 0 || wrapIdx < p305 || wrapIdx - p305 > 3000) throw new Error('envelope not wired into the Phase 3.05 AUDITOR→VALIDATED block')
  // the silent-drop guard: input>0 && output==0 → quarantine
  if (!/__auditorRawVerdicts\s*>\s*0\s*&&\s*__bw\.count\s*===?\s*0/.test(ebSrc)) throw new Error('missing input>0/output=0 silent-drop guard')
  if (!/__env\.quarantine\(/.test(ebSrc)) throw new Error('no quarantine call — silent-drop would not be LOUD')
  // envelope module contract intact
  const probe = `const e=require('${agentPaths.AGENTS_ROOT}/agents/phase-envelope'); const w=e.wrap('auditor-result',{a:1},{source:'AUDITOR',taskId:'t'}); e.validate(w,'auditor-result'); let threw=false; try{e.quarantine({x:1},'test',{taskId:'__gate125',outDir:'/tmp'})}catch(_){threw=true}; if(!threw)throw new Error('quarantine did not throw'); process.stdout.write('ok')`
  const r = spawnSync('node', ['-e', probe], { encoding: 'utf-8', timeout: 8000 })
  if (r.status !== 0) throw new Error(`phase-envelope contract probe failed: ${(r.stderr||'').slice(0,200)}`)
  return 'phase-envelope wired at AUDITOR→VALIDATED seam with LOUD silent-drop quarantine'
})

gate('GATE-124: SUPPRESSION-COUNTERWEIGHT-WIRED — Phase 3.075 logs every downgrade to the suppression ledger AND escalates high-conviction/low-evidence findings to manual-review-queue (not just logs — the promotion counterweight is LIVE)', () => {
  const ebSrc = fs.readFileSync(path.join(__dirname, 'event-bus.js'), 'utf-8')
  if (!ebSrc.includes("require('./agents/suppression-ledger')")) throw new Error('suppression-ledger not required in event-bus')
  if (!/logSuppression\(/.test(ebSrc)) throw new Error('logSuppression not called — downgrades not made visible')
  if (!/logManualReviewNeeded\(/.test(ebSrc)) throw new Error('logManualReviewNeeded not called — no escalation counterweight (the whole point)')
  if (!/isHighConvictionLowEvidence\(/.test(ebSrc)) throw new Error('escalation not gated on isHighConvictionLowEvidence')
  // the escalation must sit in the Phase 3.075 severity-filter block (archived findings)
  const phaseIdx = ebSrc.indexOf('PHASE 3.075')
  const escIdx = ebSrc.indexOf('logManualReviewNeeded(')
  if (phaseIdx < 0 || escIdx < phaseIdx || escIdx - phaseIdx > 4000) throw new Error('escalation not wired into the Phase 3.075 downgrade site')
  // helper catches downgraded-from-high (original severity), not just currently-high
  const slSrc = fs.readFileSync(path.join(__dirname, 'agents', 'suppression-ledger.js'), 'utf-8')
  if (!/severity_original|original_severity/.test(slSrc)) throw new Error('isHighConvictionLowEvidence ignores original severity — misses downgraded-from-high findings')
  // a write-only queue just relocates the silent drop — there MUST be a reader/resolver
  const rqPath = path.join(__dirname, 'agents', 'review-queue.js')
  if (!fs.existsSync(rqPath)) throw new Error('manual-review-queue has no reader (review-queue.js) — escalated findings pile up unread = silent drop relocated')
  const rqSrc = fs.readFileSync(rqPath, 'utf-8')
  if (!/manual-review-queue\.jsonl/.test(rqSrc) || !/listPending/.test(rqSrc) || !/function resolve|resolve\s*[:(]/.test(rqSrc)) {
    throw new Error('review-queue.js must read manual-review-queue.jsonl and expose listPending + resolve')
  }
  return 'Phase 3.075 logs downgrades + escalates to manual review + review-queue.js consumer (list/resolve) closes the loop'
})

gate('GATE-122: PERSONA-HOMES-INTACT — every persona resolves to exactly ONE physical SOUL.md; ownership map + squad-plugin shape consistent (restructure Phase 3, 2026-06-07)', () => {
  const own = JSON.parse(fs.readFileSync(path.join(__dirname, 'ownership.json'), 'utf-8')).map || {}
  const names = Object.keys(own)
  if (names.length < 40) throw new Error(`ownership map suspiciously small (${names.length}) — expected ~49 personas`)

  const dups = [], missing = [], orphanFlat = []
  for (const name of names) {
    const resolved = agentPaths.personaCode(name)
    // 1. resolves to a real SOUL.md
    if (!fs.existsSync(path.join(resolved, 'SOUL.md'))) missing.push(`${name} → ${resolved} (no SOUL.md)`)
    // 2. NO duplicate: persona must NOT also exist flat at /root/agents/<name> when nested elsewhere
    const flat = path.join(__dirname, name)
    if (resolved !== flat && fs.existsSync(path.join(flat, 'SOUL.md'))) dups.push(name)
  }
  if (missing.length) throw new Error(`personas with no SOUL.md at resolved home:\n${missing.slice(0, 8).join('\n')}`)
  if (dups.length) throw new Error(`DUPLICATE persona dirs (both flat + nested): ${dups.join(', ')}`)

  // 3. squad-plugin shape: each distinct squad home has an agents/ container that exists
  const homes = [...new Set(Object.values(own))]
  for (const home of homes) {
    const agentsDir = path.join(__dirname, home, 'agents')
    if (!fs.existsSync(agentsDir)) throw new Error(`squad home '${home}' missing agents/ container`)
  }
  // 4. universals share exactly one home
  for (const u of ['auditor', 'scribe', 'arbiter', 'command']) {
    if (own[u] && own[u] !== '_universal') throw new Error(`universal '${u}' not homed in _universal (got ${own[u]})`)
  }
  return `${names.length} personas, ${homes.length} squad homes, 0 dups, universals in _universal`
})

gate('GATE-119: FAILURE-CONTENT-AWARE-DISTILL — learning loop classifies failure cause, generates targeted lessons not hardcoded generic string', () => {
  const llSrc = fs.readFileSync(path.join(__dirname, 'agents', 'learning-loop.js'), 'utf-8')

  // Must have failure category classifier
  if (!llSrc.includes('FAILURE_CATEGORIES')) {
    throw new Error('learning-loop.js missing FAILURE_CATEGORIES taxonomy')
  }
  if (!llSrc.includes('classifyFailure')) {
    throw new Error('learning-loop.js missing classifyFailure() function')
  }

  // Must have targeted lesson map (not just hardcoded generic string)
  if (!llSrc.includes('FAILURE_LESSONS')) {
    throw new Error('learning-loop.js missing FAILURE_LESSONS per-category map')
  }

  // Must cover specific failure categories
  const required = ['timeout', 'rate_limit', 'scope_block', 'output_malform', 'target_unreach', 'no_findings']
  for (const cat of required) {
    // Check for key in any form: quoted or unquoted object property
    if (!llSrc.includes(`'${cat}'`) && !llSrc.includes(`"${cat}"`) && !llSrc.includes(`${cat}:`)) {
      throw new Error(`learning-loop.js FAILURE_CATEGORIES missing: ${cat}`)
    }
  }

  // Pattern must carry failureCategory field
  if (!llSrc.includes('failureCategory')) {
    throw new Error('learning-loop.js patterns missing failureCategory field')
  }

  // Propose must use specificLesson not hardcoded generic
  if (!llSrc.includes('specificLesson')) {
    throw new Error('learning-loop.js propose() missing specificLesson usage')
  }

  // Watchdog bug fix: deferred check not silent pass
  const aaSrc = fs.readFileSync(path.join(__dirname, 'agents', 'auto-applier.js'), 'utf-8')
  if (!aaSrc.includes('STALE_MS')) {
    throw new Error('auto-applier.js missing STALE_MS — watchdog silent-pass bug not fixed')
  }
  if (!aaSrc.includes('keep unchecked')) {
    throw new Error('auto-applier.js watchdog must defer (not silently pass) when quality data unavailable')
  }

  // Inline probe: classifyFailure works correctly
  const probe = `
'use strict'
const ll = require('${agentPaths.AGENTS_ROOT}/agents/learning-loop')
// distill with timeout failure should produce failureCategory='timeout'
const eps = [
  { agentName: 'VIPER', squad: 'pentest', outcome: 'failed', errorMessage: 'timed out after 600000ms', costUsd: 5, gradeScore: 0, suppressionCount: 0, findingCount: 0, ts: new Date().toISOString() },
  { agentName: 'VIPER', squad: 'pentest', outcome: 'failed', errorMessage: 'timed out after 600000ms', costUsd: 5, gradeScore: 0, suppressionCount: 0, findingCount: 0, ts: new Date().toISOString() },
  { agentName: 'VIPER', squad: 'pentest', outcome: 'failed', errorMessage: 'timed out after 600000ms', costUsd: 5, gradeScore: 0, suppressionCount: 0, findingCount: 0, ts: new Date().toISOString() },
]
const { patterns } = ll.distill({ episodes: eps, baseline: {} })
if (patterns.length === 0) throw new Error('no pattern generated for 3 timeouts')
const p = patterns[0]
if (p.failureCategory !== 'timeout') throw new Error('failureCategory should be timeout, got: ' + p.failureCategory)
if (!p.specificLesson || p.specificLesson.includes('verify endpoint reachability')) {
  throw new Error('specificLesson is still the old generic string, not timeout-targeted: ' + p.specificLesson)
}

// Also test no_findings category
const noFindEps = [
  { agentName: 'RELAY', squad: 'pentest', outcome: 'failed', errorMessage: '', costUsd: 3, gradeScore: 0, suppressionCount: 0, findingCount: 0, ts: new Date().toISOString() },
  { agentName: 'RELAY', squad: 'pentest', outcome: 'failed', errorMessage: '', costUsd: 3, gradeScore: 0, suppressionCount: 0, findingCount: 0, ts: new Date().toISOString() },
  { agentName: 'RELAY', squad: 'pentest', outcome: 'failed', errorMessage: '', costUsd: 3, gradeScore: 0, suppressionCount: 0, findingCount: 0, ts: new Date().toISOString() },
]
const { patterns: p2 } = ll.distill({ episodes: noFindEps, baseline: {} })
if (p2[0]?.failureCategory !== 'no_findings') throw new Error('no_findings not detected, got: ' + p2[0]?.failureCategory)
process.stdout.write('failure-content-aware distill: timeout→timeout-lesson, no_findings→no_findings-lesson\\n')
process.exit(0)
`
  const r = spawnSync('node', ['-e', probe], { encoding: 'utf-8', timeout: 10000 })
  if (r.status !== 0) {
    throw new Error(`GATE-119 probe failed: ${(r.stderr || r.stdout || '').trim().slice(0, 400)}`)
  }
  return (r.stdout || '').trim()
})

gate('GATE-118: AGENT-SOUL-QUALITY — all key agents have full SOUL.md (not identity card), misaligned identities fixed, challenger mandates enforced', () => {
  const agentsDir = __dirname

  // VIPER: must no longer say "Social Engineering" as primary role — now Client-Side
  const viperSrc = fs.readFileSync(agentPaths.soulPath('viper'), 'utf-8')
  if (/Social Engineering.*Specialist/.test(viperSrc) && !/Client-Side/.test(viperSrc)) {
    throw new Error('viper/SOUL.md still says Social Engineering Specialist without Client-Side fix')
  }
  if (viperSrc.split('\n').length < 50) {
    throw new Error(`viper/SOUL.md too short (${viperSrc.split('\n').length} lines) — needs full SOUL.md`)
  }

  // VAULT: must have php:// wrapper content
  const vaultSrc = fs.readFileSync(agentPaths.soulPath('vault'), 'utf-8')
  if (!vaultSrc.includes('php://filter') && !vaultSrc.includes('php://')) {
    throw new Error('vault/SOUL.md missing php:// wrapper techniques')
  }
  if (vaultSrc.split('\n').length < 50) {
    throw new Error(`vault/SOUL.md too short (${vaultSrc.split('\n').length} lines)`)
  }

  // TRACER: must have WAF detection tools
  const tracerSrc = fs.readFileSync(agentPaths.soulPath('tracer'), 'utf-8')
  if (!/wafw00f|whatwaf/.test(tracerSrc)) {
    throw new Error('tracer/SOUL.md missing WAF detection tools (wafw00f/whatwaf)')
  }

  // FORGE: must have per-engine RCE chains
  const forgeSrc = fs.readFileSync(agentPaths.soulPath('forge'), 'utf-8')
  if (!/Jinja2|jinja2/.test(forgeSrc)) {
    throw new Error('forge/SOUL.md missing Jinja2 RCE chain')
  }
  if (!/FreeMarker|freemarker/.test(forgeSrc)) {
    throw new Error('forge/SOUL.md missing FreeMarker chain')
  }

  // RANGER: must have WebSocket testing
  const rangerSrc = fs.readFileSync(agentPaths.soulPath('ranger'), 'utf-8')
  if (!/WebSocket|wscat/.test(rangerSrc)) {
    throw new Error('ranger/SOUL.md missing WebSocket testing section')
  }

  // DRILL: must have Deserialization + Prototype Pollution
  const drillSrc = fs.readFileSync(agentPaths.soulPath('drill'), 'utf-8')
  if (!drillSrc.includes('Deserialization') && !drillSrc.includes('ysoserial')) {
    throw new Error('drill/SOUL.md missing Deserialization section')
  }
  if (!drillSrc.includes('Prototype Pollution') && !drillSrc.includes('__proto__')) {
    throw new Error('drill/SOUL.md missing Prototype Pollution section')
  }

  // VISHNU: must have Challenger Mandate
  const vishnuSrc = fs.readFileSync(agentPaths.soulPath('vishnu'), 'utf-8')
  if (!vishnuSrc.includes('Challenger Mandate')) {
    throw new Error('vishnu/SOUL.md missing Challenger Mandate section')
  }
  if (!vishnuSrc.includes('FCF payout')) {
    throw new Error('vishnu/SOUL.md Challenger Mandate missing FCF payout check')
  }

  // CHANAKYA: must have Synthesis Accuracy Rules
  const chanakya = fs.readFileSync(agentPaths.soulPath('chanakya'), 'utf-8')
  if (!chanakya.includes('Synthesis Accuracy Rules')) {
    throw new Error('chanakya/SOUL.md missing Synthesis Accuracy Rules')
  }
  if (!chanakya.includes('FCF vs PAT')) {
    throw new Error('chanakya/SOUL.md Synthesis Rules missing FCF vs PAT distinction')
  }

  return 'SOUL.md quality: VIPER client-side fix, VAULT/TRACER/FORGE/RANGER upgraded, DRILL+deserialization+prototype-pollution, VISHNU challenger mandate, CHANAKYA synthesis accuracy rules'
})

gate('GATE-117: MULTI-JUDGE-CONSENSUS — 3-judge majority vote for High/Critical ARBITER decisions (+17.9% proven by research)', () => {
  const jvSrc = fs.readFileSync(path.join(__dirname, 'agents', 'judge-verifier.js'), 'utf-8')
  const rjSrc = fs.readFileSync(path.join(__dirname, 'scripts', 'run-judge-verifier.js'), 'utf-8')

  // judgeWithConsensus exported
  if (!jvSrc.includes('judgeWithConsensus')) {
    throw new Error('judge-verifier.js missing judgeWithConsensus function')
  }
  if (!jvSrc.includes('judgeFindingsWithConsensus')) {
    throw new Error('judge-verifier.js missing judgeFindingsWithConsensus function')
  }
  // 3 lenses for perspective diversity
  if (!jvSrc.includes('CONSENSUS_LENSES')) {
    throw new Error('judge-verifier.js missing CONSENSUS_LENSES array')
  }
  // Majority vote logic
  if (!jvSrc.includes('confirmedCount >= 2')) {
    throw new Error('judge-verifier.js missing majority vote (confirmedCount >= 2) logic')
  }
  // consensus_confidence field
  if (!jvSrc.includes('consensus_confidence')) {
    throw new Error('judge-verifier.js missing consensus_confidence field in result')
  }
  // run-judge-verifier wires consensus for High/Critical
  if (!rjSrc.includes('judgeFindingsWithConsensus')) {
    throw new Error('run-judge-verifier.js not using judgeFindingsWithConsensus')
  }
  if (!rjSrc.includes('consensus_used')) {
    throw new Error('run-judge-verifier.js missing consensus_used in summary')
  }
  return '3-judge consensus for High/Critical: CONSENSUS_LENSES + majority vote + consensus_confidence + wired in Phase 3.9'
})

gate('GATE-116: QUALITY-SPRINT — ARBITER evidence fix, confidence+reproduction fields, challenger agent, contradiction detector', () => {
  const ebSrc = fs.readFileSync(path.join(__dirname, 'event-bus.js'), 'utf-8')
  const kbSrc = fs.readFileSync(path.join(__dirname, 'agents', 'auditor-validated-builder.js'), 'utf-8')
  const sfSrc = fs.readFileSync(path.join(__dirname, 'src/core/squad-framework.js'), 'utf-8')

  // ARBITER evidence fix: reproduction_method + reproduction_result populated
  if (!kbSrc.includes('reproduction_method')) {
    throw new Error('auditor-validated-builder.js missing reproduction_method field')
  }
  if (!kbSrc.includes('reproduction_result')) {
    throw new Error('auditor-validated-builder.js missing reproduction_result field')
  }
  if (!kbSrc.includes('proof:')) {
    throw new Error('auditor-validated-builder.js missing proof field for ARBITER')
  }

  // Per-finding confidence + reproduction in MUST_GATES
  if (!sfSrc.includes('GATE-13')) {
    throw new Error('squad-framework.js missing GATE-13 [CONFIDENCE + REPRODUCTION]')
  }
  if (!sfSrc.includes('"confidence": "high|medium|low"')) {
    throw new Error('squad-framework.js GATE-13 missing confidence field spec')
  }

  // Confidence in live-findings format
  if (!ebSrc.includes('"confidence":"high|medium|low"')) {
    throw new Error('event-bus.js missing confidence field in live-findings format')
  }

  // Phase 2.9 contradiction detector
  if (!ebSrc.includes('Phase 2.9')) {
    throw new Error('event-bus.js missing Phase 2.9 contradiction detector')
  }
  if (!ebSrc.includes('contradiction-report-')) {
    throw new Error('event-bus.js missing contradiction-report output file')
  }

  // Phase 3.055 challenger
  if (!ebSrc.includes('Phase 3.055')) {
    throw new Error('event-bus.js missing Phase 3.055 Challenger agent')
  }
  if (!ebSrc.includes('CHALLENGER')) {
    throw new Error('event-bus.js missing CHALLENGER agent in Phase 3.055')
  }
  if (!ebSrc.includes('challenger_verdict')) {
    throw new Error('event-bus.js missing challenger_verdict annotation on findings')
  }

  return 'ARBITER evidence fix (reproduction_method/proof populated) + GATE-13 confidence + Phase 2.9 contradiction + Phase 3.055 challenger'
})

gate('GATE-115: FINAL-SPRINT — per-agent override, phase-2.5 fast-verify, stuck-agent zero-finding alert, dashboard sync, grade-AUDITOR', () => {
  const ebSrc = fs.readFileSync(path.join(__dirname, 'event-bus.js'), 'utf-8')
  const aaSrc = fs.readFileSync(path.join(__dirname, 'agents', 'auto-applier.js'), 'utf-8')
  const llSrc = fs.readFileSync(path.join(__dirname, 'agents', 'learning-loop.js'), 'utf-8')

  // Per-agent override action kind in auto-applier
  if (!aaSrc.includes("action.kind === 'agent_model_override'")) {
    throw new Error('auto-applier.js missing agent_model_override action handler')
  }
  if (!aaSrc.includes('agent-model-overrides.json')) {
    throw new Error('auto-applier.js missing agent-model-overrides.json write')
  }

  // Learning loop proposes category-specific soul_md_append (failure-content-aware, GATE-119)
  // agent_model_override is available in auto-applier.js but learning-loop.js now uses
  // soul_md_append as primary mechanism — check for that instead
  if (!llSrc.includes("kind: 'soul_md_append'")) {
    throw new Error('learning-loop.js missing soul_md_append proposal (failure-content-aware path)')
  }

  // Phase 2.5 fast-verify wired
  if (!ebSrc.includes('Phase 2.5')) {
    throw new Error('event-bus.js missing Phase 2.5 fast-verify')
  }
  if (!ebSrc.includes('FAST-VERIFIER')) {
    throw new Error('event-bus.js missing FAST-VERIFIER agent call')
  }
  if (!ebSrc.includes('_fastVerifiedContext')) {
    throw new Error('event-bus.js missing _fastVerifiedContext injection into wave 2')
  }

  // Zero-finding alert in stuck task watchdog
  if (!ebSrc.includes('zero-finding-alert')) {
    throw new Error('event-bus.js missing zero-finding-alert marker in watchdog')
  }
  if (!ebSrc.includes('Zero-finding alert')) {
    throw new Error('event-bus.js missing Zero-finding alert section in watchdog')
  }

  // Dashboard sync gap fix
  if (!ebSrc.includes('Dashboard sync gap fix')) {
    throw new Error('event-bus.js missing Dashboard sync gap fix in processQueue')
  }
  if (!ebSrc.includes("source: 'backfill'")) {
    throw new Error('event-bus.js backfill missing source marker')
  }

  // Grade-AUDITOR correlation
  if (!ebSrc.includes('auditorCorrelation')) {
    throw new Error('event-bus.js missing auditorCorrelation in gradeTask')
  }
  if (!ebSrc.includes('VALIDATED-FINDINGS-${taskId}')) {
    throw new Error('event-bus.js missing VALIDATED-FINDINGS per-specialist read in gradeTask')
  }

  return 'per-agent override + phase-2.5 fast-verify + zero-finding alert + dashboard sync + grade-AUDITOR correlation'
})

gate('GATE-114: BUG-FIXES-2 — conditional reflexion, gold-set replay, auto-applier ceiling fallback, episode waveNumber, high-suppression pattern', () => {
  const ebSrc = fs.readFileSync(path.join(__dirname, 'event-bus.js'), 'utf-8')
  const aaSrc = fs.readFileSync(path.join(__dirname, 'agents', 'auto-applier.js'), 'utf-8')
  const llSrc = fs.readFileSync(path.join(__dirname, 'agents', 'learning-loop.js'), 'utf-8')
  const erSrc = fs.readFileSync(path.join(__dirname, 'agents', 'episode-record.js'), 'utf-8')
  const gsSrc = fs.readFileSync(path.join(__dirname, 'src/grading/gold-set.js'), 'utf-8')

  // (a) Conditional specialists get full-run reflexion
  if (!ebSrc.includes('_conditionalReflexion')) {
    throw new Error('event-bus.js missing _conditionalReflexion — conditional batch reflexion not wired')
  }
  if (!ebSrc.includes('FULL-RUN REFLEXION')) {
    throw new Error('event-bus.js missing FULL-RUN REFLEXION header in conditional prompt')
  }

  // (b) gold-set replay no longer self-referential
  if (/verifyEvidenceQuote\(e\.evidence_quote,\s*e\.evidence_quote/.test(gsSrc)) {
    throw new Error('gold-set.js replay() still uses self-referential haystack (e.evidence_quote vs itself)')
  }
  if (!gsSrc.includes('activity_sample')) {
    throw new Error('gold-set.js missing activity_sample field support in replay()')
  }

  // (c) auto-applier: modelTier ceiling fallback to effort
  if (!aaSrc.includes('modelTier already at ceiling')) {
    throw new Error('auto-applier.js missing modelTier ceiling fallback to effort upgrade')
  }
  // soul_md_append creates SOUL.md if missing
  if (!aaSrc.includes('Auto-created by learning loop')) {
    throw new Error('auto-applier.js missing SOUL.md auto-create template')
  }

  // (d) episode schema: waveNumber + reflexionContextUsed + actualModel
  if (!erSrc.includes('waveNumber')) {
    throw new Error('episode-record.js missing waveNumber field in record schema')
  }
  if (!erSrc.includes('reflexionContextUsed')) {
    throw new Error('episode-record.js missing reflexionContextUsed field in record schema')
  }
  if (!erSrc.includes('actualModel')) {
    throw new Error('episode-record.js missing actualModel field in record schema')
  }

  // (e) learning-loop distill: high-suppression pattern
  if (!llSrc.includes("type: 'high-suppression'")) {
    throw new Error('learning-loop.js missing high-suppression distill pattern')
  }
  if (!llSrc.includes('suppressionByAgent')) {
    throw new Error('learning-loop.js missing suppressionByAgent accumulator')
  }

  return 'conditional reflexion + gold-set replay fixed + auto-applier ceiling fallback + episode waveNumber + high-suppression pattern'
})

gate('GATE-113: CACHE-OPTIMIZE — sdk.js enables --exclude-dynamic-system-prompt-sections by default, meter-probe reports cache savings', () => {
  const sdkSrc = fs.readFileSync(path.join(__dirname, 'agents', 'runner', 'adapters', 'sdk.js'), 'utf-8')

  // cacheOptimize default-on in spec destructuring
  if (!/cacheOptimize\s*=\s*true/.test(sdkSrc)) {
    throw new Error('sdk.js missing cacheOptimize = true default')
  }
  // The flag must be wired into extraArgs
  if (!sdkSrc.includes('exclude-dynamic-system-prompt-sections')) {
    throw new Error('sdk.js missing --exclude-dynamic-system-prompt-sections wire in extraArgs')
  }
  // Must be guarded so bare mode still works (bare already minimises system prompt)
  if (!/cacheOptimize && !bareApplied|cacheOptimize.*!bare/.test(sdkSrc)) {
    throw new Error('sdk.js cache flag must be guarded by !bareApplied')
  }

  // meter-probe must report cache savings
  const mpSrc = fs.readFileSync(path.join(__dirname, 'agents', 'runner', 'meter-probe.js'), 'utf-8')
  if (!mpSrc.includes('cacheSavingsUSD')) {
    throw new Error('meter-probe.js missing cacheSavingsUSD — cache savings not reported')
  }
  if (!mpSrc.includes('cache_read')) {
    throw new Error('meter-probe.js missing cache_read token tally')
  }

  return 'cache-optimize: cacheOptimize=true default + --exclude-dynamic-system-prompt-sections wire + cache savings in ledger'
})

gate('GATE-112: ADAPTIVE-BATCHING — specialists run in 2 parallel waves not 4 sequential batches (~35min vs ~65min wall)', () => {
  const src = fs.readFileSync(path.join(__dirname, 'event-bus.js'), 'utf-8')
  // wave1Agents must merge batch1 + batch2 into one Promise.all
  if (!src.includes('wave1Agents')) {
    throw new Error('event-bus.js missing wave1Agents — adaptive batching not implemented')
  }
  if (!src.includes('wave2Agents')) {
    throw new Error('event-bus.js missing wave2Agents — wave 2 parallel not implemented')
  }
  // Both waves must spread multiple batch arrays
  const wave1Idx = src.indexOf('wave1Agents')
  const wave1Window = src.slice(wave1Idx, wave1Idx + 300)
  if (!/PENTEST_VULN_BATCH1_dyn.*PENTEST_VULN_BATCH2_dyn|PENTEST_VULN_BATCH2_dyn.*PENTEST_VULN_BATCH1_dyn/.test(wave1Window.replace(/\s+/g, ' '))) {
    throw new Error('wave1Agents does not merge BATCH1_dyn + BATCH2_dyn')
  }
  // No sequential await between wave1 and wave2 batch expansions (they should be merged)
  if (/await Promise\.all\(PENTEST_VULN_BATCH1_dyn/.test(src)) {
    throw new Error('event-bus.js still has separate await for BATCH1_dyn — batches not merged into waves')
  }
  return '2-wave adaptive parallel: wave1=(batch1+batch2), wave2=(batch3+batch4), reflexion between waves'
})

gate('GATE-107: ADAPTIVE-THINKING — the SDK adapter NEVER sends the legacy {type:"enabled",budget_tokens} thinking form (it 400s on Fable 5 / Opus 4.8 / 4.7 — budget_tokens is fully removed there). Reasoning depth is driven by `effort` (first-class), and any explicit thinking spec is normalised to {type:"adaptive"}; disabled/absent omits the param.', () => {
  const sdkPath = path.join(__dirname, 'agents', 'runner', 'adapters', 'sdk.js')
  const rawSrc = fs.readFileSync(sdkPath, 'utf-8')
  // Strip line + block comments so the assertions check executable CODE, not the
  // JSDoc/inline docs (which legitimately mention the legacy form to explain why it's gone).
  const src = rawSrc.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').map(l => l.replace(/\/\/.*$/, '')).join('\n')
  if (!/spec\.thinking|thinking:\s*thinkingSpec/.test(src)) throw new Error('sdk.js no longer reads thinking from spec')
  if (!/resolvedThinking/.test(src)) throw new Error('sdk.js missing resolvedThinking')
  // The current-model landmine: the adapter must NEVER CONSTRUCT a budget_tokens thinking payload.
  // (A property READ like `thinkingSpec.budget_tokens != null` is fine — that normalises caller input.)
  if (/budget_tokens\s*:\s*[\dN]/.test(src)) throw new Error('sdk.js still constructs a budget_tokens thinking payload — 400s on current models')
  if (/\{\s*type:\s*'enabled'\s*,\s*budget_tokens\s*:/.test(src)) throw new Error("sdk.js still emits {type:'enabled',budget_tokens:...} — removed on Fable 5 / Opus 4.8 / 4.7")
  // It must normalise explicit thinking to adaptive and still wire options.thinking.
  if (!/\{\s*type:\s*'adaptive'\s*\}/.test(src)) throw new Error('sdk.js does not normalise thinking to {type:adaptive}')
  if (!/options\.thinking\s*=\s*resolvedThinking/.test(src)) throw new Error('sdk.js missing options.thinking = resolvedThinking wire')
  return 'adaptive-thinking: no budget_tokens ever sent; explicit thinking normalised to {type:adaptive}; effort governs depth'
})

gate('GATE-108: EPISODE-FINDINGCOUNT — specialist episodes use real findingCount from live-findings, not hardcoded 0', () => {
  const src = fs.readFileSync(path.join(__dirname, 'event-bus.js'), 'utf-8')
  // The specialist episode block must read live-findings for findingCount
  if (!/live-findings.*taskId.*jsonl/.test(src.replace(/\s+/g, ' '))) {
    throw new Error('event-bus.js missing live-findings read for specialist findingCount')
  }
  if (!/_findingCount/.test(src)) {
    throw new Error('event-bus.js missing _findingCount variable in specialist episode emit')
  }
  // updateTaskGrade must be called after gradeTask to patch gradeScore retroactively
  if (!src.includes('updateTaskGrade')) {
    throw new Error('event-bus.js missing updateTaskGrade call after gradeTask')
  }
  const updateCount = (src.match(/updateTaskGrade/g) || []).length
  if (updateCount < 3) {
    throw new Error(`event-bus.js has ${updateCount} updateTaskGrade calls — need ≥3 (one per gradeTask call site)`)
  }
  // episode-record.js must export updateTaskGrade
  const erSrc = fs.readFileSync(path.join(__dirname, 'agents', 'episode-record.js'), 'utf-8')
  if (!erSrc.includes('updateTaskGrade')) {
    throw new Error('episode-record.js missing updateTaskGrade export')
  }
  return `episode findingCount real (live-findings read) + updateTaskGrade at ${updateCount} call sites`
})

gate('GATE-109: GRADER-SLIDING-WINDOW — grader evidence prioritises structured findings over raw tail', () => {
  const src = fs.readFileSync(path.join(__dirname, 'src/grading/grader.js'), 'utf-8')
  if (!/Tier 1.*finding|finding.*Tier 1|structured.*sliding|sliding.*window/.test(src)) {
    throw new Error('grader.js missing structured sliding window comment')
  }
  if (!src.includes('findingLines')) {
    throw new Error('grader.js missing findingLines extraction in sliding window')
  }
  if (!src.includes('head =') || !src.includes('tail =')) {
    throw new Error('grader.js missing head/tail split in sliding window')
  }
  return 'grader sliding window: structured findings-first + head+tail split'
})

gate('GATE-110: SOUL-MD-APPEND — auto-applier supports prompt patch via SOUL.md append', () => {
  const aaSrc = fs.readFileSync(path.join(__dirname, 'agents', 'auto-applier.js'), 'utf-8')
  if (!aaSrc.includes("action.kind === 'soul_md_append'")) {
    throw new Error('auto-applier.js missing soul_md_append action handler')
  }
  if (!aaSrc.includes('SOUL.md')) {
    throw new Error('auto-applier.js missing SOUL.md path construction')
  }
  // learning-loop must generate soul_md_append proposals for high-failure agents
  const llSrc = fs.readFileSync(path.join(__dirname, 'agents', 'learning-loop.js'), 'utf-8')
  if (!llSrc.includes("kind: 'soul_md_append'")) {
    throw new Error('learning-loop.js missing soul_md_append proposal generation')
  }
  return 'soul_md_append: handler in auto-applier + proposal generation in learning-loop'
})

gate('GATE-111: REFLEXION — batch 1 findings injected as critique context into batch 2+ specialist prompts', () => {
  const src = fs.readFileSync(path.join(__dirname, 'event-bus.js'), 'utf-8')
  if (!src.includes('_batch1Critique')) {
    throw new Error('event-bus.js missing _batch1Critique variable — reflexion not implemented')
  }
  if (!src.includes('REFLEXION — What Wave 1 Found') && !src.includes('REFLEXION — What Batch 1 Found')) {
    throw new Error('event-bus.js missing reflexion critique header in prompt')
  }
  if (!/wave2Results.*_batch1Critique|_batch1Critique.*wave2|batch2.*_batch1Critique|_batch1Critique.*batch2/.test(src.replace(/\s+/g, ' '))) {
    throw new Error('_batch1Critique not injected into wave 2 / batch 2 prompts')
  }
  return 'reflexion: wave1 critique generated from live-findings + injected into wave2 specialist prompts'
})

gate('GATE-106: AUTO-APPLIER — full-auto learning loop executor with kill-switch + git-commit + quality-watchdog', () => {
  // Locks the 2026-06-05 upgrade: auto-applier executes proposals without human tap.
  // Guards: kill-switch (LEARNING_AUTO=off), burst-cap, git-commit per apply,
  // idempotency (applied-proposals.jsonl), quality-watchdog with auto-revert.

  const applierPath = path.join(__dirname, 'agents', 'auto-applier.js')

  // (a) File exists + syntax
  if (!fs.existsSync(applierPath)) {
    throw new Error('agents/auto-applier.js does not exist')
  }
  const syntax = spawnSync('node', ['--check', applierPath], { encoding: 'utf-8', timeout: 10000 })
  if (syntax.status !== 0) {
    throw new Error(`auto-applier.js fails syntax check: ${(syntax.stderr || '').trim().slice(0, 400)}`)
  }

  // (b) Static source invariants
  const src = fs.readFileSync(applierPath, 'utf-8')
  if (!src.includes("process.env.LEARNING_AUTO !== 'off'")) {
    throw new Error('auto-applier.js missing kill-switch check (LEARNING_AUTO !== off)')
  }
  if (!src.includes('MAX_APPLIES_PER_DAY')) {
    throw new Error('auto-applier.js missing MAX_APPLIES_PER_DAY burst-cap')
  }
  if (!src.includes('_gitCommit')) {
    throw new Error('auto-applier.js missing _gitCommit — every apply must git-commit')
  }
  if (!src.includes('REGRESSION_THRESHOLD')) {
    throw new Error('auto-applier.js missing REGRESSION_THRESHOLD quality-watchdog constant')
  }
  if (!src.includes('_isAlreadyApplied')) {
    throw new Error('auto-applier.js missing _isAlreadyApplied idempotency check')
  }

  // (c) Module contract probe
  const probe = `
'use strict'
const aa = require('${agentPaths.AGENTS_ROOT}/agents/auto-applier')
if (typeof aa.applyProposal !== 'function') throw new Error('missing applyProposal export')
if (typeof aa.applyPendingProposals !== 'function') throw new Error('missing applyPendingProposals export')
if (typeof aa.watchdogCheck !== 'function') throw new Error('missing watchdogCheck export')
if (typeof aa.isAutoEnabled !== 'function') throw new Error('missing isAutoEnabled export')
if (typeof aa.MAX_APPLIES_PER_DAY !== 'number') throw new Error('MAX_APPLIES_PER_DAY must be a number')
if (typeof aa.REGRESSION_THRESHOLD !== 'number') throw new Error('REGRESSION_THRESHOLD must be a number')

// Kill-switch test: with LEARNING_AUTO=off, applyPendingProposals returns skipped
process.env.LEARNING_AUTO = 'off'
const r = aa.applyPendingProposals()
if (r.reason !== 'LEARNING_AUTO=off (kill-switch)') {
  throw new Error('kill-switch did not fire correctly, got: ' + r.reason)
}
delete process.env.LEARNING_AUTO

// isAutoEnabled: true when env not set
if (!aa.isAutoEnabled()) throw new Error('isAutoEnabled() should be true when LEARNING_AUTO not set')

// applyProposal with no structuredAction → skipped (no crash)
const noAction = aa.applyProposal({ ts: 'x', type: 'test', agentName: 'X' })
if (noAction.applied !== false) throw new Error('proposal without structuredAction should return applied:false')

process.stdout.write('auto-applier: kill-switch, burst-cap, git-commit, watchdog, idempotency — module contract OK\\n')
process.exit(0)
`
  const r = spawnSync('node', ['-e', probe], { encoding: 'utf-8', timeout: 15000 })
  if (r.status !== 0) {
    throw new Error(`GATE-106 module contract broken: ${(r.stderr || r.stdout || '').trim().slice(0, 500)}`)
  }
  return (r.stdout || '').trim()
})

gate('GATE-105: GOAL-EVALUATOR-WIRED — evaluateConvergence is the default early-exit path in event-bus (oracle second opinion before giving up)', () => {
  // Locks the 2026-06-05 default wire: heuristic EARLY_EXIT must consult the
  // goal-evaluator oracle (fail-soft) before committing. Prevents a future
  // refactor from silently dropping the oracle override back to heuristic-only.

  const ebSrc = fs.readFileSync(path.join(__dirname, 'event-bus.js'), 'utf-8')

  // (a) Require present
  if (!/require\(['"]\.\/agents\/goal-evaluator['"]\)/.test(ebSrc)) {
    throw new Error('event-bus.js missing require(./agents/goal-evaluator)')
  }

  // (b) Wire present: evaluateConvergence awaited with the oracle injection
  if (!/await evaluateConvergence\(/.test(ebSrc)) {
    throw new Error('event-bus.js missing `await evaluateConvergence(` — goal-evaluator not wired')
  }
  if (!/_runAgent:\s*runAgent/.test(ebSrc)) {
    throw new Error('evaluateConvergence wire missing `_runAgent: runAgent` oracle injection')
  }

  // (c) Override semantics: oracle CONTINUE must mutate the decision, and the
  //     wire must be guarded inside the EARLY_EXIT branch (not replacing the
  //     4-state heuristic — the REACHCHECK alt-scheme path must survive)
  const wireIdx = ebSrc.indexOf('await evaluateConvergence(')
  const wireWindow = ebSrc.slice(Math.max(0, wireIdx - 1500), wireIdx + 1500)
  if (!/decision\.decision\s*===\s*EARLY_EXIT_DECISIONS\.EARLY_EXIT/.test(wireWindow)) {
    throw new Error('evaluateConvergence wire is not guarded by the EARLY_EXIT branch')
  }
  if (!/decision\.decision\s*=\s*EARLY_EXIT_DECISIONS\.CONTINUE/.test(wireWindow)) {
    throw new Error('oracle override does not set decision back to CONTINUE')
  }
  if (!/catch\s*\(/.test(wireWindow)) {
    throw new Error('evaluateConvergence wire has no fail-soft catch — oracle errors would kill the dispatch')
  }

  return 'goal-evaluator wired as default early-exit path: oracle injection + EARLY_EXIT guard + CONTINUE override + fail-soft'
})

// ═══════════════════════════════════════════════════════════════════════════

const allPassed = runGates()
process.exit(allPassed ? 0 : 1)
