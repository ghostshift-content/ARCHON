// test/g4-metrics.test.js
//
// Unit tests for scripts/g4-metrics.js — per-dispatch metrics collector.
// Part of G4 Phase 1 build (Task 3/6).

const assert = require('node:assert')
const { test } = require('node:test')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const { collectMetrics } = require('../scripts/g4-metrics')

function makeFixture(taskId, opts = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'g4-fixture-'))
  const validatedFile = path.join(dir, `VALIDATED-FINDINGS-${taskId}.jsonl`)
  const tasksFile = path.join(dir, 'tasks.json')

  const findings = opts.findings ?? [
    { id: '1', severity: 'Critical', title: 'SQL Injection' },
    { id: '2', severity: 'High', title: 'XSS' },
    { id: '3', severity: 'Medium', title: 'Missing CSP' },
  ]
  fs.writeFileSync(
    validatedFile,
    findings.length ? findings.map(f => JSON.stringify(f)).join('\n') : ''
  )

  const tasks = [{
    id: taskId,
    title: opts.title || `Test target ${taskId}`,
    status: 'done',
    created: '2026-05-06',
    progress: 100,
    model_profile: opts.profile || 'default',
    krishna_model: opts.krishna || 'claude-opus-4-7',
    cost_usd: opts.cost ?? 142.30,
    duration_seconds: opts.duration ?? 4567,
  }]
  fs.writeFileSync(tasksFile, JSON.stringify(tasks))

  return { dir, validatedFile, tasksFile }
}

test('collectMetrics emits required keys', () => {
  const taskId = 'TEST-1'
  const { validatedFile, tasksFile } = makeFixture(taskId)
  const m = collectMetrics({ taskId, validatedFile, tasksFile })
  assert.strictEqual(m.task_id, taskId)
  assert.ok(m.metrics, 'has metrics object')
  assert.strictEqual(m.metrics.findings_total, 3)
  assert.strictEqual(m.metrics.findings_by_severity.critical, 1)
  assert.strictEqual(m.metrics.findings_by_severity.high, 1)
  assert.strictEqual(m.metrics.findings_by_severity.medium, 1)
  assert.strictEqual(m.metrics.cost_usd, 142.30)
  assert.strictEqual(m.metrics.duration_seconds, 4567)
})

test('collectMetrics handles empty VALIDATED-FINDINGS gracefully', () => {
  const taskId = 'TEST-2'
  const { validatedFile, tasksFile } = makeFixture(taskId, { findings: [] })
  const m = collectMetrics({ taskId, validatedFile, tasksFile })
  assert.strictEqual(m.metrics.findings_total, 0)
  assert.strictEqual(m.metrics.findings_by_severity.critical, 0)
})

test('collectMetrics captures model profile for cross-run comparison', () => {
  const taskId = 'TEST-3'
  const { validatedFile, tasksFile } = makeFixture(taskId, {
    profile: 'G4_test_sonnet',
    krishna: 'claude-sonnet-4-6',
    cost: 28.50,
  })
  const m = collectMetrics({ taskId, validatedFile, tasksFile })
  assert.strictEqual(m.model_profile, 'G4_test_sonnet')
  assert.strictEqual(m.krishna_model, 'claude-sonnet-4-6')
  assert.strictEqual(m.metrics.cost_usd, 28.50)
})

test('collectMetrics throws when task is not found', () => {
  const taskId = 'TEST-4'
  const { validatedFile, tasksFile } = makeFixture(taskId)
  assert.throws(
    () => collectMetrics({ taskId: 'OTHER-ID', validatedFile, tasksFile }),
    /not found/i
  )
})

test('collectMetrics requires taskId', () => {
  assert.throws(
    () => collectMetrics({ validatedFile: '/nonexistent', tasksFile: '/nonexistent' }),
    /taskId required/i
  )
})

test('collectMetrics handles missing VALIDATED-FINDINGS file gracefully', () => {
  const taskId = 'TEST-6'
  const { tasksFile } = makeFixture(taskId)
  // pass a nonexistent validated file path
  const m = collectMetrics({ taskId, validatedFile: '/nonexistent/path.jsonl', tasksFile })
  assert.strictEqual(m.metrics.findings_total, 0,
    'missing VALIDATED-FINDINGS file → 0 findings (not crash)')
})

test('collectMetrics tolerates missing cost/duration fields', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'g4-fixture-'))
  const validatedFile = path.join(dir, 'V.jsonl')
  const tasksFile = path.join(dir, 'tasks.json')
  fs.writeFileSync(validatedFile, '')
  // task without cost_usd or duration_seconds
  fs.writeFileSync(tasksFile, JSON.stringify([{ id: 'T7', title: 'No cost data' }]))
  const m = collectMetrics({ taskId: 'T7', validatedFile, tasksFile })
  assert.strictEqual(m.metrics.cost_usd, 0)
  assert.strictEqual(m.metrics.duration_seconds, 0)
})
