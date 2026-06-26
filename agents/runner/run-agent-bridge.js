// runner/run-agent-bridge.js
//
// LEGACY SHAPE TRANSLATOR — the seam that lets the old event-bus call sites
// (spawnAgent, DHARMARAJ judge, spot-check, sequential dispatch) consume the
// AgentRunner port WITHOUT changing any of their downstream contracts.
//
// The legacy world speaks `{ code, output, cost, model }` where:
//   - `code` drives spawnWithRetry's three-way discrimination (event-bus.js:4480):
//       (a) code!==0 && code!==1 && isRateLimitError(output) → wait + retry
//       (b) code===143 || code===137 || code===null + no output → killed → retry-30s
//       (c) else → return result
//   - `output` is a STRING that calculateCost(output) JSON.parses as the CLI
//     envelope, and that the rate-limit regexes scan, and that the
//     trajectory-observer / handoff-marker hooks consume.
//
// The AgentRunner port instead returns `{ text, usage, model, raw }` and THROWS
// on failure. This module is the impedance match. It NEVER rejects: every path
// resolves to a `{ code, output, cost, model, error? }` object so the daemon's
// retry logic stays load-bearing-correct.
//
// EXIT-CODE MAPPING (get this wrong and retries go infinite or kills get dropped):
//   success            → code 0,   output = synthetic CLI envelope (REAL numbers)
//   timeout / abort     → code 143, output '' (matches killed branch (b))
//   any other throw     → code 2,   output = err.message (so the rate-limit
//                                    regexes in branch (a) can fire on it)
//
// SYNTHETIC ENVELOPE: on success we rebuild the exact JSON string shape that
// `claude --output-format json` emits, carrying the REAL cost/usage numbers the
// adapter measured (from r.raw when present — the SDK result message has
// total_cost_usd + modelUsage; the cli adapter's raw IS the original envelope
// string). calculateCost(output) and isRateLimitError(output) therefore behave
// byte-for-byte as they did against the real CLI.
//
// MODULE shape: CommonJS, matching agents/runner/*.

'use strict'

const { runAgent: realRunAgent } = require('./agent-runner')

// ───────────────────────────────────────────────────────────────────────────
// Cost computation — a tiny PURE extraction of event-bus.js calculateCost's
// NEW-envelope branch (event-bus.js:2063-2091). We compute `cost` from the
// SAME synthetic envelope we hand back as `output`, so a caller that does
// calculateCost(result.output) gets a value identical to result.cost. Keeping
// this in lockstep with calculateCost is the whole point — if calculateCost's
// NEW branch ever changes shape, update here too (GATE-95 guards the seam).
// ───────────────────────────────────────────────────────────────────────────
function costFromEnvelope(envelope) {
  if (!envelope || envelope.type !== 'result' || envelope.total_cost_usd === undefined) return null
  const totalCost = envelope.total_cost_usd || 0
  const u = envelope.usage || {}
  const input = Number(u.input_tokens || 0)
  const output = Number(u.output_tokens || 0)
  const cacheWrite = Number(u.cache_creation_input_tokens || 0)
  const cacheRead = Number(u.cache_read_input_tokens || 0)
  const mu = envelope.modelUsage || {}
  const modelKeys = Object.keys(mu)
  let model = 'unknown'
  if (modelKeys.length === 1) {
    model = modelKeys[0]
  } else if (modelKeys.length > 1) {
    model = modelKeys.reduce((a, b) =>
      Number(mu[a]?.costUSD || 0) >= Number(mu[b]?.costUSD || 0) ? a : b
    )
  }
  return {
    model,
    tokens: { input, output, cacheRead, cacheWrite },
    breakdown: { inputCost: totalCost, outputCost: 0, cacheReadCost: 0, cacheWriteCost: 0 },
    totalCost: Math.round(totalCost * 10000) / 10000,
    cacheHitRate: (cacheRead + input) > 0 ? Math.round((cacheRead / (cacheRead + input)) * 100) : 0,
  }
}

// ───────────────────────────────────────────────────────────────────────────
// Synthetic CLI envelope. Carries the REAL numbers the adapter measured:
//   - cli adapter: r.raw is the original envelope STRING — parse it and reuse
//     its total_cost_usd / modelUsage verbatim (real, not zero).
//   - sdk adapter: r.raw = { result: <SDK result message>, ... }. The SDK result
//     message has total_cost_usd + modelUsage per sdk.d.ts — reuse those.
//   - fallback (raw missing/unrecognized): synthesize modelUsage from r.usage,
//     total_cost_usd = 0 (honest: we have no measured cost).
// ───────────────────────────────────────────────────────────────────────────
function buildSyntheticEnvelope(r) {
  const usage = (r && r.usage) || {}
  const model = (r && r.model) || ''
  const text = (r && typeof r.text === 'string') ? r.text : ''

  // Try to recover the REAL source envelope from raw.
  let sourceEnvelope = null
  const raw = r && r.raw
  if (typeof raw === 'string') {
    // cli adapter: raw IS the original `claude --output-format json` envelope.
    try { sourceEnvelope = JSON.parse(raw) } catch { /* fall through */ }
  } else if (raw && typeof raw === 'object' && raw.result && typeof raw.result === 'object') {
    // sdk adapter: raw.result is the SDK terminal result message.
    sourceEnvelope = raw.result
  }

  let modelUsage
  let totalCost
  if (sourceEnvelope && typeof sourceEnvelope === 'object') {
    if (sourceEnvelope.modelUsage && typeof sourceEnvelope.modelUsage === 'object'
        && Object.keys(sourceEnvelope.modelUsage).length) {
      modelUsage = sourceEnvelope.modelUsage
    }
    if (typeof sourceEnvelope.total_cost_usd === 'number') {
      totalCost = sourceEnvelope.total_cost_usd
    }
  }

  // Fallback modelUsage from usage when the source envelope didn't carry one.
  if (!modelUsage) {
    const key = model || 'unknown'
    modelUsage = {
      [key]: {
        inputTokens: Number(usage.input_tokens || 0),
        outputTokens: Number(usage.output_tokens || 0),
        cacheReadInputTokens: Number(usage.cache_read_input_tokens || 0),
        cacheCreationInputTokens: Number(usage.cache_creation_input_tokens || 0),
        costUSD: 0,
      },
    }
  }
  if (typeof totalCost !== 'number') totalCost = 0

  return {
    type: 'result',
    subtype: 'success',
    is_error: false,
    result: text,
    usage,
    modelUsage,
    total_cost_usd: totalCost,
  }
}

// An error counts as a timeout/abort (→ code 143, the "killed" branch) when the
// message carries 'timed out' (both adapters phrase it "[xxx][label] timed out
// after Nms") OR the run was aborted via the external kill handle.
function isTimeoutOrAbort(err, abortedExternally) {
  if (abortedExternally) return true
  const msg = (err && err.message) || ''
  return /timed out/i.test(msg)
}

/**
 * Bridge spawn — call the AgentRunner port, return the legacy
 * { code, output, cost, model, error? } shape. NEVER rejects.
 *
 * @param {object} ctx
 * @param {string}   ctx.agentName
 * @param {string}   [ctx.taskId]
 * @param {string}   [ctx.model]
 * @param {string}   [ctx.systemPrompt]
 * @param {string}   ctx.userPrompt
 * @param {string}   [ctx.effort]
 * @param {string|object} [ctx.jsonSchema]
 * @param {string[]} [ctx.addDirs]
 * @param {boolean}  [ctx.bare]
 * @param {object}   [ctx.envExtras]
 * @param {boolean}  [ctx.omitApiKey]
 * @param {number}   [ctx.timeoutMs]
 * @param {Function} [ctx.onProgress]   - passthrough to the adapter
 * @param {Function} [ctx.onChildHandle] - called SYNCHRONOUSLY before the run
 *                     with a duck-typed { kill, pid, killed } handle. handle.kill()
 *                     aborts the in-flight run (→ resolves the 143 path).
 * @param {object}   [opts]
 * @param {Function} [opts._runAgent]   - DI for tests (replaces runAgent)
 * @returns {Promise<{code:number, output:string, cost:object|null, model:string, error?:string}>}
 */
async function bridgeSpawnAgent(ctx = {}, opts = {}) {
  const runAgent = opts._runAgent || realRunAgent
  const ctxModel = ctx.model || ''

  // ── Kill handle / abort plumbing ──────────────────────────────────────────
  // One AbortController owns external cancellation. The duck-typed handle below
  // is what gets registered in the task-children registry (registerTaskChild),
  // so killTaskChildren's child.kill('SIGTERM') keeps working unchanged.
  const abortController = new AbortController()
  let abortedExternally = false

  const handle = {
    pid: null,
    killed: false,
    kill(_signal) {
      this.killed = true
      abortedExternally = true
      try { abortController.abort() } catch {}
      return true
    },
  }

  // Hand the kill handle to the caller SYNCHRONOUSLY, before the run starts, so a
  // kill that races in immediately is honored. A throwing callback must not break
  // the run — but we still want the handle registered, so swallow its error.
  if (typeof ctx.onChildHandle === 'function') {
    try { ctx.onChildHandle(handle) } catch { /* caller bookkeeping is not our problem */ }
  }

  const spec = {
    agentName: ctx.agentName || 'unknown',
    taskId: ctx.taskId || '',
    userPrompt: ctx.userPrompt,
    systemPrompt: ctx.systemPrompt,
    model: ctx.model,
    effort: ctx.effort,
    jsonSchema: ctx.jsonSchema,
    addDirs: ctx.addDirs,
    bare: ctx.bare,
    envExtras: ctx.envExtras,
    omitApiKey: ctx.omitApiKey,
    timeoutMs: ctx.timeoutMs,
    onProgress: ctx.onProgress,
    // External abort passthrough — both adapters honor spec.abortController
    // (sdk: options.abortController + stream teardown; cli: group-kill on abort).
    abortController,
  }

  try {
    const r = await runAgent(spec)
    const envelope = buildSyntheticEnvelope(r)
    const output = JSON.stringify(envelope)
    const cost = costFromEnvelope(envelope)
    return { code: 0, output, cost, model: (r && r.model) || ctxModel }
  } catch (err) {
    const msg = (err && err.message) || String(err)
    if (isTimeoutOrAbort(err, abortedExternally)) {
      // Killed branch (b): code 143 + empty output → spawnWithRetry retries
      // after 30s UNLESS the task was cancelled (cancel path handled by caller).
      return { code: 143, output: '', cost: null, model: ctxModel, error: msg }
    }
    // Any other throw → code 2 with err.message IN output so the rate-limit
    // regexes (branch (a)) can fire on it and trigger wait+retry.
    return { code: 2, output: msg, cost: null, model: ctxModel, error: msg }
  }
}

module.exports = { bridgeSpawnAgent, costFromEnvelope, buildSyntheticEnvelope }
