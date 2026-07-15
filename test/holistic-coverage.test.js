'use strict'
// F1/F2: runHolistic returns an explicit status + per-feature coverage (candidate_found only where candidates exist).
const { test } = require('node:test'); const assert = require('node:assert/strict')
const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path')
const H = require('../src/runtime/holistic-review')
function srcDir() { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'hc-')); fs.mkdirSync(path.join(d,'app')); fs.writeFileSync(path.join(d,'app','a.rb'),'x'); return d }

test('F1/F2: completed status + coverage marks candidate_found only where candidates exist', async () => {
  const sd = srcDir(); const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hco-'))
  const deps = {
    spawnAgent: async (agent, taskId, prompt) => { const m = prompt.match(/one per line\) to: (\S+)/); fs.mkdirSync(path.dirname(m[1]), { recursive: true }); fs.writeFileSync(m[1], JSON.stringify({ feature: 'login', vuln_class: 'access-control', file: 'app/a.rb', status: 'SOURCE_CONFIRMED' }) + '\n'); return { code: 0 } },
    log: () => {}, trackCosts: () => {}, emitFromFile: () => 1,
  }
  const features = [{ slug: 'login', domain: 'app' }, { slug: 'search', domain: 'app' }]
  const r = await H.runHolistic(deps, { taskId: 't-hc', sourceDir: sd, features, outDir })
  assert.equal(r.status, 'completed')
  const login = r.coverage.find(c => c.feature === 'login'); const search = r.coverage.find(c => c.feature === 'search')
  assert.equal(login.review_status, 'candidate_found'); assert.equal(login.candidate_count, 1)
  assert.equal(search.review_status, 'reviewed_no_issue', 'no candidate ⇒ reviewed_no_issue, NOT candidate_found')
  assert.ok(r.coverage.every(c => c.depth === 'holistic_complete'))
  fs.rmSync(sd, { recursive: true, force: true }); fs.rmSync(outDir, { recursive: true, force: true })
})
test('§4: a free-form candidate feature name folds onto the canonical slug (coverage attributes correctly)', async () => {
  const sd = srcDir(); const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hcf-'))
  const deps = {
    // the lead invents "files_uploads_path_traversal"; the canonical slug is "file-uploads"
    spawnAgent: async (agent, taskId, prompt) => { const m = prompt.match(/one per line\) to: (\S+)/); fs.mkdirSync(path.dirname(m[1]), { recursive: true }); fs.writeFileSync(m[1], JSON.stringify({ feature: 'files_uploads_path_traversal', vuln_class: 'path-traversal', file: 'app/a.rb', status: 'SOURCE_CONFIRMED' }) + '\n'); return { code: 0 } },
    log: () => {}, trackCosts: () => {}, emitFromFile: () => 1,
  }
  const features = [{ slug: 'file-uploads', domain: 'files_uploads', name: 'File Uploads' }, { slug: 'search', domain: 'search_browse' }]
  const r = await H.runHolistic(deps, { taskId: 't-hcf', sourceDir: sd, features, outDir })
  const up = r.coverage.find(c => c.feature === 'file-uploads')
  assert.equal(up.review_status, 'candidate_found', 'free-form name folds onto the canonical slug')
  assert.equal(up.candidate_count, 1)
  assert.equal((r.anomalies || []).length, 0, 'a matched candidate is NOT an anomaly')
  fs.rmSync(sd, { recursive: true, force: true }); fs.rmSync(outDir, { recursive: true, force: true })
})
test('§4: an unattributable candidate becomes a COVERAGE_ANOMALY, never reviewed_no_issue', async () => {
  const sd = srcDir(); const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hca-'))
  const deps = {
    spawnAgent: async (agent, taskId, prompt) => { const m = prompt.match(/one per line\) to: (\S+)/); fs.mkdirSync(path.dirname(m[1]), { recursive: true }); fs.writeFileSync(m[1], JSON.stringify({ feature: 'totally_unrelated_zzz', vuln_class: 'xss', file: 'app/a.rb', status: 'SOURCE_CONFIRMED' }) + '\n'); return { code: 0 } },
    log: () => {}, trackCosts: () => {}, emitFromFile: () => 1,
  }
  const features = [{ slug: 'file-uploads', domain: 'files_uploads' }, { slug: 'search', domain: 'search_browse' }]
  const r = await H.runHolistic(deps, { taskId: 't-hca', sourceDir: sd, features, outDir })
  assert.equal(r.anomalies.length, 1, 'unmatched candidate surfaced as an anomaly')
  assert.equal(r.anomalies[0].raw_feature, 'totally_unrelated_zzz')
  assert.ok(r.coverage.every(c => c.review_status !== 'candidate_found'), 'no canonical feature falsely claims the anomaly')
  fs.rmSync(sd, { recursive: true, force: true }); fs.rmSync(outDir, { recursive: true, force: true })
})
test('F1: a session that throws ⇒ status not "completed", errors recorded, NOT silent', async () => {
  const sd = srcDir(); const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hce-'))
  const deps = { spawnAgent: async () => { throw new Error('rate limited') }, log: () => {}, trackCosts: () => {}, emitFromFile: () => 0 }
  const r = await H.runHolistic(deps, { taskId: 't-he', sourceDir: sd, features: [{ slug: 'x', domain: 'app' }], outDir })
  assert.notEqual(r.status, 'completed'); assert.ok(r.errors.length)
  fs.rmSync(sd, { recursive: true, force: true }); fs.rmSync(outDir, { recursive: true, force: true })
})
