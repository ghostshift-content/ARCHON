// runner/adapters/cli.js
//
// CLI floor adapter for AgentRunner.
// Wraps the existing `claude --print --output-format json` spawn pattern
// used in event-bus.js, parses the JSON envelope, and returns a structured
// { text, usage, model, raw } object.
//
// INVARIANT v2.1-A1 (ENV ALLOWLIST): the spawn env is an explicitly
// constructed object — never `...process.env`. The daemon env carries cloud
// creds; agents read attacker-controlled content.
//
// API KEY: Mirrors _buildClaudeSpawnEnv (event-bus.js:2208-2219).
// Reads ANTHROPIC_API_KEY from process.env OR /root/intel/anthropic-config.json
// via the shared anthropic-key.js helper. If a key is present it is injected;
// if absent (OAuth mode) no key is added so the CLI falls through to OAuth.
// This matches the stale-key/OAuth-fallback semantics of the reference.
//
// MODULE shape: CommonJS, matching /root/agents/agents/url-extractor.js.

'use strict'

const { spawn: nodeSpawn } = require('node:child_process')
const { buildSpawnEnv } = require('./common')

// Resolve via PATH by default ('claude') so non-root/OSS installs work; override
// with an absolute path via KURU_CLAUDE_BIN.
const CLAUDE_BIN = process.env.KURU_CLAUDE_BIN || 'claude'
const DEFAULT_TIMEOUT_MS = 600000 // 10 minutes — matches event-bus seq dispatch

/**
 * Parse the JSON envelope emitted by `claude --output-format json`.
 *
 * Real envelope shape (verified 2026-04-21, documented event-bus.js:2051-2062):
 *   { type: 'result', subtype: 'success', is_error: bool, result: string,
 *     usage: { input_tokens, output_tokens, ... },
 *     modelUsage: { '<model-name>': { inputTokens, outputTokens, costUSD, ... } },
 *     total_cost_usd: number }
 *
 * CRITICAL: there is NO top-level `model` field. The model name is the KEY
 * inside modelUsage. Reading parsed.model always returns undefined.
 *
 * Model extraction (mirrors event-bus.js:2075-2084):
 *   - modelUsage has exactly one key → that key is the model name
 *   - modelUsage has multiple keys → key with highest costUSD is primary
 *   - modelUsage absent/empty → ''
 *
 * Throws descriptively on parse failure or is_error — never returns a silent
 * empty string (silent-drop is the bug class this port exists to kill).
 * Fix 5: includes adapter name ('cli') and selected model in error messages.
 *
 * @param {string} raw - raw stdout from the child process
 * @param {string} agentLabel - used in error messages
 * @returns {{ text: string, usage: object, model: string, raw: string }}
 */
function _parseEnvelope(raw, agentLabel) {
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch (e) {
    throw new Error(
      `[cli][${agentLabel}] JSON parse failed on claude output: ${e.message}` +
      ` — raw output (first 200 chars): ${raw.slice(0, 200)}`
    )
  }

  // Extract model from modelUsage keys (Fix 1).
  // Mirrors event-bus.js:2075-2084 — no top-level model field exists.
  const mu = parsed.modelUsage || {}
  const modelKeys = Object.keys(mu)
  let model = ''
  if (modelKeys.length === 1) {
    model = modelKeys[0]
  } else if (modelKeys.length > 1) {
    model = modelKeys.reduce((a, b) =>
      Number(mu[a]?.costUSD || 0) >= Number(mu[b]?.costUSD || 0) ? a : b
    )
  }

  if (parsed.is_error) {
    throw new Error(
      `[cli][${agentLabel}]${model ? ` model=${model}` : ''} claude returned is_error=true: ` +
      (typeof parsed.result === 'string' ? parsed.result.slice(0, 500) : JSON.stringify(parsed))
    )
  }

  const text = typeof parsed.result === 'string' ? parsed.result : ''
  const usage = parsed.usage || {}

  return { text, usage, model, raw }
}

/**
 * Run a claude CLI invocation and return a structured result.
 *
 * @param {object} spec
 * @param {string}   spec.userPrompt    - required prompt text
 * @param {string}   [spec.systemPrompt] - optional system prompt (passed via --append-system-prompt)
 * @param {string}   [spec.model]       - optional model override
 * @param {number}   [spec.timeoutMs]   - hard timeout in ms (default 600000)
 * @param {string}   [spec.agentName]   - used for logging/error context
 * @param {string}   [spec.taskId]      - used for logging/error context
 * @param {string}   [spec.effort]      - reasoning effort ('low'|'medium'|'high'|'xhigh'|'max') → --effort
 * @param {string|object} [spec.jsonSchema] - JSON-schema constrained output → --json-schema <stringified>
 * @param {string[]} [spec.addDirs]     - extra readable dirs → one --add-dir per entry
 * @param {boolean}  [spec.bare]        - minimal mode (skip hooks/memory/etc.) → --bare (leading flag)
 * @param {object}   [spec.envExtras]   - allowlisted extra env keys (see common.ALLOWED_EXTRA_KEYS)
 * @param {boolean}  [spec.omitApiKey]  - force OAuth: never inject ANTHROPIC_API_KEY even if configured
 * @param {Function} [spec.onProgress]  - liveness callback invoked with each raw stdout chunk (string)
 * @param {Function} [spec._spawn]      - dependency injection for tests (replaces node:child_process spawn)
 * @returns {Promise<{ text: string, usage: object, model: string, raw: string }>}
 */
function run(spec) {
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
    onProgress,
    abortController,
    _spawn,
  } = spec

  const agentLabel = taskId ? `${agentName}/${taskId}` : agentName
  const spawnFn = _spawn || nodeSpawn

  // Arg order mirrors event-bus.js:2947-2958 (legacy spawnAgent):
  //   --print, [--bare], --permission-mode, bypassPermissions, [--model X],
  //   [--effort v], --output-format, json, [--json-schema v], [--add-dir d ...],
  //   [--append-system-prompt s], -p, <prompt>
  // --bare is a LEADING flag (matches event-bus, which puts it right after --print).
  const args = ['--print']
  if (bare) args.push('--bare')
  args.push('--permission-mode', 'bypassPermissions')
  if (model) args.push('--model', model)
  // --effort sits immediately after the --model block (matches event-bus order).
  if (effort) args.push('--effort', effort)
  args.push('--output-format', 'json')
  // --json-schema: the CLI flag takes a string. Accept an object (stringify it)
  // or a pre-stringified value (path or JSON string — passed through verbatim).
  if (jsonSchema !== undefined && jsonSchema !== null) {
    const schemaArg = typeof jsonSchema === 'string' ? jsonSchema : JSON.stringify(jsonSchema)
    args.push('--json-schema', schemaArg)
  }
  // --add-dir: one flag per entry (matches event-bus's addDirs construction).
  if (Array.isArray(addDirs)) {
    for (const dir of addDirs) {
      if (dir) args.push('--add-dir', dir)
    }
  }
  if (systemPrompt) args.push('--append-system-prompt', systemPrompt)
  args.push('-p', userPrompt)

  const env = buildSpawnEnv({ extras: envExtras, omitApiKey })

  return new Promise((resolve, reject) => {
    let stdout = ''
    let timedOut = false
    let settled = false
    let abortListener = null

    const settle = (fn, value) => {
      if (settled) return
      settled = true
      clearTimeout(timeoutHandle)
      if (abortListener && abortController) {
        try { abortController.signal.removeEventListener('abort', abortListener) } catch {}
      }
      fn(value)
    }

    // detached: true mirrors event-bus.js sequential dispatch (line 9335).
    // This puts the child in its own process group so we can kill the entire
    // tree on timeout via process.kill(-child.pid, ...) — preventing orphans.
    const child = spawnFn(CLAUDE_BIN, args, {
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env,
    })

    const timeoutHandle = setTimeout(() => {
      timedOut = true
      // Kill the entire process group (negative pid) to prevent orphan subprocesses.
      // Mirrors the detached: true pattern from event-bus.js. Wrap in try/catch
      // in case the process already exited between the timeout firing and the kill.
      try { process.kill(-child.pid, 'SIGTERM') } catch {}
      // Fix 4: .unref() the escalation timer so it doesn't keep the event loop alive
      // in test envs. Guard for fake-spawn environments where setTimeout may return
      // a plain number (e.g. some test shims) — call .unref() only if it exists.
      const killTimer = setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL') } catch {} }, 5000)
      if (killTimer && typeof killTimer.unref === 'function') killTimer.unref()
      settle(reject, new Error(
        `[cli][${agentLabel}] timed out after ${timeoutMs}ms`
      ))
    }, timeoutMs)

    // EXTERNAL ABORT (T7): when the bridge's kill handle fires
    // abortController.abort(), tear down the child with the SAME process-group
    // kill the timeout path uses (SIGTERM → 5s → SIGKILL on -child.pid) and
    // reject so the run maps to the bridge's 143 path. If the controller is
    // already aborted (a kill that raced in before spawn), fire immediately.
    if (abortController) {
      const onAbort = () => {
        if (settled) return
        timedOut = true // suppress the close-handler's non-zero-code path
        try { process.kill(-child.pid, 'SIGTERM') } catch {}
        const killTimer = setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL') } catch {} }, 5000)
        if (killTimer && typeof killTimer.unref === 'function') killTimer.unref()
        settle(reject, new Error(`[cli][${agentLabel}] aborted`))
      }
      if (abortController.signal.aborted) {
        onAbort()
      } else {
        abortListener = onAbort
        abortController.signal.addEventListener('abort', onAbort, { once: true })
      }
    }

    child.stdout.on('data', (chunk) => {
      const str = chunk.toString()
      stdout += str
      // Liveness callback. A throwing callback must NOT break the run — the
      // adapter's job is the structured result, not the caller's bookkeeping.
      if (onProgress) {
        try { onProgress(str) } catch { /* swallow — callback errors are the caller's problem */ }
      }
    })
    child.stderr.on('data', () => { /* suppress stderr in adapter; callers log via agentName */ })

    child.on('close', (code) => {
      if (timedOut) return // already rejected

      if (code !== 0) {
        settle(reject, new Error(
          `[cli][${agentLabel}] claude exited with non-zero code ${code}` +
          ` — stdout (first 200 chars): ${stdout.slice(0, 200)}`
        ))
        return
      }

      try {
        const result = _parseEnvelope(stdout, agentLabel)
        settle(resolve, result)
      } catch (e) {
        settle(reject, e)
      }
    })

    child.on('error', (err) => {
      settle(reject, new Error(
        `[cli][${agentLabel}] spawn error: ${err.message}`
      ))
    })
  })
}

module.exports = { run }
