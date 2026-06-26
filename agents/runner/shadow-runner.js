// agents/runner/shadow-runner.js
//
// SDK-vs-CLI SHADOW RUNNER (Task 4, run-agent modernization).
//
// PURPOSE: when SHADOW=sdk is set on the daemon, a sampled subset of live
// dispatches ALSO fire the `sdk` adapter in shadow. The shadow result is
// written ONLY to /root/intel/shadow-runs/<runKey>/<agentName>/ and a small
// structural diff is produced. This lets us compare the SDK adapter against the
// production CLI path WITHOUT risking any live behavior change.
//
// HARD INVARIANTS (this module is required from the LIVE PM2 daemon):
//   1. NO-LIVE-LEAK: every write lands under SHADOW_ROOT (or the injected
//      test outDir). Nothing here ever touches tasks.json, the activity log,
//      VALIDATED-FINDINGS, reports, or any production state.
//   2. NEVER THROWS: every code path is wrapped. On any internal error we
//      try to record it in diff.json and then swallow. The caller (event-bus)
//      additionally fire-and-forgets with .catch(()=>{}), but we must not
//      rely on that — this module is independently safe.
//   3. FIRE-AND-FORGET: returns a promise; the caller does NOT await it on
//      the live path. The live result is already in hand by the time this runs.
//
// SAMPLING: deterministic per-taskId so a given task either always samples or
// never does (stable, testable, no state file). hash(taskId) % K === 0.
// K from SHADOW_SAMPLE_K (default 5) → ~1-in-5 dispatches pay double credits.
//
// ARTIFACT PATHS: shadow-runs/<runKey>/<agentName>/ — per-agent subdirs prevent
// concurrent specialists sharing the same taskId from clobbering each other.
// agentName is sanitized: non-alphanumeric/dash/underscore chars → '_'.
//
// DISK DISCIPLINE: prune-on-write, TTL via SHADOW_TTL_DAYS (default 14d).
// At the start of each sampled run we best-effort delete run dirs under outRoot
// whose mtime is older than SHADOW_TTL_DAYS. Prune errors are fully swallowed.
//
// DIFF SHAPE (intentionally simple — no semantic LLM judging; that is a later
// phase): { ts, taskId, agentName, model, sampled, sameOutcome, deltas, error? }
//   sameOutcome = liveOk === shadowOk (both succeeded or both failed)
//   deltas = { liveOk, shadowOk, textLengthDelta, modelMatch, lengthRatio }
//
// Module style: CommonJS, matching agents/runner/agent-runner.js + meter-probe.js.

'use strict'
const __roots = require('../../paths') // portable roots (KURU_*_ROOT) — see paths.js


const fs = require('fs')
const path = require('path')

// Canonical live output root. Tests inject _outDir to redirect ALL writes.
const SHADOW_ROOT = (__roots.INTEL_ROOT + '/shadow-runs')

const DEFAULT_SAMPLE_K = 5
const DEFAULT_TTL_DAYS = 14
const SHADOW_TIMEOUT_MS = 600000

// ---------------------------------------------------------------------------
// shouldSample — deterministic 1-in-K decision, stable per taskId
// ---------------------------------------------------------------------------

/**
 * Cheap, stable string hash (djb2). Deterministic across processes — no
 * crypto needed; we only want even-ish bucketing for sampling.
 * @param {string} str
 * @returns {number} non-negative 32-bit-ish integer
 */
function _hashString(str) {
  let h = 5381
  const s = String(str == null ? '' : str)
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) + h + s.charCodeAt(i)) | 0 // h * 33 + c
  }
  return Math.abs(h)
}

/**
 * Decide whether a given task should be shadow-sampled.
 * Deterministic: same taskId + K always yields the same answer.
 * @param {string} taskId
 * @param {number} k  sample 1-in-k (k<=1 → sample everything)
 * @returns {boolean}
 */
function shouldSample(taskId, k) {
  const kk = Number(k)
  if (!Number.isFinite(kk) || kk <= 1) return true // K<=1 → sample all
  return _hashString(taskId) % Math.floor(kk) === 0
}

// ---------------------------------------------------------------------------
// internal helpers — all best-effort, none throw upward
// ---------------------------------------------------------------------------

function _resolveK(opts) {
  if (opts && Number.isFinite(Number(opts._sampleK))) return Number(opts._sampleK)
  const envK = Number(process.env.SHADOW_SAMPLE_K)
  if (Number.isFinite(envK) && envK >= 1) return envK
  return DEFAULT_SAMPLE_K
}

// Best-effort TTL prune: delete top-level run dirs under outRoot whose mtime
// is older than ttlDays. Fully wrapped — prune errors must never affect the run.
function _pruneOldRuns(outRoot, ttlDays) {
  try {
    const cutoffMs = Date.now() - ttlDays * 24 * 60 * 60 * 1000
    if (!fs.existsSync(outRoot)) return
    const entries = fs.readdirSync(outRoot, { withFileTypes: true })
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const fullPath = path.join(outRoot, entry.name)
      try {
        const stat = fs.statSync(fullPath)
        if (stat.mtimeMs < cutoffMs) {
          fs.rmSync(fullPath, { recursive: true, force: true })
        }
      } catch { /* individual dir stat/rm failure — skip, never throw */ }
    }
  } catch { /* prune failure must never affect the shadow run */ }
}

// Sanitize agentName for use as a filesystem path component.
function _sanitizeAgentName(name) {
  return String(name == null ? 'unknown-agent' : name).replace(/[^A-Za-z0-9_-]/g, '_')
}

// Safe write of a JSON file under a run dir. Returns true on success.
function _writeJsonSafe(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(obj, null, 2), 'utf8')
  return true
}

// Build the structural diff between the live (cli) result and the shadow (sdk).
function _buildDeltas({ liveOk, shadowOk, liveText, shadowText, model, shadowModel }) {
  const liveLen = typeof liveText === 'string' ? liveText.length : 0
  const shadowLen = typeof shadowText === 'string' ? shadowText.length : 0
  return {
    liveOk: !!liveOk,
    shadowOk: !!shadowOk,
    textLengthDelta: shadowLen - liveLen,
    // ratio of shadow length to live length (0 when live empty); rounded.
    lengthRatio: liveLen > 0 ? Math.round((shadowLen / liveLen) * 1000) / 1000 : 0,
    modelMatch: !!model && !!shadowModel && String(model) === String(shadowModel),
  }
}

// ---------------------------------------------------------------------------
// maybeShadowRun — the one entrypoint event-bus calls
// ---------------------------------------------------------------------------

/**
 * Maybe run the sdk adapter in shadow for this dispatch and write a diff.
 *
 * Fire-and-forget: returns a promise that ALWAYS resolves (never rejects).
 *
 * @param {object} ctx
 * @param {string} ctx.agentName
 * @param {string} ctx.taskId
 * @param {string} ctx.model        the model the live path used
 * @param {string} ctx.systemPrompt the system prompt the live path used
 * @param {string} ctx.userPrompt   the user prompt the live path used
 * @param {string} ctx.liveText     the live (cli) result text
 * @param {boolean} ctx.liveOk      whether the live run succeeded
 * @param {object} [opts]
 * @param {Function} [opts._runAgent]  DI: runAgent(spec) port (default: real port)
 * @param {string}   [opts._outDir]    DI: output root (default: SHADOW_ROOT)
 * @param {number}   [opts._sampleK]   DI: sample K (default: env or 5)
 * @returns {Promise<{sampled:boolean, error?:string, swallowed?:boolean}>}
 */
async function maybeShadowRun(ctx = {}, opts = {}) {
  // Everything in this function is defensive — it must never throw to the
  // caller, even on programmer error in ctx/opts.
  try {
    const k = _resolveK(opts)
    const taskId = ctx && ctx.taskId

    if (!shouldSample(taskId, k)) {
      return { sampled: false }
    }

    const outRoot = (opts && opts._outDir) || SHADOW_ROOT

    // Resolve TTL and best-effort prune old run dirs before writing new ones.
    const ttlDays = Number(process.env.SHADOW_TTL_DAYS)
    _pruneOldRuns(outRoot, Number.isFinite(ttlDays) && ttlDays > 0 ? ttlDays : DEFAULT_TTL_DAYS)

    // Run dir keyed by taskId + agentName; per-agent subdirs prevent parallel
    // specialists sharing the same taskId from clobbering each other.
    const runKey = taskId ? String(taskId) : `ts-${Date.now()}`
    const agentName = ctx.agentName || 'unknown'
    const agentDir = _sanitizeAgentName(agentName)
    const runDir = path.join(outRoot, runKey, agentDir)
    const outputFile = path.join(runDir, 'shadow-output.json')
    const diffFile = path.join(runDir, 'diff.json')
    const model = ctx.model || ''
    const liveText = ctx.liveText
    const liveOk = !!ctx.liveOk
    const ts = new Date().toISOString()

    const runAgent =
      (opts && opts._runAgent) || require('./agent-runner').runAgent

    // ── Fire the sdk adapter in shadow ──
    let shadowResult = null
    let shadowOk = false
    let shadowErr = null
    try {
      // runAgent may throw synchronously OR reject — await catches both since
      // it is inside try/catch and awaited.
      shadowResult = await runAgent({
        adapter: 'sdk',
        agentName,
        taskId: runKey,
        userPrompt: ctx.userPrompt,
        systemPrompt: ctx.systemPrompt,
        model,
        timeoutMs: SHADOW_TIMEOUT_MS,
      })
      shadowOk = true
    } catch (e) {
      shadowErr = e && e.message ? e.message : String(e)
      shadowOk = false
    }

    const shadowText =
      shadowResult && typeof shadowResult.text === 'string' ? shadowResult.text : ''
    const shadowModel = shadowResult && shadowResult.model ? shadowResult.model : ''

    const deltas = _buildDeltas({
      liveOk,
      shadowOk,
      liveText,
      shadowText,
      model,
      shadowModel,
    })

    const diff = {
      ts,
      taskId: taskId || null,
      agentName,
      model,
      sampled: true,
      sameOutcome: liveOk === shadowOk,
      deltas,
    }
    if (shadowErr) diff.error = shadowErr

    // ── Persist artifacts — ALL writes under outRoot, best-effort ──
    let wrote = false
    let writeErr = null
    try {
      // shadow-output.json = the structured sdk result, or the error envelope.
      _writeJsonSafe(
        outputFile,
        shadowOk
          ? shadowResult
          : { ok: false, error: shadowErr, ts, taskId: taskId || null, agentName }
      )
      _writeJsonSafe(diffFile, diff)
      wrote = true
    } catch (we) {
      writeErr = we && we.message ? we.message : String(we)
      // Last-ditch: try to record just the diff (with the write error noted).
      try {
        _writeJsonSafe(diffFile, { ...diff, writeError: writeErr })
        wrote = true
      } catch { /* swallow — NO-LIVE-LEAK / never-throw invariant */ }
    }

    if (!wrote) {
      // Could not persist anything — signal swallowed so the caller/tests
      // can observe we tried but failed, without throwing.
      return { sampled: true, error: writeErr || 'write failed', swallowed: true }
    }
    if (shadowErr) return { sampled: true, error: shadowErr }
    return { sampled: true }
  } catch (fatal) {
    // Absolute backstop — this module must NEVER throw to the live daemon.
    const msg = fatal && fatal.message ? fatal.message : String(fatal)
    return { sampled: true, error: msg, swallowed: true }
  }
}

module.exports = { maybeShadowRun, shouldSample, SHADOW_ROOT }
