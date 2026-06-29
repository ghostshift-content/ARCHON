// runner/adapters/sdk.js
//
// Agent SDK adapter for AgentRunner.
// Drives the Claude Agent SDK `query({ prompt, options })` async message
// stream and returns the SAME structured { text, usage, model, raw } object
// the cli adapter returns — the two adapters are drop-in interchangeable.
//
// WHY a stream adapter: the SDK does not return a single JSON envelope like
// `claude --output-format json`. It yields a sequence of SDKMessage objects
// (system/init, assistant, result, ...). We iterate to completion, accumulate
// the final `result` message, and translate it into the cli envelope shape.
//
// SILENT-DROP IS THE BUG CLASS THIS KILLS: every failure path throws with a
// descriptive `[sdk][agentLabel]` message. A stream that ends without a result
// message, an assistant message carrying an `error`, a result with
// is_error/error-subtype, or a transport throw all become thrown errors —
// never a bare empty string.
//
// ─────────────────────────────────────────────────────────────────────────
// ESM INTEROP: @anthropic-ai/claude-agent-sdk is ESM-only ("type":"module",
// main: sdk.mjs). This file is CommonJS, so `require()` of the package fails.
// We load `query` lazily via dynamic import() (the only interop path that
// works from CJS into an ESM-only package). The import is cached.
//
// PEER-DEP NOTE: base @anthropic-ai/sdk is pinned at 0.88.0, which is below
// the agent-sdk's declared peer requirement of >=0.93.0. Installed via
// legacy-peer-deps (see /root/agents/.npmrc). Safe because this adapter never
// imports the base SDK directly — all model work runs through the bundled CLI.
// When upgrading, re-verify grader.js and finding-validator.js as well.
//
// ─────────────────────────────────────────────────────────────────────────
// ENV ALLOWLIST (INVARIANT v2.1-A1): the SDK spawns the claude CLI subprocess.
// Per the SDK type docs (sdk.d.ts, Options.env): "When set, this value REPLACES
// the subprocess environment entirely — it is not merged with process.env."
// That is exactly the cli adapter's _buildSpawnEnv contract, so we pass the
// same explicit allowlist (HOME, PATH, TERM, CLAUDE_CONFIG_DIR, IS_SANDBOX,
// ANTHROPIC_API_KEY-if-configured) — NEVER `...process.env`. The daemon env
// carries cloud creds; agents read attacker-controlled content.
//
// AUTH (subscription / OAuth, NOT a forced sk-ant- key): we reuse the shared
// anthropic-key helper, identical to cli.js. A key is injected ONLY if one is
// actually configured (process.env or /root/intel/anthropic-config.json). When
// none is configured the key is intentionally absent, so the bundled CLI falls
// back to OAuth subscription auth via ~/.claude credentials (HOME forwarded).
// We never fabricate or force an API key. The system/init message's
// `apiKeySource` is captured and returned on `raw` so callers can verify the
// auth mode resolved to 'oauth' rather than a key.
//
// PERMISSIONS: matches the cli adapter's `--permission-mode bypassPermissions`
// via permissionMode:'bypassPermissions' + allowDangerouslySkipPermissions:true
// (the SDK requires the latter flag whenever bypassPermissions is requested —
// sdk.d.ts line 1675). IS_SANDBOX=1 is forwarded for claude-as-root.
//
// SYSTEM PROMPT: cli.js uses `--append-system-prompt`, which APPENDS to the
// default claude_code system prompt. The faithful SDK equivalent is
// systemPrompt: { type:'preset', preset:'claude_code', append: <text> }.
// A bare string would REPLACE the whole prompt (different behavior), so we use
// the preset+append form.
//
// ─────────────────────────────────────────────────────────────────────────
// CUTOVER CAPABILITY MAPPINGS (T6). Source of truth = sdk.d.ts (NOT memory):
//
//   effort     → options.effort           (sdk.d.ts:1591 `effort?: EffortLevel`,
//                                           EffortLevel union sdk.d.ts:533).
//                FIRST-CLASS. Always applied when set → raw.effortApplied=true.
//   jsonSchema → options.outputFormat      (sdk.d.ts:1653 `outputFormat?: OutputFormat`;
//                                           OutputFormat = JsonSchemaOutputFormat
//                                           sdk.d.ts:1982; shape
//                                           { type:'json_schema', schema:object }
//                                           sdk.d.ts:914-917).
//                FIRST-CLASS. `schema` MUST be an object — a JSON string is parsed.
//                Always applied when set → raw.jsonSchemaApplied=true.
//   addDirs    → options.additionalDirectories (sdk.d.ts:1285 `additionalDirectories?: string[]`).
//                FIRST-CLASS.
//   bare       → options.extraArgs={ bare: null } (sdk.d.ts:1421
//                `extraArgs?: Record<string,string|null>`; sdk.mjs renders
//                a null value as the bare CLI flag `--bare`, a string value as
//                `--<k> <v>` — verified in sdk.mjs entries loop).
//                NO first-class option exists; the extraArgs passthrough is the
//                faithful mapping → raw.bareApplied=true.
//   envExtras  → buildSpawnEnv({ extras }) — narrow allowlist (AGENT_TASK_ID).
//   omitApiKey → buildSpawnEnv({ omitApiKey }) — force-OAuth (grader.js).
//   onProgress → adapter-side liveness callback fired once per stream message.
//
// raw.{effortApplied,jsonSchemaApplied,bareApplied} let the bridge/caller verify
// each capability resolved to an actual SDK mapping (all currently true since
// every field has a faithful mapping; the flags exist so a future SDK that drops
// one can degrade honestly instead of silently).
//
// MODULE shape: CommonJS, matching agents/runner/adapters/cli.js.

'use strict'

const { buildSpawnEnv } = require('./common')

const CLAUDE_BIN = process.env.KURU_CLAUDE_BIN || 'claude'
const DEFAULT_TIMEOUT_MS = 600000 // 10 minutes — matches cli adapter

// Lazily-imported SDK `query` (ESM-only package → dynamic import from CJS).
let _queryPromise = null
function _loadQuery() {
  if (!_queryPromise) {
    _queryPromise = import('@anthropic-ai/claude-agent-sdk').then((m) => {
      if (typeof m.query !== 'function') {
        throw new Error('@anthropic-ai/claude-agent-sdk did not export query()')
      }
      return m.query
    })
  }
  return _queryPromise
}
// NOTE: _buildSpawnEnv has been moved to ./common.js (buildSpawnEnv) to enforce
// the v2.1-A1 security invariant: one canonical allowlist, two adapters.

/**
 * Normalize an SDK usage object to the snake_case shape the cli adapter
 * returns. The SDK result usage is already snake_case (BetaUsage), but we
 * translate defensively so a future camelCase shape still produces
 * { input_tokens, output_tokens, ... } and the adapters stay interchangeable.
 *
 * @param {object} u - usage from the SDK result message
 * @returns {object} usage with at least { input_tokens, output_tokens }
 */
function _normalizeUsage(u) {
  if (!u || typeof u !== 'object') return { input_tokens: 0, output_tokens: 0 }
  const pick = (snake, camel) => {
    if (typeof u[snake] === 'number') return u[snake]
    if (typeof u[camel] === 'number') return u[camel]
    return undefined
  }
  const out = { ...u }
  out.input_tokens = pick('input_tokens', 'inputTokens') ?? 0
  out.output_tokens = pick('output_tokens', 'outputTokens') ?? 0
  const cacheRead = pick('cache_read_input_tokens', 'cacheReadInputTokens')
  if (cacheRead !== undefined) out.cache_read_input_tokens = cacheRead
  const cacheCreate = pick('cache_creation_input_tokens', 'cacheCreationInputTokens')
  if (cacheCreate !== undefined) out.cache_creation_input_tokens = cacheCreate
  return out
}

/**
 * Extract the model id from a result message. Mirrors cli.js: the result's
 * `modelUsage` is keyed by model name (no reliable top-level model field).
 *   - one key  → that key
 *   - many     → key with highest costUSD
 *   - none     → fall back to the init message's model, else ''
 * Never fabricates a model id.
 *
 * @param {object} resultMsg - the SDK result message
 * @param {string} initModel - model from the system/init message (fallback)
 * @returns {string}
 */
function _extractModel(resultMsg, initModel) {
  const mu = (resultMsg && resultMsg.modelUsage) || {}
  const keys = Object.keys(mu)
  if (keys.length === 1) return keys[0]
  if (keys.length > 1) {
    return keys.reduce((a, b) =>
      Number(mu[a]?.costUSD || 0) >= Number(mu[b]?.costUSD || 0) ? a : b
    )
  }
  return initModel || ''
}

/**
 * Run an Agent SDK query and return a structured result.
 *
 * @param {object} spec
 * @param {string}   spec.userPrompt    - required prompt text
 * @param {string}   [spec.systemPrompt] - optional; appended to the claude_code preset
 * @param {string}   [spec.model]       - optional model override
 * @param {number}   [spec.timeoutMs]   - hard timeout in ms (default 600000)
 * @param {string}   [spec.agentName]   - used for logging/error context
 * @param {string}   [spec.taskId]      - used for logging/error context
 * @param {string}   [spec.effort]      - reasoning effort → options.effort (first-class, sdk.d.ts:1591)
 * @param {string|object} [spec.jsonSchema] - constrained output → options.outputFormat (sdk.d.ts:1653)
 * @param {string[]} [spec.addDirs]     - extra readable dirs → options.additionalDirectories (sdk.d.ts:1285)
 * @param {boolean}  [spec.bare]        - minimal mode → options.extraArgs={bare:null} (sdk.d.ts:1421)
 * @param {object}   [spec.envExtras]   - allowlisted extra env keys (see common.ALLOWED_EXTRA_KEYS)
 * @param {boolean}  [spec.omitApiKey]  - force OAuth: never inject ANTHROPIC_API_KEY even if configured
 * @param {boolean}  [spec.cacheOptimize] - enable --exclude-dynamic-system-prompt-sections (default true):
 *                                          moves git status/cwd/memory paths into user message so system
 *                                          prompt is stable and gets cached across successive calls.
 *                                          Ignored when bare=true (bare already minimises system prompt).
 * @param {object|boolean} [spec.thinking] - opt into ADAPTIVE thinking. `true` or {type:'adaptive'}
 *                                        (or any legacy {type:'enabled',budget_tokens} form, which is
 *                                        normalised to adaptive) → {type:'adaptive'}. Omit/false/disabled
 *                                        → no thinking param (effort governs reasoning depth). The
 *                                        legacy budget_tokens form is never sent (400s on current models).
 * @param {Function} [spec.onProgress]  - liveness callback invoked once per stream message
 * @param {Function} [spec._query]      - DI for tests: (params)=>async-iterable of SDK messages
 * @returns {Promise<{ text: string, usage: object, model: string, raw: object }>}
 */
async function run(spec) {
  const {
    userPrompt,
    systemPrompt,
    model,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    agentName = 'unknown',
    taskId = '',
    effort,
    jsonSchema,
    addDirs,
    bare,
    envExtras,
    omitApiKey,
    cacheOptimize = true,  // default on — stabilises system prompt for cache hits
    thinking: thinkingSpec,
    onProgress,
    abortController: externalAbortController,
    _query,
  } = spec

  const agentLabel = taskId ? `${agentName}/${taskId}` : agentName

  // Capability-applied flags surfaced on raw so the bridge/caller can verify each
  // field resolved to a real SDK mapping (honest-degradation contract — every
  // field currently maps first-class or via the extraArgs passthrough).
  const effortApplied = effort !== undefined && effort !== null && effort !== ''
  const jsonSchemaApplied = jsonSchema !== undefined && jsonSchema !== null
  const bareApplied = !!bare

  // Thinking is driven by `effort` (the Agent SDK's first-class, future-proof lever):
  // effort=max already maximises reasoning on current models, so there is NO manual
  // thinking injection here. The legacy {type:'enabled',budget_tokens:N} form is REMOVED
  // — it returns a 400 on Fable 5 / Opus 4.8 / 4.7 (budget_tokens is fully gone there).
  // A caller may still opt into adaptive thinking explicitly; any enabled/budget_tokens
  // form is normalised to {type:'adaptive'}, and disabled/false OMITS the param entirely
  // (an explicit {type:'disabled'} 400s on Fable 5 — omitting is the safe default).
  let resolvedThinking = null
  if (thinkingSpec === true) {
    resolvedThinking = { type: 'adaptive' }
  } else if (thinkingSpec && typeof thinkingSpec === 'object') {
    if (thinkingSpec.type === 'adaptive') resolvedThinking = { type: 'adaptive' }
    else if (thinkingSpec.type === 'enabled' || thinkingSpec.budget_tokens != null) resolvedThinking = { type: 'adaptive' }
    // {type:'disabled'} / unknown → leave null (omit the param; effort governs thinking)
  }

  // Build the query options. env is the explicit allowlist (see file header).
  const options = {
    env: buildSpawnEnv({ extras: envExtras, omitApiKey }),
    permissionMode: 'bypassPermissions',
    allowDangerouslySkipPermissions: true, // required by the SDK when bypassPermissions is set
    pathToClaudeCodeExecutable: CLAUDE_BIN, // use the daemon's known CLI, not a bundled guess
  }
  if (model) options.model = model
  if (systemPrompt) {
    // Faithful to cli.js --append-system-prompt: append to the default preset.
    options.systemPrompt = { type: 'preset', preset: 'claude_code', append: systemPrompt }
  }
  // effort — first-class SDK option (sdk.d.ts:1591).
  if (effortApplied) options.effort = effort
  // jsonSchema — first-class via outputFormat (sdk.d.ts:1653). `schema` must be an
  // OBJECT; accept a JSON string (parse it) or an already-parsed object.
  if (jsonSchemaApplied) {
    let schemaObj = jsonSchema
    if (typeof jsonSchema === 'string') {
      try {
        schemaObj = JSON.parse(jsonSchema)
      } catch (e) {
        throw new Error(
          `[sdk][${agentLabel}] jsonSchema is a string but not valid JSON ` +
          `(outputFormat.schema requires an object): ${e.message}`
        )
      }
    }
    options.outputFormat = { type: 'json_schema', schema: schemaObj }
  }
  // addDirs — first-class SDK option (sdk.d.ts:1285).
  if (Array.isArray(addDirs) && addDirs.length) {
    options.additionalDirectories = addDirs.filter(Boolean)
  }
  // bare — no first-class option; faithful mapping via the extraArgs passthrough.
  // sdk.mjs renders a null value as the bare CLI flag `--bare`.
  if (bareApplied) options.extraArgs = { ...(options.extraArgs || {}), bare: null }
  // cacheOptimize — default ON: moves dynamic system prompt sections (git status, cwd, memory paths)
  // into the first user message so the system prompt is stable across calls and qualifies for
  // Claude's prompt cache. Disabled when bare=true (bare already minimises the system prompt).
  if (cacheOptimize && !bareApplied) {
    options.extraArgs = {
      ...(options.extraArgs || {}),
      'exclude-dynamic-system-prompt-sections': null,
    }
  }
  // extended thinking — passed directly when enabled (auto-on at effort=max)
  if (resolvedThinking) options.thinking = resolvedThinking

  const queryFn = _query || (await _loadQuery())

  // Hard timeout: AbortController is the SDK's cancellation mechanism. We also
  // race a timeout promise so a stuck stream rejects with a descriptive error.
  // EXTERNAL ABORT (T7): the bridge passes spec.abortController so an outside
  // caller (kill handle → killTaskChildren) can cancel the in-flight run. We
  // reuse the caller's controller when given one (so its abort() reaches the
  // SDK + our timeout teardown); otherwise we own a fresh one. The timeout
  // branch still calls abortController.abort() either way, and an external
  // abort triggers the same teardown via the 'abort' listener below.
  const abortController = externalAbortController || new AbortController()
  if (!_query) options.abortController = abortController // real SDK only; tests DI a plain iterable

  // ── Timeout setup ─────────────────────────────────────────────────────────
  // DIVERGENCE FROM cli.js: cli.js does group-SIGKILL escalation (SIGTERM →
  // 5s → SIGKILL on -child.pid) because it owns the subprocess directly.
  // The SDK owns its subprocess; abort() is the only public cancellation API
  // and provides ~2s graceful teardown.  In addition we call stream.return()
  // to explicitly close the AsyncGenerator so it is never abandoned mid-
  // iteration. stream.return() is fire-and-forget (.catch(()=>{}), NOT
  // awaited) because the generator's finally block may itself hang.
  // ─────────────────────────────────────────────────────────────────────────
  let stream = null // hoisted so the timeout branch and finally can reach it
  let timeoutHandle = null
  let timedOutInternally = false // set before the timeout's own abort() so the
                                 // external-abort listener stays silent (the
                                 // 'timed out' reject is authoritative, not 'aborted')
  const timeoutPromise = new Promise((_, reject) => {
    timeoutHandle = setTimeout(() => {
      timedOutInternally = true
      try { abortController.abort() } catch {}
      // Explicitly close the generator — never leave it abandoned mid-iteration.
      // Fire-and-forget: do NOT await (the generator finally-block may itself hang).
      if (stream && typeof stream.return === 'function') {
        stream.return(undefined).catch(() => {})
      }
      reject(new Error(`[sdk][${agentLabel}] timed out after ${timeoutMs}ms`))
    }, timeoutMs)
    if (timeoutHandle && typeof timeoutHandle.unref === 'function') timeoutHandle.unref()
  })

  // EXTERNAL ABORT (T7): when the bridge's kill handle fires abortController.abort(),
  // terminate the run with a throw so it maps to the bridge's 143 path. We race an
  // abortPromise that rejects on the controller's 'abort' event. If the controller
  // is already aborted (a kill that raced in before run() started), reject eagerly.
  // The SDK itself also observes options.abortController; this promise guarantees a
  // prompt, descriptive throw even when the stream is a DI'd plain iterable.
  let abortListener = null
  const abortPromise = new Promise((_, reject) => {
    const onAbort = () => {
      // If the abort was initiated BY our own timeout, the timeoutPromise reject
      // is authoritative — don't shadow it with a generic 'aborted' message.
      if (timedOutInternally) return
      // Explicitly close the generator so it is never abandoned mid-iteration.
      if (stream && typeof stream.return === 'function') {
        stream.return(undefined).catch(() => {})
      }
      reject(new Error(`[sdk][${agentLabel}] aborted`))
    }
    if (abortController.signal.aborted) { onAbort(); return }
    abortListener = onAbort
    abortController.signal.addEventListener('abort', onAbort, { once: true })
  })

  const consume = (async () => {
    let initModel = ''
    let apiKeySource = ''
    let resultMsg = null

    try {
      stream = queryFn({ prompt: userPrompt, options })
    } catch (e) {
      throw new Error(`[sdk][${agentLabel}] query() failed to start: ${e.message}`)
    }

    try {
      for await (const msg of stream) {
        if (!msg || typeof msg !== 'object') continue

        // Liveness callback — fired once per stream message (after the null-guard,
        // before message-type handling). A throwing callback must NOT break the
        // run; the adapter owns the structured result, not the caller's bookkeeping.
        if (onProgress) {
          try { onProgress(msg) } catch { /* swallow — callback errors are the caller's problem */ }
        }

        // Capture init metadata (model + auth source) for verification/fallback.
        if (msg.type === 'system' && msg.subtype === 'init') {
          if (typeof msg.model === 'string') initModel = msg.model
          if (typeof msg.apiKeySource === 'string') apiKeySource = msg.apiKeySource
          continue
        }

        // An assistant message carrying an error is a hard failure (auth, billing,
        // rate_limit, overloaded, model_not_found, ...). Surface it — never drop.
        if (msg.type === 'assistant' && msg.error) {
          throw new Error(
            `[sdk][${agentLabel}]${initModel ? ` model=${initModel}` : ''} assistant error: ${msg.error}`
          )
        }

        // The terminal result message.
        if (msg.type === 'result') {
          resultMsg = msg
          // result subtypes: 'success' | 'error_during_execution' | 'error_max_turns'
          //                  | 'error_max_budget_usd' | 'error_max_structured_output_retries'
          if (msg.is_error || (msg.subtype && msg.subtype !== 'success')) {
            const errs = Array.isArray(msg.errors) && msg.errors.length
              ? `: ${msg.errors.join('; ')}`
              : ''
            // api_error_status is declared on SDKResultSuccess (sdk.d.ts:3536) but may also
            // arrive at runtime on error result messages (e.g. a 429 that surfaces as a result
            // error with empty errors[]). Append it so quota-manager.js:243's regex
            // (/429|rate.limit|quota.exceeded|too.many.requests|rate_limit_exceeded|usage.limit|
            //   capacity|overloaded/i) can match and classify the error as retryable.
            const apiStatus = (typeof msg.api_error_status === 'number' && msg.api_error_status)
              ? ` api_error_status=${msg.api_error_status}`
              : ''
            // Limit-ish subtypes signal budget/usage exhaustion — append "usage limit" so the
            // quota-manager regex fires even when errors[] is empty and api_error_status is absent.
            // Subtypes from sdk.d.ts SDKResultError union: 'error_max_budget_usd' exhausts the
            // USD budget cap; 'error_max_turns' and 'error_max_structured_output_retries' signal
            // structural limits. Map all budget/limit subtypes to a literal token the regex matches.
            const LIMIT_SUBTYPES = new Set([
              'error_max_budget_usd',
              'error_max_turns',
              'error_max_structured_output_retries',
            ])
            const limitToken = LIMIT_SUBTYPES.has(msg.subtype) ? ' usage limit' : ''
            throw new Error(
              `[sdk][${agentLabel}]${initModel ? ` model=${initModel}` : ''} ` +
              `result error (${msg.subtype || 'unknown'})${errs}${apiStatus}${limitToken}`
            )
          }
          // success — stop consuming (later messages like prompt_suggestion are noise)
          break
        }
      }
    } catch (e) {
      // Re-throw errors already carrying the [sdk][label] prefix (thrown by the
      // adapter itself above) without modification. Only wrap generator-origin
      // throws (mid-stream transport failures from the SDK/network layer).
      if (e.message && e.message.startsWith('[sdk][')) throw e
      const wrapped = new Error(`[sdk][${agentLabel}] stream transport error: ${e.message}`)
      wrapped.cause = e
      throw wrapped
    }

    // Stream ended without a usable result message → silent-drop class. Throw.
    if (!resultMsg) {
      throw new Error(
        `[sdk][${agentLabel}] stream ended without a result message ` +
        `(no terminal result — possible truncation or auth failure)`
      )
    }

    const text = typeof resultMsg.result === 'string' ? resultMsg.result : ''
    const usage = _normalizeUsage(resultMsg.usage)
    const model = _extractModel(resultMsg, initModel)

    // raw mirrors cli.js's raw (the source envelope) plus the init metadata that
    // lets callers verify auth resolved to subscription/OAuth, not a forced key.
    // The *Applied flags let the bridge/caller confirm each cutover capability
    // mapped to a real SDK option (honest-degradation contract).
    const raw = { result: resultMsg, apiKeySource, effortApplied, jsonSchemaApplied, bareApplied, thinkingApplied: !!resolvedThinking }

    return { text, usage, model, raw }
  })()

  try {
    return await Promise.race([consume, timeoutPromise, abortPromise])
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle)
    if (abortListener) {
      try { abortController.signal.removeEventListener('abort', abortListener) } catch {}
    }
  }
}

module.exports = { run }
