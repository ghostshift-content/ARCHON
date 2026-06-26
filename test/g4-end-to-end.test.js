// test/g4-end-to-end.test.js
//
// End-to-end smoke test for the full G4 pipeline:
//   1. 6 synthetic dispatches (3 targets × 2 models)
//   2. collectMetrics produces 6 metrics records
//   3. renderReport pairs them by target and renders comparison
//   4. applyDecisionCriteria yields ADOPT (with synthetic favorable data)
//
// Catches integration bugs that unit tests miss.
// Part of G4 Phase 1 build (Task 6/6).

const assert = require('node:assert')
const { test } = require('node:test')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const { collectMetrics } = require('../scripts/g4-metrics')
const { renderReport, applyDecisionCriteria, pairBySource } = require('../scripts/g4-report')

test('full G4 pipeline: 3 target pairs → renderReport → ADOPT decision', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'g4-e2e-'))

  // Build synthetic 3-target × 2-model = 6 dispatches
  const tasks = []
  const validatedFiles = {}

  for (let i = 1; i <= 3; i++) {
    for (const profile of ['default', 'G4_test_sonnet']) {
      const taskId = `T${i}-${profile}`
      const krishna = profile === 'default' ? 'claude-opus-4-7' : 'claude-sonnet-4-6'
      const cost = profile === 'default' ? 140 : 30
      tasks.push({
        id: taskId,
        title: `Target-${i}`,
        status: 'done',
        model_profile: profile,
        krishna_model: krishna,
        cost_usd: cost,
        duration_seconds: 3000,
      })
      const findings = [
        { id: '1', severity: 'Critical' },
        { id: '2', severity: 'High' },
        { id: '3', severity: 'Medium' },
      ]
      const valFile = path.join(dir, `VALIDATED-${taskId}.jsonl`)
      fs.writeFileSync(valFile, findings.map(f => JSON.stringify(f)).join('\n'))
      validatedFiles[taskId] = valFile
    }
  }

  const tasksFile = path.join(dir, 'tasks.json')
  fs.writeFileSync(tasksFile, JSON.stringify(tasks))

  // Stage 2: collect metrics for all 6 dispatches
  const metrics = []
  for (const t of tasks) {
    metrics.push(collectMetrics({ taskId: t.id, validatedFile: validatedFiles[t.id], tasksFile }))
  }
  assert.strictEqual(metrics.length, 6, 'all 6 dispatches collected')

  // Stage 3: pair them
  const pairs = pairBySource(metrics)
  assert.strictEqual(pairs.length, 3, 'pairs by target — 3 complete pairs')

  for (const { opus, sonnet } of pairs) {
    assert.strictEqual(opus.krishna_model, 'claude-opus-4-7', 'opus identified')
    assert.strictEqual(sonnet.krishna_model, 'claude-sonnet-4-6', 'sonnet identified')
    assert.strictEqual(opus.target, sonnet.target, 'pair shares target name')
  }

  // Stage 4: render report
  const report = renderReport(metrics)
  assert.match(report, /Run pairs:\*?\*?\s*3/, 'report shows 3 pairs')
  assert.match(report, /ADOPT Sonnet:.*YES/, 'decision is ADOPT under favorable synthetic data')
  for (let i = 1; i <= 3; i++) {
    assert.match(report, new RegExp(`Target-${i}`), `Target-${i} in report`)
  }

  // Stage 5: decision matches what report says
  const decision = applyDecisionCriteria(pairs)
  assert.strictEqual(decision.adopt, true, 'ADOPT under favorable synthetic data')
  assert.strictEqual(decision.evaluations.length, 3, '3 per-target evaluations')
  for (const e of decision.evaluations) {
    assert.strictEqual(e.criterion1, true, `${e.target} C1 (findings ratio)`)
    assert.strictEqual(e.criterion2, true, `${e.target} C2 (no Critical regression)`)
    assert.strictEqual(e.criterion3, true, `${e.target} C3 (cost savings ≥60%)`)
  }
})

test('full G4 pipeline: cost regression on 1 target → REJECT', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'g4-e2e-reject-'))
  const tasks = []
  const validatedFiles = {}

  for (let i = 1; i <= 3; i++) {
    for (const profile of ['default', 'G4_test_sonnet']) {
      const taskId = `T${i}-${profile}`
      const krishna = profile === 'default' ? 'claude-opus-4-7' : 'claude-sonnet-4-6'
      // T2 has only 30% cost reduction — fails C3
      const sonnetCost = i === 2 ? 100 : 30
      const cost = profile === 'default' ? 140 : sonnetCost
      tasks.push({
        id: taskId, title: `Target-${i}`, status: 'done',
        model_profile: profile, krishna_model: krishna,
        cost_usd: cost, duration_seconds: 3000,
      })
      const findings = [{ id: '1', severity: 'Critical' }]
      const valFile = path.join(dir, `VALIDATED-${taskId}.jsonl`)
      fs.writeFileSync(valFile, findings.map(f => JSON.stringify(f)).join('\n'))
      validatedFiles[taskId] = valFile
    }
  }

  const tasksFile = path.join(dir, 'tasks.json')
  fs.writeFileSync(tasksFile, JSON.stringify(tasks))

  const metrics = tasks.map(t => collectMetrics({ taskId: t.id, validatedFile: validatedFiles[t.id], tasksFile }))
  const decision = applyDecisionCriteria(pairBySource(metrics))

  assert.strictEqual(decision.adopt, false, 'one cost regression should reject the whole experiment')

  const t2eval = decision.evaluations.find(e => e.target === 'Target-2')
  assert.ok(t2eval, 'Target-2 evaluation present')
  assert.strictEqual(t2eval.criterion3, false, 'Target-2 fails C3 (cost reduction <60%)')
})

test('full G4 pipeline: VALIDATED-FINDINGS missing for one dispatch → 0 findings, no crash', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'g4-e2e-missing-'))
  const tasks = [
    {
      id: 'T1-default', title: 'TargetA', status: 'done',
      model_profile: 'default', krishna_model: 'claude-opus-4-7',
      cost_usd: 140, duration_seconds: 3000,
    },
    {
      id: 'T1-G4_test_sonnet', title: 'TargetA', status: 'done',
      model_profile: 'G4_test_sonnet', krishna_model: 'claude-sonnet-4-6',
      cost_usd: 30, duration_seconds: 3000,
    },
  ]
  const tasksFile = path.join(dir, 'tasks.json')
  fs.writeFileSync(tasksFile, JSON.stringify(tasks))

  // ONLY write VALIDATED file for opus, not sonnet
  const opusValid = path.join(dir, 'V-opus.jsonl')
  fs.writeFileSync(opusValid, JSON.stringify({ id: '1', severity: 'Critical' }))

  // collect should not crash on missing sonnet VALIDATED file
  const opusMetrics = collectMetrics({ taskId: 'T1-default', validatedFile: opusValid, tasksFile })
  const sonnetMetrics = collectMetrics({
    taskId: 'T1-G4_test_sonnet',
    validatedFile: path.join(dir, 'nonexistent.jsonl'),
    tasksFile,
  })

  assert.strictEqual(opusMetrics.metrics.findings_total, 1)
  assert.strictEqual(sonnetMetrics.metrics.findings_total, 0,
    'missing VALIDATED file → 0 findings (graceful)')

  // Pipeline still produces a decision (likely REJECT due to findings ratio = 0)
  const decision = applyDecisionCriteria(pairBySource([opusMetrics, sonnetMetrics]))
  assert.strictEqual(decision.adopt, false,
    '0 sonnet findings vs 1 opus findings → ratio 0 → fails C1')
})
