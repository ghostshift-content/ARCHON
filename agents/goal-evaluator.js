// agents/goal-evaluator.js
// Oracle-anchored convergence loop evaluator (the /goal-style done-condition)
// Design: THE-FRAMEWORK.md — "/goal for loop-until-done"
//
// Usage: alongside early-exit-decision.js. The existing heuristic runs first
// (fast, zero-credit). If it says CONTINUE but findings are thin, the oracle
// evaluation (one runAgent call) provides a second opinion with external feedback.
// If both agree on EARLY_EXIT → exit. If oracle says CONTINUE → trust oracle.
// "External feedback" = oracle-verified = satisfies the ICLR-2024 discriminator.
//
// NOT a replacement of early-exit-decision.js — an ENHANCEMENT that wraps it
// with oracle verification.

'use strict'

const { shouldEarlyExit, decisions } = require('../src/pipeline/early-exit-decision')

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CONVERGENCE_SOURCES = ['heuristic', 'oracle', 'both']

const ORACLE_TIMEOUT_MS = 30000
const ORACLE_MODEL_EFFORT = 'low'

// ---------------------------------------------------------------------------
// evaluateConvergence
// ---------------------------------------------------------------------------

/**
 * Oracle-anchored convergence evaluator.
 *
 * Runs the fast heuristic first. If the heuristic says EARLY_EXIT AND there
 * are zero existing findings AND a _runAgent injection is available, asks the
 * oracle for a second opinion. Oracle overrides heuristic on CONTINUE signal.
 *
 * @param {object} opts
 * @param {string}   [opts.taskId]               - Task identifier (for logging)
 * @param {string}   [opts.squad]                - Squad name (for logging)
 * @param {string}   [opts.targetUrl]            - Target URL
 * @param {string}   [opts.goal]                 - Task goal/brief (for richer oracle context)
 * @param {number}   [opts.endpointCount=0]      - Number of discovered endpoints
 * @param {boolean}  [opts.targetReachable=false] - Whether the target responded
 * @param {number}   [opts.missedSignalsCount=0] - Missed recon signals count
 * @param {number}   [opts.existingFindingCount=0] - Findings already recorded
 * @param {string[]} [opts.phasesCompleted]       - Phases already completed
 * @param {Function} [opts._runAgent]            - DI override for runAgent (test/oracle path)
 *
 * @returns {Promise<{shouldExit: boolean, reason: string, source: string, oracleUsed: boolean}>}
 */
async function evaluateConvergence({
  taskId,
  squad,
  targetUrl,
  goal,
  endpointCount = 0,
  targetReachable = false,
  missedSignalsCount = 0,
  existingFindingCount = 0,
  phasesCompleted = [],
  _runAgent,
} = {}) {

  // ── Step 1: run the fast heuristic ──────────────────────────────────────
  const heuristicResult = shouldEarlyExit({ endpointCount, targetReachable, missedSignalsCount })
  const { decision, reason } = heuristicResult

  // ── Step 2: CONTINUE / CONTINUE_WITH_HINTS → return immediately ─────────
  // Heuristic already says go on — no oracle needed, fast path.
  if (decision !== decisions.EARLY_EXIT) {
    return {
      shouldExit: false,
      reason,
      source: 'heuristic',
      oracleUsed: false,
    }
  }

  // ── Step 3: EARLY_EXIT + zero findings + oracle available → consult oracle
  if (existingFindingCount === 0 && typeof _runAgent === 'function') {
    let oracleText = ''
    try {
      const targetContext = targetUrl ? `Target: ${targetUrl}.` : ''
      const squadContext = squad ? ` Squad: ${squad}.` : ''
      const goalContext = goal ? ` Goal: ${String(goal).slice(0, 200)}.` : ''
      const phasesContext = phasesCompleted.length
        ? ` Phases completed: ${phasesCompleted.join(', ')}.`
        : ' Phases completed: recon only.'
      const oraclePrompt =
        `You are a security testing advisor.${targetContext}${squadContext}${goalContext}${phasesContext} ` +
        `Recon signals: endpointCount=${endpointCount}, targetReachable=${targetReachable}, ` +
        `missedSignalsCount=${missedSignalsCount}, existingFindings=${existingFindingCount}. ` +
        `Should testing STOP (insufficient testable surface) or CONTINUE ` +
        `(specialist testing may still find value)? Reply with exactly STOP or CONTINUE.`

      const runAgent = _runAgent
      const oracleResult = await runAgent({
        userPrompt: oraclePrompt,
        effort: ORACLE_MODEL_EFFORT,
        timeoutMs: ORACLE_TIMEOUT_MS,
        agentName: 'GOAL-EVALUATOR-ORACLE',
        taskId,
      })

      // Handle both structured {text} and bare string returns
      oracleText = (typeof oracleResult === 'object' && oracleResult !== null)
        ? (oracleResult.text || '')
        : String(oracleResult || '')

    } catch (err) {
      // Oracle failure → fall back to heuristic decision (fail-soft)
      return {
        shouldExit: true,
        reason,
        source: 'heuristic',
        oracleUsed: false,
      }
    }

    // Parse oracle response
    if (/CONTINUE/i.test(oracleText)) {
      return {
        shouldExit: false,
        reason: 'oracle_override_continue',
        source: 'oracle',
        oracleUsed: true,
      }
    }

    // STOP or ambiguous → heuristic + oracle both say exit
    return {
      shouldExit: true,
      reason: 'heuristic_and_oracle_agree_exit',
      source: 'both',
      oracleUsed: true,
    }
  }

  // ── Step 4: EARLY_EXIT but no oracle available or findings > 0 ──────────
  return {
    shouldExit: true,
    reason,
    source: 'heuristic',
    oracleUsed: false,
  }
}

// ---------------------------------------------------------------------------
// Module exports
// ---------------------------------------------------------------------------

module.exports = {
  evaluateConvergence,
  CONVERGENCE_SOURCES,
}
