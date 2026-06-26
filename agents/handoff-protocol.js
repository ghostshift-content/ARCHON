
const __roots = require('../paths') // portable roots (KURU_*_ROOT) — see paths.js
// agents/handoff-protocol.js
//
// Sprint C.2 (2026-05-10): A2A cross-squad handoff protocol.
// File-based async handoff: source squad drops a JSON in inbox/, resolver
// dispatches target agent, writes verdict to done/ (or failed/).
//
// Spec: docs/superpowers/specs/2026-05-10-sprint-c2-a2a-design.md
// Locked decisions: async, $0.50/$2 caps, 3 handoffs/finding, chain depth 2.

const HANDOFF_SCHEMA_VERSION = '1'
const HANDOFF_STATUSES = Object.freeze(['pending', 'completed', 'failed'])

const HANDOFFS_BASE_DIR = (__roots.INTEL_ROOT + '/handoffs')
const HANDOFFS_INBOX_DIR = (__roots.INTEL_ROOT + '/handoffs/inbox')
const HANDOFFS_DONE_DIR = (__roots.INTEL_ROOT + '/handoffs/done')
const HANDOFFS_FAILED_DIR = (__roots.INTEL_ROOT + '/handoffs/failed')

// Locked design decisions (Jay 2026-05-10):
const MAX_HANDOFFS_PER_FINDING = 3
const MAX_CHAIN_DEPTH = 2
const DEFAULT_HANDOFF_BUDGET_USD = 0.50
const MAX_TASK_HANDOFF_BUDGET_USD = 2.00

const fs = require('node:fs')
const path = require('node:path')

function generateHandoffId() {
  const ts = Date.now()
  const rand = Math.random().toString(36).slice(2, 6)
  return `h-${ts}-${rand}`
}

// Walk inbox/ + done/ + failed/ and count handoffs matching (sourceTaskId,
// sourceFindingId).  Code-review fix (2026-05-10): the specialist prompt
// promised "MAX_HANDOFFS_PER_FINDING enforced by handoff-protocol" but the
// constant was never read. This counter is the enforcement.
//
// Perf note: in normal operation each task has ≤ a few dozen handoffs across
// all 3 dirs combined — well under the "100s of files" stop-condition. We
// scan all 3 dirs (not just inbox/) so the cap survives the natural
// inbox→done / inbox→failed flow. If a deployment ever accumulates 1000s
// of done/ files for a single live task, switch to an index file.
function _countHandoffsForFinding(baseDir, sourceTaskId, sourceFindingId) {
  let count = 0
  for (const sub of ['inbox', 'done', 'failed']) {
    const dir = path.join(baseDir, sub)
    let files
    try {
      files = fs.readdirSync(dir).filter(f => f.endsWith('.json') && !f.startsWith('.'))
    } catch {
      continue // dir doesn't exist yet — nothing to count
    }
    for (const f of files) {
      const rec = readHandoff(path.join(dir, f))
      if (!rec) continue
      if (String(rec.source_task_id) === String(sourceTaskId)
          && String(rec.source_finding_id) === String(sourceFindingId)) {
        count++
      }
    }
  }
  return count
}

function createHandoff({
  sourceTaskId, sourceSquad, sourceAgent, sourceFindingId,
  targetSquad, targetCapability, request,
  parentHandoffId = null, chainDepth = 0,
  budgetUsd = DEFAULT_HANDOFF_BUDGET_USD,
  force = false,
}, { baseDir = HANDOFFS_BASE_DIR } = {}) {
  // Required-field validation
  const required = { sourceTaskId, sourceSquad, sourceAgent, sourceFindingId,
                     targetSquad, targetCapability, request }
  for (const [k, v] of Object.entries(required)) {
    if (v == null || v === '') throw new Error(`missing required field: ${k}`)
  }
  if (!request.question) throw new Error(`missing required field: request.question`)

  // Chain-depth guard
  if (chainDepth > MAX_CHAIN_DEPTH) {
    throw new Error(`chain depth ${chainDepth} exceeds MAX_CHAIN_DEPTH=${MAX_CHAIN_DEPTH}`)
  }

  // Per-finding count cap (code-review fix 2026-05-10). The specialist
  // prompt advertises this as enforced — now it actually is. --force is the
  // ops-only escape hatch (rare; logs a warning so it never goes silent).
  const existing = _countHandoffsForFinding(baseDir, sourceTaskId, sourceFindingId)
  if (existing >= MAX_HANDOFFS_PER_FINDING) {
    if (!force) {
      throw new Error(
        `finding has reached MAX_HANDOFFS_PER_FINDING (${MAX_HANDOFFS_PER_FINDING}) — refusing to create`
      )
    }
    console.warn(
      `[handoff-protocol] WARN: bypassing MAX_HANDOFFS_PER_FINDING (${existing} >= ${MAX_HANDOFFS_PER_FINDING}) ` +
      `via force=true for task=${sourceTaskId} finding=${sourceFindingId}`
    )
  }

  const handoffId = generateHandoffId()
  const inboxDir = path.join(baseDir, 'inbox')
  fs.mkdirSync(inboxDir, { recursive: true })
  const filePath = path.join(inboxDir, `${handoffId}.json`)

  const record = {
    schema_version: HANDOFF_SCHEMA_VERSION,
    handoff_id: handoffId,
    source_task_id: String(sourceTaskId),
    source_squad: sourceSquad,
    source_agent: sourceAgent,
    source_finding_id: sourceFindingId,
    target_squad: targetSquad,
    target_capability: targetCapability,
    request: {
      question: String(request.question),
      evidence: request.evidence || {},
      expected_artifacts: request.expected_artifacts || [],
    },
    created_at: new Date().toISOString(),
    status: 'pending',
    chain_depth: chainDepth,
    cost_budget_usd: budgetUsd,
    parent_handoff_id: parentHandoffId,
  }

  fs.writeFileSync(filePath, JSON.stringify(record, null, 2) + '\n')
  return { handoff_id: handoffId, path: filePath, record }
}

function readHandoff(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'))
  } catch {
    return null
  }
}

function _moveTo(srcPath, destDir, baseDir) {
  fs.mkdirSync(destDir, { recursive: true })
  const destPath = path.join(destDir, path.basename(srcPath))
  fs.renameSync(srcPath, destPath)
  return destPath
}

function markCompleted(srcPath, {
  resolvedByAgent, verdict, verdictReason,
  evidenceAdded = {}, costActualUsd = 0,
}, { baseDir = HANDOFFS_BASE_DIR } = {}) {
  if (!fs.existsSync(srcPath)) {
    // Idempotent: file already moved (or never existed). No-op.
    return { path: null, alreadyResolved: true }
  }
  const record = readHandoff(srcPath)
  if (!record) throw new Error(`unparseable handoff at ${srcPath}`)
  Object.assign(record, {
    status: 'completed',
    resolved_at: new Date().toISOString(),
    resolved_by_agent: resolvedByAgent,
    verdict, verdict_reason: verdictReason,
    evidence_added: evidenceAdded,
    cost_actual_usd: costActualUsd,
  })
  fs.writeFileSync(srcPath, JSON.stringify(record, null, 2) + '\n')
  const doneDir = path.join(baseDir, 'done')
  const newPath = _moveTo(srcPath, doneDir, baseDir)
  return { path: newPath, record }
}

function markFailed(srcPath, reason, { baseDir = HANDOFFS_BASE_DIR } = {}) {
  if (!fs.existsSync(srcPath)) {
    return { path: null, alreadyResolved: true }
  }
  const record = readHandoff(srcPath)
  if (!record) throw new Error(`unparseable handoff at ${srcPath}`)
  Object.assign(record, {
    status: 'failed',
    resolved_at: new Date().toISOString(),
    failure_reason: String(reason),
  })
  fs.writeFileSync(srcPath, JSON.stringify(record, null, 2) + '\n')
  const failedDir = path.join(baseDir, 'failed')
  const newPath = _moveTo(srcPath, failedDir, baseDir)
  return { path: newPath, record }
}

// ── Sprint C.2 Task 8 (2026-05-10): SCRIBE cross-squad corroboration ──
// Scan handoffs/done/ for verdicts matching `taskId` and build a markdown
// section grouped by source_finding_id. Returns '' when no matches exist
// (so SCRIBE never injects a fake/empty CROSS-SQUAD section).
function buildCrossSquadCorroborationSection(taskId, { baseDir = HANDOFFS_BASE_DIR } = {}) {
  if (!taskId) return ''
  const doneDir = path.join(baseDir, 'done')
  let entries
  try {
    entries = fs.readdirSync(doneDir).filter(f => f.endsWith('.json'))
  } catch {
    return '' // done/ doesn't exist yet — no handoffs to surface
  }
  const matching = []
  for (const f of entries) {
    const rec = readHandoff(path.join(doneDir, f))
    if (!rec) continue
    if (String(rec.source_task_id) === String(taskId)) matching.push(rec)
  }
  if (matching.length === 0) return ''

  // Group by source_finding_id. Stable key order = insertion order of first hit.
  const groups = new Map()
  for (const rec of matching) {
    const key = rec.source_finding_id || '<unknown-finding>'
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(rec)
  }

  let out = `\n## CROSS-SQUAD CORROBORATION (A2A handoff verdicts)\n\n`
  out += `The following findings were corroborated by cross-squad expert specialists. Cite each verdict as ADDITIONAL evidence under the source finding's evidence section in the published report — alongside (not in place of) the primary finding evidence.\n\n`
  for (const [findingId, recs] of groups) {
    out += `### Finding ${findingId}\n`
    for (const r of recs) {
      const reason = r.verdict_reason ? ` — ${r.verdict_reason}` : ''
      out += `- **${r.target_squad}/${r.target_capability}** (resolved by ${r.resolved_by_agent || '?'}): **${r.verdict}**${reason}\n`
    }
    out += `\n`
  }
  return out
}

module.exports = {
  HANDOFF_SCHEMA_VERSION,
  HANDOFF_STATUSES,
  HANDOFFS_BASE_DIR,
  HANDOFFS_INBOX_DIR,
  HANDOFFS_DONE_DIR,
  HANDOFFS_FAILED_DIR,
  MAX_HANDOFFS_PER_FINDING,
  MAX_CHAIN_DEPTH,
  DEFAULT_HANDOFF_BUDGET_USD,
  MAX_TASK_HANDOFF_BUDGET_USD,
  createHandoff,
  readHandoff,
  markCompleted,
  markFailed,
  buildCrossSquadCorroborationSection,
}
