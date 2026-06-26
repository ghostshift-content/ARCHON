
const __roots = require('../../paths') // portable roots (KURU_*_ROOT) — see paths.js
// /root/agents/anthropic-key.js
// Single source of truth for Anthropic API key discovery.
// Precedence (first match wins):
//   1. Process env ANTHROPIC_API_KEY — external override, e.g. when launching claude CLI directly with a key
//   2. /root/intel/anthropic-config.json { apiKey: "..." } — user-configured via mission-control UI
//   3. null — no key available. Caller should fall back to OAuth (claude CLI default behavior)
//
// Why three tiers:
//   - env var at top: ops can inject via systemd/pm2 env without touching files
//   - config file second: mission-control UI writes it, persists across restarts
//   - null fallback third: default OAuth path keeps working with no key (backward compatible)
//
// Generic across squads — any agent, any script, any skill that spawns claude CLI can
// call getAnthropicApiKey() to decide whether to pass the key via env.

const fs = require('fs')

const CONFIG_PATH = (__roots.INTEL_ROOT + '/anthropic-config.json')

// In-memory cache with mtime invalidation — same pattern as model-router.js
let _cache = null
let _mtime = 0
let _envCache = null

function getAnthropicApiKey() {
  // Tier 1: process.env wins
  if (!_envCache) {
    const envKey = process.env.ANTHROPIC_API_KEY
    _envCache = envKey && envKey.trim() ? envKey.trim() : null
  }
  if (_envCache) return _envCache

  // Tier 2: config file
  try {
    if (!fs.existsSync(CONFIG_PATH)) return null
    const stat = fs.statSync(CONFIG_PATH)
    if (_cache && stat.mtimeMs === _mtime) return _cache.apiKey || null
    const raw = fs.readFileSync(CONFIG_PATH, 'utf-8')
    const parsed = JSON.parse(raw)
    _cache = parsed
    _mtime = stat.mtimeMs
    return parsed.apiKey || null
  } catch {
    return null
  }
}

function setAnthropicApiKey(apiKey) {
  if (!apiKey || typeof apiKey !== 'string') {
    throw new Error('apiKey must be a non-empty string')
  }
  const trimmed = apiKey.trim()
  if (!trimmed.startsWith('sk-ant-')) {
    throw new Error('apiKey must start with sk-ant-')
  }
  const doc = { apiKey: trimmed, updated_at: new Date().toISOString() }
  const tmp = CONFIG_PATH + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(doc, null, 2))
  fs.chmodSync(tmp, 0o600) // credential — readable only by owner
  fs.renameSync(tmp, CONFIG_PATH)
  _cache = null
  _mtime = 0
  return true
}

function clearAnthropicApiKey() {
  try {
    if (fs.existsSync(CONFIG_PATH)) fs.unlinkSync(CONFIG_PATH)
  } catch {}
  _cache = null
  _mtime = 0
  return true
}

function isKeyConfigured() {
  return !!getAnthropicApiKey()
}

function keySource() {
  if (process.env.ANTHROPIC_API_KEY && process.env.ANTHROPIC_API_KEY.trim()) return 'env'
  try {
    if (fs.existsSync(CONFIG_PATH)) return 'config'
  } catch {}
  return 'oauth'
}

function resetCache() {
  _cache = null
  _mtime = 0
  _envCache = null
}

module.exports = {
  getAnthropicApiKey,
  setAnthropicApiKey,
  clearAnthropicApiKey,
  isKeyConfigured,
  keySource,
  resetCache,
  CONFIG_PATH,
}
