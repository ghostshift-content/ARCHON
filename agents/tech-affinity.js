// agents/tech-affinity.js
//
// Tech-affinity model demotion for cost optimization. When the detected tech
// stack DOES NOT include an agent's primary affinity, demote the model family
// (e.g. Sonnet → Haiku) so the specialist still runs but cheaper.
//
// IMPORTANT: This module NEVER changes whether a specialist runs — only WHICH
// MODEL they use. The "Target profile NEVER restricts specialist roster"
// invariant (event-bus.js:4901) is preserved. Hard gating on tech-fingerprint
// risks missing findings when detection is wrong (minified bundles, polyglot
// apps, hidden routes). Soft demotion captures ~70% of the cost savings with
// minimal blast radius if the fingerprint is incomplete.
//
// Off by default at the event-bus integration layer — requires explicit
// archon_TECH_GATING=enabled to take effect. This module's pure-fn
// behavior is unconditional so tests can run without the env flag.

'use strict'

// Each entry: requires_any[] — if ANY listed stack is in detected, NO demote.
// If NONE listed stack is in detected, demote to target_family.
// Agents not in this map are treated as universal (no affinity, no demote).
const AFFINITY_MAP = Object.freeze({
  // PHP-specific specialists
  drill: { requires_any: ['PHP'], target_family: 'fast' },
  // Java-specific specialists
  relay: { requires_any: ['Java'], target_family: 'fast' },
  // Add more as the roster evolves. Conservative bias: only encode CLEAR
  // tech-affinity. When in doubt, leave the agent off the map (universal).
})

// Agents that must NEVER demote regardless of detected stack. Mirrors the
// modelRouter deny_family_downgrade_for floor. Verification/validation
// agents need full Sonnet/Opus reasoning to keep error rates down.
const PROTECTED_AGENTS = new Set([
  'sentry', 'arbiter', 'auditor', 'scribe', 'atlas', 'nexus',
])

function _norm(s) { return String(s || '').toLowerCase().trim() }

function computeAffinityDowngrade(agentName, detectedStacks) {
  const agent = _norm(agentName)
  if (PROTECTED_AGENTS.has(agent)) {
    return { demote: false, reason: 'protected-agent' }
  }
  const affinity = AFFINITY_MAP[agent]
  if (!affinity) {
    return { demote: false, reason: 'no-affinity-defined-treat-as-universal' }
  }
  // Fail-safe: empty detection should NOT demote (fingerprint may be incomplete).
  if (!Array.isArray(detectedStacks) || detectedStacks.length === 0) {
    return { demote: false, reason: 'empty-detection-fail-safe' }
  }
  // Case-insensitive stack match
  const detectedLower = detectedStacks.map(_norm)
  const matches = affinity.requires_any.some(req => detectedLower.includes(_norm(req)))
  if (matches) {
    return { demote: false, reason: `stack-match:${affinity.requires_any.join('|')}` }
  }
  return {
    demote: true,
    target_family: affinity.target_family,
    reason: `affinity:${affinity.requires_any.join('|')}-not-in-detected:${detectedStacks.join(',')}`,
  }
}

module.exports = {
  AFFINITY_MAP,
  PROTECTED_AGENTS,
  computeAffinityDowngrade,
}
