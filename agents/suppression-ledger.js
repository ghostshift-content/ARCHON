// agents/suppression-ledger.js
//
// 2026-06-05: Suppression visibility ledger — GATE-SUPPRESSION-VISIBLE.
//
// PROBLEM: 4 down-weight-only filters (oracle-can't-confirm, AUDITOR-skeptical,
// judge-needs-quote, severity-cap) have no counterweight. A genuine CRITICAL
// with no quotable string silently gets downgraded to Low. For a pentest
// framework, that's a bounty missed.
//
// FIX: Every downweight gets a JSONL entry in suppression-ledger.jsonl.
// Genuine high-confidence low-evidence findings also get escalated to
// manual-review-queue.jsonl instead of silently dying.
//
// USAGE:
//   const suppressionLedger = require('./suppression-ledger')
//   suppressionLedger.logSuppression({ taskId, finding, filterName, reason, fromSeverity, toSeverity, squad })
//   suppressionLedger.logManualReviewNeeded({ taskId, finding, reason, squad })
//   const isEscalate = suppressionLedger.isHighConvictionLowEvidence(finding)
//   const count = suppressionLedger.getSuppressionCount({ taskId })
//
// ATOMICITY: appendFileSync is atomic for lines < PIPE_BUF (~4KB) on Linux.
// Single-writer per-line: no lock needed.

'use strict'
const __roots = require('../paths') // portable roots (KURU_*_ROOT) — see paths.js


const fs = require('fs')
const path = require('path')

// ---------------------------------------------------------------------------
// Default output directory — overridable for tests
// ---------------------------------------------------------------------------

const DEFAULT_OUT_DIR = __roots.INTEL_ROOT

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function _suppressionFile(outDir) {
  return path.join(outDir || DEFAULT_OUT_DIR, 'suppression-ledger.jsonl')
}

function _manualReviewFile(outDir) {
  return path.join(outDir || DEFAULT_OUT_DIR, 'manual-review-queue.jsonl')
}

function _appendLine(file, obj) {
  const dir = path.dirname(file)
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true })
  }
  fs.appendFileSync(file, JSON.stringify(obj) + '\n', 'utf8')
}

function _findingId(finding) {
  return (finding && (finding.id || finding.findingId)) || null
}

function _findingTitle(finding) {
  return (finding && finding.title) || ''
}

// ---------------------------------------------------------------------------
// logSuppression
// ---------------------------------------------------------------------------

/**
 * Log a severity downgrade to suppression-ledger.jsonl.
 *
 * Called from any phase that modifies finding severity/status. Fail-soft:
 * callers should wrap in try/catch — a ledger write failure must NEVER
 * break the pipeline.
 *
 * @param {object} opts
 * @param {string}  opts.taskId       - Task ID (required)
 * @param {object}  opts.finding      - The finding object being suppressed
 * @param {string}  opts.filterName   - Which filter applied (e.g. 'severity-profile')
 * @param {string}  opts.reason       - Human-readable reason for the downgrade
 * @param {string}  opts.fromSeverity - Original severity level
 * @param {string}  opts.toSeverity   - New (downgraded) severity level
 * @param {string}  [opts.squad]      - Squad name
 * @param {string}  [opts.outDir]     - Output directory override (for tests)
 */
function logSuppression({ taskId, finding, filterName, reason, fromSeverity, toSeverity, squad, outDir } = {}) {
  const file = _suppressionFile(outDir)
  const record = {
    ts: new Date().toISOString(),
    taskId: taskId || null,
    findingId: _findingId(finding),
    findingTitle: _findingTitle(finding),
    filterName: filterName || null,
    reason: reason || null,
    fromSeverity: fromSeverity || null,
    toSeverity: toSeverity || null,
    squad: squad || null,
  }
  _appendLine(file, record)
}

// ---------------------------------------------------------------------------
// logManualReviewNeeded
// ---------------------------------------------------------------------------

/**
 * Log a finding to manual-review-queue.jsonl when high-conviction + low-evidence.
 *
 * This is the promotion counterweight: when confidence is HIGH but machine
 * evidence is LOW, escalate to human review instead of auto-dropping.
 *
 * @param {object} opts
 * @param {string}  opts.taskId   - Task ID (required)
 * @param {object}  opts.finding  - The finding object
 * @param {string}  opts.reason   - Why manual review is needed
 * @param {string}  [opts.squad]  - Squad name
 * @param {string}  [opts.outDir] - Output directory override (for tests)
 */
function logManualReviewNeeded({ taskId, finding, reason, squad, outDir } = {}) {
  const file = _manualReviewFile(outDir)
  const record = {
    ts: new Date().toISOString(),
    taskId: taskId || null,
    findingId: _findingId(finding),
    findingTitle: _findingTitle(finding),
    reason: reason || null,
    squad: squad || null,
    status: 'pending',
  }
  _appendLine(file, record)
}

// ---------------------------------------------------------------------------
// isHighConvictionLowEvidence
// ---------------------------------------------------------------------------

/**
 * Returns true if a finding is high-conviction (severity >= high) but
 * low-evidence (not CONFIRMED, no oracle-confirmed field).
 *
 * Used by callers to decide whether to logManualReviewNeeded vs silent drop.
 *
 * @param {object} finding
 * @returns {boolean}
 */
function isHighConvictionLowEvidence(finding) {
  if (!finding || typeof finding !== 'object') return false

  // Severity check — high/critical by ORIGINAL severity, so a finding already
  // downgraded High→Low by an upstream filter still counts (that's the exact
  // suppression case the counterweight exists for — not just currently-high ones).
  const sev = String(
    finding.severity_original || finding.original_severity || finding.severity || ''
  ).toLowerCase()
  const isHighSev = sev === 'high' || sev === 'critical'
  if (!isHighSev) return false

  // Validation status — must NOT be CONFIRMED
  const vStatus = (finding.validation_status || '').toUpperCase()
  const isConfirmed = vStatus === 'CONFIRMED'
  if (isConfirmed) return false

  // Oracle check — no oracle-confirmed field
  const hasOracle = Boolean(finding['oracle-confirmed'] || finding.oracle_confirmed)
  if (hasOracle) return false

  return true
}

// ---------------------------------------------------------------------------
// getSuppressionCount
// ---------------------------------------------------------------------------

/**
 * Read suppression-ledger.jsonl and return count of entries for a taskId.
 * Returns 0 if file doesn't exist or taskId has no entries.
 *
 * @param {object} opts
 * @param {string}  opts.taskId   - Task ID to count
 * @param {string}  [opts.outDir] - Output directory override (for tests)
 * @returns {number}
 */
function getSuppressionCount({ taskId, outDir } = {}) {
  const file = _suppressionFile(outDir)
  if (!fs.existsSync(file)) return 0
  let count = 0
  try {
    const raw = fs.readFileSync(file, 'utf8').trim()
    if (!raw) return 0
    for (const line of raw.split('\n')) {
      if (!line) continue
      try {
        const parsed = JSON.parse(line)
        if (parsed.taskId === taskId) count++
      } catch {}
    }
  } catch {}
  return count
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  logSuppression,
  logManualReviewNeeded,
  isHighConvictionLowEvidence,
  getSuppressionCount,
}
