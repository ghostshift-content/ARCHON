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
function stubDeps(spawnCalls, emitted = []) {
  return {
    spawnAgent: async (agentName, taskId, prompt, sessionSuffix) => {
      spawnCalls.push({ agentName, sessionSuffix, promptLen: prompt.length })
      if (sessionSuffix && sessionSuffix.includes('discovery')) {
        return { code: 0, agentName, cost: { totalCost: 0.1, model: 'm', tokens: { total: 1 } },
          output: JSON.stringify([{ slug: 'auth', name: 'Auth', keywords: 'login,token' }, { slug: 'uploads', name: 'Uploads', keywords: 'upload,file' }]) }
      }
      // A real batch mapper writes one feature map per assigned feature; simulate it so the pipeline's
      // "map produced → assess" gate opens (else features stay 'blocked' and nothing is assessed). Pull
      // outDir + the batch's slugs out of the prompt.
      if (sessionSuffix && sessionSuffix.includes('-batch-')) {
        const dirM = prompt.match(/(\S+)\/phase1-maps\/features\//)
        const slugs = [...prompt.matchAll(/slug:\s*([a-z0-9_-]+)/gi)].map(m => m[1])
        if (dirM) for (const slug of slugs) {
          try { fs.mkdirSync(`${dirM[1]}/phase1-maps/features`, { recursive: true }); fs.writeFileSync(`${dirM[1]}/phase1-maps/features/${slug}.md`, `# ${slug}\nfast map`) } catch {}
        }
      }
      // M6: a persistent review session (suffix -p2rev-, also legacy -p2-/-p2r-) works MANY jobs in one call
      // and writes one candidate JSONL PER job. Simulate that: write a candidate for EVERY candidate-file path
      // listed in the prompt (parse feature/class from the path), so per-job streaming is exercised.
      if (sessionSuffix && /-p2rev-|-p2r-|-p2-/.test(sessionSuffix)) {
        for (const m of prompt.matchAll(/(\S+\/phase2\/([^/\s]+)\/([^/\s]+)\.candidates\.jsonl)/g)) {
          const [, cf, cls, slug] = m
          try {
            fs.mkdirSync(path.dirname(cf), { recursive: true })
            fs.writeFileSync(cf, JSON.stringify({ feature: slug, pattern: 'idor', file: 'app.rb', line: 2,
              source: 'params[:id]', sink: 'User.find', severity: 'High', confidence: 80,
              hypothesis: 'IDOR on user object', evidence: 'User.find(params[:id])',
              status: 'SOURCE_CONFIRMED', required_blackbox_proof: '', cls }) + '\n')
          } catch {}
        }
      }
      return { code: 0, agentName, cost: { totalCost: 0.2, model: 'm', tokens: { total: 1 } }, output: '{}' }
    },
    trackCosts: () => {}, updateProgress: () => {}, log: () => {}, logActivity: () => {},
    emitCandidate: (tid, rec) => { emitted.push(rec) },
  }
}

;(async () => {
  console.log('code-review-dispatcher integration (phase1-maps methodology):')

  // ── Test 1: explicit features, no deployUrl ──
  {
    const srcDir = makeSourceDir()
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crout-'))
    const calls = []
    const emitted = []
    const res = await cr.runCodeReview(
      { taskId: 'cr-test-1', squad: 'code-review-squad', projectId: '',
        meta: { sourceDir: srcDir, features: ['auth', 'uploads', 'admin'],
                vulnClasses: ['access-control', 'xss'], maxPhase2: 2, outputDir: outDir } },
      stubDeps(calls, emitted))

    ok('returns no error', !res.error, JSON.stringify(res).slice(0, 120))
    ok('stack label present (auto-detected)', typeof res.stack === 'string' && res.stack.length > 0, 'got ' + res.stack)
    ok('3 features mapped', res.featuresMapped === 3, 'got ' + res.featuresMapped)
    ok('inventories written to disk', fs.existsSync(path.join(outDir, 'phase1-maps/inventories/00_MANIFEST.md')))
    ok('phase2 class dirs created', fs.existsSync(path.join(outDir, 'phase2/access-control')) && fs.existsSync(path.join(outDir, 'phase2/xss')))
    // M3: the Source Runtime Planner wrote a plan artifact with an honest session decision
    ok('M3: source-runtime-plan.json written', fs.existsSync(path.join(outDir, 'source-runtime-plan.json')))
    try {
      const plan = JSON.parse(fs.readFileSync(path.join(outDir, 'source-runtime-plan.json'), 'utf8'))
      ok('M3: plan has a session decision + reason', plan.mapping_sessions >= 1 && plan.max_concurrent_sessions >= 1 && typeof plan.reason === 'string' && plan.mode === 'static',
        `sessions=${plan.mapping_sessions} concurrent=${plan.max_concurrent_sessions} mode=${plan.mode}`)
    } catch (e) { ok('M3: plan readable', false, e.message) }

    const mapCalls = calls.filter(c => c.sessionSuffix.includes('-batch-'))
    ok('S3: mapping runs in domain BATCHES (≤ features), not one-per-feature', mapCalls.length >= 1 && mapCalls.length <= 3, 'got ' + mapCalls.length)
    ok('mapping batches owned by specialist-pool agents', mapCalls.length > 0 && mapCalls.every(c => cr.MAPPER_POOL.includes(c.agentName)))
    ok('CURATOR consolidates', calls.some(c => c.sessionSuffix.includes('consolidate') && c.agentName === 'curator'))

    const p2 = calls.filter(c => c.sessionSuffix.includes('-p2rev-'))
    // M6: review runs as PERSISTENT specialist sessions (one per agent), NOT one spawn per (feature×class).
    ok('M6: phase2 runs as persistent specialist sessions (2 agents), not per-job', p2.length === 2, 'got ' + p2.length)
    const rq = fs.readFileSync(path.join(outDir, 'phase2-review-queue.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l))
    ok('M6: review queue has maxPhase2(2) × classes(2) = 4 jobs', rq.length === 4, 'got ' + rq.length)
    // S4 — per-batch pipeline: Phase 2 runs only AFTER mapping, so review starts after the first fast-map.
    {
      const firstBatch = calls.findIndex(c => c.sessionSuffix.includes('-batch-'))
      const firstP2 = calls.findIndex(c => c.sessionSuffix.includes('-p2rev-'))
      ok('S4: Phase 2 starts only after a batch has fast-mapped', firstBatch >= 0 && firstP2 > firstBatch, `batch@${firstBatch} p2@${firstP2}`)
    }
    // M0 — each Phase-2 job streams a structured source candidate to the board via emitCandidate.
    ok('M0: each p2 job streamed a candidate → emitCandidate called 4×', emitted.length === 4, 'got ' + emitted.length)
    ok('M0: candidates are source-shaped (type=candidate, NO url)',
      emitted.length > 0 && emitted.every(c => c.type === 'candidate' && !c.url),
      JSON.stringify(emitted[0] || {}).slice(0, 160))
    // P1 — the file path is normalized to ABSOLUTE against sourceDir (so the triager reads the right
    // file), while file_rel keeps the specialist's original relative path.
    ok('P1: candidate file is absolute (resolved vs sourceDir), file_rel keeps the relative',
      emitted.length > 0 && emitted.every(c => path.isAbsolute(c.file) && c.file === path.resolve(srcDir, 'app.rb') && c.file_rel === 'app.rb'),
      JSON.stringify(emitted[0] || {}).slice(0, 200))
    ok('M0: source candidate stays SOURCE_CONFIRMED (never RUNTIME_CONFIRMED)',
      emitted.length > 0 && emitted.every(c => c.status === 'SOURCE_CONFIRMED' && c.confirmation_status === 'SOURCE_CONFIRMED'),
      JSON.stringify(emitted[0] || {}).slice(0, 160))
    // M3 — with every (feature × selected-class) pair assessed, re-plan is correctly a no-op (no -p2r- jobs).
    ok('M3: no spurious re-plan when coverage is complete', !calls.some(c => c.sessionSuffix.includes('-p2r-')), 'unexpected re-plan spawn')
    ok('access-control routed to MARSHAL', rq.some(j => j.cls === 'access-control' && j.agent === 'marshal') && p2.some(c => c.agentName === 'marshal'))
    ok('xss routed to CIPHER', rq.some(j => j.cls === 'xss' && j.agent === 'cipher') && p2.some(c => c.agentName === 'cipher'))
    ok('AUDITOR verifies', calls.some(c => c.agentName === 'auditor'))
    ok('PROBER skipped (no deployUrl)', !calls.some(c => c.agentName === 'prober'))
    ok('SCRIBE reports last', calls[calls.length - 1].agentName === 'scribe')
  }

  // ── S3: batchMapPrompt scopes an agent to ONLY its batch's features (spec §7/§14) ──
  {
    const batch = { id: 'auth_identity-1', domain: 'auth_identity', risk: 'high', owner: 'marshal',
      features: [{ slug: 'login', name: 'Login' }, { slug: 'reset', name: 'Reset' }] }
    const p = cr.batchMapPrompt('marshal', batch, 't1', '/src', '/out', '/inv')
    ok('S3: batch prompt names each assigned feature', p.includes('login') && p.includes('reset'))
    ok('S3: batch prompt excludes non-batch features', !p.includes('admin-panel'))
    ok('S3: batch prompt enforces map-ONLY-your-batch + followup channel',
      /Map ONLY these 2 features/.test(p) && p.includes('followup-features.jsonl'))
  }

  // ── S5: selective deep mapping — high-risk batch features are deep-mapped; low-risk stay fast ──
  {
    const srcDir = makeSourceDir()
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crout-'))
    const calls = []
    await cr.runCodeReview(
      { taskId: 'cr-s5', squad: 'code-review-squad', projectId: '',
        meta: { sourceDir: srcDir, vulnClasses: ['xss'], outputDir: outDir,
          features: [
            { slug: 'login', name: 'Login', domain: 'auth_identity', risk_hint: 'high', keywords: 'auth,session' },
            { slug: 'blog', name: 'Blog', domain: 'misc', risk_hint: 'low', keywords: 'content,article' },
          ] } },
      stubDeps(calls))
    const deep = calls.filter(c => c.sessionSuffix.includes('-deep-'))
    ok('S5: high-risk feature IS deep-mapped', deep.some(c => c.sessionSuffix.includes('-deep-login')), deep.map(c => c.sessionSuffix).join(','))
    ok('S5: low-risk feature is NOT deep-mapped (selective §10)', !deep.some(c => c.sessionSuffix.includes('-deep-blog')))
    try {
      const led = JSON.parse(fs.readFileSync(path.join(outDir, 'phase1-maps', 'mapping-ledger.json'), 'utf8'))
      ok('S5: ledger depth = deep_complete (high-risk) vs fast (low-risk)',
        led.features.login.depth === 'deep_complete' && led.features.blog.depth === 'fast',
        `login=${led.features.login && led.features.login.depth} blog=${led.features.blog && led.features.blog.depth}`)
    } catch (e) { ok('S5: ledger readable', false, e.message) }
    fs.rmSync(srcDir, { recursive: true, force: true }); fs.rmSync(outDir, { recursive: true, force: true })
  }

  // ── S6: a follow-up a mapper writes gets reconciled — mapped + assessed in a reconcile round ──
  {
    const srcDir = makeSourceDir()
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crout-'))
    const calls = []
    let wroteFollowup = false
    const deps = {
      spawnAgent: async (agentName, taskId, prompt, sessionSuffix) => {
        calls.push({ agentName, sessionSuffix })
        if (sessionSuffix && sessionSuffix.includes('-batch')) {
          const dirM = prompt.match(/(\S+)\/phase1-maps\/features\//)
          const slugs = [...prompt.matchAll(/slug:\s*([a-z0-9_-]+)/gi)].map(m => m[1])
          if (dirM) {
            for (const slug of slugs) { try { fs.mkdirSync(`${dirM[1]}/phase1-maps/features`, { recursive: true }); fs.writeFileSync(`${dirM[1]}/phase1-maps/features/${slug}.md`, `# ${slug}`) } catch {} }
            // on the FIRST original batch (not a reconcile round), the mapper discovers a related feature
            if (!wroteFollowup && !sessionSuffix.includes('batchR')) {
              wroteFollowup = true
              try { fs.appendFileSync(`${dirM[1]}/phase1-maps/followup-features.jsonl`, JSON.stringify({ slug: 'oauth-callback', name: 'OAuth Callback', domain: 'auth_identity', risk_hint: 'high', keywords: 'oauth' }) + '\n') } catch {}
            }
          }
        }
        return { code: 0, agentName, cost: { totalCost: 0, model: 'm', tokens: { total: 1 } }, output: '{}' }
      },
      trackCosts: () => {}, updateProgress: () => {}, log: () => {}, logActivity: () => {},
    }
    const res = await cr.runCodeReview({ taskId: 'cr-s6', squad: 'code-review-squad', projectId: '',
      meta: { sourceDir: srcDir, vulnClasses: ['xss'], outputDir: outDir, features: [{ slug: 'login', name: 'Login', domain: 'auth_identity', risk_hint: 'high', keywords: 'auth' }] } }, deps)
    ok('A1: featuresMapped is ledger-derived — counts the follow-up feature (2, not the original 1)', res.featuresMapped === 2, 'got ' + res.featuresMapped)
    ok('A2: deterministic gate written to consolidated/ (the path SCRIBE reads)', fs.existsSync(path.join(outDir, 'phase1-maps', 'consolidated', 'phase1_completion_gate.md')))
    ok('S6: the followup was mapped in a reconcile round + queued for review (M6 review queue)',
      calls.some(c => c.sessionSuffix.includes('batchR1')) &&
      fs.readFileSync(path.join(outDir, 'phase2-review-queue.jsonl'), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)).some(j => j.feature === 'oauth-callback' && j.cls === 'xss'),
      calls.map(c => c.sessionSuffix).filter(s => /batchR|p2rev/.test(s)).join(','))
    try {
      const led = JSON.parse(fs.readFileSync(path.join(outDir, 'phase1-maps', 'mapping-ledger.json'), 'utf8'))
      ok('S6: ledger accounts for the reconciled feature', led.features['oauth-callback'] && led.features['oauth-callback'].status === 'done')
      ok('S6: completion gate — every feature terminal',
        Object.values(led.features).every(f => ['done', 'deep_complete', 'merged', 'duplicate', 'non_security', 'dead_code', 'blocked'].includes(f.status)))
      ok('S7: deterministic completion-gate.md written from the ledger',
        fs.existsSync(path.join(outDir, 'phase1-maps', 'completion-gate.md')))
    } catch (e) { ok('S6: ledger readable', false, e.message) }
    fs.rmSync(srcDir, { recursive: true, force: true }); fs.rmSync(outDir, { recursive: true, force: true })
  }

  // ── A4: fail-forward — one mapper crashes; the run continues, only its feature is blocked ──
  {
    const srcDir = makeSourceDir()
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crout-'))
    const deps = {
      spawnAgent: async (agentName, taskId, prompt, sessionSuffix) => {
        if (sessionSuffix && sessionSuffix.includes('-batch')) {
          const dirM = prompt.match(/(\S+)\/phase1-maps\/features\//)
          const slugs = [...prompt.matchAll(/slug:\s*([a-z0-9_-]+)/gi)].map(m => m[1])
          // M4: a persistent worker writes each map file AS IT FINISHES that feature, so a mid-shard crash
          // still leaves the healthy features mapped. Write every non-'admin' feature, THEN crash on admin.
          if (dirM) for (const slug of slugs) { if (slug === 'admin') continue; try { fs.mkdirSync(`${dirM[1]}/phase1-maps/features`, { recursive: true }); fs.writeFileSync(`${dirM[1]}/phase1-maps/features/${slug}.md`, `# ${slug}`) } catch {} }
          if (slugs.includes('admin')) throw new Error('mapper crashed on the admin feature') // crashes before writing admin's map
        }
        return { code: 0, agentName, cost: { totalCost: 0, tokens: { total: 0 } }, output: '{}' }
      },
      trackCosts: () => {}, updateProgress: () => {}, log: () => {}, logActivity: () => {},
    }
    let threw = false, res = null
    try {
      res = await cr.runCodeReview({ taskId: 'cr-a4', squad: 'code-review-squad', projectId: '',
        meta: { sourceDir: srcDir, vulnClasses: ['xss'], outputDir: outDir, features: [
          { slug: 'login', name: 'Login', domain: 'auth_identity', risk_hint: 'high', keywords: 'auth' },
          { slug: 'admin', name: 'Admin', domain: 'admin', risk_hint: 'high', keywords: 'admin' },
        ] } }, deps)
    } catch { threw = true }
    ok('A4: a mapper failure does NOT abort the run', !threw && !!res && !res.error)
    try {
      const led = JSON.parse(fs.readFileSync(path.join(outDir, 'phase1-maps', 'mapping-ledger.json'), 'utf8'))
      ok('A4: failed feature → blocked, healthy feature → done (isolated fallout)',
        led.features.admin.status === 'blocked' && led.features.login.status === 'done',
        `admin=${led.features.admin && led.features.admin.status} login=${led.features.login && led.features.login.status}`)
    } catch (e) { ok('A4: ledger readable', false, e.message) }
    fs.rmSync(srcDir, { recursive: true, force: true }); fs.rmSync(outDir, { recursive: true, force: true })
  }

  // ── Test 1b: DEFAULTS map + deep-assess EVERY feature (no caps) ──
  // Guards BOTH silent caps at once with 12 features and NO maxFeatures / maxPhase2:
  //   • old `maxFeatures || 10` floor  → would map only 10   (now: all 12)
  //   • old `maxPhase2  || 6`  cap     → would assess top-6  (now: all 12 → 12×2=24 p2 calls, not 12)
  {
    const srcDir = makeSourceDir()
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crout-'))
    const calls = []
    const twelve = ['auth', 'uploads', 'admin', 'search', 'billing', 'profile', 'api', 'webhooks', 'reports', 'settings', 'notifications', 'exports']
    const res = await cr.runCodeReview(
      { taskId: 'cr-test-1b', squad: 'code-review-squad', projectId: '',
        meta: { sourceDir: srcDir, features: twelve, vulnClasses: ['access-control', 'xss'], outputDir: outDir } }, // NO caps
      stubDeps(calls))
    ok('1b: no error', !res.error, JSON.stringify(res).slice(0, 120))
    ok('1b: DEFAULT maps ALL 12 features (not the old floor-10)', res.featuresMapped === 12, 'got ' + res.featuresMapped)
    // M6: 24 jobs (12×2) are all queued for review, but they run as FEW persistent specialist sessions
    // (one per agent: access-control→MARSHAL, xss→CIPHER = 2), not 24 fresh spawns.
    const rqb = fs.readFileSync(path.join(outDir, 'phase2-review-queue.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l))
    ok('1b: DEFAULT queues ALL 12 features × 2 classes = 24 review jobs (no top-6 cap)', rqb.length === 24, 'got ' + rqb.length)
    const p2b = calls.filter(c => c.sessionSuffix.includes('-p2rev-'))
    ok('1b: M6 runs those 24 jobs as 2 persistent specialist sessions, not 24 spawns', p2b.length === 2, 'got ' + p2b.length)
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
    ok('discovered 2 features → fast-mapped in batches', calls.filter(c => c.sessionSuffix.includes('-batch-')).length >= 1 && calls.filter(c => c.sessionSuffix.includes('-batch-')).length <= 2, 'got ' + calls.filter(c => c.sessionSuffix.includes('-batch-')).length)
  }

  // ── Test 3: an explicit meta.features queue is used verbatim (capped by maxFeatures); phasesOnly gates ──
  {
    const srcDir = makeSourceDir()
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crout-'))
    const calls = []
    const featureList = Array.from({ length: 43 }, (_, i) => ({ slug: `feature-${i}`, name: `Feature ${i}` }))
    const res = await cr.runCodeReview(
      { taskId: 'cr-test-3', squad: 'code-review-squad', projectId: '',
        meta: { sourceDir: srcDir, features: featureList, maxFeatures: 43, phasesOnly: ['inventories'], outputDir: outDir } },
      stubDeps(calls))
    ok('explicit meta.features queue → 43 features', res.featuresMapped === 43, 'got ' + res.featuresMapped)
    ok('phasesOnly=[inventories] → no agents spawned', calls.length === 0, 'got ' + calls.length)
  }

  // ── Test 4: Phase 0 rejects bad sourceDir ──
  {
    const res = await cr.runCodeReview({ taskId: 'cr-test-4', squad: 'code-review-squad', meta: { sourceDir: '/nonexistent-xyz' } }, stubDeps([]))
    ok('Phase 0 rejects missing sourceDir', res.error && res.phase === 0)
  }

  // ── Test 5: selectVulnClasses derives classes from the discovered surface ──
  {
    const all = cr.selectVulnClasses({ '03_graphql': 12, '07_downloads_exports': 4, '02_auth_checks': 30 })
    ok('graphql surface → graphql class', all.includes('graphql'))
    ok('downloads surface → file-handling class', all.includes('file-handling'))
    ok('auth surface → authentication-session class', all.includes('authentication-session'))
    ok('always keeps the access-control floor', all.includes('access-control'))
    ok('every selected class is a known CLASS', all.every(c => cr.CLASS[c]))
    const empty = cr.selectVulnClasses({})
    ok('empty surface still returns the baseline floor', empty.length >= 5 && empty.includes('xss'))
    ok("CLASS covers the complete canonical pattern catalog (26 classes)", Object.keys(cr.CLASS).length === 26)
  }

  // ── Test 6: every CLASS module/catalog file reference resolves on disk (no dangling refs) ──
  {
    const METH = path.join(__dirname, '..', 'squads', 'code-review', 'methodology')
    let dangling = 0
    for (const [cls, c] of Object.entries(cr.CLASS)) {
      if (c.module && !fs.existsSync(path.join(METH, 'prompts', c.module))) { dangling++; console.log(`    missing module for ${cls}: ${c.module}`) }
      if (c.catalog && !fs.existsSync(path.join(METH, 'catalogs', c.catalog))) { dangling++; console.log(`    missing catalog for ${cls}: ${c.catalog}`) }
    }
    ok('every CLASS module/catalog file resolves on disk (no dangling refs)', dangling === 0, `${dangling} dangling ref(s)`)
  }

  console.log(`\n${passed} passed, ${failed} failed`)
  process.exit(failed ? 1 : 0)
})().catch(e => { console.error('THREW:', e.stack); process.exit(1) })
