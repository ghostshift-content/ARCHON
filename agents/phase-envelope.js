// agents/phase-envelope.js
//
// B2: Typed Inter-Phase Envelope (2026-06-05)
//
// Root-cause fix for the silent-drop/stale-field class of phase-seam bugs:
//   - AUDITOR→judge VERDICT_RE breakage (May 11 + May 15, silently starved Phase 3.075+3.9)
//   - Gulf Oil dashboard bug (May 15, wrong field names crossed a seam)
//   - 22 distinct key signatures across 48 findings (finding-schema audit)
//
// Every datum flowing between phases is wrapped in a PhaseEnvelope. The
// envelope carries a schemaVersion, type tag, provenance, and timestamp so
// that the receiving phase can assert what it expects before unpacking.
//
// On type mismatch or structural violation → PhaseEnvelopeError is THROWN.
// On quarantine → a JSONL line is written to the quarantine file AND then
// re-thrown. This implements fail-into-quarantine-LOUD: never swallow errors.
//
// CommonJS. No external dependencies. Standalone (no imports from event-bus.js).

'use strict'
const __roots = require('../paths') // portable roots (KURU_*_ROOT) — see paths.js


const fs = require('node:fs')
const path = require('node:path')

// ─── Constants ───────────────────────────────────────────────────────────────

const SCHEMA_VERSION = '1'

const VALID_TYPES = new Set([
  'finding',
  'recon',
  'specialist-output',
  'auditor-result',
  'judge-verdict',
  'chain',
])

// ─── PhaseEnvelopeError ──────────────────────────────────────────────────────

class PhaseEnvelopeError extends Error {
  constructor(message) {
    super(message)
    this.name = 'PhaseEnvelopeError'
  }
}

// ─── wrap ─────────────────────────────────────────────────────────────────────

/**
 * Create a valid PhaseEnvelope.
 *
 * @param {string} type        - One of VALID_TYPES
 * @param {object} payload     - The content to carry
 * @param {object} opts
 * @param {string} opts.source - Agent name who produced this (e.g. 'AUDITOR')
 * @param {string} opts.taskId - The dispatch task ID
 * @returns {object} PhaseEnvelope
 */
function wrap(type, payload, { source = 'UNKNOWN', taskId = '' } = {}) {
  if (!VALID_TYPES.has(type)) {
    throw new PhaseEnvelopeError(
      `[phase-envelope] invalid: unknown type '${type}' — must be one of: ${[...VALID_TYPES].join(', ')}`
    )
  }
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new PhaseEnvelopeError(
      `[phase-envelope] invalid: payload must be a plain object, got ${Array.isArray(payload) ? 'array' : typeof payload}`
    )
  }
  return {
    schemaVersion: SCHEMA_VERSION,
    type,
    source: String(source),
    taskId: String(taskId),
    ts: new Date().toISOString(),
    payload,
  }
}

// ─── validate ─────────────────────────────────────────────────────────────────

/**
 * Validate a PhaseEnvelope against the expected type.
 *
 * Throws PhaseEnvelopeError on:
 *   - Wrong or missing schemaVersion
 *   - Type mismatch
 *   - Missing or non-object payload
 *
 * Returns the validated envelope on success.
 *
 * @param {*}      envelope     - The envelope to validate
 * @param {string} expectedType - The type the receiver expects
 * @returns {object} The validated envelope (same reference)
 */
function validate(envelope, expectedType) {
  if (envelope === null || typeof envelope !== 'object' || Array.isArray(envelope)) {
    throw new PhaseEnvelopeError(
      `[phase-envelope] invalid: envelope is not an object (got ${envelope === null ? 'null' : typeof envelope})`
    )
  }

  if (envelope.schemaVersion !== SCHEMA_VERSION) {
    throw new PhaseEnvelopeError(
      `[phase-envelope] invalid: schemaVersion mismatch — expected '${SCHEMA_VERSION}', got '${envelope.schemaVersion}'`
    )
  }

  if (expectedType !== undefined && envelope.type !== expectedType) {
    throw new PhaseEnvelopeError(
      `[phase-envelope] invalid: type mismatch — expected '${expectedType}', got '${envelope.type}'`
    )
  }

  if (envelope.payload === null || typeof envelope.payload !== 'object' || Array.isArray(envelope.payload)) {
    throw new PhaseEnvelopeError(
      `[phase-envelope] invalid: payload must be a plain object, got ${envelope.payload === null ? 'null' : Array.isArray(envelope.payload) ? 'array' : typeof envelope.payload}`
    )
  }

  return envelope
}

// ─── quarantine ───────────────────────────────────────────────────────────────

/**
 * Write the invalid envelope to a quarantine JSONL file, then THROW.
 * Never silently drops. This is fail-into-quarantine-LOUD.
 *
 * @param {*}      envelope         - The invalid envelope (any value)
 * @param {string} reason           - Human-readable reason for quarantine
 * @param {object} opts
 * @param {string} [opts.taskId]    - Task ID for the quarantine filename
 * @param {string} [opts.outDir]    - Directory override (default: /root/intel)
 * @throws {PhaseEnvelopeError} Always throws after writing the quarantine record
 */
function quarantine(envelope, reason, { taskId = '', outDir } = {}) {
  const dir = outDir || __roots.INTEL_ROOT
  const suffix = taskId ? `-${taskId}` : ''
  const file = path.join(dir, `quarantine${suffix}.jsonl`)

  const record = {
    ts: new Date().toISOString(),
    reason: String(reason),
    envelope,
    source: 'phase-envelope',
  }

  try {
    // Ensure directory exists (for test temp dirs)
    fs.mkdirSync(dir, { recursive: true })
    fs.appendFileSync(file, JSON.stringify(record) + '\n', 'utf-8')
  } catch (writeErr) {
    // Even if the write fails, we still throw — fail-LOUD always
    throw new PhaseEnvelopeError(
      `[phase-envelope] quarantine write failed (${writeErr.message}) — original reason: ${reason}`
    )
  }

  throw new PhaseEnvelopeError(
    `[phase-envelope] quarantined: ${reason}`
  )
}

// ─── PhaseEnvelope class (optional OO interface) ─────────────────────────────

/**
 * PhaseEnvelope class — thin wrapper around wrap/validate/quarantine.
 * The factory functions above are the primary API; this class is for callers
 * that prefer OO syntax.
 */
class PhaseEnvelope {
  /**
   * @param {string} type
   * @param {object} payload
   * @param {object} opts - { source, taskId }
   */
  constructor(type, payload, opts = {}) {
    const env = wrap(type, payload, opts)
    Object.assign(this, env)
  }
}

// ─── Exports ──────────────────────────────────────────────────────────────────

module.exports = {
  SCHEMA_VERSION,
  VALID_TYPES,
  PhaseEnvelope,
  PhaseEnvelopeError,
  wrap,
  validate,
  quarantine,
}
