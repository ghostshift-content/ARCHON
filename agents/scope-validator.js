// agents/scope-validator.js
//
// 2026-05-15: Validates every finding's host against the dispatch-time scope
// list. Motivation: Q#8 surfaced that specialists do out-of-band discovery
// (subdomain enum, hostname guessing) and produce findings on hosts that
// weren't in the original Bugcrowd scope. Of 11 findings on api.motorola.com,
// only 2 (www.motorola.com-hosted) were cleanly in scope.
//
// Three outcomes per finding:
//   - in-scope                  — host matches scope list (exact or wildcard)
//   - infrastructure-dependency — host not in scope, but an in-scope asset
//                                 demonstrably depends on it (payment infra
//                                 for in-scope checkout, etc.). VYASA should
//                                 include with explicit dependency note.
//   - out-of-scope              — host doesn't match scope or any dependency.
//                                 VYASA should omit OR mark clearly.
//
// Scope-list shape (per-task config at /root/intel/scope-{taskId}.json):
//   {
//     "in_scope": [ "www.motorola.com", "*.support.motorola.com" ],
//     "infra_dependencies": {
//       "paymentuxe-prod.cloud.motorola.net": ["www.motorola.com"],
//       ...
//     }
//   }

'use strict'

const { extractFirstUrl } = require('./url-extractor')

const SCOPE_STATUS = Object.freeze({
  IN_SCOPE: 'in-scope',
  OUT_OF_SCOPE: 'out-of-scope',
  INFRA_DEPENDENCY: 'infrastructure-dependency',
})

// Belt-and-suspenders URL resolution. Even after kripa-validated-builder
// emits canonical `finding.url`, defensive extraction protects against
// in-flight findings, other-squad producers, and re-processed archives.
// Priority: explicit fields > details > notes > evidence (string variant).
function _resolveUrl(finding) {
  if (!finding) return ''
  return (
    finding.url ||
    finding.affected_url ||
    finding.target ||
    extractFirstUrl(finding.details || '') ||
    extractFirstUrl(finding.notes || '') ||
    (typeof finding.evidence === 'string' ? extractFirstUrl(finding.evidence) : '') ||
    ''
  )
}

function _hostnameOf(urlOrHost) {
  if (!urlOrHost) return ''
  try {
    return new URL(urlOrHost).hostname.toLowerCase()
  } catch {
    // Already a bare hostname (no scheme)? Trim path/port noise.
    return String(urlOrHost).toLowerCase().replace(/^[a-z]+:\/\//, '').split('/')[0].split(':')[0]
  }
}

function _matchesPattern(host, pattern) {
  const h = String(host || '').toLowerCase()
  const p = String(pattern || '').toLowerCase()
  if (!h || !p) return false
  if (p === h) return true
  if (p.startsWith('*.')) {
    const suffix = p.slice(1) // ".support.motorola.com"
    return h.endsWith(suffix) && h.length > suffix.length
  }
  return false
}

function validateFindingScope(finding, scope) {
  const url = _resolveUrl(finding)
  if (!url) {
    return { status: SCOPE_STATUS.OUT_OF_SCOPE, reason: 'no URL on finding (fail-safe)' }
  }
  const host = _hostnameOf(url)
  if (!host) {
    return { status: SCOPE_STATUS.OUT_OF_SCOPE, reason: `unparsable URL: ${url.slice(0, 80)}` }
  }
  const inScope = (scope && scope.in_scope) || []
  for (const pattern of inScope) {
    if (_matchesPattern(host, pattern)) {
      const kind = pattern.startsWith('*.') ? 'wildcard' : 'exact match'
      return { status: SCOPE_STATUS.IN_SCOPE, reason: `${kind} → ${pattern}` }
    }
  }
  const deps = (scope && scope.infra_dependencies) || {}
  if (deps[host]) {
    const dependents = deps[host]
    return {
      status: SCOPE_STATUS.INFRA_DEPENDENCY,
      reason: `host ${host} supports in-scope: ${dependents.join(', ')}`,
    }
  }
  return {
    status: SCOPE_STATUS.OUT_OF_SCOPE,
    reason: `host ${host} not in scope list, no infra dependency`,
  }
}

function annotateFindings(findings, scope) {
  if (!Array.isArray(findings)) return []
  return findings.map(f => {
    const { status, reason } = validateFindingScope(f, scope)
    return { ...f, scope_status: status, scope_reason: reason }
  })
}

function summarize(annotatedFindings) {
  const counts = { in_scope: 0, infra_dependency: 0, out_of_scope: 0 }
  for (const f of annotatedFindings || []) {
    if (f.scope_status === SCOPE_STATUS.IN_SCOPE) counts.in_scope += 1
    else if (f.scope_status === SCOPE_STATUS.INFRA_DEPENDENCY) counts.infra_dependency += 1
    else counts.out_of_scope += 1
  }
  return counts
}

module.exports = {
  SCOPE_STATUS,
  validateFindingScope,
  annotateFindings,
  summarize,
}
