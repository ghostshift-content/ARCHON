// test/quality-tracker.test.js
// Unit tests for agents/quality-tracker.js
// Run: bun test test/quality-tracker.test.js
//
// All tests are OFFLINE — no LLM calls. Uses temp dirs for isolation.

'use strict'

const assert = require('node:assert')
const { test } = require('node:test')
const fs = require('fs')
const path = require('path')
const os = require('os')

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'quality-tracker-test-'))
}

function readJsonlLines(file) {
  if (!fs.existsSync(file)) return []
  const raw = fs.readFileSync(file, 'utf8').trim()
  if (!raw) return []
  return raw.split('\n').filter(Boolean).map((l) => JSON.parse(l))
}

function loadModule() {
  const modPath = require.resolve('../agents/quality-tracker')
  delete require.cache[modPath]
  return require('../agents/quality-tracker')
}

// ---------------------------------------------------------------------------
// Helper: write fixture lines to quality.jsonl with given ts offsets
// ---------------------------------------------------------------------------

function writeFixtureLine(file, overrides) {
  const record = {
    ts: new Date().toISOString(),
    taskId: 'fixture-task',
    squad: 'pentest',
    agentName: 'ATLAS',
    passed: 8,
    total: 10,
    passRate: 0.8,
    gradeScore: 0.8,
    costUsd: 0.05,
    durationMs: 5000,
    adapterUsed: 'cli',
    ...overrides,
  }
  const dir = path.dirname(file)
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
  fs.appendFileSync(file, JSON.stringify(record) + '\n', 'utf8')
}

// ---------------------------------------------------------------------------
// Test 1: recordRunQuality writes correct JSONL
// ---------------------------------------------------------------------------

test('recordRunQuality writes correct JSONL with passRate computed', async () => {
  const qt = loadModule()
  const outDir = makeTempDir()

  qt.recordRunQuality({
    taskId: 'task-001',
    squad: 'pentest',
    agentName: 'ATLAS',
    passed: 8,
    total: 10,
    gradeScore: 80,  // as 0-100 — should normalise to 0.8
    costUsd: 0.0512,
    durationMs: 12000,
    adapterUsed: 'cli',
    outDir,
  })

  const qFile = path.join(outDir, 'quality.jsonl')
  assert.ok(fs.existsSync(qFile), 'quality.jsonl should exist')

  const lines = readJsonlLines(qFile)
  assert.strictEqual(lines.length, 1, 'should have 1 line')

  const line = lines[0]
  assert.ok(line.ts, 'ts should be set')
  assert.strictEqual(line.taskId, 'task-001')
  assert.strictEqual(line.squad, 'pentest')
  assert.strictEqual(line.agentName, 'ATLAS')
  assert.strictEqual(line.passed, 8)
  assert.strictEqual(line.total, 10)
  assert.strictEqual(line.passRate, 0.8, 'passRate should be passed/total')
  assert.strictEqual(line.gradeScore, 0.8, 'gradeScore 80 should normalise to 0.8')
  assert.strictEqual(line.costUsd, 0.0512)
  assert.strictEqual(line.durationMs, 12000)
  assert.strictEqual(line.adapterUsed, 'cli')

  fs.rmSync(outDir, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// Test 2: getSquadBaseline returns noData:true when no entries
// ---------------------------------------------------------------------------

test('getSquadBaseline returns noData:true when no entries exist', async () => {
  const qt = loadModule()
  const outDir = makeTempDir()

  // No file exists
  const result = qt.getSquadBaseline('pentest', { outDir })
  assert.strictEqual(result.noData, true, 'should return noData:true')
  assert.strictEqual(result.runs, 0, 'runs should be 0')
  assert.strictEqual(result.squad, 'pentest')
  assert.strictEqual(result.windowDays, 30)

  // File exists but has no entries for this squad
  const qFile = path.join(outDir, 'quality.jsonl')
  writeFixtureLine(qFile, { squad: 'stocks' })
  const result2 = qt.getSquadBaseline('pentest', { outDir })
  assert.strictEqual(result2.noData, true, 'should return noData:true for other squad data')

  fs.rmSync(outDir, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// Test 3: getSquadBaseline returns correct avgPassRate/avgCostUsd for fixture data
// ---------------------------------------------------------------------------

test('getSquadBaseline returns correct averages for fixture data', async () => {
  const qt = loadModule()
  const outDir = makeTempDir()
  const qFile = path.join(outDir, 'quality.jsonl')

  // Write 3 pentest records
  writeFixtureLine(qFile, { squad: 'pentest', passRate: 0.9, gradeScore: 0.9, costUsd: 0.10, durationMs: 5000, adapterUsed: 'cli' })
  writeFixtureLine(qFile, { squad: 'pentest', passRate: 0.8, gradeScore: 0.8, costUsd: 0.20, durationMs: 7000, adapterUsed: 'sdk' })
  writeFixtureLine(qFile, { squad: 'pentest', passRate: 0.7, gradeScore: 0.7, costUsd: 0.30, durationMs: 9000, adapterUsed: 'cli' })
  // One stocks record — should not affect pentest baseline
  writeFixtureLine(qFile, { squad: 'stocks', passRate: 0.5, costUsd: 0.50, durationMs: 3000 })

  const baseline = qt.getSquadBaseline('pentest', { outDir })
  assert.strictEqual(baseline.runs, 3, 'should have 3 runs')
  assert.ok(!baseline.noData, 'should not have noData')

  // avgPassRate = (0.9 + 0.8 + 0.7) / 3 = 0.8
  assert.strictEqual(baseline.avgPassRate, 0.8, 'avgPassRate should be 0.8')
  // avgCostUsd = (0.10 + 0.20 + 0.30) / 3 = 0.2
  assert.strictEqual(baseline.avgCostUsd, 0.2, 'avgCostUsd should be 0.2')
  // avgGradeScore = (0.9 + 0.8 + 0.7) / 3 = 0.8
  assert.strictEqual(baseline.avgGradeScore, 0.8, 'avgGradeScore should be 0.8')
  // p50: sorted [5000, 7000, 9000], idx=1 → 7000
  assert.strictEqual(baseline.p50DurationMs, 7000, 'p50DurationMs should be 7000')
  // adapterBreakdown: cli=2, sdk=1
  assert.strictEqual(baseline.adapterBreakdown.cli, 2, 'cli count should be 2')
  assert.strictEqual(baseline.adapterBreakdown.sdk, 1, 'sdk count should be 1')

  fs.rmSync(outDir, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// Test 4: snapshotAllSquads covers all 5 squads with noData when empty
// ---------------------------------------------------------------------------

test('snapshotAllSquads covers all 5 squads with noData when empty', async () => {
  const qt = loadModule()
  const outDir = makeTempDir()

  const snapshot = qt.snapshotAllSquads({ outDir })
  assert.ok(snapshot.ts, 'snapshot should have ts')
  assert.ok(snapshot.squads, 'snapshot should have squads')

  const expectedSquads = ['pentest', 'stocks', 'cloud-security', 'network-pentest', 'code-review']
  for (const sq of expectedSquads) {
    assert.ok(snapshot.squads[sq], `snapshot should include squad: ${sq}`)
    assert.strictEqual(snapshot.squads[sq].noData, true, `${sq} should have noData:true when empty`)
    assert.strictEqual(snapshot.squads[sq].runs, 0)
  }

  // File should be written
  const snapFile = path.join(outDir, 'quality-snapshot.json')
  assert.ok(fs.existsSync(snapFile), 'quality-snapshot.json should be written')
  const parsed = JSON.parse(fs.readFileSync(snapFile, 'utf-8'))
  assert.ok(parsed.ts, 'snapshot file should have ts')
  assert.ok(parsed.squads, 'snapshot file should have squads')

  fs.rmSync(outDir, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// Test 5: windowDays filter works — old entries excluded
// ---------------------------------------------------------------------------

test('windowDays filter excludes old entries', async () => {
  const qt = loadModule()
  const outDir = makeTempDir()
  const qFile = path.join(outDir, 'quality.jsonl')

  // Write 1 recent entry
  writeFixtureLine(qFile, { squad: 'pentest', passRate: 0.9, costUsd: 0.10, durationMs: 5000, adapterUsed: 'cli' })

  // Write 1 old entry (35 days ago — beyond 30-day window)
  const oldTs = new Date(Date.now() - 35 * 24 * 60 * 60 * 1000).toISOString()
  writeFixtureLine(qFile, { squad: 'pentest', ts: oldTs, passRate: 0.5, costUsd: 0.50, durationMs: 1000, adapterUsed: 'cli' })

  // With default windowDays=30: only the recent entry should count
  const baseline = qt.getSquadBaseline('pentest', { outDir, windowDays: 30 })
  assert.strictEqual(baseline.runs, 1, 'should only count 1 recent run')
  assert.strictEqual(baseline.avgPassRate, 0.9, 'avgPassRate should be 0.9 (only recent entry)')

  // With windowDays=40: both entries should count
  const baseline40 = qt.getSquadBaseline('pentest', { outDir, windowDays: 40 })
  assert.strictEqual(baseline40.runs, 2, 'should count both runs with 40-day window')
  assert.ok(Math.abs(baseline40.avgPassRate - 0.7) < 0.001, 'avgPassRate should be ~0.7 with both entries')

  fs.rmSync(outDir, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// Test 6: PRODUCTION_SQUADS constant has exactly 5 squads
// ---------------------------------------------------------------------------

test('PRODUCTION_SQUADS constant has exactly 5 squads', async () => {
  const qt = loadModule()
  assert.ok(Array.isArray(qt.PRODUCTION_SQUADS), 'PRODUCTION_SQUADS should be an array')
  assert.strictEqual(qt.PRODUCTION_SQUADS.length, 5, 'should have exactly 5 squads')

  const expected = ['pentest', 'stocks', 'cloud-security', 'network-pentest', 'code-review']
  for (const sq of expected) {
    assert.ok(qt.PRODUCTION_SQUADS.includes(sq), `PRODUCTION_SQUADS should include: ${sq}`)
  }
})

// ---------------------------------------------------------------------------
// Test 7: recordRunQuality creates outDir if it does not exist
// ---------------------------------------------------------------------------

test('recordRunQuality creates outDir if it does not exist', async () => {
  const qt = loadModule()
  const baseDir = makeTempDir()
  const outDir = path.join(baseDir, 'deeply', 'nested', 'dir')

  assert.doesNotThrow(() => {
    qt.recordRunQuality({
      taskId: 'task-nested',
      squad: 'stocks',
      agentName: 'CHANAKYA',
      passed: 5,
      total: 5,
      gradeScore: 100,
      costUsd: 0.01,
      durationMs: 3000,
      adapterUsed: 'sdk',
      outDir,
    })
  }, 'recordRunQuality should not throw if outDir does not exist')

  assert.ok(fs.existsSync(path.join(outDir, 'quality.jsonl')), 'quality.jsonl should be created')

  fs.rmSync(baseDir, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// Test 8: gradeScore normalisation — 0-100 and 0-1 both accepted
// ---------------------------------------------------------------------------

test('gradeScore normalises both 0-100 and 0-1 inputs', async () => {
  const qt = loadModule()
  const outDir = makeTempDir()
  const qFile = path.join(outDir, 'quality.jsonl')

  // Score as 0-100
  qt.recordRunQuality({ taskId: 't1', squad: 'pentest', agentName: 'X', passed: 9, total: 10, gradeScore: 90, costUsd: 0, durationMs: 0, adapterUsed: 'cli', outDir })
  // Score as 0-1
  qt.recordRunQuality({ taskId: 't2', squad: 'pentest', agentName: 'X', passed: 7, total: 10, gradeScore: 0.7, costUsd: 0, durationMs: 0, adapterUsed: 'cli', outDir })

  const lines = readJsonlLines(qFile)
  assert.strictEqual(lines[0].gradeScore, 0.9, '90 → 0.9')
  assert.strictEqual(lines[1].gradeScore, 0.7, '0.7 → 0.7')

  fs.rmSync(outDir, { recursive: true, force: true })
})
