// agents/episode-record.js
//
// Typed Feedback / episode record for OBSERVE + gated learning loop (B7, 2026-06-05).
//
// PURPOSE: The trajectory-observer grovels over polluted JSONL logs, forcing
// schema_version filter workarounds. The OBSERVE stage of the learning loop
// must consume TYPED episode records emitted at phase completion — not grep
// log files. "If the loop learns from polluted feedback, it learns the
// pollution." (THE-FRAMEWORK.md)
//
// USAGE:
//   const er = require('./agents/episode-record')
//   er.emitEpisode({ taskId, squad, agentName, phase, outcome, gradeScore,
//                    costUsd, durationMs, adapterUsed, suppressionCount,
//                    findingCount, errorMessage })
//   const episodes = er.readEpisodes({ windowDays: 7, squad: 'pentest' })
//
// ATOMICITY: appendFileSync is atomic for lines < PIPE_BUF (~4KB) on Linux.
// FAIL-SOFT:  emitEpisode never throws — errors are logged to stderr only.

'use strict'
const __roots = require('../paths') // portable roots (KURU_*_ROOT) — see paths.js


const fs = require('fs')
const path = require('path')

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const EPISODE_VERSION = '1'

const EPISODE_OUTCOMES = ['completed', 'failed', 'timeout', 'cancelled', 'rate-limited']

// ---------------------------------------------------------------------------
// Default output directory
// ---------------------------------------------------------------------------

const DEFAULT_OUT_DIR = __roots.INTEL_ROOT

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function _episodesDir(outDir) {
  return path.join(outDir || DEFAULT_OUT_DIR, 'episodes')
}

function _episodesFile(outDir) {
  return path.join(_episodesDir(outDir), 'episodes.jsonl')
}

// ---------------------------------------------------------------------------
// validateOutcome
// ---------------------------------------------------------------------------

/**
 * Returns true if `outcome` is one of the known EPISODE_OUTCOMES.
 * @param {string} outcome
 * @returns {boolean}
 */
function validateOutcome(outcome) {
  return EPISODE_OUTCOMES.includes(outcome)
}

// ---------------------------------------------------------------------------
// emitEpisode
// ---------------------------------------------------------------------------

/**
 * Write ONE typed episode record to episodes/episodes.jsonl (mkdir -p on first write).
 * NEVER throws — any error is caught and logged to stderr.
 *
 * @param {object} opts
 * @param {string}  opts.taskId
 * @param {string}  opts.squad
 * @param {string}  opts.agentName
 * @param {string}  opts.phase
 * @param {string}  opts.outcome          - One of EPISODE_OUTCOMES
 * @param {number}  [opts.gradeScore]     - 0–1 float (or 0–100, normalised internally)
 * @param {number}  [opts.costUsd]
 * @param {number}  [opts.durationMs]
 * @param {string}  [opts.adapterUsed]    - 'cli' | 'sdk'
 * @param {number}  [opts.suppressionCount]
 * @param {number}  [opts.findingCount]
 * @param {number}  [opts.waveNumber]      - Which parallel wave this agent ran in (1, 2, 3=conditional)
 * @param {boolean} [opts.reflexionContextUsed] - Whether reflexion critique was injected into this agent
 * @param {string}  [opts.actualModel]    - Actual model string used (from cost.model)
 * @param {string}  [opts.errorMessage]
 * @param {string}  [opts.outDir]         - Override for tests
 */
function emitEpisode({
  taskId,
  squad,
  agentName,
  phase,
  outcome,
  gradeScore,
  costUsd,
  durationMs,
  adapterUsed,
  suppressionCount,
  findingCount,
  waveNumber,
  reflexionContextUsed,
  actualModel,
  errorMessage,
  outDir,
} = {}) {
  try {
    const episodesFile = _episodesFile(outDir)
    // mkdir -p on first write
    const dir = path.dirname(episodesFile)
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true })
    }

    // Normalise gradeScore: accept both 0–100 and 0–1. UNGRADED (null/undefined/
    // non-finite) → null (honest "unknown"), NOT a fake 0: the grade is genuinely not
    // known at emission (settle=Phase 2, grading=Phase 5); updateTaskGrade backfills the
    // real score later. A fake 0 poisons distill (looks like a failed run) and starves
    // memory-from-success (can't tell ungraded from scored-zero).
    let score = null
    if (gradeScore !== null && gradeScore !== undefined && Number.isFinite(Number(gradeScore))) {
      score = Number(gradeScore)
      if (score > 1 && score <= 100) score = score / 100
    }

    const record = {
      epVersion: EPISODE_VERSION,
      ts: new Date().toISOString(),
      taskId: taskId || null,
      squad: squad || null,
      agentName: agentName || null,
      phase: phase || null,
      outcome: outcome || null,
      gradeScore: score,
      costUsd: Number(costUsd) || 0,
      durationMs: Number(durationMs) || 0,
      adapterUsed: adapterUsed || null,
      suppressionCount: Number(suppressionCount) || 0,
      findingCount: Number(findingCount) || 0,
      waveNumber: typeof waveNumber === 'number' ? waveNumber : null,
      reflexionContextUsed: typeof reflexionContextUsed === 'boolean' ? reflexionContextUsed : null,
      actualModel: actualModel || null,
      errorMessage: errorMessage || null,
    }

    // appendFileSync is atomic for lines < PIPE_BUF on Linux
    fs.appendFileSync(episodesFile, JSON.stringify(record) + '\n', 'utf8')
  } catch (err) {
    // Fail-soft: telemetry must never break the pipeline
    console.error('[episode-record] emitEpisode error (non-fatal):', err.message)
  }
}

// ---------------------------------------------------------------------------
// updateTaskGrade — retroactively set gradeScore for specialist episodes
// ---------------------------------------------------------------------------

/**
 * Append a grade-update record so readEpisodes can merge real gradeScore values
 * into specialist episodes that were emitted before gradeTask() ran.
 * Append-only — never rewrites episodes.jsonl.
 *
 * @param {string} taskId
 * @param {number} gradeScore   - 0–1 float (passRate / 100)
 * @param {object} [opts]
 * @param {string}  [opts.outDir] - Override for tests
 */
function updateTaskGrade(taskId, gradeScore, { outDir } = {}) {
  try {
    const dir = _episodesDir(outDir)
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
    const file = path.join(dir, 'grade-updates.jsonl')
    // Only record a REAL grade — an undefined/null/non-finite grade must not poison the
    // signal as a fake 0 (the pre-fix bug wrote 8 zero-updates for one ungraded task).
    const g = Number(gradeScore)
    if (!Number.isFinite(g)) return
    const record = {
      ts: new Date().toISOString(),
      taskId: taskId || null,
      gradeScore: g > 1 && g <= 100 ? g / 100 : g,
    }
    fs.appendFileSync(file, JSON.stringify(record) + '\n', 'utf8')
  } catch (err) {
    console.error('[episode-record] updateTaskGrade error (non-fatal):', err.message)
  }
}

// ---------------------------------------------------------------------------
// readEpisodes
// ---------------------------------------------------------------------------

/**
 * Read episodes.jsonl, parse, filter by squad (if provided) and windowDays.
 * Merges grade-updates.jsonl so specialist episodes get real gradeScore values.
 * Returns array sorted ascending by ts. Malformed lines → skip + warn.
 * Returns [] if file missing.
 *
 * @param {object} [opts]
 * @param {number}  [opts.windowDays=7]   - Look-back window in days
 * @param {string}  [opts.squad]          - Filter to this squad (optional)
 * @param {string}  [opts.outDir]         - Override for tests
 * @returns {object[]}
 */
function readEpisodes({ windowDays = 7, squad, outDir } = {}) {
  const episodesFile = _episodesFile(outDir)
  if (!fs.existsSync(episodesFile)) return []

  let raw
  try {
    raw = fs.readFileSync(episodesFile, 'utf8').trim()
  } catch {
    return []
  }
  if (!raw) return []

  const cutoff = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000).toISOString()

  const results = []
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue
    let record
    try {
      record = JSON.parse(line)
    } catch {
      console.warn('[episode-record] readEpisodes: skipping malformed line')
      continue
    }
    // Filter by windowDays
    if (!record.ts || record.ts < cutoff) continue
    // Filter by squad (if specified)
    if (squad && record.squad !== squad) continue
    results.push(record)
  }

  // Merge grade-updates: apply real gradeScore from gradeTask() to specialist episodes
  const gradeUpdatesFile = path.join(_episodesDir(outDir), 'grade-updates.jsonl')
  if (fs.existsSync(gradeUpdatesFile)) {
    const gradeByTask = {} // taskId → latest gradeScore
    try {
      for (const line of fs.readFileSync(gradeUpdatesFile, 'utf8').split('\n').filter(Boolean)) {
        try {
          const u = JSON.parse(line)
          if (u.taskId && typeof u.gradeScore === 'number') gradeByTask[u.taskId] = u.gradeScore
        } catch {}
      }
    } catch {}
    for (const ep of results) {
      // Backfill the real grade onto episodes emitted before grading ran (gradeScore
      // null/unknown, or a legacy 0-placeholder).
      if ((ep.gradeScore === null || ep.gradeScore === undefined || ep.gradeScore === 0) && ep.taskId && gradeByTask[ep.taskId] !== undefined) {
        ep.gradeScore = gradeByTask[ep.taskId]
      }
    }
  }

  // Sort ascending by ts
  results.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0))
  return results
}

// ---------------------------------------------------------------------------
// Module exports
// ---------------------------------------------------------------------------

module.exports = {
  EPISODE_VERSION,
  EPISODE_OUTCOMES,
  emitEpisode,
  readEpisodes,
  validateOutcome,
  updateTaskGrade,
}
