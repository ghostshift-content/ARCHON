
const __roots = require('../paths') // portable roots (KURU_*_ROOT) — see paths.js
// agents/llm-model-resolver.js
//
// Centralized LLM model resolver for code paths that fire `claude --print`
// subprocesses outside the squad-routing flow (handoff resolver, judge verifier,
// trajectory observer, process-handoff CLI).
//
// Why this exists
// ───────────────
// Those 4 paths previously had hardcoded `claude-haiku-4-5` / `claude-sonnet-4-6`
// strings. When Anthropic ships a new fast/balanced model and Jay edits
// /root/intel/model-config.json, the hardcoded paths silently keep firing the
// old model. Same regression class as the 2026-04-20 stocks routing fix.
//
// Contract
// ────────
//   resolveLLMModel({ family, override }) → "claude-..."
//     family   = 'fast' | 'balanced' | 'powerful' (default: 'balanced')
//     override = optional explicit model ID; if truthy, returned as-is
//
// Behavior
// ────────
//   1. override wins (env-var passthrough — e.g. HANDOFF_LLM_MODEL=claude-foo)
//   2. else read families.<family> from /root/intel/model-config.json
//   3. cache result for ~10s (avoids hammering the disk on every spawn)
//   4. unknown family → falls back to 'balanced' (graceful — a typo in caller
//      code should not crash the pipeline)
//   5. missing/malformed config → FALLBACK_FAMILIES constant
//
// Why a separate module instead of extending model-router.js?
//   model-router.getModelForAgent() is per-agent, role-based, complexity-aware,
//   and returns {model, effort, family, upgraded, reason, role}. These 4 hot
//   paths just need a model string by family — they don't have an agent name,
//   they're not subject to per-squad role rules, and they don't want effort
//   bumps. A small dedicated resolver is clearer than overloading the router.

const fs = require('node:fs')

const CONFIG_PATH = (__roots.INTEL_ROOT + '/model-config.json')
const CACHE_TTL_MS = 10_000

// Documented hardcoded fallback. If model-config.json is missing/corrupt,
// these IDs fire. Update when Anthropic deprecates a current model AND
// model-config.json hasn't been updated yet.
const FALLBACK_FAMILIES = Object.freeze({
  fast: 'claude-haiku-4-5',
  balanced: 'claude-sonnet-4-6',
  powerful: 'claude-opus-4-7',
})

let _cache = null
let _cacheAt = 0
let _cacheKey = null // tracks the config path that produced _cache (for test override)

function resetCache() {
  _cache = null
  _cacheAt = 0
  _cacheKey = null
}

function _loadFamilies(configPath) {
  // Cache by (path, time-window). Test paths bypass the cache because tests
  // pass _configPathForTest pointing at one-shot tmp files.
  const now = Date.now()
  if (_cache && _cacheKey === configPath && (now - _cacheAt) < CACHE_TTL_MS) {
    return _cache
  }
  let families
  try {
    const raw = fs.readFileSync(configPath, 'utf-8')
    const parsed = JSON.parse(raw)
    if (parsed && parsed.families && typeof parsed.families === 'object') {
      families = parsed.families
    } else {
      families = FALLBACK_FAMILIES
    }
  } catch {
    families = FALLBACK_FAMILIES
  }
  _cache = families
  _cacheAt = now
  _cacheKey = configPath
  return families
}

/**
 * Resolve a model ID for an off-squad LLM call.
 *
 * @param {object} [opts]
 * @param {('fast'|'balanced'|'powerful')} [opts.family='balanced']
 * @param {string|null|undefined} [opts.override] — explicit model ID; if truthy, wins
 * @param {string} [opts._configPathForTest] — internal test hook; do not use in prod
 * @returns {string} model ID, e.g. 'claude-haiku-4-5'
 */
function resolveLLMModel(opts) {
  const o = opts || {}
  if (o.override && typeof o.override === 'string' && o.override.trim()) {
    return o.override
  }
  const requested = o.family || 'balanced'
  const configPath = o._configPathForTest || CONFIG_PATH
  const families = _loadFamilies(configPath)
  const got = families[requested]
  if (got && typeof got === 'string') return got
  // Unknown family or family present in config but with bad value → fallback to balanced
  return families.balanced || FALLBACK_FAMILIES.balanced
}

module.exports = {
  resolveLLMModel,
  resetCache,
  FALLBACK_FAMILIES,
  CACHE_TTL_MS,
  CONFIG_PATH,
}
