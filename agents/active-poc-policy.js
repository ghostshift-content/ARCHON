// agents/active-poc-policy.js
//
// 2026-05-12 Phase B (active-poc mode): the SAFETY contract for any
// active-PoC probe. Three independent gates ALL required:
//
//   1. taskConfig.engagement_mode === 'active-poc'
//   2. active_poc_permission token valid (issuer, expiry, scope, caps)
//   3. archon_ACTIVE_POC=enabled env var (operator kill-switch)
//
// Per-probe runtime gates: target-in-scope + per-finding cap + per-task
// cap + defender-response abort.
//
// Pure module — no I/O except process.env. Designed to be small + tested.
// Universal across squads (pentest, cloud-security, network-pentest, etc.)
// — squad-specific probe libraries import this module to enforce safety.

'use strict'

const REQUIRED_PERMISSION_FIELDS = Object.freeze([
  'permission_id', 'issued_by', 'valid_until',
  'scope_domains', 'capabilities',
  'max_total_probes', 'max_per_finding',
])

// Validate task-config + permission token. Returns {ok, reason} where
// reason is human-readable. Used at Phase 3.08 entry — if !ok, the entire
// active-PoC run is skipped silently (logged, but no probes fire).
function validatePermission(taskConfig) {
  if (!taskConfig || taskConfig.engagement_mode !== 'active-poc') {
    return { ok: false, reason: 'engagement_mode is not active-poc' }
  }
  const perm = taskConfig.active_poc_permission
  if (!perm) return { ok: false, reason: 'missing active_poc_permission' }
  for (const f of REQUIRED_PERMISSION_FIELDS) {
    if (perm[f] == null) return { ok: false, reason: `permission missing field: ${f}` }
  }
  const until = new Date(perm.valid_until)
  if (Number.isNaN(until.getTime())) {
    return { ok: false, reason: 'invalid valid_until timestamp' }
  }
  if (until.getTime() < Date.now()) {
    return { ok: false, reason: 'permission expired' }
  }
  if (!Array.isArray(perm.scope_domains) || perm.scope_domains.length === 0) {
    return { ok: false, reason: 'scope_domains must be non-empty array' }
  }
  if (!Array.isArray(perm.capabilities) || perm.capabilities.length === 0) {
    return { ok: false, reason: 'capabilities must be non-empty array' }
  }
  return { ok: true, permission: perm }
}

// Glob matcher: supports `*.foo.com` (any subdomain) and exact `foo.com`.
// Pure function. No regex injection risk since we control the operator set.
function _matchesGlob(domain, pattern) {
  if (pattern.startsWith('*.')) {
    const suffix = pattern.slice(2)
    return domain === suffix || domain.endsWith('.' + suffix)
  }
  return domain === pattern
}

// True if domain is INCLUDED in scope and NOT EXCLUDED. Excludes win.
function targetInScope(domain, permission) {
  if (!domain || !permission) return false
  const excludes = permission.scope_excludes || []
  for (const ex of excludes) {
    if (_matchesGlob(domain, ex)) return false
  }
  for (const inc of permission.scope_domains) {
    if (_matchesGlob(domain, inc)) return true
  }
  return false
}

// Operator kill-switch: the daemon must have archon_ACTIVE_POC=enabled
// to allow ANY active probe. Means even if a task ships with active-poc
// config, an unprepared daemon refuses to run.
function envIsEnabled() {
  return process.env.archon_ACTIVE_POC === 'enabled'
}

// Defender-response detection: rate-limit, WAF challenge, CAPTCHA wall.
// On match, the probe should abort immediately and not retry — we are
// being observed and continuing could escalate detection. Heuristics:
//   - HTTP 429 = rate limit always aborts
//   - HTTP 403 + cf-mitigated header = Cloudflare challenge
//   - body contains "g-recaptcha-response" / "captcha-required" / "hcaptcha"
function shouldAbortOnDefender({ status, headers = {}, body = '' } = {}) {
  if (status === 429) return true
  if (status === 403) {
    for (const k of Object.keys(headers)) {
      if (k.toLowerCase() === 'cf-mitigated') return true
    }
  }
  if (typeof body === 'string' && /g-recaptcha-response|captcha-required|hcaptcha/i.test(body)) {
    return true
  }
  return false
}

// Per-run cap state. Mutable object — recordProbe updates counters.
// Used by active-poc-runner to gate every probe dispatch.
function newCapState(permission) {
  return {
    max_total: permission.max_total_probes,
    max_per_finding: permission.max_per_finding,
    per_finding: new Map(),
    total: 0,
  }
}

function canProbe(state, findingId) {
  if (state.total >= state.max_total) return false
  const used = state.per_finding.get(findingId) || 0
  if (used >= state.max_per_finding) return false
  return true
}

function recordProbe(state, findingId) {
  state.total += 1
  state.per_finding.set(findingId, (state.per_finding.get(findingId) || 0) + 1)
}

module.exports = {
  validatePermission,
  targetInScope,
  envIsEnabled,
  shouldAbortOnDefender,
  newCapState,
  canProbe,
  recordProbe,
  REQUIRED_PERMISSION_FIELDS,
}
