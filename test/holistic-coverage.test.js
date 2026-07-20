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

test('§1: a feature whose holistic session FAILED is a coverage gap, never reviewed_no_issue', async () => {
  const sd = srcDir(); const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hcf1-'))
  const deps = { spawnAgent: async () => { throw new Error('rate limited') }, log: () => {}, trackCosts: () => {}, emitFromFile: () => 0 }
  const r = await H.runHolistic(deps, { taskId: 't-hf1', sourceDir: sd, features: [{ slug: 'login', domain: 'app' }], outDir })
  const cov = r.coverage.find(c => c.feature === 'login')
  assert.equal(cov.review_status, 'blocked_coverage_gap', 'failed session ⇒ coverage gap')
  assert.notEqual(cov.review_status, 'reviewed_no_issue')
  assert.equal(cov.mapping_status, 'failed')
  fs.rmSync(sd, { recursive: true, force: true }); fs.rmSync(outDir, { recursive: true, force: true })
})

test('§8: a clean feature records the assigned files + full lens list, not just candidate-derived evidence', async () => {
  const sd = srcDir(); const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hc8-'))
  const deps = { spawnAgent: async (a, t, prompt) => { const m = prompt.match(/one per line\) to: (\S+)/); fs.mkdirSync(path.dirname(m[1]), { recursive: true }); fs.writeFileSync(m[1], ''); return { code: 0 } }, log: () => {}, trackCosts: () => {}, emitFromFile: () => 0 }
  const r = await H.runHolistic(deps, { taskId: 't-h8', sourceDir: sd, features: [{ slug: 'login', domain: 'app' }], outDir })
  const cov = r.coverage.find(c => c.feature === 'login')
  assert.equal(cov.review_status, 'reviewed_no_issue')
  assert.ok(cov.files_reviewed.length >= 1, 'files_reviewed reflects the assigned manifest even with no candidates')
  assert.ok(cov.classes_reviewed.length >= 5, 'classes_reviewed is the full lens list, not candidate-derived')
  fs.rmSync(sd, { recursive: true, force: true }); fs.rmSync(outDir, { recursive: true, force: true })
})

test('§3: workstream_coverage tracks every planned workstream; a failed shard is non-terminal', async () => {
  const sd = srcDir(); const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hcws-'))
  const deps = { spawnAgent: async () => { throw new Error('boom') }, log: () => {}, trackCosts: () => {}, emitFromFile: () => 0 }
  const r = await H.runHolistic(deps, { taskId: 't-ws', sourceDir: sd, features: [{ slug: 'login', domain: 'app' }], outDir })
  assert.ok(Array.isArray(r.workstream_coverage) && r.workstream_coverage.length >= 1)
  assert.ok(r.workstream_coverage.every(w => 'terminal' in w && 'status' in w))
  assert.equal(r.workstream_coverage[0].terminal, false, 'a failed session is NOT terminal')
  assert.equal(r.workstream_coverage[0].status, 'failed')
  assert.notEqual(r.status, 'completed', 'a non-terminal workstream ⇒ run is not "completed"')
  fs.rmSync(sd, { recursive: true, force: true }); fs.rmSync(outDir, { recursive: true, force: true })
})

test('§2: _detectSharedFiles flags base controllers + cross-dir-referenced modules', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'shd-'))
  fs.mkdirSync(path.join(d, 'app', 'controllers'), { recursive: true })
  fs.mkdirSync(path.join(d, 'app', 'auth'), { recursive: true }); fs.mkdirSync(path.join(d, 'app', 'billing'), { recursive: true })
  fs.writeFileSync(path.join(d, 'app', 'controllers', 'application_controller.rb'), 'class ApplicationController; end')
  const manifest = [
    { path: 'app/controllers/application_controller.rb', bytes: 100 },
    { path: 'app/auth/login.rb', bytes: 100 },
    { path: 'app/billing/refund.rb', bytes: 100 },
  ]
  const shared = H._detectSharedFiles(d, manifest)
  assert.ok(shared.has('app/controllers/application_controller.rb'), 'base controller detected as shared')
  fs.rmSync(d, { recursive: true, force: true })
})

test('§1: an OVERSIZED workstream is NOT spawned; it is a non-terminal coverage blocker', async () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'hov-')); fs.mkdirSync(path.join(d, 'app'))
  // one file whose tokens exceed the (small) usable budget → forced oversized single-file workstream
  fs.writeFileSync(path.join(d, 'app', 'huge.rb'), 'x'.repeat(400_000))
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hovo-'))
  let spawned = 0
  const deps = { spawnAgent: async () => { spawned++; return { code: 0 } }, log: () => {}, trackCosts: () => {}, emitFromFile: () => 0 }
  // model_context=200k ⇒ usable ~50k ⇒ the ~100k-token file is oversized and cannot be sliced
  const r = await H.runHolistic(deps, { taskId: 't-ov', sourceDir: d, features: [{ slug: 'x', domain: 'app' }], outDir, model_context: 200_000 })
  const over = (r.workstream_coverage || []).filter(w => w.oversized || w.status === 'oversized_blocked')
  assert.ok(over.length >= 1, 'oversized workstream present in coverage')
  assert.ok(over.every(w => !w.terminal), 'oversized workstream is NON-terminal')
  assert.equal(spawned, 0, 'NO holistic session spawned for the oversized slice')
  assert.notEqual(r.status, 'completed', 'run is not "completed" when a slice is oversized')
  fs.rmSync(d, { recursive: true, force: true }); fs.rmSync(outDir, { recursive: true, force: true })
})
