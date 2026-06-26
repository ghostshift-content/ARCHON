// agents/quality-tracker.js
//
// 2026-06-05: Per-squad quality baseline tracker.
//
// PROBLEM: Every quality number in the docs is fictional. "The SDK didn't
// change quality" was proven for one run by comparison — but there's no
// baseline number you can actually track over time.
//
// FIX: After every graded task, record quality metrics to quality.jsonl.
// Then provide getSquadBaseline() for windowed aggregation and
// snapshotAllSquads() to write quality-snapshot.json (the "quality.json"
// from THE-FRAMEWORK.md).
//
// USAGE:
//   const qt = require('./agents/quality-tracker')
//   qt.recordRunQuality({ taskId, squad, agentName, passed, total, gradeScore, costUsd, durationMs, adapterUsed })
//   const baseline = qt.getSquadBaseline('pentest', { windowDays: 30 })
//   await qt.snapshotAllSquads()
//
// ATOMICITY: appendFileSync is atomic for lines < PIPE_BUF (~4KB) on Linux.

'use strict'
const __roots = require('../paths') // portable roots (KURU_*_ROOT) — see paths.js


const fs = require('fs')
const path = require('path')

// ---------------------------------------------------------------------------
// Production squads
// ---------------------------------------------------------------------------

const PRODUCTION_SQUADS = ['pentest', 'stocks', 'cloud-security', 'network-pentest', 'code-review']

// ---------------------------------------------------------------------------
// Default output directory
// ---------------------------------------------------------------------------

const DEFAULT_OUT_DIR = __roots.INTEL_ROOT

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function _qualityFile(outDir) {
  return path.join(outDir || DEFAULT_OUT_DIR, 'quality.jsonl')
}

function _snapshotFile(outDir) {
  return path.join(outDir || DEFAULT_OUT_DIR, 'quality-snapshot.json')
}

function _appendLine(file, obj) {
  const dir = path.dirname(file)
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true })
  }
  fs.appendFileSync(file, JSON.stringify(obj) + '\n', 'utf8')
}

function _readLines(file) {
  if (!fs.existsSync(file)) return []
  try {
    const raw = fs.readFileSync(file, 'utf8').trim()
    if (!raw) return []
    return raw.split('\n').filter(Boolean).map((l) => {
      try { return JSON.parse(l) } catch { return null }
    }).filter(Boolean)
  } catch {
    return []
  }
}

// ---------------------------------------------------------------------------
// recordRunQuality
// ---------------------------------------------------------------------------

/**
 * Append one quality record to quality.jsonl.
 *
 * Called after every graded task. Fail-soft: wrap in try/catch at call site.
 *
 * @param {object} opts
 * @param {string}  opts.taskId       - Task ID
 * @param {string}  opts.squad        - Squad name (e.g. 'pentest')
 * @param {string}  opts.agentName    - Leader or primary agent name
 * @param {number}  opts.passed       - Number of expectations passed
 * @param {number}  opts.total        - Total expectations
 * @param {number}  opts.gradeScore   - Normalised pass rate 0–100 (or 0–1 float)
 * @param {number}  opts.costUsd      - Total cost for this task in USD
 * @param {number}  opts.durationMs   - Wall-clock duration for this task
 * @param {string}  opts.adapterUsed  - 'cli' or 'sdk'
 * @param {string}  [opts.outDir]     - Output directory override (for tests)
 */
function recordRunQuality({ taskId, squad, agentName, passed, total, gradeScore, costUsd, durationMs, adapterUsed, outDir } = {}) {
  const file = _qualityFile(outDir)

  // UNGRADED (2026-06-08): a run with no eval expectations (gradeTask → null) is NOT a
  // grade-0 failure — it's simply unmeasured. Recording it as 0 poisoned the quality
  // baseline AND the learning loop (which read 0 < 0.5 as a "low-grade failure" and fired
  // spurious self-improvement proposals). Mark it ungraded; baseline + learning skip it.
  const ungraded = gradeScore === null || gradeScore === undefined
  const passedNum = ungraded ? null : (Number(passed) || 0)
  const totalNum = ungraded ? null : (Number(total) || 1)
  const passRate = ungraded ? null : (totalNum > 0 ? passedNum / totalNum : 0)

  // Normalise gradeScore: accept both 0–100 and 0–1
  let score = ungraded ? null : (Number(gradeScore) || 0)
  if (score !== null && score > 1 && score <= 100) score = score / 100

  const record = {
    ts: new Date().toISOString(),
    taskId: taskId || null,
    squad: squad || null,
    agentName: agentName || null,
    passed: passedNum,
    total: totalNum,
    passRate,
    gradeScore: score,
    ungraded,
    costUsd: Number(costUsd) || 0,
    durationMs: Number(durationMs) || 0,
    adapterUsed: adapterUsed || null,
  }
  _appendLine(file, record)

  // Watchdog: check if any auto-applied squad config caused quality regression
  if (!outDir) {
    try {
      const autoApplier = require('./auto-applier')
      autoApplier.watchdogCheck()
    } catch {
      // fail-soft — watchdog must never break quality recording
    }
  }
}

// ---------------------------------------------------------------------------
// getSquadBaseline
// ---------------------------------------------------------------------------

/**
 * Aggregate quality metrics for a squad over a time window.
 *
 * @param {string} squad              - Squad name
 * @param {object} [opts]
 * @param {number}  [opts.windowDays=30] - Look-back window in days
 * @param {string}  [opts.outDir]        - Output directory override (for tests)
 * @returns {object} Baseline metrics or {squad, windowDays, runs:0, noData:true}
 */
function getSquadBaseline(squad, { windowDays = 30, outDir } = {}) {
  const file = _qualityFile(outDir)
  const lines = _readLines(file)

  const cutoff = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000).toISOString()
  // exclude ungraded runs — they have no quality signal and would drag the baseline to 0
  const matching = lines.filter((r) => r.squad === squad && r.ts >= cutoff && !r.ungraded && r.gradeScore !== null)

  if (matching.length === 0) {
    return { squad, windowDays, runs: 0, noData: true }
  }

  const runs = matching.length
  const avgPassRate = matching.reduce((s, r) => s + (r.passRate || 0), 0) / runs
  const avgGradeScore = matching.reduce((s, r) => s + (r.gradeScore || 0), 0) / runs
  const avgCostUsd = matching.reduce((s, r) => s + (r.costUsd || 0), 0) / runs

  // p50 durationMs
  const durations = matching.map((r) => r.durationMs || 0).sort((a, b) => a - b)
  const p50DurationMs = durations[Math.floor(runs / 2)] || 0

  // Adapter breakdown
  const adapterBreakdown = { sdk: 0, cli: 0 }
  for (const r of matching) {
    const a = r.adapterUsed || 'sdk' // unset = pure-SDK cutover default (matches resolvedAdapterName)
    if (a === 'sdk') adapterBreakdown.sdk++
    else adapterBreakdown.cli++
  }

  return {
    squad,
    windowDays,
    runs,
    avgPassRate: Math.round(avgPassRate * 10000) / 10000,
    avgGradeScore: Math.round(avgGradeScore * 10000) / 10000,
    avgCostUsd: Math.round(avgCostUsd * 10000) / 10000,
    p50DurationMs,
    adapterBreakdown,
  }
}

// ---------------------------------------------------------------------------
// snapshotAllSquads
// ---------------------------------------------------------------------------

/**
 * Build baselines for all 5 production squads and write quality-snapshot.json.
 *
 * This is the "quality.json" referenced in THE-FRAMEWORK.md.
 *
 * @param {object} [opts]
 * @param {number}  [opts.windowDays=30] - Look-back window in days
 * @param {string}  [opts.outDir]        - Output directory override (for tests)
 * @returns {object} The snapshot written to disk
 */
function snapshotAllSquads({ windowDays = 30, outDir } = {}) {
  const squads = {}
  for (const squad of PRODUCTION_SQUADS) {
    squads[squad] = getSquadBaseline(squad, { windowDays, outDir })
  }

  const snapshot = {
    ts: new Date().toISOString(),
    windowDays,
    squads,
  }

  const file = _snapshotFile(outDir)
  const dir = path.dirname(file)
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true })
  }
  fs.writeFileSync(file, JSON.stringify(snapshot, null, 2) + '\n', 'utf8')
  return snapshot
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  PRODUCTION_SQUADS,
  recordRunQuality,
  getSquadBaseline,
  snapshotAllSquads,
}
