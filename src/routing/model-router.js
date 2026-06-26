
const __roots = require('../../paths') // portable roots (KURU_*_ROOT) — see paths.js
// /root/agents/model-router.js
// Dynamic model routing: family aliases + role defaults + complexity auto-upgrade + effort tuning.
// Single source of truth: /root/intel/model-config.json
//
// Key design decisions:
//   1. Code NEVER references raw model IDs ("claude-opus-4-7"). Always resolves through families.
//      When Anthropic ships 4.8, change ONE line in model-config.json — zero code changes.
//   2. Startup validation against Anthropic /v1/models catches deprecations BEFORE a pentest starts.
//   3. Role-based defaults, not per-agent. Adding a new agent = one line in agent_roles map.
//   4. Complexity score upgrades recon/conditional agents on hard targets; leaders/validation never
//      drop below their role default (deny_family_downgrade_for floor).
//
// Exports:
//   loadModelConfig()                              → cached config object
//   validateModelsAtStartup()                      → async, returns {ok, missing[], available[]}
//   resolveFamily(family)                          → "claude-opus-4-7"
//   getModelForAgent(agent, {complexityScore})     → {model, effort, family, upgraded, reason}
//   computeComplexityScore(phase0Results)          → {score, tier, signals[]}
//   getEffortLevel(agent, complexityScore)         → "xhigh"
//   resetCache()                                   → clears in-memory config (for tests)

const fs = require('fs')
const path = require('path')
const https = require('https')

const CONFIG_PATH = (__roots.INTEL_ROOT + '/model-config.json')
const OVERRIDES_PATH = (__roots.INTEL_ROOT + '/agent-model-overrides.json')

// Valid effort levels per Claude CLI. Order matters for upgrade/downgrade comparisons.
const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max']

// Family ordering for tier comparisons: index 0 = cheapest, last = most powerful
const FAMILY_ORDER = ['fast', 'balanced', 'powerful']

// In-memory cache — avoids re-reading the JSON on every agent spawn
let _configCache = null
let _configMtime = 0
let _overridesCache = null
let _overridesMtime = 0

function loadModelConfig() {
  try {
    const stat = fs.statSync(CONFIG_PATH)
    if (_configCache && stat.mtimeMs === _configMtime) return _configCache
    const raw = fs.readFileSync(CONFIG_PATH, 'utf-8')
    const parsed = JSON.parse(raw)
    _validateConfigShape(parsed)
    _configCache = parsed
    _configMtime = stat.mtimeMs
    return _configCache
  } catch (e) {
    // Hard fallback: never leave a running pentest without SOME model config
    console.error(`[model-router] Failed to load ${CONFIG_PATH}: ${e.message}. Using hardcoded fallback.`)
    return _hardcodedFallback()
  }
}

function resetCache() {
  _configCache = null
  _configMtime = 0
  _overridesCache = null
  _overridesMtime = 0
}

function loadOverrides() {
  try {
    if (!fs.existsSync(OVERRIDES_PATH)) return {}
    const stat = fs.statSync(OVERRIDES_PATH)
    if (_overridesCache && stat.mtimeMs === _overridesMtime) return _overridesCache
    const raw = fs.readFileSync(OVERRIDES_PATH, 'utf-8')
    const parsed = JSON.parse(raw)
    // v2 format: { overrides: { agent: {family, effort} } }
    // v1 format: { agent: "model-id" } — treated as {family: null, effort: null} (falls back to role)
    let overrides = {}
    if (parsed && typeof parsed === 'object') {
      if (parsed.overrides && typeof parsed.overrides === 'object') {
        overrides = parsed.overrides
      } else {
        // v1 compat: ignore flat model-ID overrides (role defaults take over)
        overrides = {}
      }
    }
    _overridesCache = overrides
    _overridesMtime = stat.mtimeMs
    return _overridesCache
  } catch (e) {
    console.error(`[model-router] Failed to load ${OVERRIDES_PATH}: ${e.message}. Ignoring.`)
    return {}
  }
}

function resolveFamily(family) {
  const cfg = loadModelConfig()
  const resolved = cfg.families[family]
  if (!resolved) {
    throw new Error(`[model-router] Unknown family "${family}". Valid: ${Object.keys(cfg.families).join(', ')}`)
  }
  return resolved
}

function _roleForAgent(agentName, squad) {
  const cfg = loadModelConfig()
  const agentKey = String(agentName || '').toLowerCase()
  // (2026-04-20) Per-squad overrides take precedence. Dual-use agents (veteran
  // exists in both pentest and stocks) need different roles depending on which
  // squad dispatched them. Fall back to flat agent_roles, then vuln_specialist.
  if (squad && cfg.squad_agent_roles && cfg.squad_agent_roles[squad]?.[agentKey]) {
    return cfg.squad_agent_roles[squad][agentKey]
  }
  return cfg.agent_roles[agentKey] || 'vuln_specialist' // safe default: balanced/high
}

function getEffortLevel(agentName, complexityScore, squad) {
  const cfg = loadModelConfig()
  const role = _roleForAgent(agentName, squad)
  const roleDefault = cfg.role_defaults[role]
  if (!roleDefault) return cfg.effort_defaults.balanced || 'high'
  // Complexity-based effort bump: bump exploitation specialists (NOT recon) on medium+ targets.
  // Recon stays at default effort — empirical evidence shows Haiku/medium exhaustive beats
  // Sonnet/high focused for discovery work. Recon wants breadth, not depth.
  if (typeof complexityScore === 'number' && complexityScore >= 4) {
    if (['vuln_specialist', 'conditional', 'api_security'].includes(role)) {
      const idx = EFFORT_LEVELS.indexOf(roleDefault.effort)
      // Only bump on complex (>=6) — medium just gets family upgrade for conditional
      if (complexityScore >= 6 && idx >= 0 && idx < EFFORT_LEVELS.length - 2) {
        // cap at xhigh — never auto-bump to max
        return EFFORT_LEVELS[idx + 1]
      }
    }
  }
  return roleDefault.effort
}

function getModelForAgent(agentName, opts = {}) {
  const cfg = loadModelConfig()

  // Feature flag: disable routing entirely (emergency rollback).
  // `enabled: false` disables all dynamic logic — falls back to balanced/high for everyone.
  // `rollback_mode: "force_sonnet"` same effect, alternative signal for ops clarity.
  if (cfg.enabled === false || cfg.rollback_mode === 'force_sonnet') {
    const fallbackFamily = 'balanced'
    return {
      model: resolveFamily(fallbackFamily),
      effort: cfg.effort_defaults?.[fallbackFamily] || 'high',
      family: fallbackFamily,
      upgraded: false,
      reason: `rollback:${cfg.enabled === false ? 'disabled' : cfg.rollback_mode}`,
      role: 'rollback',
    }
  }

  // MODEL_PROFILE override (G4 multi-model test pattern):
  // If the env-driven profile defines a model for this agent, use it directly.
  // This sits AFTER rollback (kill-switch wins) but BEFORE normal routing.
  // See: agents/model-config.js
  try {
    const modelConfigShim = require('../../agents/model-config')
    const profileOverride = modelConfigShim.getProfileOverride(agentName)
    if (profileOverride) {
      return {
        model: profileOverride,
        effort: 'high',
        family: 'profile_override',
        upgraded: false,
        reason: `profile:${process.env.MODEL_PROFILE || 'default'}`,
        role: _roleForAgent(agentName, opts.squad),
      }
    }
  } catch (_) {
    // model-config.js is optional; fall through to normal routing if missing
  }

  const overrides = loadOverrides()
  const complexityScore = typeof opts.complexityScore === 'number' ? opts.complexityScore : 0
  const squad = typeof opts.squad === 'string' ? opts.squad : undefined
  const agentKey = String(agentName || '').toLowerCase()
  const role = _roleForAgent(agentName, squad)
  const roleDefault = cfg.role_defaults[role] || { family: 'balanced', effort: 'high' }

  let family = roleDefault.family
  let upgraded = false
  let reason = `role:${role}`

  // Complexity auto-upgrade, but respect the "never downgrade" floor for critical agents
  const denyDowngradeList = cfg.deny_family_downgrade_for || []
  const isProtected = denyDowngradeList.includes(agentKey)

  if (complexityScore >= 4 && !isProtected) {
    const tier = (cfg.complexity_scoring?.tiers || []).find(t => complexityScore >= t.min && complexityScore <= t.max)
    // NEW tier actions (post audit 2026-04-19):
    //   bump_specialist_effort: effort bump for vuln_specialist on medium targets (family unchanged)
    //   bump_specialist_effort_and_upgrade_conditional: effort bump + conditional upgrades to balanced on complex targets
    // OLD actions kept for backwards compatibility (will be removed in v3):
    //   upgrade_recon_to_balanced, upgrade_recon_and_conditional_to_balanced
    if (tier?.action === 'bump_specialist_effort_and_upgrade_conditional') {
      if (role === 'conditional' && _familyRank(family) < _familyRank('balanced')) {
        family = 'balanced'
        upgraded = true
        reason = `complexity:${complexityScore} upgrade_conditional`
      }
      // Effort bump for vuln_specialist happens in getEffortLevel below — nothing to do here
    } else if (tier?.action === 'bump_specialist_effort') {
      // Effort bump only, no family change — handled in getEffortLevel
    } else if (tier?.action === 'upgrade_recon_to_balanced' && role === 'recon') {
      // Legacy: kept for backwards compat if someone restores old tier config
      if (_familyRank(family) < _familyRank('balanced')) {
        family = 'balanced'
        upgraded = true
        reason = `complexity:${complexityScore} upgrade_recon (legacy)`
      }
    } else if (tier?.action === 'upgrade_recon_and_conditional_to_balanced') {
      if (['recon', 'conditional'].includes(role) && _familyRank(family) < _familyRank('balanced')) {
        family = 'balanced'
        upgraded = true
        reason = `complexity:${complexityScore} upgrade_recon_and_conditional (legacy)`
      }
    }
  }

  let effort = getEffortLevel(agentName, complexityScore, squad)

  // Per-agent overrides take final precedence (except denyDowngrade floor)
  const agentOverride = overrides[agentKey]
  if (agentOverride && typeof agentOverride === 'object') {
    if (agentOverride.family && cfg.families[agentOverride.family]) {
      const desiredRank = _familyRank(agentOverride.family)
      const currentRank = _familyRank(family)
      // Respect deny-downgrade: can only upgrade (or stay equal), never downgrade protected agents
      if (!isProtected || desiredRank >= currentRank) {
        family = agentOverride.family
        reason = `override:${agentOverride.family}`
      }
    }
    if (agentOverride.effort && EFFORT_LEVELS.includes(agentOverride.effort)) {
      effort = agentOverride.effort
    }
  }

  const model = resolveFamily(family)
  return { model, effort, family, upgraded, reason, role }
}

function computeComplexityScore(phase0Results = {}) {
  const cfg = loadModelConfig()
  const signals = cfg.complexity_scoring?.signals || []
  const matched = []
  let score = 0

  const haystack = _buildHaystack(phase0Results)

  for (const sig of signals) {
    let matched_here = false
    if (Array.isArray(sig.match)) {
      matched_here = sig.match.some(kw => haystack.includes(String(kw).toLowerCase()))
    }
    if (!matched_here && Array.isArray(sig.match_tech)) {
      const tech = String(phase0Results.tech || phase0Results.technology || '').toLowerCase()
      matched_here = sig.match_tech.some(t => tech.includes(String(t).toLowerCase()))
    }
    if (!matched_here && Array.isArray(sig.match_header)) {
      const headers = _headerString(phase0Results).toLowerCase()
      matched_here = sig.match_header.some(h => headers.includes(String(h).toLowerCase()))
    }
    if (!matched_here && typeof sig.match_subdomain_count_gte === 'number') {
      const count = Number(phase0Results.subdomainCount || phase0Results.subdomains?.length || 0)
      matched_here = count >= sig.match_subdomain_count_gte
    }
    if (matched_here) {
      score += (Number(sig.points) || 0)
      matched.push({ id: sig.id, points: sig.points })
    }
  }

  const tier = (cfg.complexity_scoring?.tiers || []).find(t => score >= t.min && score <= t.max)
  return { score, tier: tier?.name || 'unknown', tierAction: tier?.action || 'defaults', signals: matched }
}

async function validateModelsAtStartup(apiKey) {
  const cfg = loadModelConfig()
  const configured = Object.values(cfg.families)
  const key = apiKey || process.env.ANTHROPIC_API_KEY

  if (!key) {
    // Not a hard failure — event-bus may run without Anthropic API env var
    // (e.g. when using OpenClaw/Bedrock). Skip the live check.
    return { ok: true, skipped: true, reason: 'no_anthropic_api_key', configured }
  }

  try {
    const available = await _fetchAvailableModels(key)
    const availableIds = new Set(available.map(m => m.id))
    const missing = configured.filter(id => !availableIds.has(id))
    return {
      ok: missing.length === 0,
      missing,
      available: [...availableIds],
      configured,
    }
  } catch (e) {
    // Network / auth errors shouldn't block boot
    return { ok: true, skipped: true, reason: `fetch_failed:${e.message}`, configured }
  }
}

// ── Internals ──

function _validateConfigShape(cfg) {
  if (!cfg || typeof cfg !== 'object') throw new Error('config is not an object')
  if (!cfg.families || typeof cfg.families !== 'object') throw new Error('families missing')
  if (!cfg.role_defaults) throw new Error('role_defaults missing')
  if (!cfg.agent_roles) throw new Error('agent_roles missing')
  for (const alias of Object.keys(cfg.families)) {
    if (typeof cfg.families[alias] !== 'string' || !cfg.families[alias].startsWith('claude-')) {
      throw new Error(`family "${alias}" must resolve to a claude-* model ID`)
    }
  }
}

function _familyRank(family) {
  const idx = FAMILY_ORDER.indexOf(family)
  return idx < 0 ? 0 : idx
}

function _buildHaystack(p0) {
  const parts = []
  if (p0.authType) parts.push(String(p0.authType))
  if (p0.waf) parts.push(String(p0.waf))
  if (p0.tech) parts.push(String(p0.tech))
  if (p0.notes) parts.push(String(p0.notes))
  if (Array.isArray(p0.subdomains)) parts.push(p0.subdomains.join(' '))
  if (p0.headers && typeof p0.headers === 'object') parts.push(Object.keys(p0.headers).join(' '))
  return parts.join(' ').toLowerCase()
}

function _headerString(p0) {
  if (!p0.headers) return ''
  if (typeof p0.headers === 'string') return p0.headers
  if (typeof p0.headers === 'object') return Object.keys(p0.headers).join(' ')
  return ''
}

function _fetchAvailableModels(apiKey) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.anthropic.com',
      path: '/v1/models',
      method: 'GET',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      timeout: 5000,
    }, (res) => {
      const chunks = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () => {
        try {
          const body = JSON.parse(Buffer.concat(chunks).toString())
          if (Array.isArray(body.data)) return resolve(body.data)
          reject(new Error(`unexpected response: ${JSON.stringify(body).slice(0, 200)}`))
        } catch (e) { reject(e) }
      })
    })
    req.on('error', reject)
    req.on('timeout', () => { req.destroy(new Error('timeout')) })
    req.end()
  })
}

function _hardcodedFallback() {
  return {
    families: {
      fast: 'claude-haiku-4-5',
      balanced: 'claude-sonnet-4-6',
      powerful: 'claude-opus-4-8',
    },
    effort_defaults: { fast: 'medium', balanced: 'high', powerful: 'xhigh' },
    role_defaults: {
      phase0_waf_auth:  { family: 'balanced', effort: 'high' },
      recon:            { family: 'fast',     effort: 'medium' },
      vuln_specialist:  { family: 'balanced', effort: 'high' },
      conditional:      { family: 'balanced', effort: 'medium' },
      validation:       { family: 'balanced', effort: 'high' },
      chain_analysis:   { family: 'powerful', effort: 'xhigh' },
      report:           { family: 'balanced', effort: 'high' },
      verification:     { family: 'balanced', effort: 'high' },
      stock_leader:     { family: 'powerful', effort: 'xhigh' },
      stock_analyst:    { family: 'fast',     effort: 'medium' },
      stock_challenger: { family: 'fast',     effort: 'high' },
      grading:          { family: 'fast',     effort: 'low' },
      compliance:       { family: 'fast',     effort: 'high' },
      api_security:     { family: 'balanced', effort: 'medium' },
    },
    agent_roles: {},
    complexity_scoring: { signals: [], tiers: [] },
    deny_family_downgrade_for: ['auditor', 'atlas', 'chanakya', 'scribe', 'arbiter'],
  }
}

module.exports = {
  loadModelConfig,
  loadOverrides,
  resolveFamily,
  getModelForAgent,
  computeComplexityScore,
  getEffortLevel,
  validateModelsAtStartup,
  resetCache,
  EFFORT_LEVELS,
  FAMILY_ORDER,
}
