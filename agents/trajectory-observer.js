
const __roots = require('../paths') // portable roots (KURU_*_ROOT) — see paths.js
// agents/trajectory-observer.js
//
// Sprint C.1 (2026-05-09): TrajAD-inspired specialist output observer.
// Pure observation layer — no auto-rollback in MVP. Logs verdicts so we
// can decide rollback policy from data, not speculation.
//
// Spec: docs/superpowers/specs/2026-05-09-sprint-c1-trajectory-rollback.md
// Reference: arXiv 2602.06443 (TrajAD step-level trajectory rollback)

const SCHEMA_VERSION = '1'
const VERDICTS = Object.freeze(['on-track', 'off-track', 'crashed', 'indeterminate'])
const FAILURE_DIMS = Object.freeze(['goal-alignment', 'evidence-quality', 'coherence'])
// FIX 3 (2026-05-09): canonical log moved to a subdir. The legacy path
// `/root/intel/trajectory-observations.jsonl` was being polluted by
// specialist shell-echo writes (live pentest 1778394458903) — non-canonical
// schemas with verdict='HONEST'/'CONFIRMED'/'DISPROVEN'. Subdir is less
// likely to collide because most prompt instructions and shell scripts
// reference the file form, not the subdir form.
const DEFAULT_LOG_PATH = (__roots.INTEL_ROOT + '/trajectory/observations.jsonl')
// Legacy path retained ONLY for documentation/migration awareness — we no
// longer write to it. Readers can scan this for historical data, but
// canonical writes go to DEFAULT_LOG_PATH.
const LEGACY_LOG_PATH = (__roots.INTEL_ROOT + '/trajectory-observations.jsonl')

const MAX_OUTPUT_BYTES = 3000

function buildObserverPrompt({ agent, goal, output }) {
  // Anti-sycophancy: deliberately ignore any downstream verdict fields.
  // Caller may pass them; we don't read them. Same discipline as judge-verifier.
  const safeAgent = String(agent || '(unknown)')
  const safeGoal = String(goal || '(no goal stated)')
  let safeOutput
  if (output == null || (typeof output === 'string' && output.trim() === '')) {
    safeOutput = '(no output)'
  } else {
    const s = String(output)
    safeOutput = s.length > MAX_OUTPUT_BYTES
      ? s.slice(0, MAX_OUTPUT_BYTES) + '\n…[truncated]'
      : s
  }

  return `You are the Trajectory Observer. Classify the SPECIALIST OUTPUT below
against its stated GOAL using a 3-dimension rubric. Do NOT validate the findings
themselves — that is a separate layer's job. Your job is to spot specialists that
went off-track, crashed silently, or produced incoherent output.

SPECIALIST: ${safeAgent}
GOAL: ${safeGoal}

OUTPUT:
${safeOutput}

EVALUATE 3 DIMENSIONS in order. First-failed determines verdict:

1. Goal alignment — Did the specialist actually attempt the stated goal?
   PASS: output addresses the goal directly with relevant artefacts
   FAIL: output is unrelated, generic recon, or wrong domain

2. Evidence quality — Are claims backed by concrete artefacts (curl, screenshots,
   response bodies, file paths)?
   PASS: at least one concrete artefact tied to a claim
   FAIL: assertions only, no probe data, no commands

3. Coherence — Is the output internally consistent and parseable?
   PASS: structured findings, complete sentences, no obvious crash mid-output
   FAIL: truncated mid-token, repeated paragraphs, malformed JSON, "Killed" / "OOM"

OUTPUT STRICT JSON ONLY (no markdown fences, no commentary):
{
  "verdict": "on-track" | "off-track" | "crashed" | "indeterminate",
  "first_failed_dim": "goal-alignment" | "evidence-quality" | "coherence" | null,
  "reason": "<one sentence>"
}

Verdict rules:
  - "on-track":      ALL THREE dimensions pass
  - "off-track":     dim 1 or 2 failed (specialist reasoning is wrong)
  - "crashed":       dim 3 failed AND output looks truncated/empty
  - "indeterminate": insufficient signal to decide either way

Be skeptical but fair. Specialists may legitimately find nothing — that's not
"off-track" if their probes were appropriate.`
}

function parseObserverResponse(text) {
  // Strix-style discipline (matches Sprint B.1 judge-verifier): fail-safe
  // returns 'indeterminate' rather than silently confirming. Caller decides
  // what to do with indeterminate (here: just logged, not acted on in MVP).
  if (!text || typeof text !== 'string') {
    return { verdict: 'indeterminate', first_failed_dim: null, reason: '', error: 'empty response' }
  }
  let cleaned = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '')
  const m = cleaned.match(/\{[\s\S]*\}/)
  if (!m) {
    return { verdict: 'indeterminate', first_failed_dim: null, reason: '', error: 'no JSON found' }
  }
  let parsed
  try {
    parsed = JSON.parse(m[0])
  } catch (e) {
    return { verdict: 'indeterminate', first_failed_dim: null, reason: '', error: `parse failed: ${e.message}` }
  }
  // Validate verdict
  let verdict = String(parsed.verdict || '').toLowerCase()
  let error
  if (!VERDICTS.includes(verdict)) {
    error = `unknown verdict: ${parsed.verdict}`
    verdict = 'indeterminate'
  }
  // Validate first_failed_dim
  let dim = parsed.first_failed_dim
  if (dim != null && !FAILURE_DIMS.includes(String(dim))) {
    dim = null
  }
  if (verdict === 'on-track') dim = null // can't have a failed dim if on-track
  const result = {
    verdict,
    first_failed_dim: dim || null,
    reason: String(parsed.reason || '').slice(0, 500),
  }
  if (error) result.error = error
  return result
}

const fs = require('node:fs')
const path = require('node:path')

function logObservation(obs, logFile = DEFAULT_LOG_PATH) {
  // Fail-soft: caller is mid-pipeline (Phase 2 specialist completion). An
  // observer-log error must never break the run. Worst case we lose a
  // single line of telemetry.
  try {
    const enriched = {
      schema_version: SCHEMA_VERSION,
      observed_at: obs.observed_at || new Date().toISOString(),
      ...obs,
    }
    const line = JSON.stringify(enriched) + '\n'
    const dir = path.dirname(logFile)
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
    fs.appendFileSync(logFile, line)
  } catch (e) {
    // Swallow. A future enhancement can wire this to logActivity, but for
    // MVP we accept silent loss of one telemetry record over breaking the run.
  }
}

// ── Concurrency cap (FIX 2, 2026-05-10) ─────────────────────────────────────
// Every specialist completion fires a fresh `claude --print` subprocess via
// the observer. With parallel pentests + 18 specialists each, 30+ concurrent
// processes could stress host memory + hit Anthropic rate-limits.
//
// Two modes:
//   QUEUE  (default)         — calls beyond CAP wait for a slot. Total log
//                              entries unchanged; only timing affected.
//   DROP   (env-flagged)     — calls beyond CAP get verdict='indeterminate'
//                              + error='cap-exceeded', NO LLM fired. Logged
//                              for telemetry. Use when host pressure > timing.
//
// Toggle via env:
//   TRAJECTORY_OBSERVER_CAP            (default: 5)
//   TRAJECTORY_OBSERVER_CAP_DROP_OVER  (truthy → drop mode; default queue)
const OBSERVER_CONCURRENCY_CAP = 5

let _activeCount = 0
const _waitQueue = []

function _getCap() {
  const env = parseInt(process.env.TRAJECTORY_OBSERVER_CAP, 10)
  return Number.isFinite(env) && env > 0 ? env : OBSERVER_CONCURRENCY_CAP
}

function _isDropMode() {
  const v = process.env.TRAJECTORY_OBSERVER_CAP_DROP_OVER
  return v && /^(1|true|yes)$/i.test(String(v))
}

function _acquireSlot() {
  // Returns a Promise that resolves once a slot is available. Resolves
  // immediately if under cap; otherwise queues a resolver to be called when
  // _releaseSlot fires.
  if (_activeCount < _getCap()) {
    _activeCount++
    return Promise.resolve()
  }
  return new Promise(resolve => _waitQueue.push(resolve))
}

function _releaseSlot() {
  if (_waitQueue.length > 0) {
    // Hand the slot directly to the next waiter — keep _activeCount at cap.
    const next = _waitQueue.shift()
    next() // waiter increments their own active accounting via the resolution path
    return
  }
  _activeCount = Math.max(0, _activeCount - 1)
}

// Test-only: reset module state between tests
function _resetConcurrencyForTest() {
  _activeCount = 0
  _waitQueue.length = 0
}

async function observeSpecialistOutput({
  agent, taskId, goal, output,
  callLLM, logFile = DEFAULT_LOG_PATH,
  elapsedMs = null, model = null,
}) {
  const outputStr = typeof output === 'string' ? output : (output == null ? '' : String(output))
  const outputBytes = Buffer.byteLength(outputStr, 'utf-8')

  // Concurrency cap: drop mode short-circuits when at cap; queue mode awaits
  // a slot. The cap protects host memory and Anthropic rate-limits from
  // unbounded fan-out on parallel pentests.
  const cap = _getCap()
  let dropped = false
  if (_activeCount >= cap && _isDropMode()) {
    dropped = true
  } else {
    await _acquireSlot()
  }

  let parsed = { verdict: 'indeterminate', first_failed_dim: null, reason: '' }
  if (dropped) {
    parsed = {
      verdict: 'indeterminate',
      first_failed_dim: null,
      reason: '',
      error: 'cap-exceeded',
    }
  } else {
    try {
      const prompt = buildObserverPrompt({ agent, goal, output: outputStr })
      const response = await callLLM(prompt)
      parsed = parseObserverResponse(response)
    } catch (e) {
      parsed = { verdict: 'indeterminate', first_failed_dim: null, reason: '', error: `LLM error: ${e.message}` }
    } finally {
      // Always release the slot — even on error — to prevent semaphore leaks.
      _releaseSlot()
    }
  }

  const obs = {
    task_id: String(taskId),
    agent: String(agent || '(unknown)'),
    verdict: parsed.verdict,
    first_failed_dim: parsed.first_failed_dim,
    reason: parsed.reason,
    output_bytes: outputBytes,
    elapsed_ms: elapsedMs,
    model,
    observed_at: new Date().toISOString(),
  }
  if (parsed.error) obs.error = parsed.error

  // Persist (fail-soft inside logObservation)
  logObservation(obs, logFile)

  return obs
}

// FIX 3 (2026-05-09): canonical-only reader. Returns ONLY records where
// `schema_version === SCHEMA_VERSION`. Skips/silently drops malformed
// lines and missing files (fail-soft: log file may be in flux during a
// run; readers cannot crash on a transient parse error).
//
// Use this instead of `fs.readFileSync(...).split('\n')` whenever you
// want to consume trajectory observations programmatically — it gives
// you the canonical observer-only view, isolated from any specialist
// pollution that may have leaked into the legacy file.
function readTrajectoryLog(filePath = DEFAULT_LOG_PATH) {
  let raw
  try {
    raw = fs.readFileSync(filePath, 'utf-8')
  } catch {
    return [] // missing / unreadable → empty
  }
  if (!raw || !raw.trim()) return []
  const out = []
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue
    let parsed
    try {
      parsed = JSON.parse(line)
    } catch {
      continue // malformed — skip silently
    }
    if (!parsed || typeof parsed !== 'object') continue
    if (parsed.schema_version !== SCHEMA_VERSION) continue // non-canonical — skip
    out.push(parsed)
  }
  return out
}

module.exports = {
  SCHEMA_VERSION,
  VERDICTS,
  FAILURE_DIMS,
  DEFAULT_LOG_PATH,
  LEGACY_LOG_PATH,
  OBSERVER_CONCURRENCY_CAP,
  buildObserverPrompt,
  parseObserverResponse,
  logObservation,
  observeSpecialistOutput,
  readTrajectoryLog,
  // Test-only export
  _resetConcurrencyForTest,
}
