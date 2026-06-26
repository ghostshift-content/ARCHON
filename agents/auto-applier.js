// agents/auto-applier.js
//
// Full-auto learning-loop executor — applies proposals from learning-loop.js
// without human tap. Every apply is git-committed (instant revert available).
//
// KILL-SWITCH: set env LEARNING_AUTO=off to disable all applies.
//
// Safety floor (not human-tap — technical only):
//   1. Kill-switch: LEARNING_AUTO=off → skip silently
//   2. Idempotency: applied-proposals.jsonl tracks already-applied ids
//   3. Git commit per apply: one `git revert HEAD~N` undoes any apply
//   4. Quality watchdog: post-apply grade regression → auto git-revert + Telegram
//   5. Max 5 applies per 24h (burst-cap — prevents runaway loop on bad data)
//   6. Fail-soft everywhere: apply error → log + skip, never crash the daemon
//
// Supported structuredAction kinds:
//   squad_config_patch  — patches a field in agents/squads/{squad}/squad.json
//
// For any proposal without a structuredAction (e.g. legacy text-only proposals),
// a note is logged and it is skipped (no action can be taken without a spec).

'use strict'
const __roots = require('../paths') // portable roots (KURU_*_ROOT) — see paths.js


const fs = require('fs')
const path = require('path')
const { spawnSync } = require('child_process')

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const INTEL_DIR = __roots.INTEL_ROOT
const AGENTS_DIR = __roots.AGENTS_ROOT
const SQUAD_CONFIGS_DIR = path.join(AGENTS_DIR, 'agents', 'squads')

// ── SAFETY PERIMETER (GATE-126) — the "can't grade itself" structural bar ──
// The self-improver is structurally barred from editing the judge / independent
// verifier / gates / reward / eval / its own safety machinery. Even though the
// 3 action kinds are bounded today, this is defense-in-depth: any future action
// kind or path-escape that tries to write into the perimeter is refused, fail-closed.
const SAFETY_PERIMETER = [
  'verify-framework.js',                                  // the gates
  'judge-verifier.js',                                    // judge logic
  'grader.js', 'grader-config.json', 'gold-set.js',       // reward / grading
  'model-config.json',                                    // reward-anchor model families
  'suppression-ledger.js', 'learning-loop.js',            // self-improvement safety machinery
  'auto-applier.js', 'goal-evaluator.js',
  path.sep + 'eval' + path.sep,                           // per-squad test sets
  path.sep + 'arbiter' + path.sep,                      // the judge persona
  path.sep + 'auditor' + path.sep,                          // the independent verifier persona
]
function _assertNotPerimeter(targetPath) {
  let resolved
  try { resolved = path.resolve(String(targetPath)) } catch { throw new Error('SAFETY PERIMETER: unresolvable write target — refused (fail-closed)') }
  for (const seg of SAFETY_PERIMETER) {
    if (resolved.includes(seg)) {
      throw new Error(`SAFETY PERIMETER: auto-applier refused to write '${resolved}' — the self-improver is structurally barred from the judge/verifier/gates/reward/eval (can't-grade-itself rule)`)
    }
  }
}
const APPLIED_LOG = path.join(INTEL_DIR, 'applied-proposals.jsonl')
const PROPOSALS_FILE = path.join(INTEL_DIR, 'learning-proposals.jsonl')
const TELEGRAM_OUTBOX = path.join(INTEL_DIR, 'telegram-outbox')
const WATCHDOG_FILE = path.join(INTEL_DIR, 'auto-apply-watchdog.jsonl')

// Hard cap: at most this many applies in a 24h window
const MAX_APPLIES_PER_DAY = 5

// Effort level ordering (from model-router.js — keep in sync)
const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max']
// Model family ordering (from model-router.js — keep in sync)
const FAMILY_ORDER = ['fast', 'balanced', 'powerful']

// Quality regression threshold — if grade drops by more than this fraction
// after an apply, auto-revert (e.g. 0.15 = 15% drop triggers revert)
const REGRESSION_THRESHOLD = 0.15

// ---------------------------------------------------------------------------
// Kill-switch
// ---------------------------------------------------------------------------

function isAutoEnabled() {
  return process.env.LEARNING_AUTO !== 'off'
}

// ---------------------------------------------------------------------------
// Helpers — applied log (idempotency)
// ---------------------------------------------------------------------------

function _readAppliedLog() {
  if (!fs.existsSync(APPLIED_LOG)) return []
  try {
    return fs.readFileSync(APPLIED_LOG, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l))
  } catch {
    return []
  }
}

function _isAlreadyApplied(proposal) {
  const applied = _readAppliedLog()
  return applied.some(a => a.proposalId === _proposalId(proposal))
}

function _proposalId(proposal) {
  // Stable ID from ts + type + agentName — same proposal won't apply twice
  return `${proposal.ts || ''}:${proposal.type || ''}:${proposal.agentName || ''}`
}

function _logApplied(proposal, result) {
  try {
    const entry = {
      proposalId: _proposalId(proposal),
      appliedAt: new Date().toISOString(),
      type: proposal.type,
      agentName: proposal.agentName,
      squad: proposal.squad,
      structuredAction: proposal.structuredAction,
      result,
    }
    fs.appendFileSync(APPLIED_LOG, JSON.stringify(entry) + '\n', 'utf8')
  } catch (e) {
    console.error('[auto-applier] _logApplied error (non-fatal):', e.message)
  }
}

// ---------------------------------------------------------------------------
// Burst cap — max N applies per 24h
// ---------------------------------------------------------------------------

function _appliesInLast24h() {
  const applied = _readAppliedLog()
  const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
  return applied.filter(a => a.appliedAt && a.appliedAt > cutoff).length
}

// ---------------------------------------------------------------------------
// Squad config reader/writer
// ---------------------------------------------------------------------------

function _squadConfigPath(squad) {
  return path.join(SQUAD_CONFIGS_DIR, squad, 'squad.json')
}

function _readSquadConfig(squad) {
  const p = _squadConfigPath(squad)
  if (!fs.existsSync(p)) throw new Error(`squad.json not found for squad: ${squad}`)
  return JSON.parse(fs.readFileSync(p, 'utf8'))
}

function _writeSquadConfig(squad, config) {
  _assertNotPerimeter(_squadConfigPath(squad))
  const p = _squadConfigPath(squad)
  fs.writeFileSync(p, JSON.stringify(config, null, 2) + '\n', 'utf8')
}

// ---------------------------------------------------------------------------
// Field transition helpers
// ---------------------------------------------------------------------------

function _upgradeModelTier(current) {
  const idx = FAMILY_ORDER.indexOf(current)
  if (idx === -1 || idx >= FAMILY_ORDER.length - 1) return null // already max or unknown
  return FAMILY_ORDER[idx + 1]
}

function _downgradeModelTier(current) {
  const idx = FAMILY_ORDER.indexOf(current)
  if (idx <= 0) return null // already min or unknown
  return FAMILY_ORDER[idx - 1]
}

function _downgradeEffort(current) {
  const idx = EFFORT_LEVELS.indexOf(current)
  if (idx <= 0) return null // already min or unknown
  return EFFORT_LEVELS[idx - 1]
}

function _upgradeEffort(current) {
  const idx = EFFORT_LEVELS.indexOf(current)
  if (idx === -1 || idx >= EFFORT_LEVELS.length - 1) return null
  return EFFORT_LEVELS[idx + 1]
}

// ---------------------------------------------------------------------------
// Git commit helper
// ---------------------------------------------------------------------------

function _gitCommit(message, extraPaths = []) {
  try {
    // Stage squad configs + any extra paths (e.g. SOUL.md files)
    const pathsToStage = ['agents/squads', ...extraPaths]
    const addResult = spawnSync('git', [
      '-C', AGENTS_DIR, 'add', ...pathsToStage
    ], { encoding: 'utf8', timeout: 10000 })

    if (addResult.status !== 0) {
      return { ok: false, error: `git add failed: ${(addResult.stderr || '').trim()}` }
    }

    const commitResult = spawnSync('git', [
      '-C', AGENTS_DIR, 'commit', '-m', message
    ], { encoding: 'utf8', timeout: 15000 })

    if (commitResult.status !== 0) {
      const out = (commitResult.stdout || '').trim()
      // "nothing to commit" is not an error
      if (/nothing to commit/i.test(out)) return { ok: true, sha: null, noChange: true }
      return { ok: false, error: `git commit failed: ${(commitResult.stderr || out).trim()}` }
    }

    // Extract SHA from output
    const sha = (commitResult.stdout || '').match(/\[main\s+([a-f0-9]+)\]/)?.[1] || null
    return { ok: true, sha }
  } catch (e) {
    return { ok: false, error: e.message }
  }
}

function _gitRevert(sha) {
  if (!sha) return { ok: false, error: 'no sha to revert' }
  try {
    const r = spawnSync('git', [
      '-C', AGENTS_DIR, 'revert', '--no-edit', sha
    ], { encoding: 'utf8', timeout: 20000 })
    return r.status === 0
      ? { ok: true }
      : { ok: false, error: (r.stderr || r.stdout || '').trim() }
  } catch (e) {
    return { ok: false, error: e.message }
  }
}

// ---------------------------------------------------------------------------
// Telegram notification
// ---------------------------------------------------------------------------

function _notify(text) {
  try {
    if (!fs.existsSync(TELEGRAM_OUTBOX)) fs.mkdirSync(TELEGRAM_OUTBOX, { recursive: true })
    const file = path.join(TELEGRAM_OUTBOX, `auto-apply-${Date.now()}.json`)
    fs.writeFileSync(file, JSON.stringify({ chat_id: '487977821', text }), 'utf8')
  } catch {
    // fail-soft
  }
}

// ---------------------------------------------------------------------------
// applyStructuredAction — the actual patch logic
// ---------------------------------------------------------------------------

/**
 * @param {object} action  - proposal.structuredAction
 * @returns {{ ok: boolean, detail: string, from: any, to: any }}
 */
function _applyStructuredAction(action) {
  if (!action || !action.kind) {
    return { ok: false, detail: 'no structuredAction or missing kind' }
  }

  if (action.kind === 'soul_md_append') {
    const { agentPath, lesson } = action
    if (!agentPath || !lesson) {
      return { ok: false, detail: `soul_md_append missing agentPath or lesson: ${JSON.stringify(action)}` }
    }
    const soulPath = require('path').join(agentPath, 'SOUL.md')
    try { _assertNotPerimeter(soulPath) } catch (pe) { return { ok: false, detail: pe.message } }
    // Create minimal SOUL.md if the agent directory exists but has no SOUL.md yet
    if (!require('fs').existsSync(soulPath)) {
      const agentName = require('path').basename(agentPath).toUpperCase()
      if (!require('fs').existsSync(agentPath)) {
        return { ok: false, detail: `agent directory not found: ${agentPath}` }
      }
      try {
        const template = `# SOUL.md — ${agentName}\n\n*Auto-created by learning loop. Add identity and role description here.*\n\n## Core Identity\n**${agentName}** — Specialist Agent\n\n## Learned Lessons\n`
        require('fs').writeFileSync(soulPath, template, 'utf8')
      } catch (e) {
        return { ok: false, detail: `SOUL.md create failed: ${e.message}` }
      }
    }
    try {
      const ts = new Date().toISOString().slice(0, 10)
      const entry = `\n## Auto-learned (${ts})\n- ${lesson}\n`
      require('fs').appendFileSync(soulPath, entry, 'utf8')
      // Stage SOUL.md relative to AGENTS_DIR for git commit
      const relPath = require('path').relative(AGENTS_DIR, soulPath)
      return { ok: true, detail: `soul_md_append: ${soulPath} ← "${lesson.slice(0, 80)}"`, from: null, to: lesson, _extraGitPaths: [relPath] }
    } catch (e) {
      return { ok: false, detail: `soul_md_append write failed: ${e.message}` }
    }
  }

  if (action.kind === 'agent_model_override') {
    const { agentName, family, effort } = action
    if (!agentName) return { ok: false, detail: 'agent_model_override: agentName required' }
    if (!family && !effort) return { ok: false, detail: 'agent_model_override: family or effort required' }

    const EFFORT_LEVELS_VALID = ['low', 'medium', 'high', 'xhigh', 'max']
    const FAMILY_VALID = ['fast', 'balanced', 'powerful']
    if (family && !FAMILY_VALID.includes(family)) return { ok: false, detail: `unknown family: ${family}` }
    if (effort && !EFFORT_LEVELS_VALID.includes(effort)) return { ok: false, detail: `unknown effort: ${effort}` }

    const overridesPath = path.join(__roots.INTEL_ROOT, 'agent-model-overrides.json')
    let doc = { version: 2, overrides: {} }
    try {
      const raw = fs.readFileSync(overridesPath, 'utf-8')
      const parsed = JSON.parse(raw)
      if (parsed && parsed.overrides) doc = parsed
    } catch {}
    if (!doc.overrides) doc.overrides = {}

    const override = {}
    if (family) override.family = family
    if (effort) override.effort = effort
    doc.overrides[agentName.toLowerCase()] = override

    try { _assertNotPerimeter(overridesPath) } catch (pe) { return { ok: false, detail: pe.message } }
    try {
      fs.writeFileSync(overridesPath, JSON.stringify(doc, null, 2), 'utf8')
    } catch (e) {
      return { ok: false, detail: `agent_model_override write failed: ${e.message}` }
    }
    // No git commit — agent-model-overrides.json is a runtime file in /root/intel/ (not in git)
    return { ok: true, detail: `${agentName} override → ${JSON.stringify(override)}`, from: doc.overrides[agentName.toLowerCase()], to: override, _skipGitCommit: true }
  }

  if (action.kind === 'squad_config_patch') {
    const { squad, field, direction } = action
    if (!squad || !field || !direction) {
      return { ok: false, detail: `squad_config_patch missing squad/field/direction: ${JSON.stringify(action)}` }
    }

    let config
    try {
      config = _readSquadConfig(squad)
    } catch (e) {
      return { ok: false, detail: e.message }
    }

    const current = config[field]
    let next = null

    if (field === 'modelTier') {
      next = direction === 'upgrade' ? _upgradeModelTier(current) : _downgradeModelTier(current)
      // Fallback: if modelTier is already at ceiling, upgrade effort instead
      if (next === null && direction === 'upgrade') {
        const currentEffort = config.effort || 'high'
        const effortNext = _upgradeEffort(currentEffort)
        if (effortNext !== null) {
          config.effort = effortNext
          try { _writeSquadConfig(squad, config) } catch (e) { return { ok: false, detail: `write failed: ${e.message}` } }
          return { ok: true, detail: `${squad} modelTier already at ceiling (${current}); upgraded effort instead: ${currentEffort} → ${effortNext}`, from: currentEffort, to: effortNext }
        }
        return { ok: false, detail: `${squad} both modelTier (${current}) and effort (${currentEffort}) at ceiling — no upgrade path` }
      }
    } else if (field === 'effort') {
      next = direction === 'upgrade' ? _upgradeEffort(current) : _downgradeEffort(current)
    } else {
      return { ok: false, detail: `unknown field: ${field}` }
    }

    if (next === null) {
      return { ok: false, detail: `${field} already at limit (${current}), cannot ${direction}` }
    }

    config[field] = next
    try {
      _writeSquadConfig(squad, config)
    } catch (e) {
      return { ok: false, detail: `write failed: ${e.message}` }
    }

    return { ok: true, detail: `${squad} ${field}: ${current} → ${next}`, from: current, to: next }
  }

  return { ok: false, detail: `unknown action kind: ${action.kind}` }
}

// ---------------------------------------------------------------------------
// applyProposal — apply one proposal (public API for tests)
// ---------------------------------------------------------------------------

/**
 * Apply a single proposal. Returns result object (never throws).
 *
 * @param {object} proposal
 * @returns {{ applied: boolean, reason: string, sha?: string }}
 */
function applyProposal(proposal) {
  try {
    if (!proposal.structuredAction) {
      return { applied: false, reason: 'no structuredAction — text-only proposal, skipped' }
    }

    // requiresHumanTap (2026-06-09): config/routing changes (squad effort/modelTier, model
    // overrides) are NEVER auto-applied — they need human approval (a cost-outlier from one
    // hung run could otherwise auto-downgrade a whole squad's effort). Gated by ACTION KIND,
    // not just the proposal flag — OLD proposals (written before the flag existed) lack it but
    // must still be blocked. soul_md_append (lesson) stays auto-eligible. Approve via the CLI.
    const _hsKind = proposal.structuredAction && proposal.structuredAction.kind
    if (proposal.requiresHumanTap || _hsKind === 'squad_config_patch' || _hsKind === 'agent_model_override') {
      return { applied: false, reason: 'requires human tap — config/routing change; approve via learning-loop CLI' }
    }

    if (_isAlreadyApplied(proposal)) {
      return { applied: false, reason: 'already applied (idempotency check)' }
    }

    const actionResult = _applyStructuredAction(proposal.structuredAction)
    if (!actionResult.ok) {
      return { applied: false, reason: actionResult.detail }
    }

    // Git commit — skip for runtime files (agent_model_override writes to /root/intel/)
    const skipGit = actionResult._skipGitCommit === true
    const extraPaths = actionResult._extraGitPaths || []
    const msg = `auto-improve: ${proposal.type} — ${actionResult.detail}\n\n` +
      `Agent: ${proposal.agentName || 'unknown'} · Squad: ${proposal.squad || 'unknown'}\n` +
      `Pattern: ${proposal.reason || ''}\n\n` +
      `Applied by auto-applier.js (LEARNING_AUTO=on). Revert: git revert HEAD\n\n` +
      `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`
    const gitResult = skipGit ? { ok: true, sha: null, skipped: 'runtime-file' } : _gitCommit(msg, extraPaths)

    _logApplied(proposal, { actionResult, gitResult })

    const sha = gitResult.sha || null

    // Record watchdog baseline
    _recordWatchdogBaseline({ proposal, sha, actionDetail: actionResult.detail })

    // Notify
    _notify(
      `🤖 **Auto-improve applied**\n` +
      `Type: ${proposal.type}\n` +
      `${actionResult.detail}\n` +
      `Agent: ${proposal.agentName || '?'} | Squad: ${proposal.squad || '?'}\n` +
      `Git: ${sha || '(no commit)'}\n` +
      `Revert: \`git revert ${sha || 'HEAD'}\``
    )

    return { applied: true, reason: actionResult.detail, sha }
  } catch (e) {
    return { applied: false, reason: `applyProposal error: ${e.message}` }
  }
}

// ---------------------------------------------------------------------------
// applyPendingProposals — read all proposals, apply unapplied ones
// ---------------------------------------------------------------------------

/**
 * Read learning-proposals.jsonl, apply all unapplied proposals with
 * structuredActions. Respects kill-switch and burst-cap.
 *
 * @returns {{ skipped: number, applied: number, failed: number, reason?: string }}
 */
function applyPendingProposals() {
  if (!isAutoEnabled()) {
    return { skipped: 0, applied: 0, failed: 0, reason: 'LEARNING_AUTO=off (kill-switch)' }
  }

  if (!fs.existsSync(PROPOSALS_FILE)) {
    return { skipped: 0, applied: 0, failed: 0, reason: 'no proposals file yet' }
  }

  const burstCount = _appliesInLast24h()
  if (burstCount >= MAX_APPLIES_PER_DAY) {
    return {
      skipped: 0, applied: 0, failed: 0,
      reason: `burst-cap reached (${burstCount}/${MAX_APPLIES_PER_DAY} applies in 24h)`
    }
  }

  let proposals = []
  try {
    proposals = fs.readFileSync(PROPOSALS_FILE, 'utf8')
      .split('\n').filter(Boolean).map(l => JSON.parse(l))
  } catch (e) {
    return { skipped: 0, applied: 0, failed: 0, reason: `read error: ${e.message}` }
  }

  let applied = 0, skipped = 0, failed = 0
  const budget = MAX_APPLIES_PER_DAY - burstCount

  for (const proposal of proposals) {
    if (applied >= budget) break

    if (!proposal.structuredAction) { skipped++; continue }
    if (_isAlreadyApplied(proposal)) { skipped++; continue }

    const result = applyProposal(proposal)
    if (result.applied) applied++
    else if (result.reason.includes('error')) failed++
    else skipped++
  }

  return { applied, skipped, failed }
}

// ---------------------------------------------------------------------------
// Quality watchdog — record baseline + check for regression
// ---------------------------------------------------------------------------

function _recordWatchdogBaseline({ proposal, sha, actionDetail }) {
  try {
    const snapshotPath = path.join(INTEL_DIR, 'quality-snapshot.json')
    let preApplyGrade = null
    if (fs.existsSync(snapshotPath)) {
      const snap = JSON.parse(fs.readFileSync(snapshotPath, 'utf8'))
      const squadKey = proposal.squad
      if (squadKey && snap[squadKey]) {
        preApplyGrade = snap[squadKey].avgGrade || null
      }
    }
    const entry = {
      ts: new Date().toISOString(),
      proposalId: _proposalId(proposal),
      squad: proposal.squad,
      sha,
      actionDetail,
      preApplyGrade,
      checked: false,
    }
    fs.appendFileSync(WATCHDOG_FILE, JSON.stringify(entry) + '\n', 'utf8')
  } catch {
    // fail-soft
  }
}

/**
 * Check pending watchdog entries. If quality regressed since the apply,
 * auto-revert the commit and notify.
 * Call this after quality-tracker.recordRunQuality().
 */
function watchdogCheck() {
  if (!fs.existsSync(WATCHDOG_FILE)) return

  let entries
  try {
    entries = fs.readFileSync(WATCHDOG_FILE, 'utf8')
      .split('\n').filter(Boolean).map(l => JSON.parse(l))
  } catch {
    return
  }

  const snapshotPath = path.join(INTEL_DIR, 'quality-snapshot.json')
  if (!fs.existsSync(snapshotPath)) return

  let snap
  try {
    snap = JSON.parse(fs.readFileSync(snapshotPath, 'utf8'))
  } catch {
    return
  }

  const updated = entries.map(entry => {
    if (entry.checked) return entry
    if (!entry.squad || !entry.sha) return { ...entry, checked: true }

    const current = snap[entry.squad]?.avgGrade
    if (typeof current !== 'number' || typeof entry.preApplyGrade !== 'number') {
      // Bug fix (2026-06-06): old code silently marked as checked when no quality data available.
      // This caused the watchdog to pass with no actual check — a false safety.
      // Now: defer (keep unchecked) for up to 7 days, then mark stale and notify.
      const ageMs = Date.now() - Date.parse(entry.ts || 0)
      const STALE_MS = 7 * 24 * 60 * 60 * 1000
      if (ageMs > STALE_MS) {
        // Apply is too old to verify — treat as unverifiable, notify and close
        _notify(`⚠️ **Auto-improve watchdog: STALE (no quality data after 7d)**\nApply: ${entry.actionDetail}\nSHA: ${entry.sha}\nSquad: ${entry.squad}\nRun a dispatch to get quality data, then the watchdog can check.`)
        return { ...entry, checked: true, stale: true }
      }
      // Not yet stale — keep unchecked (defer to next recordRunQuality call)
      return entry
    }

    const drop = (entry.preApplyGrade - current) / entry.preApplyGrade
    if (drop > REGRESSION_THRESHOLD) {
      // Regression detected — auto-revert
      const revertResult = _gitRevert(entry.sha)
      const msg = revertResult.ok
        ? `✅ auto-reverted ${entry.sha}`
        : `⚠️ revert failed: ${revertResult.error}`

      _notify(
        `⚠️ **Auto-improve REVERTED (quality regression)**\n` +
        `Squad: ${entry.squad}\n` +
        `Grade before: ${entry.preApplyGrade.toFixed(2)} → after: ${current.toFixed(2)} (drop: ${(drop * 100).toFixed(0)}%)\n` +
        `Action: ${entry.actionDetail}\n` +
        `${msg}`
      )
      return { ...entry, checked: true, reverted: true, revertResult }
    }

    return { ...entry, checked: true, reverted: false }
  })

  try {
    fs.writeFileSync(
      WATCHDOG_FILE,
      updated.map(e => JSON.stringify(e)).join('\n') + '\n',
      'utf8'
    )
  } catch {
    // fail-soft
  }
}

// ---------------------------------------------------------------------------
// Module exports
// ---------------------------------------------------------------------------

module.exports = {
  applyProposal,
  applyPendingProposals,
  watchdogCheck,
  isAutoEnabled,
  MAX_APPLIES_PER_DAY,
  REGRESSION_THRESHOLD,
}
