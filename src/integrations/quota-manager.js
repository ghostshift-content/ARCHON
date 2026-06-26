
const __roots = require('../../paths') // portable roots (KURU_*_ROOT) — see paths.js
/**
 * QUOTA MANAGER — Provider-agnostic rate limit tracking + smart dispatch gating
 * 
 * Architecture:
 *   - Tracks per-model rate limit state
 *   - Learns reset patterns from errors/successes
 *   - Decides: "safe to dispatch?" before every spawnAgent()
 *   - Supports fallback chains (sonnet → haiku)
 *   - Persistent state (survives PM2 restarts)
 */

const fs = require('fs')
const path = require('path')

const STATE_FILE = (__roots.INTEL_ROOT + '/quota.json')

// Default cooldown ladder (exponential backoff)
const COOLDOWN_LADDER = [
  2 * 60 * 1000,       // 1st hit: 2 min
  10 * 60 * 1000,      // 2nd hit: 10 min
  30 * 60 * 1000,      // 3rd hit: 30 min
  3 * 60 * 60 * 1000,  // 4th hit: 3 hours (full session reset)
  3 * 60 * 60 * 1000,  // 5th+: keep at 3 hours
]

function loadState() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      return JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8'))
    }
  } catch {}
  return { providers: {}, history: [] }
}

function saveState(state) {
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2))
  } catch (e) {
    console.error(`[QuotaManager] Failed to save state: ${e.message}`)
  }
}

function getModelState(state, model) {
  // model format: "anthropic/claude-sonnet-4-6" or "anthropic/claude-haiku-4-5"
  const parts = model.includes('/') ? model.split('/') : ['unknown', model]
  const provider = parts[0]
  const modelName = parts.slice(1).join('/')
  
  if (!state.providers[provider]) state.providers[provider] = { models: {} }
  if (!state.providers[provider].models[modelName]) {
    state.providers[provider].models[modelName] = {
      status: 'ok',           // ok | cooldown | exhausted
      errorCount: 0,
      lastError: null,
      lastSuccess: null,
      cooldownUntil: null,
      estimatedResetAt: null,
      totalHits: 0,
      resets: [],              // timestamps of observed resets (for learning)
    }
  }
  return state.providers[provider].models[modelName]
}

/**
 * Check if we can dispatch to this model right now
 * @returns {object} { allowed: boolean, reason: string, waitMs: number }
 */
function canDispatch(model) {
  const state = loadState()
  const ms = getModelState(state, model)
  const now = Date.now()
  
  if (ms.status === 'ok') {
    return { allowed: true, reason: 'ok' }
  }
  
  if (ms.cooldownUntil) {
    const cooldownEnd = new Date(ms.cooldownUntil).getTime()
    if (now >= cooldownEnd) {
      // Cooldown expired — allow dispatch, reset status
      ms.status = 'ok'
      ms.errorCount = 0
      ms.cooldownUntil = null
      saveState(state)
      return { allowed: true, reason: 'cooldown_expired' }
    } else {
      const waitMs = cooldownEnd - now
      const waitMin = Math.ceil(waitMs / 60000)
      return { 
        allowed: false, 
        reason: `rate_limited — cooldown until ${ms.cooldownUntil} (${waitMin} min remaining)`,
        waitMs,
        resetAt: ms.cooldownUntil
      }
    }
  }
  
  // Status is not ok but no cooldown set — treat as ok
  ms.status = 'ok'
  saveState(state)
  return { allowed: true, reason: 'reset' }
}

/**
 * Report a rate limit error from an agent
 * @param {string} model - Model that was rate-limited
 * @param {string} errorOutput - Raw error output from agent
 */
function reportLimit(model, errorOutput) {
  const state = loadState()
  const ms = getModelState(state, model)
  const now = new Date()
  
  ms.errorCount = (ms.errorCount || 0) + 1
  ms.totalHits = (ms.totalHits || 0) + 1
  ms.lastError = now.toISOString()
  ms.status = 'cooldown'
  
  // Try to parse retry-after from error output
  let retryAfterMs = null
  
  // Pattern 1: "retry after X seconds"
  const retryMatch = errorOutput.match(/retry.after\s*[:=]?\s*(\d+)\s*s/i)
  if (retryMatch) {
    retryAfterMs = parseInt(retryMatch[1]) * 1000
  }
  
  // Pattern 2: "retry-after: X" header
  const headerMatch = errorOutput.match(/retry-after:\s*(\d+)/i)
  if (headerMatch) {
    retryAfterMs = parseInt(headerMatch[1]) * 1000
  }
  
  // Pattern 3: reset timestamp
  const resetMatch = errorOutput.match(/reset.at\s*[:=]?\s*(\d{4}-\d{2}-\d{2}T[\d:]+Z?)/i)
  if (resetMatch) {
    const resetTime = new Date(resetMatch[1]).getTime()
    retryAfterMs = Math.max(0, resetTime - Date.now())
  }
  
  // Pattern 4: "Resets in X hr Y min" (from Anthropic UI-style messages)
  const hrmMatch = errorOutput.match(/resets?\s*in\s*(\d+)\s*hr?\s*(\d+)?\s*min/i)
  if (hrmMatch) {
    const hrs = parseInt(hrmMatch[1]) || 0
    const mins = parseInt(hrmMatch[2]) || 0
    retryAfterMs = (hrs * 60 + mins) * 60 * 1000
  }
  
  if (retryAfterMs) {
    // Use parsed reset time
    ms.cooldownUntil = new Date(Date.now() + retryAfterMs).toISOString()
    ms.estimatedResetAt = ms.cooldownUntil
  } else {
    // Use exponential backoff ladder
    const ladderIndex = Math.min(ms.errorCount - 1, COOLDOWN_LADDER.length - 1)
    const cooldownMs = COOLDOWN_LADDER[ladderIndex]
    ms.cooldownUntil = new Date(Date.now() + cooldownMs).toISOString()
  }
  
  // Record in history
  state.history.push({
    ts: now.toISOString(),
    model,
    event: 'rate_limit',
    errorCount: ms.errorCount,
    cooldownUntil: ms.cooldownUntil,
    parsedRetryAfter: retryAfterMs ? `${Math.round(retryAfterMs/1000)}s` : 'none — used ladder'
  })
  
  // Keep history manageable (last 100 entries)
  if (state.history.length > 100) state.history = state.history.slice(-100)
  
  saveState(state)
  
  const waitMin = Math.ceil((new Date(ms.cooldownUntil).getTime() - Date.now()) / 60000)
  return {
    cooldownUntil: ms.cooldownUntil,
    waitMinutes: waitMin,
    errorCount: ms.errorCount,
    source: retryAfterMs ? 'parsed_from_error' : 'exponential_backoff'
  }
}

/**
 * Report successful agent completion — reset error state
 */
function reportSuccess(model) {
  const state = loadState()
  const ms = getModelState(state, model)
  
  // If we were in cooldown and now succeeded → record the reset time for learning
  if (ms.status === 'cooldown' || ms.errorCount > 0) {
    ms.resets.push(new Date().toISOString())
    if (ms.resets.length > 20) ms.resets = ms.resets.slice(-20)
  }
  
  ms.status = 'ok'
  ms.errorCount = 0
  ms.lastSuccess = new Date().toISOString()
  ms.cooldownUntil = null
  
  saveState(state)
}

/**
 * Get best available model from a fallback chain
 * @param {string[]} models - Ordered list of preferred models
 * @returns {string|null} First available model, or null if all limited
 */
function getBestAvailableModel(models) {
  for (const model of models) {
    const check = canDispatch(model)
    if (check.allowed) return model
  }
  return null
}

/**
 * Get status summary for logging/display
 */
function getStatus() {
  const state = loadState()
  const summary = {}
  for (const [provider, pData] of Object.entries(state.providers)) {
    for (const [model, mData] of Object.entries(pData.models || {})) {
      const key = `${provider}/${model}`
      summary[key] = {
        status: mData.status,
        errorCount: mData.errorCount,
        cooldownUntil: mData.cooldownUntil,
        totalHits: mData.totalHits || 0,
      }
    }
  }
  return summary
}

/**
 * Parse agent output for rate limit indicators
 * @returns {boolean}
 */
function isRateLimitError(output) {
  return /429|rate.limit|quota.exceeded|too.many.requests|rate_limit_exceeded|usage.limit|capacity|overloaded/i.test(output || '')
}

module.exports = {
  canDispatch,
  reportLimit,
  reportSuccess,
  getBestAvailableModel,
  getStatus,
  isRateLimitError,
  loadState,
}
