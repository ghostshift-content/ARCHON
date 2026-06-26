
const __roots = require('../paths') // portable roots (KURU_*_ROOT) — see paths.js
// test/kripa-validated-builder.test.js
// Covers the KRIPA→VALIDATED-FINDINGS bridge that closes the long-standing
// pipeline gap. Empirical context: rounds 9 & 10 confirmed Phase 3.9 was
// reading stale shared file because no producer wrote per-task VALIDATED-
// FINDINGS. This module is the producer.

const assert = require('node:assert')
const { test } = require('node:test')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const {
  buildFromBuffer,
  buildFromActivityLog,
  writeValidatedFindingsFile,
  buildAndWriteForTask,
  parseKripaEntry,
  inferSeverity,
  extractOriginalAgent,
} = require('../agents/kripa-validated-builder')

// Real KRIPA action lines pulled from /root/intel/ACTIVITY-LOG.jsonl after
// round-10 webvpn.us.lenovo.com (taskId 1778467022281). The em-dash is the
// actual character used by KRIPA's prompt template.
const KRIPA_ACTIONS = [
  'CONFIRMED — F-001: No Account Lockout on VPN Authentication',
  'CONFIRMED — F-002: Stateless Brute Force — Cookieless Requests Bypass CSRF Gate and Reach Auth Backend',
  'KILLED — F-003: Logout CSRF Bypass (Multiple Agents: NAKUL, SHIKHANDI, KRITAVARMA)',
  'KILLED — F-004: URL-Encoded Slash Bypass (%2F, //, %2F%2F bypasses 403 on /+CSCOE+/logon.html)',
  'CONFIRMED — F-007: Internal Infrastructure Topology Disclosure via TLS Certificate SAN',
  'CONFIRMED — F-008: Tarpit Bypass via Global VPN Node Cluster — 30+ Nodes Share ISE Backend With No Rate Limiting',
  'KILLED — F-010: CSRF Token Validation Absent on Login Endpoint (SHIKHANDI 3-way test)',
  'SELF_EVAL: 8/10 — Comprehensive validation with 15 independent probes',
  'Validation Summary — Task 1778467022281 (webvpn.us.lenovo.com round-10)',
  '💰 Cost: $0.8177',
]

function mkActivityLogBuffer(taskId, actions, otherAgents = []) {
  const lines = []
  for (const a of actions) {
    lines.push(JSON.stringify({
      ts: '2026-05-11T05:41:52Z',
      agent: 'KRIPA',
      action: a,
      taskId: String(taskId),
      details: 'reasoning trace for ' + a.slice(0, 40),
    }))
  }
  // Add non-KRIPA noise to prove the filter
  for (const a of otherAgents) {
    lines.push(JSON.stringify({
      ts: '2026-05-11T05:30:00Z',
      agent: a.agent || 'NOISE',
      action: a.action || 'CONFIRMED — F-999: Should be ignored',
      taskId: a.taskId || String(taskId),
    }))
  }
  return lines.join('\n')
}

test('parseKripaEntry extracts CONFIRMED verdicts; drops KILLED + non-verdict lines', () => {
  const taskId = 'T-1'
  const okLine = JSON.stringify({
    agent: 'KRIPA',
    taskId,
    ts: '2026-05-11T05:00:00Z',
    action: 'CONFIRMED — F-001: No Account Lockout on VPN Authentication',
  })
  const r = parseKripaEntry(okLine, taskId)
  assert.ok(r)
  assert.strictEqual(r.id, 'F-001')
  assert.strictEqual(r.validation_status, 'CONFIRMED')
  assert.match(r.title, /No Account Lockout/)

  const killedLine = JSON.stringify({
    agent: 'KRIPA',
    taskId,
    action: 'KILLED — F-002: Some Killed Finding',
  })
  assert.strictEqual(parseKripaEntry(killedLine, taskId), null,
    'KILLED entries must not produce records')

  const summaryLine = JSON.stringify({
    agent: 'KRIPA',
    taskId,
    action: 'SELF_EVAL: 8/10 — summary noise',
  })
  assert.strictEqual(parseKripaEntry(summaryLine, taskId), null,
    'SELF_EVAL / summary lines must not produce records')
})

test('parseKripaEntry filters by taskId — wrong task IDs are skipped', () => {
  const line = JSON.stringify({
    agent: 'KRIPA',
    taskId: 'wrong-task',
    action: 'CONFIRMED — F-001: Should not match',
  })
  assert.strictEqual(parseKripaEntry(line, 'correct-task'), null)
})

test('parseKripaEntry filters by agent — non-KRIPA entries are skipped', () => {
  const line = JSON.stringify({
    agent: 'IMPOSTOR',
    taskId: 'T-1',
    action: 'CONFIRMED — F-001: Should not match',
  })
  assert.strictEqual(parseKripaEntry(line, 'T-1'), null)
})

test('extractOriginalAgent pulls source agent names from title parens', () => {
  assert.strictEqual(
    extractOriginalAgent('Some Finding (Multiple Agents: NAKUL, SHIKHANDI, KRITAVARMA)'),
    'NAKUL,SHIKHANDI,KRITAVARMA'
  )
  assert.strictEqual(extractOriginalAgent('Lone Finding (RUDRA)'), 'RUDRA')
  assert.strictEqual(extractOriginalAgent('No Parens Finding'), 'unknown')
})

test('inferSeverity escalates RCE/SQLi/cred-stuffing to High; defaults to Medium', () => {
  assert.strictEqual(inferSeverity('Stateless brute force — Cookieless Requests'), 'High')
  assert.strictEqual(inferSeverity('SQL Injection via login form'), 'High')
  assert.strictEqual(inferSeverity('CSRF token absent'), 'Medium')
  assert.strictEqual(inferSeverity('Missing X-Frame-Options header'), 'Low')
  assert.strictEqual(inferSeverity('Random finding nobody categorized'), 'Medium')
})

test('buildFromBuffer parses the full round-10 activity log → 4 CONFIRMED records', () => {
  const buf = mkActivityLogBuffer('1778467022281', KRIPA_ACTIONS)
  const out = buildFromBuffer(buf, '1778467022281')
  assert.strictEqual(out.length, 4, 'expected 4 CONFIRMED (F-001, F-002, F-007, F-008)')
  const ids = out.map(r => r.id).sort()
  assert.deepStrictEqual(ids, ['F-001', 'F-002', 'F-007', 'F-008'])
  // Severity inference
  const f001 = out.find(r => r.id === 'F-001')
  const f002 = out.find(r => r.id === 'F-002')
  assert.strictEqual(f002.severity, 'High', 'brute force should infer High')
  assert.ok(['Medium', 'High'].includes(f001.severity), `F-001 sev got ${f001.severity}`)
  // Every record carries taskId + validation_status
  for (const r of out) {
    assert.strictEqual(r.taskId, '1778467022281')
    assert.strictEqual(r.validation_status, 'CONFIRMED')
    assert.ok(r.title.length > 5)
  }
})

test('buildFromBuffer skips non-KRIPA noise and unrelated tasks', () => {
  const noise = [
    { agent: 'NAKUL', taskId: 'T-1', action: 'CONFIRMED — F-001: Real finding from NAKUL' },
    { agent: 'KRIPA', taskId: 'OTHER-TASK', action: 'CONFIRMED — F-001: Other task' },
  ]
  const buf = mkActivityLogBuffer('T-1', [
    'CONFIRMED — F-100: True positive',
  ], noise)
  const out = buildFromBuffer(buf, 'T-1')
  assert.strictEqual(out.length, 1)
  assert.strictEqual(out[0].id, 'F-100')
})

test('buildFromBuffer de-duplicates by ID (re-emitted lines count once)', () => {
  const buf = mkActivityLogBuffer('T-1', [
    'CONFIRMED — F-001: First emit',
    'CONFIRMED — F-001: Second emit (re-run)',
    'CONFIRMED — F-002: Different one',
  ])
  const out = buildFromBuffer(buf, 'T-1')
  assert.strictEqual(out.length, 2)
  assert.deepStrictEqual(out.map(r => r.id).sort(), ['F-001', 'F-002'])
})

test('writeValidatedFindingsFile writes atomic + correct path', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kripa-validator-'))
  const records = [
    { id: 'F-1', title: 'A', validation_status: 'CONFIRMED', severity: 'High' },
    { id: 'F-2', title: 'B', validation_status: 'CONFIRMED', severity: 'Medium' },
  ]
  const { path: outPath, count } = writeValidatedFindingsFile(records, 'TEST-123', { intelDir: tmpDir })
  assert.strictEqual(count, 2)
  assert.strictEqual(outPath, path.join(tmpDir, 'VALIDATED-FINDINGS-TEST-123.jsonl'))
  // Verify the contents are valid jsonl
  const lines = fs.readFileSync(outPath, 'utf-8').trim().split('\n')
  assert.strictEqual(lines.length, 2)
  for (const l of lines) {
    const parsed = JSON.parse(l)
    assert.ok(['F-1', 'F-2'].includes(parsed.id))
  }
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

test('writeValidatedFindingsFile handles empty record set gracefully', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kripa-validator-'))
  const { path: outPath, count } = writeValidatedFindingsFile([], 'EMPTY-T', { intelDir: tmpDir })
  assert.strictEqual(count, 0)
  // File should exist but be empty (downstream readers handle empty file)
  assert.ok(fs.existsSync(outPath))
  assert.strictEqual(fs.readFileSync(outPath, 'utf-8'), '')
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

test('buildAndWriteForTask end-to-end: reads custom log → writes VALIDATED-FINDINGS', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kripa-validator-'))
  const taskId = 'E2E-1'
  const logPath = path.join(tmpDir, 'fake-activity.jsonl')
  fs.writeFileSync(logPath, mkActivityLogBuffer(taskId, KRIPA_ACTIONS))

  const { path: outPath, count, records } = buildAndWriteForTask(taskId, {
    activityLogPath: logPath,
    intelDir: tmpDir,
  })
  assert.strictEqual(count, 4)
  assert.strictEqual(records.length, 4)
  assert.ok(fs.existsSync(outPath))
  // Confirm Phase-3.9-compatible shape (per-task path)
  assert.match(outPath, /VALIDATED-FINDINGS-E2E-1\.jsonl$/)
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

test('buildAndWriteForTask: missing taskId throws (defensive — caller must pass)', () => {
  assert.throws(() => buildAndWriteForTask(''), /taskId required/)
  assert.throws(() => buildAndWriteForTask(null), /taskId required/)
})

test('round-10 backfill: real ACTIVITY-LOG produces the 4 round-10 confirmed findings', () => {
  // This is an integration probe — only meaningful if the live ACTIVITY-LOG
  // contains the round-10 KRIPA entries. Skip gracefully if not present
  // (e.g., on a clean dev box).
  const liveLog = (__roots.INTEL_ROOT + '/ACTIVITY-LOG.jsonl')
  if (!fs.existsSync(liveLog)) return
  const out = buildFromActivityLog('1778467022281', { activityLogPath: liveLog })
  if (out.length === 0) return // log rotated, no longer has round-10 entries
  // If round-10 entries are still there, must include F-001 + F-002 + F-007 + F-008
  const ids = new Set(out.map(r => r.id))
  for (const expected of ['F-001', 'F-002', 'F-007', 'F-008']) {
    assert.ok(ids.has(expected), `round-10 backfill missing ${expected} (got ${[...ids].join(',')})`)
  }
})
