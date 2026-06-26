// agents/severity-profile.js
//
// 2026-05-15: Universal severity profile filter. Borrowed pattern from
// bughunter-ai (h4ckologic/bughunter-ai) — user-selectable mode at
// dispatch decides which findings reach the final report.
//
// Three profiles: bounty (high-only, paid programs), pentest (medium+,
// engagements), comprehensive (all severities, research). Zero-day
// indicator phrases bypass the CVSS floor.
//
// DOWNGRADE-NOT-DROP: findings below threshold move to archived, never
// deleted. Archived findings remain available for cross-squad chain
// analysis and audit.

'use strict'

const PROFILES = Object.freeze({
  bounty: Object.freeze({ name: 'bounty', min_cvss: 8.0, target_count: 10 }),
  pentest: Object.freeze({ name: 'pentest', min_cvss: 4.0, target_count: 20 }),
  comprehensive: Object.freeze({ name: 'comprehensive', min_cvss: 0.0, target_count: 50 }),
})

// Maps from caller-friendly program intent to the right severity profile.
// Framework-general — no per-program (Lenovo / HackerOne / etc) coupling.
//
// program_type values:
//   kudos          → pentest      (kudos-only programs accept Mediums)
//   paid_bounty    → bounty       (paid programs typically pay High+ only)
//   internal_audit → comprehensive (find everything, even Lows)
//   bug_bash       → pentest      (events run shallow + want volume)
//
// Add new program_type → profile mappings here as the framework grows.
const PROGRAM_TYPE_TO_PROFILE = Object.freeze({
  kudos: 'pentest',
  paid_bounty: 'bounty',
  internal_audit: 'comprehensive',
  bug_bash: 'pentest',
})

const ZERO_DAY_INDICATORS = Object.freeze([
  /\bpre[-_ ]?auth(entication)?\s+rce\b/i,
  /\bauth(entication)?\s+bypass\b/i,
  /\baccount\s+takeover\b/i,
  /\bidor.*sensitive\b/i,
  /\bstored\s+xss.*admin\b/i,
  /\bprivilege\s+escalation\b/i,
  /\bno\s+(public\s+)?cve\b/i,
  /\bzero[-_ ]?day\b/i,
  /\bnovel\s+technique\b/i,
])

function _profileFor(name) {
  return PROFILES[name] || null
}

function _resolveProfileOrWarn(name, warnings) {
  const p = _profileFor(name)
  if (p) return p
  if (warnings) warnings.push(`unknown profile "${name}" — defaulting to pentest`)
  return PROFILES.pentest
}

/**
 * Resolves which severity profile to use for a dispatch.
 *
 * Priority:
 *   1. Explicit dispatch.severity_profile (must be a known profile name)
 *   2. dispatch.program_type via PROGRAM_TYPE_TO_PROFILE
 *   3. Default 'pentest'
 *
 * Unknown explicit profile or unknown program_type both silently fall
 * through to 'pentest'. The caller is responsible for logging the
 * fallback if it matters.
 */
function resolveProfile(dispatch) {
  if (!dispatch || typeof dispatch !== 'object') return 'pentest'
  const explicit = dispatch.severity_profile || (dispatch.meta && dispatch.meta.severityProfile)
  if (typeof explicit === 'string' && _profileFor(explicit)) {
    return explicit
  }
  const pt = dispatch.program_type
  if (typeof pt === 'string' && PROGRAM_TYPE_TO_PROFILE[pt]) {
    return PROGRAM_TYPE_TO_PROFILE[pt]
  }
  return 'pentest'
}

function _findingText(finding) {
  return ((finding && finding.title) || '') + ' ' + ((finding && finding.details) || '')
}

function _matchesZeroDay(finding) {
  const text = _findingText(finding)
  for (const re of ZERO_DAY_INDICATORS) {
    if (re.test(text)) return re.source
  }
  return null
}

function classifyFinding(finding, profileName, squadPolicy) {
  const profile = _resolveProfileOrWarn(profileName, null)
  const cvss = squadPolicy.cvssOf(finding)
  const zeroDayMatch = _matchesZeroDay(finding)
  if (zeroDayMatch) {
    return { decision: 'report', reason: `zero-day indicator matched: ${zeroDayMatch}` }
  }
  if (cvss >= profile.min_cvss) {
    return { decision: 'report', reason: `cvss ${cvss} >= ${profile.min_cvss} (${profile.name})` }
  }
  return {
    decision: 'archive',
    reason: `cvss ${cvss} below ${profile.name} floor ${profile.min_cvss}`,
  }
}

function filterFindings(findings, profileName, squadPolicy, { taskId, squad, outDir } = {}) {
  const warnings = []
  _resolveProfileOrWarn(profileName, warnings)
  const reported = []
  const archived = []
  for (const f of findings || []) {
    const { decision, reason } = classifyFinding(f, profileName, squadPolicy)
    if (decision === 'report') {
      reported.push({ ...f, profile_reason: reason })
    } else {
      // Log every downgrade to the suppression ledger — GATE-SUPPRESSION-VISIBLE.
      // outDir is forwarded so tests write to a temp dir instead of polluting the
      // PRODUCTION ledger (the prod file had accreted 9090 test fixtures with taskId:null
      // because this never threaded outDir — the suppression-recall metric read pure noise).
      try {
        require('./suppression-ledger').logSuppression({
          taskId,
          finding: f,
          filterName: 'severity-profile',
          reason,
          fromSeverity: f.severity || null,
          toSeverity: 'archived',
          squad,
          outDir,
        })
      } catch {}
      archived.push({ ...f, archive_reason: reason })
    }
  }
  return { reported, archived, warnings }
}

function summarize(filterResult) {
  const r = filterResult || {}
  const reported = (r.reported || []).length
  const archived = (r.archived || []).length
  return { reported, archived, total: reported + archived }
}

module.exports = {
  PROFILES,
  PROGRAM_TYPE_TO_PROFILE,
  ZERO_DAY_INDICATORS,
  classifyFinding,
  filterFindings,
  resolveProfile,
  summarize,
}
