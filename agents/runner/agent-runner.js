// runner/agent-runner.js
//
// AgentRunner — thin adapter selector.
//
// This is the chokepoint that replaces the raw `claude --print` spawn
// sites in event-bus.js. It selects among registered adapters and delegates.
//
// Adapter selection priority:
//   1. spec.adapter
//   2. process.env.ADAPTER
//   3. 'sdk' (default — PURE-SDK cutover 2026-06-04)
//
// The default is 'sdk': the pure-SDK path is now the production default.
// 'cli' remains the rollback floor — force it via `ADAPTER=cli` env or
// per-call `spec.adapter: 'cli'`. The cli adapter (legacy `claude --print`
// spawn) is kept intact precisely so this rollback path stays load-bearing.
//
// Adding a new adapter (e.g. 'sdk') requires ZERO changes here — just add
// an entry to ADAPTER_REGISTRY below. The registry uses lazy require so
// the cli module is only loaded when actually used.
//
// Module style: CommonJS, matching /root/agents/agents/url-extractor.js.

'use strict'

// ---------------------------------------------------------------------------
// Adapter registry
// ---------------------------------------------------------------------------
// Keys are adapter names; values are factory functions (lazy require keeps
// the registry cheap — adapters are only loaded when selected).
// When 'sdk' adapter is built (next task), add it here: no other changes.

const ADAPTER_REGISTRY = {
  sdk: () => require('./adapters/sdk'),            // DEFAULT (PURE-SDK cutover 2026-06-04)
  cli: () => require('./adapters/cli'),            // rollback floor — ADAPTER=cli or spec.adapter
  // interactive: () => require('./adapters/interactive'), // future
}

const KNOWN_ADAPTERS = Object.keys(ADAPTER_REGISTRY)

// ---------------------------------------------------------------------------
// runAgent
// ---------------------------------------------------------------------------

/**
 * Run an agent via the selected adapter.
 *
 * @param {object} spec
 * @param {string}   spec.userPrompt    - REQUIRED. The user-facing prompt text.
 * @param {string}   [spec.systemPrompt] - Optional system prompt.
 * @param {string}   [spec.model]       - Optional model override (default left to CLI).
 * @param {number}   [spec.timeoutMs]   - Hard timeout in ms (default: 600000).
 * @param {string}   [spec.agentName]   - Optional label used for logging / errors.
 * @param {string}   [spec.taskId]      - Optional task identifier for logging.
 * @param {string}   [spec.adapter]     - Adapter name: 'sdk' (default) | 'cli' (rollback floor).
 * @param {Function} [spec._spawn]      - Test-only: override spawn used by cli adapter.
 *
 * @returns {Promise<{ text: string, usage: object, model: string, raw: string }>}
 *          Always a structured object — never a bare string.
 *          Always throws with context on failure — never a silent empty string.
 */
async function runAgent(spec = {}) {
  // --- Validate required fields ---
  if (!spec.userPrompt || typeof spec.userPrompt !== 'string') {
    throw new Error(
      '[AgentRunner] userPrompt is required and must be a non-empty string. ' +
      `Got: ${JSON.stringify(spec.userPrompt)}`
    )
  }

  // --- Select adapter ---
  const adapterName = resolvedAdapterName(spec)

  if (!ADAPTER_REGISTRY[adapterName]) {
    throw new Error(
      `[AgentRunner] Unknown adapter "${adapterName}". ` +
      `Known adapters: ${KNOWN_ADAPTERS.join(', ')}`
    )
  }

  const adapter = ADAPTER_REGISTRY[adapterName]()

  // --- Delegate to adapter ---
  return adapter.run(spec)
}

/**
 * The SINGLE source of truth for which adapter a run resolves to.
 * Precedence: spec.adapter → process.env.ADAPTER → 'sdk' (pure-SDK cutover default).
 * Analytics MUST label runs via this — never re-derive with a different fallback
 * (the old `|| 'cli'` mislabeled every default-path SDK run as cli, corrupting the
 * cli-vs-sdk billing signal). Enforced by GATE-123.
 */
function resolvedAdapterName(spec = {}) {
  return spec.adapter || process.env.ADAPTER || 'sdk'
}

module.exports = { runAgent, resolvedAdapterName }
