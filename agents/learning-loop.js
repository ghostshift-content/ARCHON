// agents/learning-loop.js
//
// FULL-AUTO SELF-IMPROVEMENT LOOP. Improver can never grade itself.
// OBSERVE → DISTILL → PROPOSE → AUTO-APPLY pipeline (upgraded 2026-06-05).
//
// Auto-apply safety floor (not human-tap — technical only):
//   1. Kill-switch: LEARNING_AUTO=off → skip all applies
//   2. Idempotency: applied-proposals.jsonl prevents double-apply
//   3. Git commit per apply: `git revert HEAD` undoes any change
//   4. Quality watchdog: grade regression → auto git-revert + Telegram
//   5. Burst cap: max 5 applies per 24h
//
// USAGE:
//   const ll = require('./agents/learning-loop')
//   const obs = await ll.observe({ squad: 'pentest', windowDays: 7 })
//   const dist = ll.distill(obs)
//   const props = ll.propose(dist)
//   const result = await ll.runLoop({ squad: 'pentest', windowDays: 7 })

'use strict'

const fs = require('fs')
const path = require('path')
const agentPaths = require('../paths') // resolver — proposal agentPath must hit the persona's real (possibly nested) home

// ---------------------------------------------------------------------------
// Default output directory
// ---------------------------------------------------------------------------

const DEFAULT_OUT_DIR = agentPaths.INTEL_ROOT

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const RECURRING_FAILURE_THRESHOLD = 3   // ≥3 failures by same agent → pattern
const GRADE_LOW_THRESHOLD = 0.5          // gradeScore < 0.5 → grade concern
const GRADE_LOW_EPISODE_THRESHOLD = 3    // ≥3 low-grade episodes → pattern
const COST_OUTLIER_MULTIPLIER = 2        // episode costUsd > 2× avg → outlier

// ---------------------------------------------------------------------------
// observe
// ---------------------------------------------------------------------------

/**
 * OBSERVE stage: collect episodes + squad baseline for analysis.
 *
 * @param {object} opts
 * @param {string}  [opts.squad]          - Squad to observe (optional — all if omitted)
 * @param {number}  [opts.windowDays=7]   - Look-back window
 * @param {string}  [opts.outDir]         - Override for tests
 * @returns {Promise<{episodes: object[], baseline: object, observedAt: string}>}
 */
async function observe({ squad, windowDays = 7, outDir } = {}) {
  const { readEpisodes } = require('./episode-record')
  const qualityTracker = require('./quality-tracker')

  const episodes = readEpisodes({ windowDays, squad, outDir })
  const baseline = squad
    ? qualityTracker.getSquadBaseline(squad, { windowDays, outDir })
    : { runs: 0, noData: true }

  return {
    episodes,
    baseline,
    observedAt: new Date().toISOString(),
  }
}

// ---------------------------------------------------------------------------
// distill
// ---------------------------------------------------------------------------

/**
 * DISTILL stage: pure function — no I/O. Finds patterns in observed data.
 *
 * Detects:
 *   1. Recurring failure patterns (same agentName, outcome=failed, ≥3 in window)
 *   2. Cost outliers (episode costUsd > 2× squad avgCostUsd)
 *   3. Grade score below threshold (gradeScore < 0.5 for ≥3 episodes)
 *
 * @param {object} observedData
 * @param {object[]} observedData.episodes
 * @param {object}   observedData.baseline
 * @returns {{patterns: object[], alerts: object[]}}
 */
function distill({ episodes = [], baseline = {} } = {}) {
  const patterns = []
  const alerts = []

  if (!episodes || episodes.length === 0) {
    return { patterns, alerts }
  }

  // --- 1. Recurring failure patterns — failure-CONTENT aware (GATE-119) ---
  // Root cause fix: old distill() only counted failures, never read WHY.
  // Now: categorize failure mode from errorMessage + durationMs + findingCount.
  // Same 3 failures → same lesson was the bug. Now → targeted lesson per cause.

  const FAILURE_CATEGORIES = {
    timeout:        /timeout|timed out|SIGKILL|hard.limit|max.runtime/i,
    rate_limit:     /429|rate.limit|quota|too.many.requests|overload/i,
    scope_block:    /out.of.scope|blocked|OOS|scope.prevalidat/i,
    output_malform: /parse.fail|malformed|invalid.*json|unexpected.*token|syntax.error/i,
    target_unreach: /unreachable|ECONNREFUSED|ETIMEDOUT|503|502|no.route/i,
    no_findings:    /^$/, // detected by findingCount=0 and outcome=failed
  }

  function classifyFailure(ep) {
    const msg = (ep.errorMessage || '').toLowerCase()
    if (!msg && Number(ep.findingCount) === 0 && ep.outcome === 'failed') return 'no_findings'
    for (const [cat, re] of Object.entries(FAILURE_CATEGORIES)) {
      if (cat === 'no_findings') continue
      if (re.test(msg)) return cat
    }
    return msg.length > 0 ? 'other' : 'no_findings'
  }

  const FAILURE_LESSONS = {
    timeout: 'Recurring timeouts: be more targeted — pick the 3 most likely attack vectors per endpoint, not exhaustive. Write partial findings before timeout. Use shorter curl timeouts (--max-time 10).',
    rate_limit: 'Recurring rate-limit hits: add 2-3s sleep between requests. Use --max-time 15. Check for X-RateLimit-Remaining header before bulk testing.',
    scope_block: 'Recurring scope blocks: read scope config first (cat /root/intel/scope-*.json). Verify each endpoint is in-scope before testing. Log DISPROVEN for out-of-scope attempts.',
    output_malform: 'Recurring output format errors: write findings as valid JSON objects. Test your JSON with python3 -c "import json; json.loads(line)" before appending. Use single quotes in shell echo commands.',
    target_unreach: 'Recurring unreachable targets: run a quick reachability check (curl -sI --max-time 5 URL) before deep testing. If unreachable, log DISPROVEN and stop early.',
    no_findings: 'Recurring zero-findings runs: broaden your methodology — test adjacent attack surface, vary payloads, try unauthenticated vs authenticated paths. Log what you disproved explicitly.',
    other: 'Recurring failures with mixed causes: verify endpoint reachability and authentication before deep testing. Log clear stop conditions when tests are inconclusive.',
  }

  const failuresByAgent = {}
  for (const ep of episodes) {
    if (ep.outcome === 'failed') {
      const agent = ep.agentName || 'unknown'
      if (!failuresByAgent[agent]) failuresByAgent[agent] = { episodes: [], categories: {} }
      failuresByAgent[agent].episodes.push(ep)
      const cat = classifyFailure(ep)
      failuresByAgent[agent].categories[cat] = (failuresByAgent[agent].categories[cat] || 0) + 1
    }
  }
  for (const [agentName, { episodes: failures, categories }] of Object.entries(failuresByAgent)) {
    if (failures.length >= RECURRING_FAILURE_THRESHOLD) {
      const squad = failures[0].squad || null
      // Dominant failure category = what the lesson targets
      const dominantCat = Object.entries(categories).sort((a, b) => b[1] - a[1])[0]?.[0] || 'other'
      const lesson = FAILURE_LESSONS[dominantCat] || FAILURE_LESSONS.other
      const catBreakdown = Object.entries(categories).map(([c, n]) => `${c}:${n}`).join(', ')
      patterns.push({
        type: 'recurring-failure',
        agentName,
        squad,
        count: failures.length,
        failureCategory: dominantCat,
        failureCategoryBreakdown: catBreakdown,
        specificLesson: lesson,
        description: `${agentName} failed ${failures.length} times (dominant cause: ${dominantCat}) — ${catBreakdown}`,
      })
    }
  }

  // --- 2. Cost outliers ---
  // EXCLUDE failed/hung runs (2026-06-09): a killed agent (e.g. veteran's 45min hang, exit 143)
  // burns cost producing nothing — that's a HANG to fix (the activity-stall watchdog), NOT a
  // "this agent needs less effort" signal. Counting it inflated the avg AND fired a spurious
  // "downgrade effort" proposal. Only completed runs carry a real cost signal.
  const completedEpisodes = episodes.filter(ep => ep.outcome === 'completed')

  // PER-AGENT historical baseline (2026-06-09): compare each agent's cost to its OWN
  // trailing history, NOT a cross-agent average. Two structural false-positive sources
  // are killed: (1) the squad LEADER (CHANAKYA) inherently costs ~3-4× an analyst, and
  // (2) cheap challengers (vishnu/shakuni/vidura ~$0.15) drag any shared cohort average
  // down so mid-cost analysts (lakshmi) trip the 2× line. An agent is only an outlier
  // vs ITSELF. Requires a minimum sample of that agent's own runs before it can be judged
  // — a single data point is never a reliable "downgrade effort" signal.
  const AGENT_MIN = 3
  const byAgent = {}  // agentName -> { costs:[], avg:number }
  for (const ep of completedEpisodes) {
    const c = Number(ep.costUsd) || 0
    if (c <= 0) continue
    const a = ep.agentName || 'unknown'
    ;(byAgent[a] || (byAgent[a] = { costs: [] })).costs.push(c)
  }
  for (const a of Object.keys(byAgent)) {
    const cs = byAgent[a].costs
    byAgent[a].avg = cs.reduce((s, c) => s + c, 0) / cs.length
  }
  for (const ep of completedEpisodes) {
    const cost = Number(ep.costUsd) || 0
    if (cost <= 0) continue
    const a = ep.agentName || 'unknown'
    const h = byAgent[a]
    // Not enough of THIS agent's own history to judge → can't call it an outlier.
    if (!h || h.costs.length < AGENT_MIN) continue
    if (cost > h.avg * COST_OUTLIER_MULTIPLIER) {
      patterns.push({
        type: 'cost-outlier',
        agentName: ep.agentName || 'unknown',
        squad: ep.squad || null,
        count: 1,
        description: `${ep.agentName || 'unknown'} cost $${cost.toFixed(4)} exceeds 2× its own ${h.costs.length}-run avg ($${h.avg.toFixed(4)}) in task ${ep.taskId}`,
      })
    }
  }

  // --- 3. Grade score below threshold ---
  // Group low-grade episodes by agentName
  const lowGradeByAgent = {}
  for (const ep of episodes) {
    // ungraded episodes (gradeScore null) carry NO quality signal — skip them. Counting
    // them as 0 made every ungraded run look like a failure and fired spurious proposals.
    if (ep.gradeScore === null || ep.gradeScore === undefined) continue
    const score = Number(ep.gradeScore) || 0
    // score<=0 is also no-reliable-signal: pre-2026-06-08 the ungraded→0 bug recorded many
    // ungraded runs as exactly 0; a genuine 0% run is pathological/rare. Skip to avoid poison.
    if (score <= 0) continue
    if (score < GRADE_LOW_THRESHOLD) {
      const agent = ep.agentName || 'unknown'
      if (!lowGradeByAgent[agent]) lowGradeByAgent[agent] = []
      lowGradeByAgent[agent].push(ep)
    }
  }
  for (const [agentName, lowEps] of Object.entries(lowGradeByAgent)) {
    if (lowEps.length >= GRADE_LOW_EPISODE_THRESHOLD) {
      const squad = lowEps[0].squad || null
      patterns.push({
        type: 'low-grade',
        agentName,
        squad,
        count: lowEps.length,
        description: `${agentName} scored below ${GRADE_LOW_THRESHOLD} grade ${lowEps.length} times in the observation window`,
      })
    }
  }

  // --- 4. High suppression rate pattern ---
  // Agents whose findings are frequently suppressed by the severity filter have
  // a calibration problem — they're finding real issues but mis-rating severity.
  // Threshold: ≥3 episodes with suppressionCount > 0 in the window.
  const suppressionByAgent = {}
  for (const ep of episodes) {
    if (ep.suppressionCount && ep.suppressionCount > 0) {
      const agent = ep.agentName || 'unknown'
      if (!suppressionByAgent[agent]) suppressionByAgent[agent] = { count: 0, squad: ep.squad || null }
      suppressionByAgent[agent].count++
    }
  }
  for (const [agentName, { count, squad }] of Object.entries(suppressionByAgent)) {
    if (count >= 3) {
      patterns.push({
        type: 'high-suppression',
        agentName,
        squad,
        count,
        description: `${agentName} had ${count} episodes with suppressed findings — severity calibration likely off`,
      })
    }
  }

  return { patterns, alerts }
}

// ---------------------------------------------------------------------------
// propose
// ---------------------------------------------------------------------------

/**
 * PROPOSE stage: pure function — no I/O, no LLM calls. Rule-based only.
 * For each pattern, generates a proposal with a structuredAction that
 * auto-applier.js can execute directly (no human tap required).
 *
 * @param {object} distilledData
 * @param {object[]} distilledData.patterns
 * @returns {object[]} proposals
 */
function propose({ patterns = [] } = {}) {
  if (!patterns || patterns.length === 0) return []

  const proposals = []

  for (const pattern of patterns) {
    let proposal

    if (pattern.type === 'recurring-failure') {
      // Failure-content-aware proposal (GATE-119): uses specificLesson from failureCategory,
      // not a hardcoded generic string. Different root causes → different targeted lessons.
      const agentDir = pattern.agentName && pattern.agentName !== 'unknown'
        ? agentPaths.personaCode(pattern.agentName.toLowerCase()) : null
      let action = null

      if (agentDir && pattern.count >= 3) {
        // Use the category-specific lesson, not a generic one
        const lesson = pattern.specificLesson ||
          `Recurring failure (${pattern.count} times, cause: ${pattern.failureCategory || 'unknown'}): review your testing approach for this failure class.`
        action = {
          kind: 'soul_md_append',
          agentPath: agentDir,
          lesson: `[${pattern.failureCategory || 'failure'}] ${lesson}`,
        }
      } else if (!agentDir && pattern.squad) {
        // No specific agent known — squad-level tweak based on failure type
        const isTimeout = pattern.failureCategory === 'timeout'
        action = {
          kind: 'squad_config_patch',
          squad: pattern.squad,
          field: isTimeout ? 'effort' : 'modelTier',
          direction: isTimeout ? 'downgrade' : 'upgrade', // timeout → less effort (faster); other → more power
        }
      }

      proposal = {
        type: 'recurring-failure',
        agentName: pattern.agentName,
        squad: pattern.squad || null,
        reason: pattern.description,
        failureCategory: pattern.failureCategory,
        failureCategoryBreakdown: pattern.failureCategoryBreakdown,
        suggestedAction: action
          ? `${pattern.failureCategory}-targeted fix for ${pattern.agentName}: ${action.kind}`
          : `No actionable fix — insufficient data (agentName unknown, count=${pattern.count})`,
        structuredAction: action,
      }
    } else if (pattern.type === 'cost-outlier') {
      // Downgrade effort to reduce cost
      const action = pattern.squad
        ? { kind: 'squad_config_patch', squad: pattern.squad, field: 'effort', direction: 'downgrade' }
        : null
      proposal = {
        type: 'cost-outlier',
        agentName: pattern.agentName,
        squad: pattern.squad || null,
        reason: pattern.description,
        suggestedAction: `Downgrade effort for ${pattern.squad || pattern.agentName} squad — cost outlier detected`,
        structuredAction: action,
      }
    } else if (pattern.type === 'low-grade') {
      // Upgrade model tier to improve output quality
      const action = pattern.squad
        ? { kind: 'squad_config_patch', squad: pattern.squad, field: 'modelTier', direction: 'upgrade' }
        : null
      proposal = {
        type: 'low-grade',
        agentName: pattern.agentName,
        squad: pattern.squad || null,
        reason: pattern.description,
        suggestedAction: `Upgrade modelTier for ${pattern.squad || pattern.agentName} squad — recurring low grades detected`,
        structuredAction: action,
      }
    } else if (pattern.type === 'high-suppression') {
      // Append SOUL.md lesson about severity calibration
      const action = pattern.agentName && pattern.agentName !== 'unknown'
        ? {
            kind: 'soul_md_append',
            agentPath: agentPaths.personaCode(pattern.agentName.toLowerCase()),
            lesson: `High severity suppression rate detected (${pattern.count} episodes): severity claims are frequently downgraded by the severity filter. Be conservative — only claim Critical/High when there is direct HTTP response evidence of impact. Prefer Medium over High when exploit requires chaining.`,
          }
        : null
      proposal = {
        type: 'high-suppression',
        agentName: pattern.agentName,
        squad: pattern.squad || null,
        reason: pattern.description,
        suggestedAction: `Append severity calibration lesson to ${pattern.agentName} SOUL.md — findings frequently suppressed`,
        structuredAction: action,
      }
    } else {
      // Unknown pattern type — log only, no structuredAction
      proposal = {
        type: 'unknown-pattern',
        agentName: pattern.agentName || 'unknown',
        squad: pattern.squad || null,
        reason: pattern.description || `Unknown pattern: ${pattern.type}`,
        suggestedAction: `Investigate pattern type "${pattern.type}" for agent ${pattern.agentName || 'unknown'}`,
        structuredAction: null,
      }
    }

    // requiresHumanTap (2026-06-09): high-stakes config/routing changes (squad effort/modelTier,
    // model overrides) must be human-approved even in full-auto mode — they change cost+quality
    // for the WHOLE squad. Low-risk lesson appends (soul_md_append) stay auto-eligible (the
    // intended self-improvement). The auto-applier enforces this flag.
    const _kind = proposal && proposal.structuredAction && proposal.structuredAction.kind
    proposal.requiresHumanTap = (_kind === 'squad_config_patch' || _kind === 'agent_model_override')
    proposals.push(proposal)
  }

  // Within-run dedup (2026-06-09): distill can emit many identical patterns in one
  // window (e.g. 7 cost-outliers for the same leader across 7 episodes) → collapse to
  // one proposal per dedup-key so the human-review queue isn't flooded with duplicates.
  const _seen = new Set()
  const deduped = []
  for (const p of proposals) {
    const k = proposalDedupKey(p)
    if (_seen.has(k)) continue
    _seen.add(k)
    deduped.push(p)
  }
  return deduped
}

// Stable identity for dedup: same (type, squad, agent, action kind/field/direction)
// → same proposal, regardless of the human-readable reason/description text.
function proposalDedupKey(p) {
  const a = (p && p.structuredAction) || {}
  return [p && p.type, (p && p.squad) || '', (p && p.agentName) || '', a.kind || '', a.field || '', a.direction || ''].join('|')
}

// ---------------------------------------------------------------------------
// runLoop
// ---------------------------------------------------------------------------

/**
 * Run the full OBSERVE→DISTILL→PROPOSE loop.
 * Writes proposals to /root/intel/learning-proposals.jsonl (one line per
 * proposal, append). Returns summary.
 *
 * @param {object} opts
 * @param {string}  [opts.squad]          - Squad to observe
 * @param {number}  [opts.windowDays=7]   - Look-back window
 * @param {string}  [opts.outDir]         - Override for tests
 * @returns {Promise<{observed: number, patterns: number, proposals: number, humanTapRequired: true}>}
 */
// autoApply (2026-06-09): the post-dispatch trigger runs in PROPOSE-ONLY mode (autoApply:false)
// — OBSERVE→DISTILL→PROPOSE writes proposals for human review (learning-loop.js list / approve),
// never auto-modifies. This is the SOTA human-in-the-loop approval pattern and the safe first
// cadence while the episode signal is still building. Set autoApply:true to also run the applier.
// DEFAULT IS false (2026-06-10): a caller that OMITS the flag (e.g. the CLI entrypoint) must NOT
// silently arm the dormant applier — it matches the documented PROPOSE-ONLY posture. Auto-apply is
// opt-in only (explicit autoApply:true), and even then config/routing changes stay human-gated (GATE-139).
async function runLoop({ squad, windowDays = 7, outDir, autoApply = false } = {}) {
  // OBSERVE
  const observed = await observe({ squad, windowDays, outDir })

  // DISTILL
  const distilled = distill(observed)

  // PROPOSE
  const proposals = propose(distilled)

  // Write proposals to learning-proposals.jsonl
  if (proposals.length > 0) {
    try {
      const proposalsFile = path.join(outDir || DEFAULT_OUT_DIR, 'learning-proposals.jsonl')
      const dir = path.dirname(proposalsFile)
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true })
      }
      // Cross-run dedup (2026-06-09): skip any proposal whose dedup-key already exists
      // as an UNRESOLVED proposal in the file — otherwise the same suggestion re-queues
      // every run until a human acts on it (the ITC run alone produced 7 identical
      // "downgrade effort" entries). Resolved proposals (resolved:true) may re-propose.
      const existingKeys = new Set()
      try {
        const prior = fs.readFileSync(proposalsFile, 'utf8').split('\n').filter(Boolean)
        for (const ln of prior) {
          try {
            const p = JSON.parse(ln)
            if (p && p.resolved) continue
            existingKeys.add(proposalDedupKey(p))
          } catch {}
        }
      } catch {}
      const ts = new Date().toISOString()
      let appended = 0
      for (const proposal of proposals) {
        const k = proposalDedupKey(proposal)
        if (existingKeys.has(k)) continue
        const line = JSON.stringify({ ts, squad: squad || null, ...proposal })
        fs.appendFileSync(proposalsFile, line + '\n', 'utf8')
        existingKeys.add(k)
        appended++
      }
      proposals._appended = appended
    } catch (err) {
      // Fail-soft: learning loop must never break anything
      console.error('[learning-loop] runLoop: error writing proposals (non-fatal):', err.message)
    }
  }

  // AUTO-APPLY — runs immediately after propose (no human tap), unless autoApply:false
  let applyResult = { applied: 0, skipped: 0, failed: 0, reason: 'skipped' }
  if (!outDir && autoApply) {
    // Skip auto-apply in test mode (outDir override means test context)
    try {
      const autoApplier = require('./auto-applier')
      applyResult = autoApplier.applyPendingProposals()
    } catch (err) {
      // Fail-soft: auto-apply failure must not break the loop
      console.error('[learning-loop] auto-apply error (non-fatal):', err.message)
    }
  }

  return {
    observed: observed.episodes.length,
    patterns: distilled.patterns.length,
    proposals: proposals.length,
    appended: (proposals && proposals._appended) || 0,
    applied: applyResult.applied,
    applySkipped: applyResult.skipped,
    applyFailed: applyResult.failed,
    applyReason: applyResult.reason,
  }
}

// ---------------------------------------------------------------------------
// listPendingProposals
// ---------------------------------------------------------------------------

/**
 * Read /root/intel/learning-proposals.jsonl and return all proposals
 * with requiresHumanTap:true, sorted by ts descending (newest first).
 *
 * @param {object} [opts]
 * @param {string}  [opts.outDir]  - Override output dir (for tests)
 * @returns {object[]} proposals sorted by ts descending
 */
function listPendingProposals({ outDir } = {}) {
  const proposalsFile = path.join(outDir || DEFAULT_OUT_DIR, 'learning-proposals.jsonl')
  if (!fs.existsSync(proposalsFile)) return []

  let lines
  try {
    lines = fs.readFileSync(proposalsFile, 'utf-8').split('\n').filter(Boolean)
  } catch (err) {
    return []
  }

  const proposals = []
  for (const line of lines) {
    try {
      const obj = JSON.parse(line)
      proposals.push(obj)
    } catch {
      // Skip malformed lines
    }
  }

  // Sort by ts descending (newest first)
  proposals.sort((a, b) => {
    const ta = a.ts || ''
    const tb = b.ts || ''
    if (ta < tb) return 1
    if (ta > tb) return -1
    return 0
  })

  return proposals
}

// ---------------------------------------------------------------------------
// Module exports
// ---------------------------------------------------------------------------

module.exports = {
  observe,
  distill,
  propose,
  runLoop,
  listPendingProposals,
}

// ---------------------------------------------------------------------------
// CLI entrypoint
// ---------------------------------------------------------------------------

if (require.main === module) {
  const cmd = process.argv[2] || null
  const windowDays = parseInt(process.argv[3]) || 7
  const targetSquads = cmd && cmd !== 'list' && cmd !== 'all'
    ? [cmd]
    : require('./quality-tracker').PRODUCTION_SQUADS
  console.log(`Running learning loop for ${cmd || 'all squads'} (window: ${windowDays}d)...`)
  Promise.all(targetSquads.map(s => module.exports.runLoop({ squad: s, windowDays })))
    .then(results => {
      const total = results.reduce((a, r) => ({
        proposals: a.proposals + r.proposals,
        patterns: a.patterns + r.patterns,
        applied: a.applied + (r.applied || 0),
      }), { proposals: 0, patterns: 0, applied: 0 })
      console.log(`Done. Patterns: ${total.patterns}, Proposals: ${total.proposals}, Applied: ${total.applied}`)
      console.log('Log: /root/intel/learning-proposals.jsonl')
      console.log('Applied log: /root/intel/applied-proposals.jsonl')
      if (process.env.LEARNING_AUTO === 'off') console.log('NOTE: LEARNING_AUTO=off — kill-switch active, no applies ran')
    })
    .catch(e => { console.error('Learning loop error:', e.message); process.exit(1) })
}
