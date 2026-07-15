'use strict'
// M4: mapping runs as FEW persistent worker sessions (the planner's shard count), each mapping MANY features
// in one call — not one short-lived spawn per feature/small-batch. This is the rate-limit win: fewer, longer
// Claude sessions.
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path')
require('../paths')
const cr = require('../src/dispatch/code-review-dispatcher')

function makeSourceDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'm4src-'))
  fs.writeFileSync(path.join(dir, 'app.rb'), 'get "/x" do\n  1\nend\n')
  return dir
}

test('M4: 90 features across 3 domains map in 3 persistent sessions, each mapping many features', async () => {
  const srcDir = makeSourceDir()
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'm4out-'))
  const domains = ['auth_identity', 'integrations_api', 'files_uploads']
  const features = []
  for (const d of domains) for (let i = 0; i < 30; i++) features.push({ slug: `${d}-${i}`, name: `${d} ${i}`, domain: d, risk_hint: 'medium', keywords: d })

  const mapCallSlugCounts = [] // slugs mapped per INITIAL worker session
  const deps = {
    spawnAgent: async (agentName, taskId, prompt, sessionSuffix) => {
      const isInitial = sessionSuffix && sessionSuffix.includes('-batch-') && !sessionSuffix.includes('-batchR')
      const isMap = isInitial || (sessionSuffix && (sessionSuffix.includes('-defer') || sessionSuffix.includes('-batchR')))
      if (isMap) {
        const dirM = prompt.match(/(\S+)\/phase1-maps\/features\//)
        const slugs = [...prompt.matchAll(/slug:\s*([a-z0-9_-]+)/gi)].map((m) => m[1])
        if (isInitial) mapCallSlugCounts.push(slugs.length)
        if (dirM) for (const s of slugs) { fs.mkdirSync(`${dirM[1]}/phase1-maps/features`, { recursive: true }); fs.writeFileSync(`${dirM[1]}/phase1-maps/features/${s}.md`, `# ${s}`) }
      }
      return { agentName, code: 0, cost: { totalCost: 0, model: 'm', tokens: { total: 1 } }, output: '{}' }
    },
    trackCosts: () => {}, updateProgress: () => {}, log: () => {}, logActivity: () => {},
  }

  const res = await cr.runCodeReview({ taskId: 'm4-workers', squad: 'code-review-squad', projectId: '',
    meta: { sourceDir: srcDir, vulnClasses: ['access-control'], outputDir: outDir, features, deepMap: false } }, deps)

  const plan = JSON.parse(fs.readFileSync(path.join(outDir, 'source-runtime-plan.json'), 'utf8'))
  assert.equal(plan.mapping_sessions, 3, '90 features → 3 sessions (unified §6 ladder: 76-150 → 3)')
  assert.equal(mapCallSlugCounts.length, 3, 'exactly 3 persistent worker sessions ran (not 90 one-per-feature spawns)')
  assert.ok(mapCallSlugCounts.every((n) => n > 1), 'each worker session mapped MANY features, not one')
  assert.equal(mapCallSlugCounts.reduce((a, b) => a + b, 0), 90, 'the three sessions cover all 90 features')
  assert.equal(res.featuresMapped, 90)

  fs.rmSync(srcDir, { recursive: true, force: true }); fs.rmSync(outDir, { recursive: true, force: true })
})

test('idempotent resume: pre-existing feature maps skip the mapper spawn (no re-map, no tokens)', async () => {
  const srcDir = makeSourceDir()
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'reuseout-'))
  const features = ['alpha', 'beta', 'gamma'].map(s => ({ slug: s, name: s, domain: 'misc', risk_hint: 'medium', keywords: s }))
  // simulate a prior scan: every feature's map already exists on disk
  fs.mkdirSync(`${outDir}/phase1-maps/features`, { recursive: true })
  for (const f of features) fs.writeFileSync(`${outDir}/phase1-maps/features/${f.slug}.md`, `# ${f.slug}`)
  let mapSpawns = 0
  const deps = {
    spawnAgent: async (agentName, taskId, prompt, sessionSuffix) => {
      if (sessionSuffix && sessionSuffix.includes('-batch') && !sessionSuffix.includes('-batchR')) mapSpawns++
      return { agentName, code: 0, cost: { totalCost: 0, tokens: { total: 1 } }, output: '{}' }
    },
    trackCosts: () => {}, updateProgress: () => {}, log: () => {}, logActivity: () => {},
  }
  const res = await cr.runCodeReview({ taskId: 'reuse-1', squad: 'code-review-squad', projectId: '',
    meta: { sourceDir: srcDir, vulnClasses: ['xss'], outputDir: outDir, features, phasesOnly: ['mapping'], deepMap: false } }, deps)
  assert.equal(mapSpawns, 0, 'NO mapper session spawned — the on-disk maps were reused')
  assert.equal(res.featuresMapped, 3, 'all three features counted as mapped (reused)')
  fs.rmSync(srcDir, { recursive: true, force: true }); fs.rmSync(outDir, { recursive: true, force: true })
})

test('M4: the mapping prompt is a persistent long-running worker, not a one-feature agent', () => {
  const batch = { id: 'auth_identity-1', domain: 'auth_identity', risk: 'mixed', owner: 'marshal',
    features: [{ slug: 'login', name: 'Login' }, { slug: 'reset', name: 'Reset' }] }
  const p = cr.batchMapPrompt('marshal', batch, 't1', '/src', '/out', '/inv')
  assert.match(p, /long-running worker session/i)
  assert.match(p, /DO NOT stop after the first/i)
  assert.match(p, /NEVER report a feature as done unless its map file actually exists/i)
  assert.match(p, /Map ONLY these 2 features/)
})
