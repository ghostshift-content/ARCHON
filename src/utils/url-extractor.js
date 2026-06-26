// /root/agents/url-extractor.js
//
// Extract a single target URL from a dispatch.
// Replaces three duplicated regex sites in event-bus.js (lines 3731, 6066, 7560).
//
// Priority order (2026-05-09 — round-8 motorola.com fix):
//   1. dispatch.config.target_url  — canonical, set by dispatcher
//   2. dispatch.config.target      — legacy alias
//   3. Scheme-prefixed URL anywhere in taskTitle/description/goal
//      (first scheme-prefixed match wins, left-to-right)
//   4. Bare-domain match against TLD allowlist in title/description/goal
//      (bare matches get `https://` prefix; banking targets are HTTPS-only)
//   5. null if nothing matches.
//
// Round-8 regression (2026-05-09):
//   Title "...validation on motorola.com" + config {target_url:
//   "https://support.motorola.com"} previously extracted bare 'motorola.com'
//   from the title, EKLAVYA crawled the wrong host, wasted ~15 min.
//   Now config.target_url wins. Title extraction is a fallback only.
//
// Trailing punctuation (`,`, `)`, `.`) is stripped from the matched URL.

const SCHEME_RE = /https?:\/\/[^\s'"<>)]+/i
const BARE_RE = /\b[\w.-]+\.(?:com|net|org|io|dev|app|xyz|co|ae|sa)\b/i

function extractTargetUrl(dispatch) {
  if (!dispatch || typeof dispatch !== 'object') return null

  // Priority 1+2: config.target_url > config.target.
  // We accept either a full URL (scheme present) OR a bare domain (gets
  // https:// prefix for consistency with the title-fallback path).
  const cfg = dispatch.config || {}
  const cfgCandidates = [cfg.target_url, cfg.target]
  for (const raw of cfgCandidates) {
    if (typeof raw !== 'string') continue
    const trimmed = raw.trim()
    if (!trimmed) continue
    // Already a scheme URL — return verbatim (after punct strip).
    if (/^https?:\/\//i.test(trimmed)) {
      return _stripPunct(trimmed)
    }
    // Bare domain in config — promote to https:// (mirrors title fallback).
    if (BARE_RE.test(trimmed)) {
      const m = trimmed.match(BARE_RE)
      return `https://${_stripPunct(m[0])}`
    }
    // Non-empty but unrecognized — skip to next candidate. (Don't pollute
    // downstream callers with malformed config strings.)
  }

  // Priority 3+4: fall back to title/description/goal extraction
  // (preserves backwards compat for legacy dispatches without config).
  const parts = [
    dispatch.taskTitle || dispatch.title || '',
    dispatch.description || '',
    dispatch.goal || '',
  ]
  const combined = parts.filter(Boolean).join(' ')
  if (!combined) return null

  const schemeMatch = combined.match(SCHEME_RE)
  if (schemeMatch) {
    return _stripPunct(schemeMatch[0])
  }
  const bareMatch = combined.match(BARE_RE)
  if (bareMatch) {
    return `https://${_stripPunct(bareMatch[0])}`
  }
  return null
}

function _stripPunct(url) {
  return url.replace(/[,).]+$/, '')
}

module.exports = { extractTargetUrl }
