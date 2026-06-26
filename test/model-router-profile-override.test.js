// test/model-router-profile-override.test.js
//
// Verifies model-router.js consults agents/model-config.js for MODEL_PROFILE
// overrides BEFORE applying its normal routing logic.
//
// Part of G4 Phase 1 build (Task 2/6).

const assert = require('node:assert')
const { test } = require('node:test')
const modelRouter = require('../src/routing/model-router')

function withProfile(profile, fn) {
  const orig = process.env.MODEL_PROFILE
  try {
    if (profile === undefined) delete process.env.MODEL_PROFILE
    else process.env.MODEL_PROFILE = profile
    modelRouter.resetCache()
    return fn()
  } finally {
    if (orig === undefined) delete process.env.MODEL_PROFILE
    else process.env.MODEL_PROFILE = orig
    modelRouter.resetCache()
  }
}

test('default profile (env unset) — modelRouter normal routing applies', () => {
  withProfile(undefined, () => {
    const result = modelRouter.getModelForAgent('ATLAS')
    assert.ok(result.model, 'returns a model')
    assert.notStrictEqual(result.family, 'profile_override',
      'should NOT use profile_override family when MODEL_PROFILE unset')
  })
})

test('default profile explicit — modelRouter normal routing applies', () => {
  withProfile('default', () => {
    const result = modelRouter.getModelForAgent('ATLAS')
    assert.notStrictEqual(result.family, 'profile_override',
      'default profile is empty; should fall through to modelRouter')
  })
})

test('G4_test_sonnet — ATLAS gets Sonnet via profile override', () => {
  withProfile('G4_test_sonnet', () => {
    const result = modelRouter.getModelForAgent('ATLAS')
    assert.strictEqual(result.model, 'claude-sonnet-4-6',
      'ATLAS should be Sonnet under G4_test_sonnet profile')
    assert.strictEqual(result.family, 'profile_override',
      'family should be profile_override marker')
    assert.match(result.reason, /^profile:G4_test_sonnet$/)
  })
})

test('G4_test_sonnet — SENTRY falls through to normal routing (not in profile)', () => {
  withProfile('G4_test_sonnet', () => {
    const result = modelRouter.getModelForAgent('SENTRY')
    assert.notStrictEqual(result.family, 'profile_override',
      'SENTRY is not in G4_test_sonnet — should use modelRouter normal routing')
  })
})

test('G4_test_sonnet — SCRIBE falls through (not in profile)', () => {
  withProfile('G4_test_sonnet', () => {
    const result = modelRouter.getModelForAgent('SCRIBE')
    assert.notStrictEqual(result.family, 'profile_override')
  })
})

test('Unknown profile — falls through to normal routing', () => {
  withProfile('nonexistent_profile', () => {
    const result = modelRouter.getModelForAgent('ATLAS')
    assert.notStrictEqual(result.family, 'profile_override',
      'unknown profile returns null override → normal routing')
  })
})

test('Profile override is case-insensitive on agent name', () => {
  withProfile('G4_test_sonnet', () => {
    const upper = modelRouter.getModelForAgent('ATLAS')
    const lower = modelRouter.getModelForAgent('atlas')
    assert.strictEqual(upper.model, 'claude-sonnet-4-6')
    assert.strictEqual(lower.model, 'claude-sonnet-4-6')
  })
})
