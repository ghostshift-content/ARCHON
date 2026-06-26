// agents/model-config.js
//
// MODEL_PROFILE override registry — sits ABOVE model-router.js to support
// experiments like G4 multi-model test without disrupting modelRouter's
// existing role-based + complexity-based routing logic.
//
// How it works:
//   1. model-router.js's getModelForAgent() calls getProfileOverride() FIRST
//   2. If MODEL_PROFILE env is set AND that profile defines this agent → return the override
//   3. Otherwise return null → modelRouter falls through to its normal routing
//
// Adding a new profile: insert a new key in PROFILES with agent→model mappings.
// Empty profile object = no overrides (modelRouter handles everything).
//
// Spec: docs/superpowers/specs/2026-05-06-G4-multi-model-test-design.md
// Plan: docs/superpowers/plans/2026-05-06-G4-multi-model-test-plan.md

const PROFILES = Object.freeze({
  // Default profile = no overrides (use modelRouter's normal logic)
  default: Object.freeze({}),

  // G4 experiment: KRISHNA only swap to Sonnet, everything else default
  G4_test_sonnet: Object.freeze({
    krishna: 'claude-sonnet-4-6',
  }),
})

/**
 * Returns the model override for an agent under the current/specified profile,
 * or null if no override applies (caller should fall through to default routing).
 *
 * @param {string} agent - agent name (case-insensitive, e.g. 'KRISHNA' or 'krishna')
 * @param {string} [profile] - profile name; defaults to process.env.MODEL_PROFILE or 'default'
 * @returns {string|null} model name (e.g. 'claude-sonnet-4-6') or null
 */
function getProfileOverride(agent, profile) {
  const profileName = profile || process.env.MODEL_PROFILE || 'default'
  if (!PROFILES[profileName]) {
    // Unknown profile — caller's MODEL_PROFILE env is invalid; fall through to default
    return null
  }
  const agentKey = String(agent || '').toLowerCase()
  return PROFILES[profileName][agentKey] || null
}

module.exports = { PROFILES, getProfileOverride }
