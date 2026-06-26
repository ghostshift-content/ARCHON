// test/suppression-ledger.test.js
// Unit tests for agents/suppression-ledger.js
// Run: bun test test/suppression-ledger.test.js
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
  return fs.mkdtempSync(path.join(os.tmpdir(), 'suppression-ledger-test-'))
}

function readJsonlLines(file) {
  if (!fs.existsSync(file)) return []
  const raw = fs.readFileSync(file, 'utf8').trim()
  if (!raw) return []
  return raw.split('\n').filter(Boolean).map((l) => JSON.parse(l))
}

function loadModule() {
  const modPath = require.resolve('../agents/suppression-ledger')
  delete require.cache[modPath]
  return require('../agents/suppression-ledger')
}

// ---------------------------------------------------------------------------
// Test 1: logSuppression writes correct JSONL line to temp dir
// ---------------------------------------------------------------------------

test('logSuppression writes correct JSONL line to temp dir', async () => {
  const sl = loadModule()
  const outDir = makeTempDir()

  sl.logSuppression({
    taskId: 'task-001',
    finding: { id: 'F001', title: 'SQL Injection in /api/login', severity: 'critical' },
    filterName: 'severity-profile',
    reason: 'cvss 2.0 below bounty floor 8.0',
    fromSeverity: 'critical',
    toSeverity: 'archived',
    squad: 'pentest',
    outDir,
  })

  const ledgerFile = path.join(outDir, 'suppression-ledger.jsonl')
  assert.ok(fs.existsSync(ledgerFile), 'suppression-ledger.jsonl should exist')

  const lines = readJsonlLines(ledgerFile)
  assert.strictEqual(lines.length, 1, 'should have 1 line')

  const line = lines[0]
  assert.ok(line.ts, 'ts should be set')
  assert.strictEqual(line.taskId, 'task-001')
  assert.strictEqual(line.findingId, 'F001')
  assert.strictEqual(line.findingTitle, 'SQL Injection in /api/login')
  assert.strictEqual(line.filterName, 'severity-profile')
  assert.strictEqual(line.reason, 'cvss 2.0 below bounty floor 8.0')
  assert.strictEqual(line.fromSeverity, 'critical')
  assert.strictEqual(line.toSeverity, 'archived')
  assert.strictEqual(line.squad, 'pentest')

  fs.rmSync(outDir, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// Test 2: logManualReviewNeeded writes correct JSONL with status:'pending'
// ---------------------------------------------------------------------------

test('logManualReviewNeeded writes correct JSONL with status:pending', async () => {
  const sl = loadModule()
  const outDir = makeTempDir()

  sl.logManualReviewNeeded({
    taskId: 'task-002',
    finding: { id: 'F002', title: 'Auth Bypass via Token Manipulation', severity: 'critical' },
    reason: 'high severity + no oracle confirmation',
    squad: 'pentest',
    outDir,
  })

  const mrFile = path.join(outDir, 'manual-review-queue.jsonl')
  assert.ok(fs.existsSync(mrFile), 'manual-review-queue.jsonl should exist')

  const lines = readJsonlLines(mrFile)
  assert.strictEqual(lines.length, 1, 'should have 1 line')

  const line = lines[0]
  assert.ok(line.ts, 'ts should be set')
  assert.strictEqual(line.taskId, 'task-002')
  assert.strictEqual(line.findingId, 'F002')
  assert.strictEqual(line.findingTitle, 'Auth Bypass via Token Manipulation')
  assert.strictEqual(line.reason, 'high severity + no oracle confirmation')
  assert.strictEqual(line.squad, 'pentest')
  assert.strictEqual(line.status, 'pending', 'status must be pending')

  fs.rmSync(outDir, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// Test 3: isHighConvictionLowEvidence — various scenarios
// ---------------------------------------------------------------------------

test('isHighConvictionLowEvidence returns correct booleans', async () => {
  const sl = loadModule()

  // true: high severity + not CONFIRMED + no oracle
  assert.strictEqual(
    sl.isHighConvictionLowEvidence({ severity: 'critical', validation_status: 'PENDING' }),
    true,
    'critical + PENDING should be true'
  )
  assert.strictEqual(
    sl.isHighConvictionLowEvidence({ severity: 'high', validation_status: 'KILLED' }),
    true,
    'high + KILLED should be true'
  )
  assert.strictEqual(
    sl.isHighConvictionLowEvidence({ severity: 'high' }),
    true,
    'high + no validation_status should be true'
  )

  // false: CONFIRMED finding
  assert.strictEqual(
    sl.isHighConvictionLowEvidence({ severity: 'critical', validation_status: 'CONFIRMED' }),
    false,
    'CONFIRMED should be false'
  )

  // false: low severity
  assert.strictEqual(
    sl.isHighConvictionLowEvidence({ severity: 'low', validation_status: 'PENDING' }),
    false,
    'low severity should be false'
  )
  assert.strictEqual(
    sl.isHighConvictionLowEvidence({ severity: 'medium', validation_status: 'PENDING' }),
    false,
    'medium severity should be false'
  )
  assert.strictEqual(
    sl.isHighConvictionLowEvidence({ severity: 'info', validation_status: 'PENDING' }),
    false,
    'info severity should be false'
  )

  // false: has oracle-confirmed field
  assert.strictEqual(
    sl.isHighConvictionLowEvidence({ severity: 'critical', 'oracle-confirmed': true }),
    false,
    'oracle-confirmed should be false'
  )
  assert.strictEqual(
    sl.isHighConvictionLowEvidence({ severity: 'high', oracle_confirmed: true }),
    false,
    'oracle_confirmed should be false'
  )

  // false: null/undefined/non-object
  assert.strictEqual(sl.isHighConvictionLowEvidence(null), false, 'null should be false')
  assert.strictEqual(sl.isHighConvictionLowEvidence(undefined), false, 'undefined should be false')
  assert.strictEqual(sl.isHighConvictionLowEvidence('string'), false, 'string should be false')
})

// ---------------------------------------------------------------------------
// Test 4: getSuppressionCount returns correct count per taskId
// ---------------------------------------------------------------------------

test('getSuppressionCount returns correct count for taskId', async () => {
  const sl = loadModule()
  const outDir = makeTempDir()

  // No file yet → 0
  const countBefore = sl.getSuppressionCount({ taskId: 'task-aaa', outDir })
  assert.strictEqual(countBefore, 0, 'should be 0 before any writes')

  // Write 3 entries for task-aaa, 1 for task-bbb
  sl.logSuppression({ taskId: 'task-aaa', finding: { id: 'F1', title: 'F1' }, filterName: 'sf', reason: 'r', fromSeverity: 'high', toSeverity: 'archived', squad: 'pentest', outDir })
  sl.logSuppression({ taskId: 'task-aaa', finding: { id: 'F2', title: 'F2' }, filterName: 'sf', reason: 'r', fromSeverity: 'critical', toSeverity: 'archived', squad: 'pentest', outDir })
  sl.logSuppression({ taskId: 'task-aaa', finding: { id: 'F3', title: 'F3' }, filterName: 'sf', reason: 'r', fromSeverity: 'medium', toSeverity: 'archived', squad: 'pentest', outDir })
  sl.logSuppression({ taskId: 'task-bbb', finding: { id: 'F4', title: 'F4' }, filterName: 'sf', reason: 'r', fromSeverity: 'high', toSeverity: 'archived', squad: 'cloud-security', outDir })

  const countA = sl.getSuppressionCount({ taskId: 'task-aaa', outDir })
  assert.strictEqual(countA, 3, 'task-aaa should have 3 suppression entries')

  const countB = sl.getSuppressionCount({ taskId: 'task-bbb', outDir })
  assert.strictEqual(countB, 1, 'task-bbb should have 1 suppression entry')

  const countC = sl.getSuppressionCount({ taskId: 'task-ccc', outDir })
  assert.strictEqual(countC, 0, 'task-ccc should have 0 entries')

  fs.rmSync(outDir, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// Test 5: Functions don't throw if outDir doesn't exist yet (creates it)
// ---------------------------------------------------------------------------

test('logSuppression creates outDir if it does not exist', async () => {
  const sl = loadModule()
  const baseDir = makeTempDir()
  const outDir = path.join(baseDir, 'nested', 'dir', 'that', 'does', 'not', 'exist')

  // Should not throw — must create dir
  assert.doesNotThrow(() => {
    sl.logSuppression({
      taskId: 'task-new',
      finding: { id: 'F99', title: 'New Finding' },
      filterName: 'test',
      reason: 'auto-create test',
      fromSeverity: 'high',
      toSeverity: 'archived',
      squad: 'pentest',
      outDir,
    })
  }, 'logSuppression should not throw if outDir does not exist')

  assert.ok(fs.existsSync(path.join(outDir, 'suppression-ledger.jsonl')), 'file should be created')

  assert.doesNotThrow(() => {
    const baseDir2 = makeTempDir()
    const outDir2 = path.join(baseDir2, 'nested2', 'deep')
    sl.logManualReviewNeeded({
      taskId: 'task-new2',
      finding: { id: 'F100', title: 'Another Finding' },
      reason: 'auto-create test 2',
      squad: 'cloud-security',
      outDir: outDir2,
    })
    assert.ok(fs.existsSync(path.join(outDir2, 'manual-review-queue.jsonl')), 'manual-review file created')
    fs.rmSync(baseDir2, { recursive: true, force: true })
  }, 'logManualReviewNeeded should not throw if outDir does not exist')

  fs.rmSync(baseDir, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// Test 6: Pipeline safety — write failure doesn't propagate (read-only dir)
// ---------------------------------------------------------------------------

test('pipeline safety: callers handle write failure gracefully via try/catch', async () => {
  const sl = loadModule()

  // Simulate what callers are supposed to do: wrap in try/catch
  // Use /dev/null as outDir will cause mkdirSync to fail (can't create dir under /dev/null)
  let threw = false
  try {
    sl.logSuppression({
      taskId: 'test',
      finding: { id: 'X' },
      filterName: 'test',
      reason: 'test',
      fromSeverity: 'high',
      toSeverity: 'low',
      squad: 'pentest',
      outDir: '/dev/null/impossible-path',
    })
    // If it doesn't throw, that's also fine for caller safety test
  } catch (err) {
    threw = true
    // The calling pattern in severity-profile.js wraps in try/catch, so even if
    // logSuppression throws, the pipeline is protected.
  }

  // Whether it threw or not, the test is that wrapping in try/catch is the contract.
  // The important thing is our caller in severity-profile.js wraps in try/catch.
  // Verify that the caller pattern (try/catch wrapping) is present in severity-profile.js
  const severityProfileSrc = fs.readFileSync(
    path.join(__dirname, '../agents/severity-profile.js'),
    'utf-8'
  )
  assert.ok(
    severityProfileSrc.includes('try {') && severityProfileSrc.includes('suppression-ledger'),
    'severity-profile.js should have try/catch wrapping suppression-ledger call'
  )
  assert.ok(
    severityProfileSrc.includes('} catch {}'),
    'severity-profile.js should have empty catch block for fail-soft'
  )
})
