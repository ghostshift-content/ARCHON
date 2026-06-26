
const __roots = require('../paths') // portable roots (KURU_*_ROOT) — see paths.js
// agents/handoff-resolver.js
//
// Sprint C.2 Task 5 (2026-05-10): handoff resolver. Loads each squad's
// capabilities.json, routes incoming handoffs by target_squad +
// target_capability, dispatches the target agent, persists verdict.

const fs = require('node:fs')
const path = require('node:path')
const {
  HANDOFFS_BASE_DIR, readHandoff, markCompleted, markFailed,
  MAX_TASK_HANDOFF_BUDGET_USD,
} = require('./handoff-protocol')

// Sum cost_actual_usd across all completed handoffs for a given task.
// Code-review fix (2026-05-10): MAX_TASK_HANDOFF_BUDGET_USD was exported but
// never read. processHandoff now checks this BEFORE dispatching, so a
// runaway specialist can't burn through the budget post-hoc.
function _sumTaskCostFromDone(baseDir, sourceTaskId) {
  const doneDir = path.join(baseDir, 'done')
  let files
  try {
    files = fs.readdirSync(doneDir).filter(f => f.endsWith('.json') && !f.startsWith('.'))
  } catch {
    return 0
  }
  let sum = 0
  for (const f of files) {
    const rec = readHandoff(path.join(doneDir, f))
    if (!rec) continue
    if (String(rec.source_task_id) !== String(sourceTaskId)) continue
    const c = Number(rec.cost_actual_usd)
    if (Number.isFinite(c)) sum += c
  }
  return sum
}

const DEFAULT_SQUADS_DIR = (__roots.AGENTS_ROOT + '/squads')

function loadCapabilityMap(squadsDir = DEFAULT_SQUADS_DIR) {
  const map = {}
  if (!fs.existsSync(squadsDir)) return map
  for (const squad of fs.readdirSync(squadsDir)) {
    const capFile = path.join(squadsDir, squad, 'capabilities.json')
    if (!fs.existsSync(capFile)) continue
    let parsed
    try {
      parsed = JSON.parse(fs.readFileSync(capFile, 'utf-8'))
    } catch {
      continue // skip malformed
    }
    map[parsed.squad || squad] = {}
    for (const cap of (parsed.capabilities || [])) {
      map[parsed.squad || squad][cap.id] = cap
    }
  }
  return map
}

function resolveTarget(capabilityMap, targetSquad, targetCapability) {
  const squadMap = capabilityMap[targetSquad]
  if (!squadMap) return null
  const cap = squadMap[targetCapability]
  if (!cap) return null
  return {
    squad: targetSquad,
    capability: targetCapability,
    agent: cap.agents[0], // primary agent for the capability
    cap,
  }
}

async function processHandoff(filePath, capabilityMap, {
  dispatchAgent, baseDir = HANDOFFS_BASE_DIR,
} = {}) {
  // Idempotence: file already moved (resolved or failed earlier)
  if (!fs.existsSync(filePath)) {
    return { status: 'noop', alreadyResolved: true }
  }
  const record = readHandoff(filePath)
  if (!record) {
    markFailed(filePath, 'unparseable handoff JSON', { baseDir })
    return { status: 'failed', reason: 'unparseable' }
  }
  // Route
  const target = resolveTarget(capabilityMap, record.target_squad, record.target_capability)
  if (!target) {
    markFailed(filePath, `no capability matching ${record.target_squad}/${record.target_capability}`, { baseDir })
    return { status: 'failed', reason: 'no-capability' }
  }
  // Per-task budget cap (BEFORE dispatch — protects against runaway).
  // Code-review fix (2026-05-10): MAX_TASK_HANDOFF_BUDGET_USD enforcement.
  const summedCost = _sumTaskCostFromDone(baseDir, record.source_task_id)
  if (summedCost >= MAX_TASK_HANDOFF_BUDGET_USD) {
    const reason = `task budget exceeded ($${summedCost.toFixed(2)} of $${MAX_TASK_HANDOFF_BUDGET_USD.toFixed(2)})`
    markFailed(filePath, reason, { baseDir })
    return { status: 'failed', reason: 'budget-exceeded', summedCost }
  }
  // Dispatch
  let result
  try {
    result = await dispatchAgent({
      agent: target.agent,
      squad: target.squad,
      capability: target.capability,
      handoff: record,
    })
  } catch (e) {
    markFailed(filePath, `dispatch error: ${e.message}`, { baseDir })
    return { status: 'failed', reason: 'dispatch-error', error: e.message }
  }
  if (!result || !result.verdict) {
    markFailed(filePath, 'dispatch returned no verdict', { baseDir })
    return { status: 'failed', reason: 'no-verdict' }
  }
  markCompleted(filePath, {
    resolvedByAgent: target.agent,
    verdict: result.verdict,
    verdictReason: result.verdictReason || '',
    evidenceAdded: result.evidenceAdded || {},
    costActualUsd: result.costActualUsd || 0,
  }, { baseDir })
  return { status: 'completed' }
}

// ─── Sprint C.2 Task 7: watcher + dispatcher closure ───────────────────────

/**
 * Build the prompt the dispatched agent (e.g. KUBERA) sees for a handoff.
 *
 * Anti-sycophancy discipline: the dispatched agent receives ONLY the raw
 * evidence + the question. It MUST NOT see source-agent notes, the parent
 * verdict, or any source-claimed severity — same isolation the judge layer
 * (Sprint A+B) uses to keep verdicts independent.
 */
function buildHandoffDispatchPrompt({ agent, squad, capability, handoff }) {
  const req = handoff.request || {}
  const evidenceJson = JSON.stringify(req.evidence || {}, null, 2)
  const expectedArtifacts = (req.expected_artifacts || []).join(', ') || '(none specified)'
  // Whitelist what we expose. NEVER spread `handoff` into the prompt — that
  // would leak any future source-agent fields by accident.
  return [
    `You are ${agent} (${squad} squad), the expert for capability "${capability}".`,
    ``,
    `An independent finding from another squad needs your verdict. You are NOT`,
    `told what the source agent thought, what severity they assigned, or what`,
    `their conclusion was. Form your verdict from the raw evidence and your`,
    `domain expertise alone.`,
    ``,
    `── Question ──`,
    String(req.question || '(no question)'),
    ``,
    `── Raw evidence (machine-collected, not interpreted) ──`,
    evidenceJson,
    ``,
    `── Expected artifacts ──`,
    expectedArtifacts,
    ``,
    `── Response format (REQUIRED — strict JSON, no prose) ──`,
    `{`,
    `  "verdict": "CONFIRMED" | "REFUTED" | "INDETERMINATE",`,
    `  "reason": "one or two sentences explaining the verdict",`,
    `  "evidence_added": { /* any new facts you collected */ }`,
    `}`,
    ``,
    `Respond with ONLY the JSON object. No code fences, no commentary.`,
  ].join('\n')
}

/**
 * Strix-style verdict parser. Empty / malformed / missing-verdict → INDETERMINATE.
 * Tolerates ```json ... ``` fences and surrounding prose by extracting the first
 * balanced { ... } block.
 */
function parseHandoffVerdict(raw) {
  const fail = (reason) => ({
    verdict: 'INDETERMINATE',
    verdictReason: `parse failure: ${reason}`,
    evidenceAdded: {},
    costActualUsd: 0,
  })
  if (raw == null) return fail('empty response')
  const text = String(raw).trim()
  if (!text) return fail('empty response')

  // Strip a markdown fence if present, otherwise look for the first JSON block.
  let candidate = text
  const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fenceMatch) candidate = fenceMatch[1].trim()
  if (!candidate.startsWith('{')) {
    const braceIdx = candidate.indexOf('{')
    if (braceIdx >= 0) candidate = candidate.slice(braceIdx)
  }

  let parsed
  try {
    parsed = JSON.parse(candidate)
  } catch (e) {
    return fail(`malformed JSON (${e.message})`)
  }
  if (!parsed || typeof parsed !== 'object') return fail('not an object')
  const verdict = parsed.verdict
  if (!verdict || typeof verdict !== 'string') return fail('missing verdict field')
  const verdictNorm = verdict.toUpperCase()
  const allowed = new Set(['CONFIRMED', 'REFUTED', 'INDETERMINATE'])
  if (!allowed.has(verdictNorm)) return fail(`unknown verdict "${verdict}"`)

  return {
    verdict: verdictNorm,
    verdictReason: String(parsed.reason || parsed.verdict_reason || ''),
    evidenceAdded: parsed.evidence_added || parsed.evidenceAdded || {},
    costActualUsd: Number(parsed.cost_actual_usd || parsed.costActualUsd || 0) || 0,
  }
}

/**
 * Build a dispatchAgent closure backed by a Claude subprocess (or any LLM
 * exposed via callLLM(prompt, { model })). Matches scripts/run-judge-verifier
 * pattern: subprocess instead of full event-bus spawnAgent (which is too
 * tightly coupled to the squad-specific dispatch flow).
 */
function buildClaudeDispatcher({ callLLM, model } = {}) {
  if (typeof callLLM !== 'function') {
    throw new Error('buildClaudeDispatcher: callLLM function required')
  }
  // 2026-05-10: route through resolveLLMModel so caller can either pass an
  // explicit model (e.g. HANDOFF_LLM_MODEL env var passthrough) OR fall through
  // to the configured balanced family. Same regression class as 2026-04-20
  // stocks fix — no hardcoded model IDs in dispatch paths.
  const { resolveLLMModel } = require('./llm-model-resolver')
  const resolvedModel = resolveLLMModel({ family: 'balanced', override: model })
  return async ({ agent, squad, capability, handoff }) => {
    const prompt = buildHandoffDispatchPrompt({ agent, squad, capability, handoff })
    const response = await callLLM(prompt, { model: resolvedModel })
    return parseHandoffVerdict(response)
  }
}

/**
 * Single-pass inbox sweep. Reads every *.json from <baseDir>/inbox and runs
 * processHandoff on each. Returns counts; never throws — individual handoff
 * failures end up in <baseDir>/failed/ via processHandoff's own markFailed.
 */
async function processInboxOnce({
  capabilityMap, dispatchAgent, baseDir = HANDOFFS_BASE_DIR,
} = {}) {
  const inboxDir = path.join(baseDir, 'inbox')
  if (!fs.existsSync(inboxDir)) {
    return { processed: 0, succeeded: 0, failed: 0 }
  }
  const files = fs.readdirSync(inboxDir).filter(f => f.endsWith('.json') && !f.startsWith('.'))
  let succeeded = 0
  let failed = 0
  for (const file of files) {
    const filePath = path.join(inboxDir, file)
    let result
    try {
      result = await processHandoff(filePath, capabilityMap, { dispatchAgent, baseDir })
    } catch (e) {
      // Defensive: processHandoff is supposed to swallow its own errors via
      // markFailed, but if something escapes, count it as failed.
      failed++
      continue
    }
    if (result && result.status === 'completed') succeeded++
    else if (result && result.status === 'failed') failed++
    // status === 'noop' (already-resolved) does not count as processed
  }
  return {
    processed: succeeded + failed,
    succeeded,
    failed,
  }
}

module.exports = {
  loadCapabilityMap,
  resolveTarget,
  processHandoff,
  // Sprint C.2 Task 7
  buildHandoffDispatchPrompt,
  parseHandoffVerdict,
  buildClaudeDispatcher,
  processInboxOnce,
}
