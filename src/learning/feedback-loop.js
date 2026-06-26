#!/usr/bin/env node
/**
 * FEEDBACK LOOP — Universal Post-Task Learning Engine
 * 
 * Called after ARBITER verification completes for ANY squad.
 * Extracts failure traces, generates lessons, updates disproven cache,
 * calculates agent scores, and detects patterns.
 * 
 * All functions are squad-agnostic — works for pentest, stocks, red-team, etc.
 */

const fs = require('fs')
const agentPaths = require('../../paths') // Phase-1 resolver chokepoint (GATE-121)
const path = require('path')

// ── Paths ──
const INTEL_DIR = agentPaths.INTEL_ROOT
const ACTIVITY_LOG = `${INTEL_DIR}/ACTIVITY-LOG.jsonl`
const VERIFICATION_LOG = `${INTEL_DIR}/verification-log.jsonl`
const AGENT_SCORES_FILE = `${INTEL_DIR}/agent-scores.json`

const MAX_LESSONS = 50
const MAX_DISPROVEN = 500
const DISPROVEN_EXPIRY_DAYS = 30
const PATTERN_TASK_WINDOW = 20
const SCORE_TASK_WINDOW = 10

// ── Utilities ──
function ensureDir(dir) {
  try { fs.mkdirSync(dir, { recursive: true }) } catch {}
}

function readJSONSafe(file, fallback = {}) {
  try {
    if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf-8'))
  } catch {}
  return fallback
}

function writeJSONSafe(file, data) {
  ensureDir(path.dirname(file))
  fs.writeFileSync(file, JSON.stringify(data, null, 2))
}

function readLines(file) {
  try {
    if (!fs.existsSync(file)) return []
    return fs.readFileSync(file, 'utf-8').trim().split('\n').filter(Boolean)
  } catch { return [] }
}

function parseJSONL(file) {
  return readLines(file).map(line => {
    try { return JSON.parse(line) } catch { return null }
  }).filter(Boolean)
}

// (2026-04-20 I8 fix) Fast per-task activity read — uses per-task log when
// available, falls back to global only if needed. Callers that know the taskId
// should use this instead of parseJSONL(ACTIVITY_LOG).filter(e => e.taskId===X)
// which reads the entire 500MB-capable global log on every call.
const taskLog = (() => { try { return require('../utils/task-log') } catch { return null } })()
function readTaskActivityFast(taskId) {
  if (!taskId) return []
  if (taskLog && taskLog.taskLogExists(taskId)) {
    return taskLog.readTaskLog(taskId)
  }
  // Fallback: slow path. Only hit if task-log file missing (pre-migration tasks).
  return parseJSONL(ACTIVITY_LOG).filter(e => String(e.taskId) === String(taskId))
}

function log(msg) {
  const ts = new Date().toISOString()
  console.log(`[${ts}] [FEEDBACK] ${msg}`)
}

// ══════════════════════════════════════════════════════════
// A) EXTRACT FAILURE TRACES
// ══════════════════════════════════════════════════════════
function extractFailureTraces(taskId, squad) {
  const traces = {
    taskId,
    squad,
    disproven: [],
    rejections: [],
    gradeFailures: [],
    lowScores: [],
  }

  // (2026-04-20 I8 fix) Use per-task log fast path instead of scanning the 500MB
  // global log every call. Same result, O(entries-for-task) not O(all-history).
  const taskActivities = readTaskActivityFast(taskId)

  for (const entry of taskActivities) {
    const action = entry.action || ''

    // DISPROVEN entries
    if (action.includes('DISPROVEN:')) {
      traces.disproven.push({
        agent: entry.agent,
        technique: entry.technique || action.replace('DISPROVEN:', '').trim(),
        target: entry.target || '',
        reason: entry.reason || entry.details || '',
        ts: entry.ts,
      })
    }

    // Grade failures
    if (action.includes('Quality Score') || action.includes('Grade:')) {
      const gradeMatch = action.match(/(\d+)%/)
      if (gradeMatch && parseInt(gradeMatch[1]) < 100) {
        traces.lowScores.push({
          agent: entry.agent,
          score: parseInt(gradeMatch[1]),
          details: entry.details || '',
        })
      }
    }
  }

  // Read verification log for ARBITER rejections
  const verifications = parseJSONL(VERIFICATION_LOG)
  const taskVerifications = verifications.filter(e => String(e.taskId) === String(taskId))

  for (const entry of taskVerifications) {
    if (entry.verdict === 'FAIL' || entry.verdict === 'PARTIAL' || (entry.passRate && entry.passRate < 100)) {
      traces.rejections.push({
        verdict: entry.verdict,
        passRate: entry.passRate,
        details: entry.details || entry.findings || '',
        round: entry.round || 1,
        ts: entry.ts,
      })
    }

    // Extract individual finding rejections
    if (entry.findings && Array.isArray(entry.findings)) {
      for (const finding of entry.findings) {
        if (finding.status === 'FALSE_POSITIVE' || finding.status === 'REJECTED' || finding.verified === false) {
          traces.rejections.push({
            verdict: 'REJECTED',
            finding: finding.title || finding.name || '',
            reason: finding.reason || finding.notes || '',
            ts: entry.ts,
          })
        }
      }
    }
  }

  return traces
}

// ══════════════════════════════════════════════════════════
// B) GENERATE LESSONS
// ══════════════════════════════════════════════════════════
function generateLessons(agentName, failureTraces) {
  const lessons = []
  const dateStr = new Date().toISOString().slice(0, 10)
  const taskId = failureTraces.taskId

  // Lessons from DISPROVEN entries
  for (const d of failureTraces.disproven) {
    lessons.push({
      date: dateStr,
      taskId,
      agent: d.agent,
      type: 'DISPROVEN',
      rule: `RULE: Technique "${d.technique}" was ineffective on "${d.target}" — ${d.reason}. Skip this approach for similar targets.`,
    })
  }

  // Lessons from ARBITER rejections
  for (const r of failureTraces.rejections) {
    if (r.finding) {
      lessons.push({
        date: dateStr,
        taskId,
        agent: agentName,
        type: 'REJECTION',
        rule: `RULE: Finding "${r.finding}" was rejected by ARBITER — ${r.reason}. Ensure independent verification before claiming this type of finding.`,
      })
    } else if (r.passRate !== undefined && r.passRate < 70) {
      lessons.push({
        date: dateStr,
        taskId,
        agent: agentName,
        type: 'LOW_PASS_RATE',
        rule: `RULE: Task ${taskId} achieved only ${r.passRate}% pass rate on round ${r.round || 1}. Review methodology — findings need stronger evidence and independent reproduction.`,
      })
    }
  }

  // Lessons from low grades
  for (const s of failureTraces.lowScores) {
    if (s.score < 80) {
      lessons.push({
        date: dateStr,
        taskId,
        agent: s.agent,
        type: 'LOW_GRADE',
        rule: `RULE: Agent ${s.agent} scored ${s.score}% on task ${taskId}. ${s.details ? `Issues: ${s.details.substring(0, 200)}` : 'Improve coverage and evidence quality.'}`,
      })
    }
  }

  return lessons
}

// ══════════════════════════════════════════════════════════
// C) WRITE FEEDBACK (agent + squad level)
// ══════════════════════════════════════════════════════════
function writeFeedback(agentName, taskId, squad, lessons, taskMetadata) {
  if (!lessons || lessons.length === 0) return

  const dateStr = new Date().toISOString().slice(0, 10)

  // 1. Write to agent's lessons.md
  const agentLower = agentName.toLowerCase()
  const agentLessonsFile = agentPaths.lessonsPath(agentLower)
  appendLessons(agentLessonsFile, lessons, taskId, dateStr, taskMetadata)

  // 2. Write to squad-level lessons
  const squadLessonsFile = `${INTEL_DIR}/squad-lessons-${normalizeSquad(squad)}.md`
  appendLessons(squadLessonsFile, lessons, taskId, dateStr, taskMetadata)

  log(`📚 Wrote ${lessons.length} lessons for ${agentName} (task ${taskId}, squad ${squad})`)
}

function appendLessons(file, lessons, taskId, dateStr, taskMetadata) {
  ensureDir(path.dirname(file))

  let existing = ''
  try { existing = fs.readFileSync(file, 'utf-8') } catch {}

  // Build metadata tag for smart memory ranking
  const metaTag = taskMetadata ? `\n<!-- META: ${JSON.stringify({
    targetDomain: taskMetadata.targetDomain || '',
    techStack: taskMetadata.techStack || '',
    agent: taskMetadata.agent || '',
    authType: taskMetadata.authType || '',
    hitCount: 0,
    missCount: 0,
    archived: false
  })} -->` : ''

  // Build new entry with metadata
  const entry = `\n### ${dateStr} — Task ${taskId}\n${lessons.map(l => `- ${l.rule}`).join('\n')}${metaTag}\n`

  let content = existing + entry

  // Cap at MAX_LESSONS entries (count ### headers)
  const sections = content.split(/(?=\n### )/)
  if (sections.length > MAX_LESSONS) {
    // Keep header (first section if it doesn't start with ###) + last MAX_LESSONS entries
    const header = sections[0].startsWith('### ') ? '' : sections[0]
    const kept = sections.filter(s => s.startsWith('### ') || s.trim().startsWith('### ')).slice(-MAX_LESSONS)
    content = header + kept.join('')
  }

  fs.writeFileSync(file, content)
}

// ══════════════════════════════════════════════════════════
// D) DISPROVEN CACHE
// ══════════════════════════════════════════════════════════
function writeDisprovenCache(taskId, squad, disproven) {
  if (!disproven || disproven.length === 0) return

  const cacheFile = `${INTEL_DIR}/disproven-cache-${normalizeSquad(squad)}.json`
  const cache = readJSONSafe(cacheFile, { entries: [], lastUpdated: null })
  const now = new Date()

  // Add new entries
  for (const d of disproven) {
    cache.entries.push({
      taskId,
      technique: d.technique,
      target: d.target,
      reason: d.reason,
      agent: d.agent,
      ts: d.ts || now.toISOString(),
      expires: new Date(now.getTime() + DISPROVEN_EXPIRY_DAYS * 86400000).toISOString(),
    })
  }

  // Expire old entries
  cache.entries = cache.entries.filter(e => new Date(e.expires) > now)

  // Cap at MAX_DISPROVEN (remove oldest first)
  if (cache.entries.length > MAX_DISPROVEN) {
    cache.entries = cache.entries.slice(-MAX_DISPROVEN)
  }

  cache.lastUpdated = now.toISOString()
  writeJSONSafe(cacheFile, cache)
  log(`🚫 Disproven cache updated: ${disproven.length} new entries for ${squad}`)
}

// ══════════════════════════════════════════════════════════
// E) AGENT SCORECARD
// ══════════════════════════════════════════════════════════
function calculateAgentScore(agentName, taskId, squad, grade, arbiterPassRate) {
  const scores = readJSONSafe(AGENT_SCORES_FILE, {})
  const dateStr = new Date().toISOString().slice(0, 10)
  const key = agentName.toLowerCase()

  if (!scores[key]) {
    scores[key] = {
      avgGrade: 0,
      avgarbiter: 0,
      tasksCompleted: 0,
      trend: 'new',
      lastUpdated: dateStr,
      history: [],
    }
  }

  const agent = scores[key]

  // Add to history
  agent.history.push({
    taskId,
    squad,
    grade: grade || 0,
    arbiter: arbiterPassRate || 0,
    date: dateStr,
  })

  // Keep only last SCORE_TASK_WINDOW entries
  if (agent.history.length > SCORE_TASK_WINDOW) {
    agent.history = agent.history.slice(-SCORE_TASK_WINDOW)
  }

  // Calculate rolling averages
  const prevAvgGrade = agent.avgGrade
  agent.avgGrade = Math.round(agent.history.reduce((s, h) => s + h.grade, 0) / agent.history.length)
  agent.avgarbiter = Math.round(agent.history.reduce((s, h) => s + h.arbiter, 0) / agent.history.length)
  agent.tasksCompleted = (agent.tasksCompleted || 0) + 1
  agent.lastUpdated = dateStr

  // Calculate trend (compare current avg to previous)
  if (agent.history.length < 3) {
    agent.trend = 'new'
  } else {
    const diff = agent.avgGrade - prevAvgGrade
    if (diff > 3) agent.trend = 'improving'
    else if (diff < -3) agent.trend = 'declining'
    else agent.trend = 'stable'
  }

  writeJSONSafe(AGENT_SCORES_FILE, scores)
  log(`📊 Agent score updated: ${agentName} — avg grade ${agent.avgGrade}%, trend: ${agent.trend}`)
}

// ══════════════════════════════════════════════════════════
// F) PATTERN DETECTION
// ══════════════════════════════════════════════════════════
function detectPatterns(squad) {
  const normalizedSquad = normalizeSquad(squad)
  const activities = parseJSONL(ACTIVITY_LOG)

  // Get unique task IDs for this squad, most recent first
  const squadTasks = [...new Set(
    activities.filter(e => normalizeSquad(e.squad) === normalizedSquad).map(e => e.taskId)
  )].filter(Boolean).slice(-PATTERN_TASK_WINDOW)

  if (squadTasks.length < 3) return // Not enough data

  const taskEntries = activities.filter(e => squadTasks.includes(e.taskId))

  // Count recurring patterns
  const disproven = {}
  const falsePositives = {}
  const techniques = {}

  for (const entry of taskEntries) {
    const action = entry.action || ''

    if (action.includes('DISPROVEN:')) {
      const tech = entry.technique || action.replace('DISPROVEN:', '').split('on')[0].trim()
      disproven[tech] = (disproven[tech] || 0) + 1
    }

    if (action.includes('FALSE_POSITIVE') || action.includes('REJECTED')) {
      const finding = action.substring(0, 80)
      falsePositives[finding] = (falsePositives[finding] || 0) + 1
    }
  }

  // Read verification log for patterns
  const verifications = parseJSONL(VERIFICATION_LOG)
  const squadVerifications = verifications.filter(e => squadTasks.includes(String(e.taskId)))

  let totalVerifications = squadVerifications.length
  let totalPasses = squadVerifications.filter(e => e.verdict === 'PASS').length
  let avgPassRate = totalVerifications > 0
    ? Math.round(squadVerifications.reduce((s, e) => s + (e.passRate || 0), 0) / totalVerifications)
    : 0

  // Build report
  const dateStr = new Date().toISOString().slice(0, 10)
  const recurring = Object.entries(disproven).filter(([, c]) => c >= 2).sort((a, b) => b[1] - a[1])
  const fpPatterns = Object.entries(falsePositives).filter(([, c]) => c >= 2).sort((a, b) => b[1] - a[1])

  let report = `# Squad Pattern Report: ${squad}\n`
  report += `_Generated: ${dateStr} | Tasks analyzed: ${squadTasks.length}_\n\n`

  report += `## Verification Stats\n`
  report += `- Total verifications: ${totalVerifications}\n`
  report += `- Pass rate: ${totalPasses}/${totalVerifications} (${totalVerifications > 0 ? Math.round(totalPasses / totalVerifications * 100) : 0}%)\n`
  report += `- Average ARBITER score: ${avgPassRate}%\n\n`

  if (recurring.length > 0) {
    report += `## Recurring Failed Techniques\n`
    report += `_These techniques keep failing — consider avoiding or changing approach_\n\n`
    for (const [tech, count] of recurring) {
      report += `- **${tech}** — failed ${count} times across ${squadTasks.length} tasks\n`
    }
    report += '\n'
  }

  if (fpPatterns.length > 0) {
    report += `## Common False Positives\n`
    report += `_These findings keep getting rejected — improve evidence quality_\n\n`
    for (const [finding, count] of fpPatterns) {
      report += `- **${finding}** — rejected ${count} times\n`
    }
    report += '\n'
  }

  if (recurring.length === 0 && fpPatterns.length === 0) {
    report += `## No Recurring Issues\n`
    report += `No significant patterns detected yet. Keep running tasks.\n`
  }

  const patternFile = `${INTEL_DIR}/squad-patterns-${normalizedSquad}.md`
  ensureDir(INTEL_DIR)
  fs.writeFileSync(patternFile, report)
  log(`🔍 Pattern report written: ${patternFile}`)
}

// ══════════════════════════════════════════════════════════
// CONTEXT PROVIDERS (for prompt injection)
// ══════════════════════════════════════════════════════════

/**
 * Get disproven cache context for prompt injection
 * @param {string} squad - Squad identifier
 * @param {string} [target] - Optional target to filter for
 * @returns {string} Context string or empty
 */
// (2026-04-23) Memory de-anchoring: over-tested targets accumulate biased
// memory (lessons + disproven cache). When an agent sees the same target 5+
// times with ever-more-refined lessons, it starts pattern-matching stale
// observations instead of probing fresh. The "fresh eyes" gate strips most
// memory context on repeatedly-scanned targets, replacing it with a directive
// to verify fresh. Threshold: >= FRESH_EYES_RECENT_SCANS runs in the last
// FRESH_EYES_WINDOW_DAYS days.
const FRESH_EYES_RECENT_SCANS = 3
const FRESH_EYES_WINDOW_DAYS = 14

function _countRecentScansForTarget(target) {
  if (!target) return 0
  try {
    const tasksFile = `${INTEL_DIR}/tasks.json`
    if (!fs.existsSync(tasksFile)) return 0
    const tasks = JSON.parse(fs.readFileSync(tasksFile, 'utf-8'))
    const cutoff = Date.now() - FRESH_EYES_WINDOW_DAYS * 24 * 3600 * 1000
    const needle = target.toLowerCase()
    let n = 0
    for (const t of tasks) {
      if (!t || t.status !== 'done') continue
      const haystack = `${t.title || ''} ${t.goal || ''}`.toLowerCase()
      if (!haystack.includes(needle)) continue
      const ts = Date.parse(t.startedAt || t.lastUpdate || t.created || '')
      if (!Number.isFinite(ts) || ts < cutoff) continue
      n++
    }
    return n
  } catch { return 0 }
}

function isOverTested(target) {
  return _countRecentScansForTarget(target) >= FRESH_EYES_RECENT_SCANS
}

// Exported so callers can inject a fresh-eyes preamble when memory is trimmed.
function getFreshEyesNotice(target) {
  const scans = _countRecentScansForTarget(target)
  if (scans < FRESH_EYES_RECENT_SCANS) return ''
  return `\n## ⚠️ FRESH-EYES MODE (target over-tested)\n` +
         `This target has been scanned ${scans} times in the last ${FRESH_EYES_WINDOW_DAYS} days. ` +
         `Prior memory has been intentionally downweighted to prevent pattern-matching bias. ` +
         `VERIFY every finding against the live target — do NOT assume prior observations still hold. ` +
         `Treat lessons from earlier runs as HYPOTHESES to test, not conclusions to apply.\n`
}

function getDisprovenContext(squad, target) {
  // Fresh-eyes gate: if this target has been scanned frequently, skip the
  // disproven cache entirely. Agents should probe independently on over-tested
  // targets rather than inherit a frozen list of "don't try this" patterns.
  if (isOverTested(target)) return ''

  const cacheFile = `${INTEL_DIR}/disproven-cache-${normalizeSquad(squad)}.json`
  const cache = readJSONSafe(cacheFile, { entries: [] })
  const now = new Date()

  // Filter: not expired, optionally matching target
  let entries = cache.entries.filter(e => new Date(e.expires) > now)

  if (target && entries.length > 0) {
    // Prefer entries matching this target, but include general ones too
    const targetLower = (target || '').toLowerCase()
    const relevant = entries.filter(e =>
      !e.target || e.target.toLowerCase().includes(targetLower) || targetLower.includes(e.target.toLowerCase())
    )
    if (relevant.length > 0) entries = relevant
  }

  // Take last 20 most recent
  entries = entries.slice(-20)

  if (entries.length === 0) return ''

  let context = '\n## KNOWN INEFFECTIVE TECHNIQUES (from prior tasks)\n'
  context += 'These approaches were already tried and failed. Do NOT retry unless you have a specific new reason:\n\n'
  for (const e of entries) {
    context += `- ❌ "${e.technique}" on ${e.target || 'target'} — ${e.reason || 'failed'}\n`
  }
  return context
}

/**
 * Get squad-level lessons for prompt injection
 * @param {string} squad - Squad identifier
 * @returns {string} Lessons context or empty
 */
function getSquadLessons(squad, target) {
  // Fresh-eyes gate: on over-tested targets, skip lessons so agents don't
  // anchor on stale conclusions. Note: `target` is optional for back-compat —
  // callers that pass it get the gate; callers that don't always get lessons.
  if (target && isOverTested(target)) return ''

  const lessonsFile = `${INTEL_DIR}/squad-lessons-${normalizeSquad(squad)}.md`
  try {
    if (!fs.existsSync(lessonsFile)) return ''
    const content = fs.readFileSync(lessonsFile, 'utf-8')

    // Extract last 10 lesson sections
    const sections = content.split(/(?=\n### )/).filter(s => s.includes('### '))
    const recent = sections.slice(-10)

    if (recent.length === 0) return ''

    let context = '\n## SQUAD LESSONS LEARNED (from prior tasks)\n'
    context += 'Apply these lessons to avoid repeating mistakes:\n'
    context += recent.join('').trim()
    context += '\n'
    return context
  } catch {
    return ''
  }
}

// ══════════════════════════════════════════════════════════
// MAIN ENTRY POINT
// ══════════════════════════════════════════════════════════

/**
 * Process all feedback after a task's ARBITER verification completes.
 * Single entry point called by event bus.
 * 
 * @param {string} taskId
 * @param {string} taskTitle
 * @param {string} squad
 * @param {string} leader - Lead agent name
 * @param {object} verifyResult - { verdict, passRate, ... }
 * @param {Array} allCosts - Cost tracking array
 */
async function processTaskFeedback(taskId, taskTitle, squad, leader, verifyResult, allCosts) {
  try {
    log(`🔄 Processing feedback for task ${taskId} (${squad}) — verdict: ${verifyResult.verdict}`)

    // 1. Extract failure traces
    const traces = extractFailureTraces(taskId, squad)

    // 2. Generate lessons (only if there were issues)
    const hasIssues = traces.disproven.length > 0 || traces.rejections.length > 0 || traces.lowScores.length > 0
    if (hasIssues) {
      const lessons = generateLessons(leader, traces)

      // 3. Write feedback to agent + squad level
      if (lessons.length > 0) {
        writeFeedback(leader, taskId, squad, lessons)
      }
    }

    // 4. Update disproven cache
    if (traces.disproven.length > 0) {
      writeDisprovenCache(taskId, squad, traces.disproven)
    }

    // 5. Calculate agent score
    const grade = extractGradeForTask(taskId, leader)
    calculateAgentScore(leader, taskId, squad, grade, verifyResult.passRate || 0)

    // 6. Detect patterns (async, non-blocking)
    try {
      detectPatterns(squad)
    } catch (e) {
      log(`⚠️ Pattern detection error (non-fatal): ${e.message}`)
    }

    log(`✅ Feedback loop complete for task ${taskId}`)
  } catch (e) {
    log(`❌ Feedback loop error (non-fatal): ${e.message}`)
  }
}

// ── Helper: extract grade for a task from activity log ──
function extractGradeForTask(taskId, leader) {
  // (2026-04-20 I8 fix) Per-task fast path.
  const activities = readTaskActivityFast(taskId)
  const gradeEntries = activities.filter(e =>
    String(e.action || '').includes('Quality Score') || String(e.action || '').includes('Grade:')
  )

  for (const entry of gradeEntries.reverse()) {
    const match = (entry.action || '').match(/(\d+)%/)
    if (match) return parseInt(match[1])
  }

  return 0
}

// ── Normalize squad name ──
function normalizeSquad(squad) {
  return (squad || 'unknown').toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '')
}

// (2026-04-23) Pipeline-completeness context provider — gated by squad config.
// Returns framework-agnostic white-box discipline text for code-review
// specialists. Designed to extend to cloud (IAM chain), network (CVE-banner),
// pentest (attack chain) later — just add branches keyed off the provider name
// from getEvidenceCompletenessConfig(squad).provider.
//
// Framework examples below are ILLUSTRATIVE — the specialist decides how
// they map to the specific target. This function never runs language detection;
// it just reminds the specialist WHICH layers exist in typical frameworks.
function getPipelineCompletenessContext(squad, target) {
  let sf
  try { sf = require('../core/squad-framework') } catch { return '' }
  const cfg = sf.getEvidenceCompletenessConfig(squad)
  if (!cfg || !cfg.enabled) return ''

  if (cfg.provider === 'pipeline') {
    return `

## EVIDENCE-COMPLETENESS DISCIPLINE (Pipeline Provider)

Before emitting ANY candidate, construct a \`pipeline_trace\` array listing every request-path layer you inspected from user input to the claimed sink. Minimum layers required for this squad to accept a "full" claim: 3.

### Layer taxonomy (framework-agnostic)
Every modern web framework has some subset of these layers. Identify which apply to this target:
  1. ROUTER CONSTRAINT — route-table auth/role constraint before dispatch (Rails constraints lambda or namespace scope; Django decorator in urls.py; Express middleware on route group; Laravel middleware chain; Spring @PreAuthorize annotation on URL mapping)
  2. MIDDLEWARE STACK — global middleware inspecting request.path and enforcing auth/role (Rack middleware, Django middleware, Express app.use, Laravel HTTP kernel, ASP.NET filters)
  3. CONTROLLER ANCESTORS — full class chain (parent → grandparent → module prepends/includes) (Rails ApplicationController ancestors, module prepend_mod_with; Django mixins; Spring @ControllerAdvice; Laravel controller middleware in __construct)
  4. FRAMEWORK CONVENTION — namespace/folder convention auto-wiring auth (Rails Admin:: convention, Django admin site, Nest guards on module)
  5. BEFORE/AROUND_ACTIONS — controller-scoped filters (Rails before_action, Django @method_decorator, Spring @Secured)
  6. POLICY/ABILITY CHECK — inline authorize calls in the action (Pundit, CanCanCan, Casbin, ABAC)
  7. MODEL-LEVEL SCOPE — query scoped by current_user even when controller doesn't (Rails default_scope, Django model manager)
  8. SINK — the actual vulnerable operation (read, write, shell-out, render, fetch)

### Output schema (every candidate MUST emit)
- \`evidence_completeness\`: "full" | "partial" | "local_only"
- \`pipeline_trace\`: array of layer tokens you INSPECTED (not just layers you mentioned)
- \`upstream_defenses_checked\`: array of {layer, file, outcome} for each layer; outcome ∈ {"none","partial","active","cannot_determine_statically"}
- \`runtime_verification_command\`: a single curl (or equivalent) that a human can run to verify
- \`expected_true_positive_signature\`: precise HTTP signature (status + body substring) if vuln exists
- \`expected_false_positive_signature\`: precise HTTP signature if an upstream layer we missed blocks the attack

### Severity discipline
- \`full\` = you inspected EVERY relevant layer + verified absence of defense at each. May claim Critical.
- \`partial\` = some layers inspected, others not. Max severity AUDITOR will accept: Medium.
- \`local_only\` = single-file evidence (e.g., "class inherits from X"). Max severity AUDITOR will accept: Low.

### Anti-patterns (automatic downgrade triggers)
- Claiming Critical/High without pipeline_trace ≥ 3 entries → treated as partial
- \`runtime_verification_command\` missing on Critical/High → auto-downgrade + \`unverifiable_by_design: true\`
- Identical TP/FP signatures → candidate rejected as malformed
- "Controller doesn't inherit from AdminController" as sole evidence for BFLA → local_only (framework may enforce elsewhere)

### Universal principle
Don't claim what you haven't traced. A missing check in ONE file is not proof of absence across the pipeline. Your confidence must match the completeness of your inspection, not the severity of the potential impact.
`
  }

  // Future providers: cloud (iam-chain), network (cve-banner), pentest (attack-chain),
  // ai-security (model-chain). Each would have its own branch here.
  return ''
}

// (2026-04-23 v2) Threat-model discipline provider. Stacks with v1
// getPipelineCompletenessContext in specialist prompts. Framework-agnostic
// reasoning about attacker privilege + trust boundaries + intentionality.
function getThreatModelContext(squad, target) {
  let sf
  try { sf = require('../core/squad-framework') } catch { return '' }
  const cfg = sf.getThreatModelConfig(squad)
  if (!cfg || !cfg.enabled) return ''

  if (cfg.provider === 'threat-model') {
    return `

## THREAT-MODEL DISCIPLINE (v2 — stacks with evidence_completeness)

Before claiming any Critical or High severity, emit a structured \`threat_model\` object on the candidate. Framework-agnostic — concepts apply whether target is Rails, Django, Express, Spring, Laravel, Go (Gin/Echo), .NET, PHP (Symfony/Laravel), Ruby (Rails/Sinatra), Python (FastAPI/Flask), Node, or anything else.

### Attacker-privilege levels (\`attacker_privilege\`)
- **unauth** — no credentials needed. Pre-auth RCE, unauthenticated IDOR. No severity cap.
- **authenticated** — any logged-in user (including free-signup). Genuine BFLA. No severity cap.
- **privileged** — in-app elevated role (project-maintainer, group-owner, organization-admin). Max severity: High.
- **admin** — instance admin / superuser-in-app. Max severity: Medium (admin already has full app control).
- **superuser** — OS-level shell / sudo / worker process. Max severity: Low.

### Trust-boundary classes (\`trust_boundary_crossed\`)
- **none** — attack stays within privilege attacker already has (admin using admin features). −1 tier.
- **cross-user** — affects another user's data without consent. No adjustment.
- **cross-tenant** — affects another org/tenant/workspace. +1 tier (undoes admin cap).
- **privilege-escalation** — attacker gains new in-app privilege. +1 tier.
- **unauth-to-auth** — pre-auth attacker gains authenticated session. +1 tier.
- **cross-org** — multi-tenant cross-instance. +1 tier.

### Documented-as-intended (\`documented_as_intended\`)
If the observed behavior is covered by:
- Official docs describing it as a feature
- Passing tests with intentional names (\`*_intended_spec\`, \`*_by_design_test\`)
- Comments near code (\`# intentional\`, \`// by design\`, \`/* feature: ... */\`)
- Feature flags exposed to end users

→ set true. Triggers −1 tier cap (WONTFIX territory).

### Toolchain-presence (\`toolchain_presence_verified\`)
For claims depending on a specific binary/library/config being exploitable AT RUNTIME:
- Binary CVE: verify installed (e.g., \`which convert\`, \`which ffmpeg\`)
- Library CVE: verify loaded (not just in manifest)
- Config-flag: verify default + whether exposed to end users

If claim depends on toolchain + unverified → max Low + flag \`toolchain_not_verified\`.

### Validation-layer inventory (\`validation_layers_checked\`)
For claims alleging validation gap: record every layer you inspected. Array from:
- \`router\` — route-table constraint
- \`middleware\` — global filter before dispatch
- \`controller\` — before_action / guard in controller class
- \`model\` — ActiveRecord/Django/ORM-level validation
- \`db-constraint\` — database-level (NOT NULL, CHECK, foreign-key)
- \`framework-default\` — framework convention

If validation-gap claim with fewer than 3 layers inspected → cap Medium. Validation can live at any layer — must check all.

### Severity cap stacking (AUDITOR applies)
1. Specialist claim →
2. v1 evidence_completeness cap (full/partial/local_only) →
3. attacker_privilege cap →
4. trust_boundary_crossed tier-delta →
5. documented_as_intended if true →
6. toolchain_presence_verified if applicable →
7. validation_layers_checked if applicable →
8. Final severity = MIN of all ceilings reached.

### Anti-inflation patterns (learned from GitLab verification 2026-04-23)
- Admin changing user email silently: admin + none + documented=true → Informational. Not a vuln — it's the admin rescue feature.
- Admin injecting OAuth identity into victim account: admin + privilege-escalation → +1 from Medium = High (genuine privilege transfer).
- Controller doesn't inherit from AdminController: local_only evidence + admin_privilege=unauth on /admin/ path = INCOHERENT → AUDITOR rejects.
- ImageMagick CVE claim without \`which convert\` verification: max Low (toolchain unverified).

### Universal principle
Severity must match realistic attack path, not theoretical worst case. An admin doing admin things is not a CVE; a non-admin doing admin things is. A library CVE is only exploitable if the library runs. A validation gap at one layer may be closed at another — check every layer before you claim.

### Missing threat_model → SAFE defaults
Forgetting to emit threat_model doesn't help you inflate severity. AUDITOR applies SAFE defaults (admin / none / documented=true / []) which cascade to Low/Informational. Fill it honestly or your claim drops.
`
  }

  return ''
}

module.exports = {
  processTaskFeedback,
  getDisprovenContext,
  getSquadLessons,
  getFreshEyesNotice,
  getPipelineCompletenessContext,
  getThreatModelContext,
  isOverTested,
  extractFailureTraces,
  generateLessons,
  writeFeedback,
  writeDisprovenCache,
  calculateAgentScore,
  detectPatterns,
}
