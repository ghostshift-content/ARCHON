// agents/prod-endpoint-validator.js
//
// 2026-05-15: Catches findings that claim PRODUCTION impact but validated
// against sandbox/test/uat/dev endpoints. Q#8 surfaced this hard:
// F-002 was titled "PROD PayPal CRITICAL", but KRIPA's actual probe hit
// api.sandbox.paypal.com — Jay tested api.paypal.com and got
// invalid_client. The framework's "9 confirmed" claim was inflated because
// nobody checked "is the validation endpoint actually production?"
//
// This module classifies each URL by environment kind (production /
// sandbox / uat / staging / test / dev) and flags Critical/High findings
// whose validation endpoint is NOT production.
//
// Conservative default: hostnames with no explicit non-prod signal are
// treated as production. We only flag explicit mismatches.

'use strict'

const ENDPOINT_KIND = Object.freeze({
  PRODUCTION: 'production',
  SANDBOX: 'sandbox',
  UAT: 'uat',
  STAGING: 'staging',
  TEST: 'test',
  DEV: 'dev',
})

// Hostname-pattern signals, checked in priority order.
// Each entry: [regex, kind, signal].
const HOST_PATTERNS = [
  [/(^|[.-])sandbox([.-]|$)/i, ENDPOINT_KIND.SANDBOX, 'sandbox token in host'],
  [/(^|[.-])sb([.-]|$)/i, ENDPOINT_KIND.SANDBOX, 'sb token in host'],
  [/(^|[.-])uat([.-]|$)/i, ENDPOINT_KIND.UAT, 'uat token in host'],
  [/(^|[.-])(staging|stage)([.-]|$)/i, ENDPOINT_KIND.STAGING, 'staging token in host'],
  [/(^|[.-])test([.-]|$)/i, ENDPOINT_KIND.TEST, 'test token in host'],
  [/(^|[.-])dev([.-]|$)/i, ENDPOINT_KIND.DEV, 'dev token in host'],
  [/(^|[.-])qa([.-]|$)/i, ENDPOINT_KIND.TEST, 'qa token in host'],
]

// Path-pattern signals — only fire when the path explicitly carries a
// non-prod marker. Avoids false positives on URLs like /api/test-suite
// where "test-suite" is a real path segment.
const PATH_PATTERNS = [
  [/\/sandbox(\/|$|\?)/i, ENDPOINT_KIND.SANDBOX, 'sandbox in path'],
]

function _hostnameOf(url) {
  if (!url) return ''
  try { return new URL(url).hostname.toLowerCase() } catch {
    return String(url).toLowerCase().replace(/^[a-z]+:\/\//, '').split('/')[0].split(':')[0]
  }
}

function _pathnameOf(url) {
  if (!url) return ''
  try { return new URL(url).pathname.toLowerCase() } catch { return '' }
}

function classifyEndpoint(url) {
  if (!url) return { kind: ENDPOINT_KIND.PRODUCTION, signal: 'no url — default production' }
  const host = _hostnameOf(url)
  const path = _pathnameOf(url)
  for (const [re, kind, sig] of HOST_PATTERNS) {
    if (re.test(host)) return { kind, signal: sig }
  }
  for (const [re, kind, sig] of PATH_PATTERNS) {
    if (re.test(path)) return { kind, signal: sig }
  }
  return { kind: ENDPOINT_KIND.PRODUCTION, signal: 'no non-prod signal detected' }
}

const HIGH_SEVERITY = new Set(['critical', 'high'])

function _claimsProd(finding) {
  // "PROD" appearing in title or details indicates the finding ASSERTS
  // production impact. When combined with a non-prod validation endpoint,
  // that's a mismatch worth flagging.
  const text = ((finding && finding.title) || '') + ' ' + ((finding && finding.details) || '')
  return /\bprod(uction)?\b/i.test(text)
}

function auditFinding(finding) {
  const sev = String((finding && finding.severity) || '').toLowerCase()
  const url = (finding && (finding.url || finding.affected_url)) || ''
  const ep = classifyEndpoint(url)
  const isCriticalOrHigh = HIGH_SEVERITY.has(sev)
  const claimsProd = _claimsProd(finding)
  const isProdEndpoint = ep.kind === ENDPOINT_KIND.PRODUCTION

  // Warn when: (a) severity is Critical/High AND (b) endpoint is non-prod.
  // The title-claims-PROD check adds context to the reason but isn't a
  // gate — Critical severity against sandbox is suspicious regardless.
  const warn = isCriticalOrHigh && !isProdEndpoint
  const reasonParts = []
  if (warn) {
    reasonParts.push(`severity=${sev}`)
    reasonParts.push(`endpoint=${ep.kind} (${ep.signal})`)
    if (claimsProd) reasonParts.push('title claims PROD')
  }
  return {
    ...finding,
    prod_validation_kind: ep.kind,
    prod_validation_signal: ep.signal,
    prod_validation_warning: warn,
    prod_validation_reason: warn ? reasonParts.join(' | ') : '',
  }
}

function auditFindings(findings) {
  if (!Array.isArray(findings)) return []
  return findings.map(auditFinding)
}

function summarize(audited) {
  let warnings = 0
  let clean = 0
  for (const f of audited || []) {
    if (f.prod_validation_warning) warnings += 1
    else clean += 1
  }
  return { warnings, clean }
}

module.exports = {
  ENDPOINT_KIND,
  classifyEndpoint,
  auditFinding,
  auditFindings,
  summarize,
}
