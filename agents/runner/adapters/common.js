// runner/adapters/common.js
//
// INVARIANT v2.1-A1 (ENV ALLOWLIST): single canonical source for the env
// object passed to the claude CLI subprocess (via cli.js spawn) or the
// Agent SDK (via sdk.js query options.env).
//
// WHY ONE MODULE: two copies of _buildSpawnEnv WILL drift silently — one copy
// gets an allowed key added or a comment updated and the other doesn't. A
// security allowlist with two implementations is not an allowlist; it is a
// hidden attack surface. Rule-of-three does NOT apply here: this is a security
// invariant, not a convenience helper.
//
// Per the SDK type docs (sdk.d.ts, Options.env): "When set, this value REPLACES
// the subprocess environment entirely — it is not merged with process.env."
// That is exactly this module's contract: ALLOWLIST only — NEVER spread process.env.
// The daemon env carries cloud creds; agents read attacker-controlled content.
//
// AUTH: Reads ANTHROPIC_API_KEY from process.env OR /root/intel/anthropic-config.json
// via the shared anthropic-key.js helper. If a key is present it is injected;
// if absent (OAuth/subscription mode) no key is added so the CLI falls through
// to OAuth via ~/.claude credentials (HOME is forwarded).
//
// MODULE shape: CommonJS, matching agents/runner/adapters/cli.js and sdk.js.

'use strict'

const os = require('os')
const anthropicKey = require('../../../src/integrations/anthropic-key')

// ───────────────────────────────────────────────────────────────────────────
// EXTRA-ENV ALLOWLIST (INVARIANT v2.1-A1, narrowed): the ONLY non-base env keys
// a caller may inject through buildSpawnEnv(opts.extras). This is NOT a generic
// passthrough — it is a hand-curated allowlist. The legacy spawn path (and the
// dynamic-workflow agents that succeed it) sets AGENT_TASK_ID so the spawned
// CLI/SDK subprocess can self-identify its task in logs/hooks. Anything else is
// a hard error: a generic env passthrough would re-open the cloud-cred exposure
// hole this whole module exists to seal. Add a key here ONLY with a security
// review and a matching reason.
// ───────────────────────────────────────────────────────────────────────────
const ALLOWED_EXTRA_KEYS = ['AGENT_TASK_ID']

/**
 * Build the minimal env object passed to the claude CLI subprocess (or SDK).
 * ALLOWLIST only — never spread process.env.
 *
 * Allowed keys:
 *   HOME              — CLI locates ~/.claude OAuth credentials
 *   PATH              — sub-executables (node, npx, etc.)
 *   TERM              — prevents "unknown terminal type" noise
 *   CLAUDE_CONFIG_DIR — non-standard but honoured by the CLI (if set)
 *   IS_SANDBOX        — claude-as-root bypassPermissions requirement (if set)
 *   ANTHROPIC_API_KEY — injected from anthropic-key.js IF configured (and NOT
 *                       suppressed via opts.omitApiKey); otherwise intentionally
 *                       absent so CLI falls back to OAuth auth
 *   <extras>          — caller-supplied keys, each of which MUST be in
 *                       ALLOWED_EXTRA_KEYS (else throws). Narrow allowlist only.
 *
 * @param {object} [opts]
 * @param {object} [opts.extras]      - extra env keys to inject; each key MUST be
 *                                       in ALLOWED_EXTRA_KEYS or this throws.
 * @param {boolean} [opts.omitApiKey] - when true, NEVER inject ANTHROPIC_API_KEY
 *                                       even if configured (force-OAuth, e.g.
 *                                       grader.js). Default false.
 * @returns {object} allowlisted env object
 */
function buildSpawnEnv(opts = {}) {
  const { extras, omitApiKey = false } = opts || {}
  const env = {}

  // HOME — required so the CLI locates ~/.claude OAuth credentials (subscription auth).
  // Daemon contexts may lack HOME; fall back to the current user's home (os.homedir())
  // rather than assuming root, so OAuth resolves for non-root/OSS installs.
  env.HOME = process.env.HOME || os.homedir()

  // PATH — needed to locate sub-executables (node, npx, etc.)
  if (process.env.PATH) env.PATH = process.env.PATH

  // TERM — cosmetic but prevents "unknown terminal type" noise
  if (process.env.TERM) env.TERM = process.env.TERM

  // CLAUDE_CONFIG_DIR — non-standard but honoured by the CLI
  if (process.env.CLAUDE_CONFIG_DIR) env.CLAUDE_CONFIG_DIR = process.env.CLAUDE_CONFIG_DIR

  // IS_SANDBOX — claude running as root requires IS_SANDBOX=1 for bypassPermissions; non-sensitive flag
  if (process.env.IS_SANDBOX) env.IS_SANDBOX = process.env.IS_SANDBOX

  // ANTHROPIC_API_KEY — inject ONLY if configured AND not explicitly suppressed.
  // omitApiKey forces OAuth/subscription auth even when a key is present
  // (grader.js's independent-judge force-OAuth semantics). We never fabricate.
  if (!omitApiKey) {
    const apiKey = anthropicKey.getAnthropicApiKey()
    if (apiKey) env.ANTHROPIC_API_KEY = apiKey
  }

  // extras — narrow allowlisted caller-supplied keys. THROW on anything not in
  // ALLOWED_EXTRA_KEYS. This is the v2.1-A1 boundary: never a generic passthrough.
  if (extras && typeof extras === 'object') {
    for (const key of Object.keys(extras)) {
      if (!ALLOWED_EXTRA_KEYS.includes(key)) {
        throw new Error(
          `[buildSpawnEnv] env extra "${key}" is not allowlisted. ` +
          `Allowed extra keys: ${ALLOWED_EXTRA_KEYS.join(', ')}. ` +
          `(INVARIANT v2.1-A1: extras are a narrow allowlist, never a generic env passthrough.)`
        )
      }
      const val = extras[key]
      if (val !== undefined && val !== null) env[key] = String(val)
    }
  }

  return env
}

module.exports = { buildSpawnEnv, ALLOWED_EXTRA_KEYS }
