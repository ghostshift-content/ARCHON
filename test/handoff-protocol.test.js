
const __roots = require('../paths') // portable roots (KURU_*_ROOT) — see paths.js
// test/handoff-protocol.test.js
const assert = require('node:assert')
const { test } = require('node:test')
const {
  HANDOFF_SCHEMA_VERSION,
  HANDOFF_STATUSES,
  HANDOFFS_INBOX_DIR,
  HANDOFFS_DONE_DIR,
  HANDOFFS_FAILED_DIR,
  MAX_HANDOFFS_PER_FINDING,
  MAX_CHAIN_DEPTH,
  DEFAULT_HANDOFF_BUDGET_USD,
  MAX_TASK_HANDOFF_BUDGET_USD,
} = require('../agents/handoff-protocol')

test('HANDOFF_SCHEMA_VERSION is "1"', () => {
  assert.strictEqual(HANDOFF_SCHEMA_VERSION, '1')
})

test('HANDOFF_STATUSES has the three canonical values', () => {
  assert.deepStrictEqual(
    HANDOFF_STATUSES.slice().sort(),
    ['completed', 'failed', 'pending']
  )
})

test('Inbox/done/failed paths point at /root/intel/handoffs/<sub>/', () => {
  assert.strictEqual(HANDOFFS_INBOX_DIR, (__roots.INTEL_ROOT + '/handoffs/inbox'))
  assert.strictEqual(HANDOFFS_DONE_DIR, (__roots.INTEL_ROOT + '/handoffs/done'))
  assert.strictEqual(HANDOFFS_FAILED_DIR, (__roots.INTEL_ROOT + '/handoffs/failed'))
})

test('Locked-decision constants match Jay 2026-05-10 design', () => {
  assert.strictEqual(MAX_HANDOFFS_PER_FINDING, 3)
  assert.strictEqual(MAX_CHAIN_DEPTH, 2)
  assert.strictEqual(DEFAULT_HANDOFF_BUDGET_USD, 0.50)
  assert.strictEqual(MAX_TASK_HANDOFF_BUDGET_USD, 2.00)
})

const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const { createHandoff } = require('../agents/handoff-protocol')

test('createHandoff: writes a JSON file to inbox dir', () => {
  const tmpBase = path.join(os.tmpdir(), `handoff-test-${Date.now()}`)
  try {
    const result = createHandoff({
      sourceTaskId: 'T1',
      sourceSquad: 'pentest',
      sourceAgent: 'ASHWATTHAMA',
      sourceFindingId: 'ASH-001',
      targetSquad: 'cloud-security',
      targetCapability: 'data-residency',
      request: {
        question: 'Is this PII flow legal?',
        evidence: { api_host: 'cube.zhaopin.com' },
      },
    }, { baseDir: tmpBase })
    assert.ok(result.handoff_id, 'handoff_id must be set')
    assert.match(result.handoff_id, /^h-\d+-[a-z0-9]+$/)
    assert.ok(fs.existsSync(result.path), 'file must exist')
    const parsed = JSON.parse(fs.readFileSync(result.path, 'utf-8'))
    assert.strictEqual(parsed.schema_version, '1')
    assert.strictEqual(parsed.status, 'pending')
    assert.strictEqual(parsed.chain_depth, 0)
    assert.strictEqual(parsed.cost_budget_usd, 0.50)
    assert.strictEqual(parsed.source_squad, 'pentest')
    assert.strictEqual(parsed.target_capability, 'data-residency')
  } finally {
    fs.rmSync(tmpBase, { recursive: true, force: true })
  }
})

test('createHandoff: respects parent_handoff_id and chain_depth', () => {
  const tmpBase = path.join(os.tmpdir(), `handoff-chain-${Date.now()}`)
  try {
    const r = createHandoff({
      sourceTaskId: 'T1', sourceSquad: 'cloud-security', sourceAgent: 'KUBERA',
      sourceFindingId: 'F1', targetSquad: 'network-pentest',
      targetCapability: 'dns-attribution',
      request: { question: 'q', evidence: {} },
      parentHandoffId: 'h-abc-123',
      chainDepth: 1,
    }, { baseDir: tmpBase })
    const parsed = JSON.parse(fs.readFileSync(r.path, 'utf-8'))
    assert.strictEqual(parsed.parent_handoff_id, 'h-abc-123')
    assert.strictEqual(parsed.chain_depth, 1)
  } finally {
    fs.rmSync(tmpBase, { recursive: true, force: true })
  }
})

test('createHandoff: throws if chain_depth > MAX_CHAIN_DEPTH', () => {
  const tmpBase = path.join(os.tmpdir(), `handoff-depth-${Date.now()}`)
  try {
    assert.throws(
      () => createHandoff({
        sourceTaskId: 'T1', sourceSquad: 'pentest', sourceAgent: 'A',
        sourceFindingId: 'F1', targetSquad: 'cloud-security',
        targetCapability: 'x',
        request: { question: 'q', evidence: {} },
        chainDepth: 3,
      }, { baseDir: tmpBase }),
      /chain depth/i,
      'must reject chain_depth > MAX_CHAIN_DEPTH'
    )
  } finally {
    fs.rmSync(tmpBase, { recursive: true, force: true })
  }
})

test('createHandoff: creates parent dirs if missing', () => {
  const tmpBase = path.join(os.tmpdir(), `handoff-mkdir-${Date.now()}`)
  try {
    assert.ok(!fs.existsSync(tmpBase), 'parent must not exist')
    createHandoff({
      sourceTaskId: 'T1', sourceSquad: 'pentest', sourceAgent: 'A',
      sourceFindingId: 'F1', targetSquad: 'cloud-security',
      targetCapability: 'x',
      request: { question: 'q', evidence: {} },
    }, { baseDir: tmpBase })
    assert.ok(fs.existsSync(path.join(tmpBase, 'inbox')), 'inbox dir created')
  } finally {
    fs.rmSync(tmpBase, { recursive: true, force: true })
  }
})

test('createHandoff: required fields missing throws', () => {
  assert.throws(
    () => createHandoff({}, { baseDir: '/tmp' }),
    /missing required field/i
  )
})

const { readHandoff, markCompleted, markFailed } = require('../agents/handoff-protocol')

test('readHandoff: parses JSON file from any handoff dir', () => {
  const tmpBase = path.join(os.tmpdir(), `handoff-read-${Date.now()}`)
  try {
    const r = createHandoff({
      sourceTaskId: 'T1', sourceSquad: 'pentest', sourceAgent: 'A',
      sourceFindingId: 'F1', targetSquad: 'cloud-security',
      targetCapability: 'x', request: { question: 'q', evidence: {} },
    }, { baseDir: tmpBase })
    const parsed = readHandoff(r.path)
    assert.strictEqual(parsed.handoff_id, r.handoff_id)
    assert.strictEqual(parsed.status, 'pending')
  } finally {
    fs.rmSync(tmpBase, { recursive: true, force: true })
  }
})

test('readHandoff: returns null for missing file', () => {
  assert.strictEqual(readHandoff('/nonexistent/path.json'), null)
})

test('markCompleted: moves file from inbox to done with verdict fields', () => {
  const tmpBase = path.join(os.tmpdir(), `handoff-mark-done-${Date.now()}`)
  try {
    const r = createHandoff({
      sourceTaskId: 'T1', sourceSquad: 'pentest', sourceAgent: 'A',
      sourceFindingId: 'F1', targetSquad: 'cloud-security',
      targetCapability: 'x', request: { question: 'q', evidence: {} },
    }, { baseDir: tmpBase })
    const result = markCompleted(r.path, {
      resolvedByAgent: 'KUBERA',
      verdict: 'CONFIRMED',
      verdictReason: 'GDPR Art. 44 violation',
      evidenceAdded: { framework: 'GDPR' },
      costActualUsd: 0.42,
    }, { baseDir: tmpBase })
    assert.ok(!fs.existsSync(r.path), 'inbox file must be moved')
    assert.ok(fs.existsSync(result.path), 'done file must exist')
    const parsed = JSON.parse(fs.readFileSync(result.path, 'utf-8'))
    assert.strictEqual(parsed.status, 'completed')
    assert.strictEqual(parsed.verdict, 'CONFIRMED')
    assert.strictEqual(parsed.cost_actual_usd, 0.42)
    assert.ok(parsed.resolved_at)
  } finally {
    fs.rmSync(tmpBase, { recursive: true, force: true })
  }
})

test('markFailed: moves to failed/ with reason', () => {
  const tmpBase = path.join(os.tmpdir(), `handoff-mark-fail-${Date.now()}`)
  try {
    const r = createHandoff({
      sourceTaskId: 'T1', sourceSquad: 'pentest', sourceAgent: 'A',
      sourceFindingId: 'F1', targetSquad: 'unknown-squad',
      targetCapability: 'x', request: { question: 'q', evidence: {} },
    }, { baseDir: tmpBase })
    const result = markFailed(r.path, 'no capability matching unknown-squad/x', { baseDir: tmpBase })
    assert.ok(!fs.existsSync(r.path), 'inbox file moved')
    assert.ok(fs.existsSync(result.path), 'failed file exists')
    const parsed = JSON.parse(fs.readFileSync(result.path, 'utf-8'))
    assert.strictEqual(parsed.status, 'failed')
    assert.match(parsed.failure_reason, /no capability/)
  } finally {
    fs.rmSync(tmpBase, { recursive: true, force: true })
  }
})

test('markCompleted: idempotent — second call is a no-op', () => {
  const tmpBase = path.join(os.tmpdir(), `handoff-idempotent-${Date.now()}`)
  try {
    const r = createHandoff({
      sourceTaskId: 'T1', sourceSquad: 'pentest', sourceAgent: 'A',
      sourceFindingId: 'F1', targetSquad: 'cloud-security',
      targetCapability: 'x', request: { question: 'q', evidence: {} },
    }, { baseDir: tmpBase })
    markCompleted(r.path, {
      resolvedByAgent: 'X', verdict: 'CONFIRMED', verdictReason: 'r',
    }, { baseDir: tmpBase })
    let threw = false
    try {
      markCompleted(r.path, {
        resolvedByAgent: 'X', verdict: 'REFUTED', verdictReason: 'r2',
      }, { baseDir: tmpBase })
    } catch { threw = true }
    assert.strictEqual(threw, false, 'second call must not throw')
  } finally {
    fs.rmSync(tmpBase, { recursive: true, force: true })
  }
})
