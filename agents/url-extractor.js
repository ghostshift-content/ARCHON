// agents/url-extractor.js
//
// Single-purpose: extract first http(s) URL from arbitrary text.
// Used by Phase 3.05 kripa-validated-builder (producer) and Phase 3.06
// scope-validator (consumer fallback). Pentest squad-policy keeps its
// own inline regex for now — gate-covered, not worth churn.
//
// The regex stops at whitespace, quotes, backticks, angle brackets.
// Trailing punctuation (.,;:)]) is trimmed because URLs in prose
// frequently end with sentence terminators that aren't part of the URL.
//
// NOTE: this is distinct from /root/agents/url-extractor.js (top-level,
// extractTargetUrl) which extracts a canonical target URL from a dispatch
// object via priority order. Different API, different concern — kept
// separate to avoid coupling Phase 0/3.06 routing with Phase 3.05 producer
// emission.

'use strict'

const URL_REGEX = /https?:\/\/[^\s'"`<>\[\]]+/i
const TRAILING_PUNCT = /[.,;:)\]}>]+$/

function extractFirstUrl(text) {
  if (typeof text !== 'string' || text.length === 0) return ''
  const match = text.match(URL_REGEX)
  if (!match) return ''
  return match[0].replace(TRAILING_PUNCT, '')
}

module.exports = { extractFirstUrl, URL_REGEX }
