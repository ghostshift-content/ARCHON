// agents/finding-schema.js
//
// Sprint A.2 (2026-05-09): canonical FindingSchema normalizer.
//
// Production audit on /root/intel/pentest/VALIDATED-FINDINGS.jsonl (48 findings)
// found 22 distinct key signatures, severity in 3 case variants, 42/48 missing
// `title`, and two schema families (DHARMA-style / DURYODHANA-style). Downstream
// components silently broke on the variance (e.g., severity case-sensitive
// comparisons skipped half the findings; missing `title` produced "(no title)"
// in judge prompts that anchored Stage A on absence of context).
//
// This module is the SINGLE source of truth for finding-record shape between
// the specialist→KRIPA write boundary and any downstream reader (judge, browser
// verifier, VYASA). Belt-and-suspenders with judge-verifier's extractEvidence:
// normalize the record once, stringify object fields in the prompt builder.

const fs = require('node:fs')
const { wrap: _envelopeWrap } = require('./phase-envelope')

const CANONICAL_SEVERITIES = ['Info', 'Low', 'Medium', 'High', 'Critical']

const REQUIRED_FIELDS = ['id', 'title', 'severity', 'validation_status', 'original_agent', 'taskId']

let _autoIdCounter = 0
function _autoId() {
  _autoIdCounter += 1
  return `F-AUTO-${Date.now()}-${_autoIdCounter}`
}

/**
 * Coerce severity to title-case canonical form.
 * Unknown/missing → 'Medium' (safe default — too low fails Stage B; too high primes false-confidence).
 */
function normalizeSeverity(s) {
  if (s == null) return 'Medium'
  const m = String(s).match(/^(critical|high|medium|low|info)/i)
  if (!m) return 'Medium'
  const lc = m[1].toLowerCase()
  return lc.charAt(0).toUpperCase() + lc.slice(1)
}

/**
 * Normalize a finding record to canonical schema. Non-destructive: returns
 * a fresh object; original input is not mutated. Object-shaped fields like
 * `evidence` are PRESERVED (judge-verifier's extractEvidence handles them).
 *
 * Canonical fields (always present after normalize):
 *   - id        — falls back to findingId, then synthesized "anon-{n}"
 *   - title     — falls back to id-based label, then type, then "Untitled finding"
 *   - severity  — title-cased canonical (Critical/High/Medium/Low/Info)
 *
 * All other input fields are passed through unchanged.
 */
function normalizeFinding(finding) {
  const f = finding && typeof finding === 'object' ? { ...finding } : {}

  f.severity = normalizeSeverity(f.severity)

  // id: prefer existing, else map findingId
  if (!f.id && f.findingId) {
    f.id = f.findingId
  }

  // title: prefer existing, then synthesize
  if (!f.title || (typeof f.title === 'string' && !f.title.trim())) {
    if (f.id) {
      f.title = `Finding ${f.id}`
    } else if (f.type) {
      f.title = `Untitled ${f.type} finding`
    } else {
      f.title = 'Untitled finding'
    }
  }

  return f
}

/**
 * Validates + auto-repairs a finding for safe consumption by downstream phases.
 *
 * Returns { valid, finding, warnings }.
 *   - valid=false only when input isn't a plain object (cannot be repaired).
 *   - finding is the (possibly-repaired) shallow clone — never the input ref.
 *   - warnings is an array of human-readable strings describing each auto-repair.
 *
 * Policy: never reject a salvageable finding. Schema drift is logged, not
 * silently dropped. The original_agent + taskId provenance is preserved
 * even when other fields are synthesized.
 */
function validateFinding(input) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    return { valid: false, finding: null, warnings: ['input is not a plain object'] }
  }

  const warnings = []
  const finding = { ...input }

  if (!finding.id) {
    finding.id = _autoId()
    warnings.push(`missing id — synthesized ${finding.id}`)
  }
  if (!finding.title) {
    finding.title = finding.id
    warnings.push(`missing title — defaulted to id (${finding.title})`)
  }
  if (!finding.severity) {
    finding.severity = 'Medium'
    warnings.push('missing severity — defaulted to Medium')
  } else {
    finding.severity = normalizeSeverity(finding.severity)
  }
  if (!finding.validation_status) {
    finding.validation_status = 'unknown'
    warnings.push('missing validation_status — defaulted to unknown')
  }
  if (!finding.original_agent) {
    finding.original_agent = 'UNKNOWN'
    warnings.push('missing original_agent — defaulted to UNKNOWN')
  }
  if (!finding.taskId) {
    finding.taskId = ''
    warnings.push('missing taskId — defaulted to empty string')
  }

  return { valid: true, finding, warnings }
}

/**
 * Read a JSONL findings file, parse each line, normalize each record.
 * Skips malformed lines (logs to stderr in dev). Returns [] for missing file.
 *
 * Use this at every read boundary instead of inline fs.readFileSync + JSON.parse,
 * so downstream code never sees raw specialist output drift.
 */
function readFindingsFile(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return []
  const raw = fs.readFileSync(filePath, 'utf-8')
  const lines = raw.split('\n').map(l => l.trim()).filter(Boolean)
  const findings = []
  for (const line of lines) {
    try {
      findings.push(normalizeFinding(JSON.parse(line)))
    } catch {
      // malformed line — skip silently (typical when KRIPA writes mid-flush)
    }
  }
  return findings
}

/**
 * Wrap a finding in a typed PhaseEnvelope.
 *
 * Bridges the new envelope system without breaking existing validateFinding callers.
 * The finding is normalized before wrapping.
 *
 * @param {object} finding          - Raw or pre-validated finding object
 * @param {object} opts
 * @param {string} opts.source      - Agent name who produced this (e.g. 'KRIPA')
 * @param {string} opts.taskId      - The dispatch task ID
 * @returns {object} PhaseEnvelope with type='finding'
 */
function wrapFinding(finding, { source = 'UNKNOWN', taskId = '' } = {}) {
  const normalized = normalizeFinding(finding)
  return _envelopeWrap('finding', normalized, { source, taskId })
}

module.exports = {
  normalizeFinding,
  normalizeSeverity,
  readFindingsFile,
  validateFinding,
  wrapFinding,
  CANONICAL_SEVERITIES,
  REQUIRED_FIELDS,
}
