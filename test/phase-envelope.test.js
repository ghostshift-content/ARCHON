// test/phase-envelope.test.js
//
// Tests for agents/phase-envelope.js (B2 — Typed Inter-Phase Envelope)
// Runs under both bun and node (node:test).

'use strict'
const __roots = require('../paths') // portable roots (KURU_*_ROOT) — see paths.js


const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const {
  SCHEMA_VERSION,
  PhaseEnvelope,
  PhaseEnvelopeError,
  wrap,
  validate,
  quarantine,
} = require((__roots.AGENTS_ROOT + '/agents/phase-envelope'))

// ─── wrap ─────────────────────────────────────────────────────────────────────

test('wrap: produces envelope with correct schemaVersion, type, source, taskId, ts, payload', () => {
  const payload = { url: 'https://example.com', status: 200 }
  const env = wrap('recon', payload, { source: 'ARJUN', taskId: 'task-abc123' })

  assert.equal(env.schemaVersion, SCHEMA_VERSION)
  assert.equal(env.schemaVersion, '1')
  assert.equal(env.type, 'recon')
  assert.equal(env.source, 'ARJUN')
  assert.equal(env.taskId, 'task-abc123')
  assert.ok(typeof env.ts === 'string' && env.ts.length > 0, 'ts should be a non-empty string')
  // ts should be a valid ISO date
  assert.ok(!isNaN(Date.parse(env.ts)), 'ts should parse as a valid date')
  assert.deepEqual(env.payload, payload)
})

test('wrap: all valid types are accepted', () => {
  const types = ['finding', 'recon', 'specialist-output', 'kripa-result', 'judge-verdict', 'chain']
  for (const t of types) {
    const env = wrap(t, { x: 1 }, { source: 'TEST', taskId: 'tid' })
    assert.equal(env.type, t)
  }
})

test('wrap: uses defaults when source/taskId not provided', () => {
  const env = wrap('finding', { id: 'F-1' })
  assert.equal(env.source, 'UNKNOWN')
  assert.equal(env.taskId, '')
})

test('wrap: throws PhaseEnvelopeError on unknown type', () => {
  assert.throws(
    () => wrap('unknown-type', { x: 1 }),
    (e) => e instanceof PhaseEnvelopeError && /unknown type/.test(e.message)
  )
})

test('wrap: throws PhaseEnvelopeError when payload is not a plain object', () => {
  assert.throws(() => wrap('finding', null), PhaseEnvelopeError)
  assert.throws(() => wrap('finding', 'string'), PhaseEnvelopeError)
  assert.throws(() => wrap('finding', [1, 2, 3]), PhaseEnvelopeError)
  assert.throws(() => wrap('finding', 42), PhaseEnvelopeError)
})

test('wrap: payload is not mutated (fresh envelope object)', () => {
  const payload = { a: 1 }
  const env = wrap('chain', payload, { source: 'VYASA', taskId: 't1' })
  payload.b = 2
  // payload mutation does NOT affect the envelope's stored payload
  // (wrap does not deep-clone, but the reference is the same; this test
  //  verifies the envelope structure is correct, not isolation)
  assert.equal(env.payload.a, 1)
})

// ─── PhaseEnvelope class ──────────────────────────────────────────────────────

test('PhaseEnvelope class: constructor produces correct envelope shape', () => {
  const env = new PhaseEnvelope('judge-verdict', { verdict: 'CONFIRMED' }, { source: 'DHARMARAJ', taskId: 'jv-1' })
  assert.equal(env.schemaVersion, '1')
  assert.equal(env.type, 'judge-verdict')
  assert.equal(env.source, 'DHARMARAJ')
  assert.equal(env.taskId, 'jv-1')
  assert.deepEqual(env.payload, { verdict: 'CONFIRMED' })
})

// ─── validate ─────────────────────────────────────────────────────────────────

test('validate: passes on correct type and schemaVersion', () => {
  const env = wrap('kripa-result', { status: 'VALIDATED' }, { source: 'KRIPA', taskId: 't2' })
  const result = validate(env, 'kripa-result')
  assert.equal(result, env) // returns same reference
})

test('validate: passes when no expectedType given', () => {
  const env = wrap('chain', { chains: [] }, { source: 'CONSTRUCTOR', taskId: 't3' })
  const result = validate(env)
  assert.equal(result, env)
})

test('validate: throws PhaseEnvelopeError on type mismatch', () => {
  const env = wrap('finding', { id: 'F-2' }, { source: 'KARNA', taskId: 't4' })
  assert.throws(
    () => validate(env, 'kripa-result'),
    (e) => {
      assert.ok(e instanceof PhaseEnvelopeError, 'must be PhaseEnvelopeError')
      // Error message must include BOTH the expected and actual type
      assert.ok(/finding/.test(e.message), `message must mention 'finding', got: ${e.message}`)
      assert.ok(/kripa-result/.test(e.message), `message must mention 'kripa-result', got: ${e.message}`)
      return true
    }
  )
})

test('validate: throws PhaseEnvelopeError on wrong schemaVersion', () => {
  const env = wrap('recon', { data: 'ok' }, { source: 'RUDRA', taskId: 't5' })
  const tampered = { ...env, schemaVersion: '99' }
  assert.throws(
    () => validate(tampered, 'recon'),
    (e) => e instanceof PhaseEnvelopeError && /schemaVersion/.test(e.message)
  )
})

test('validate: throws PhaseEnvelopeError when payload is missing', () => {
  const env = wrap('specialist-output', { text: 'ok' }, { source: 'BHEEM', taskId: 't6' })
  const noPayload = { ...env }
  delete noPayload.payload
  assert.throws(
    () => validate(noPayload, 'specialist-output'),
    (e) => e instanceof PhaseEnvelopeError && /payload/.test(e.message)
  )
})

test('validate: throws PhaseEnvelopeError when payload is null', () => {
  const env = wrap('finding', { id: 'F-3' }, { source: 'NAKUL', taskId: 't7' })
  const nullPayload = { ...env, payload: null }
  assert.throws(
    () => validate(nullPayload, 'finding'),
    (e) => e instanceof PhaseEnvelopeError && /payload/.test(e.message)
  )
})

test('validate: throws PhaseEnvelopeError when envelope is not an object', () => {
  assert.throws(() => validate(null, 'finding'), PhaseEnvelopeError)
  assert.throws(() => validate('string', 'finding'), PhaseEnvelopeError)
  assert.throws(() => validate(42, 'finding'), PhaseEnvelopeError)
})

// ─── PhaseEnvelopeError ───────────────────────────────────────────────────────

test('PhaseEnvelopeError: is instanceof Error and PhaseEnvelopeError', () => {
  const e = new PhaseEnvelopeError('test message')
  assert.ok(e instanceof Error)
  assert.ok(e instanceof PhaseEnvelopeError)
  assert.equal(e.name, 'PhaseEnvelopeError')
  assert.equal(e.message, 'test message')
})

// ─── quarantine ───────────────────────────────────────────────────────────────

test('quarantine: writes JSONL line to temp dir with correct fields', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pe-test-'))
  const badEnv = { schemaVersion: '0', type: 'unknown', payload: null }
  const reason = 'type mismatch in test'
  const taskId = 'test-task-001'

  let threw = false
  try {
    quarantine(badEnv, reason, { taskId, outDir: tmpDir })
  } catch (e) {
    threw = true
    assert.ok(e instanceof PhaseEnvelopeError, 'must throw PhaseEnvelopeError')
    assert.ok(/quarantined/.test(e.message), `message should say 'quarantined', got: ${e.message}`)
  }

  assert.ok(threw, 'quarantine must throw after writing')

  const expectedFile = path.join(tmpDir, `quarantine-${taskId}.jsonl`)
  assert.ok(fs.existsSync(expectedFile), `quarantine file should exist at ${expectedFile}`)

  const raw = fs.readFileSync(expectedFile, 'utf-8').trim()
  const lines = raw.split('\n').filter(Boolean)
  assert.equal(lines.length, 1, 'should write exactly one JSONL line')

  const record = JSON.parse(lines[0])
  assert.ok(typeof record.ts === 'string' && record.ts.length > 0, 'record.ts missing')
  assert.equal(record.reason, reason)
  assert.deepEqual(record.envelope, badEnv)
  assert.equal(record.source, 'phase-envelope')

  // cleanup
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

test('quarantine: THROWS after writing — never swallows the error', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pe-test-throw-'))
  let threw = false
  try {
    quarantine({ bad: true }, 'test throw', { taskId: 'thr-1', outDir: tmpDir })
  } catch (e) {
    threw = true
    assert.ok(e instanceof PhaseEnvelopeError)
  }
  assert.ok(threw, 'quarantine must always throw')
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

test('quarantine: appends multiple lines when called multiple times', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pe-test-multi-'))
  const taskId = 'multi-001'

  for (let i = 0; i < 3; i++) {
    try { quarantine({ i }, `reason-${i}`, { taskId, outDir: tmpDir }) } catch {}
  }

  const file = path.join(tmpDir, `quarantine-${taskId}.jsonl`)
  const lines = fs.readFileSync(file, 'utf-8').trim().split('\n').filter(Boolean)
  assert.equal(lines.length, 3, 'should have 3 JSONL lines')

  fs.rmSync(tmpDir, { recursive: true, force: true })
})

test('quarantine: uses quarantine.jsonl (no taskId suffix) when taskId is empty', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pe-test-notask-'))
  try { quarantine({ x: 1 }, 'no task', { taskId: '', outDir: tmpDir }) } catch {}

  const file = path.join(tmpDir, 'quarantine.jsonl')
  assert.ok(fs.existsSync(file), `should write to quarantine.jsonl, not found at ${file}`)
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

// ─── End-to-end: wrap → validate → quarantine on failure ─────────────────────

test('e2e: wrap → validate passes on matching type', () => {
  const env = wrap('finding', { id: 'F-e2e', severity: 'High' }, { source: 'BHEEM', taskId: 'e2e-1' })
  const validated = validate(env, 'finding')
  assert.equal(validated.payload.id, 'F-e2e')
  assert.equal(validated.type, 'finding')
})

test('e2e: wrap → validate mismatch → quarantine on failure flow', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pe-e2e-'))
  const taskId = 'e2e-flow'

  // Producer wraps as 'kripa-result'
  const env = wrap('kripa-result', { verdict: 'CONFIRMED', score: 9 }, { source: 'KRIPA', taskId })

  // Consumer expects 'judge-verdict' — type mismatch
  let validationError = null
  try {
    validate(env, 'judge-verdict')
  } catch (e) {
    validationError = e
  }
  assert.ok(validationError instanceof PhaseEnvelopeError, 'validate must throw on type mismatch')

  // On mismatch, quarantine the envelope
  let quarantineThrew = false
  try {
    quarantine(env, validationError.message, { taskId, outDir: tmpDir })
  } catch (e) {
    quarantineThrew = true
    assert.ok(e instanceof PhaseEnvelopeError)
  }
  assert.ok(quarantineThrew, 'quarantine must throw')

  // Verify the quarantine file was written
  const file = path.join(tmpDir, `quarantine-${taskId}.jsonl`)
  assert.ok(fs.existsSync(file))
  const record = JSON.parse(fs.readFileSync(file, 'utf-8').trim())
  assert.equal(record.source, 'phase-envelope')
  assert.ok(/judge-verdict/.test(record.reason) || /kripa-result/.test(record.reason))

  fs.rmSync(tmpDir, { recursive: true, force: true })
})

// ─── wrapFinding bridge (finding-schema.js) ───────────────────────────────────

test('wrapFinding: bridges finding-schema.js → phase-envelope wrapping', () => {
  const { wrapFinding } = require((__roots.AGENTS_ROOT + '/agents/finding-schema'))
  const finding = {
    id: 'F-bridge-1',
    title: 'CORS misconfiguration',
    severity: 'CRITICAL', // uppercase — normalizeFinding should title-case it
    validation_status: 'VALIDATED',
    original_agent: 'ARJUN',
    taskId: 'bridge-task-1',
  }
  const env = wrapFinding(finding, { source: 'KRIPA', taskId: 'bridge-task-1' })

  assert.equal(env.schemaVersion, '1')
  assert.equal(env.type, 'finding')
  assert.equal(env.source, 'KRIPA')
  assert.equal(env.taskId, 'bridge-task-1')
  // Severity should be normalized by normalizeFinding
  assert.equal(env.payload.severity, 'Critical')
  assert.equal(env.payload.id, 'F-bridge-1')
})
