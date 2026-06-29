// src/pipeline/outcome-classifier.js
//
// Every probe attempt gets a typed outcome — even failures are signal the agent
// adapts on (a 403/challenge means "try a WAF bypass", not "give up"). Pure.
//
// classes: success | sanitized | blocked | rate-limited | error | inconclusive

'use strict'

const OUTCOMES = ['success', 'sanitized', 'blocked', 'rate-limited', 'error', 'inconclusive']

const RATE_RE = /rate.?limit|too many requests|429|slow down|retry-after/i
const BLOCK_RE = /\bblocked\b|access denied|forbidden|cf-mitigated|__cf_chl|cloudflare|akamaighost|incident id|imperva|request unsuccessful|web application firewall|\bwaf\b|captcha|challenge/i

// deps/signals: { status, body, error, markerPresent }
//   status        — HTTP status (number) if known
//   body          — response body / agent output snippet
//   error         — truthy if the request itself failed (network/timeout)
//   markerPresent — true if the injected marker/nonce executed/reflected (proof),
//                   false if a 200 came back without it, undefined if unknown
function classifyOutcome({ status, body, error, markerPresent } = {}) {
  if (error) return 'error'
  const text = String(body || '')
  const code = Number(status)

  if (code === 429 || RATE_RE.test(text)) return 'rate-limited'
  if (code === 403 || code === 406 || code === 401 || BLOCK_RE.test(text)) return 'blocked'

  if (markerPresent === true) return 'success'
  if (markerPresent === false) return 'sanitized' // got a response, payload neutralized
  return 'inconclusive'
}

// Tally a list of attempts (each {status,body,error,markerPresent}) → counts by class.
function tallyOutcomes(attempts = []) {
  const counts = Object.fromEntries(OUTCOMES.map(o => [o, 0]))
  for (const a of attempts || []) counts[classifyOutcome(a)]++
  return counts
}

module.exports = { OUTCOMES, classifyOutcome, tallyOutcomes }
