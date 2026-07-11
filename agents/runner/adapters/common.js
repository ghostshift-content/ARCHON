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
const proxyConfig = require('../../../src/integrations/proxy-config')

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
 *   HTTP_PROXY / HTTPS_PROXY / NO_PROXY (+ lowercase) / NODE_EXTRA_CA_CERTS /
 *   NODE_TLS_REJECT_UNAUTHORIZED — injected from proxy-config.js IFF an operator
 *                       has configured an intercepting proxy (Burp Suite, ZAP,
 *                       mitmproxy, ...). This is what routes agent-fired
 *                       curl/nuclei/sqlmap/git/wget/node/python subprocesses
 *                       through the proxy. See proxy-config.js for the config
 *                       surface (ARCHON_PROXY_URL/_ENABLED/_BYPASS/_CA_CERT/
 *                       _INSECURE). Absent entirely when no proxy is configured —
 *                       zero behavior change for operators who don't opt in.
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

  // USER / LOGNAME — the username. On macOS the Claude OAuth credential lives in the
  // KEYCHAIN (not a ~/.claude file), and the claude CLI uses USER to locate that
  // keychain item — without it a spawned agent reports "Not logged in" even when the
  // user IS logged in. Confirmed empirically: HOME+PATH+USER authenticates; HOME+PATH
  // alone fails. Both are the non-secret username (Linux daemons may set LOGNAME, not
  // USER), so forward whichever is present. This is the fix for subscription auth in a
  // spawned agent on macOS.
  if (process.env.USER) env.USER = process.env.USER
  if (process.env.LOGNAME) env.LOGNAME = process.env.LOGNAME

  // PATH — needed to locate sub-executables (node, npx, etc.)
  if (process.env.PATH) env.PATH = process.env.PATH

  // TERM — cosmetic but prevents "unknown terminal type" noise
  if (process.env.TERM) env.TERM = process.env.TERM

  // CLAUDE_CONFIG_DIR — non-standard but honoured by the CLI
  if (process.env.CLAUDE_CONFIG_DIR) env.CLAUDE_CONFIG_DIR = process.env.CLAUDE_CONFIG_DIR

  // CLAUDE_CODE_OAUTH_TOKEN — long-lived SUBSCRIPTION OAuth token (`claude setup-token`).
  // REQUIRED for the headless daemon: agents are spawned with this stripped allowlist,
  // through which the interactive Keychain/Claude-Code-session login is NOT reachable
  // (a bare `claude` here reports "Not logged in"). This token is the env-portable way
  // to carry the subscription into the spawned CLI. It is a subscription credential,
  // NOT an API key, so it is forwarded regardless of omitApiKey / the subscription-only
  // lock and never registers as metered-key auth.
  if (process.env.CLAUDE_CODE_OAUTH_TOKEN) env.CLAUDE_CODE_OAUTH_TOKEN = process.env.CLAUDE_CODE_OAUTH_TOKEN

  // IS_SANDBOX — claude running as root requires IS_SANDBOX=1 for bypassPermissions; non-sensitive flag
  if (process.env.IS_SANDBOX) env.IS_SANDBOX = process.env.IS_SANDBOX

  // Subscription-only lock (opt-in, default off = unchanged behavior): when
  // ARCHON_SUBSCRIPTION_ONLY is set, NEVER inject an API key for ANY agent — even
  // if an ANTHROPIC_API_KEY is present in the env or a saved config file. This
  // guarantees every run authenticates with the Claude SUBSCRIPTION via OAuth and
  // can never silently fall through to metered API billing.
  const subscriptionOnly = /^(1|true|on|yes|enabled)$/i.test(String(process.env.ARCHON_SUBSCRIPTION_ONLY || '').trim())

  // ANTHROPIC_API_KEY — inject ONLY if configured AND not suppressed (per-call
  // omitApiKey, e.g. grader.js's force-OAuth, OR the global subscription-only
  // lock above). We never fabricate a key.
  if (!omitApiKey && !subscriptionOnly) {
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

  // Intercepting-proxy support (Burp Suite / ZAP / mitmproxy / any HTTP(S) or
  // SOCKS proxy) — see proxy-config.js. This is a DEDICATED, named set of keys
  // (not a generic passthrough), so it doesn't weaken the v2.1-A1 allowlist
  // invariant above: an operator opts in explicitly via ARCHON_PROXY_URL /
  // ARCHON_PROXY_ENABLED, and getProxyEnv() returns {} (no-op) otherwise.
  // This is what makes every curl/nuclei/sqlmap/git/wget/node/python subprocess
  // an agent's Bash tool spawns visible in the proxy — not just ARCHON's own
  // direct API calls.
  Object.assign(env, proxyConfig.getProxyEnv())

  return env
}

module.exports = { buildSpawnEnv, ALLOWED_EXTRA_KEYS }
