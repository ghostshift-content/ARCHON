// test/squad-config-loader.test.js
// Unit tests for agents/squad-config-loader.js
// Run: bun test test/squad-config-loader.test.js

'use strict'
const __roots = require('../paths') // portable roots (KURU_*_ROOT) — see paths.js


const { test, describe, beforeEach } = require('node:test')
const assert = require('node:assert/strict')

const loader = require((__roots.AGENTS_ROOT + '/agents/squad-config-loader'))

// Always start each test with a clean cache so tests are independent
beforeEach(() => {
  loader.clearCache()
})

describe('loadSquadConfig', () => {
  test('returns correct leader for pentest squad (ATLAS)', () => {
    const cfg = loader.loadSquadConfig('pentest')
    assert.equal(cfg.leader, 'ATLAS', `expected ATLAS, got ${cfg.leader}`)
    assert.equal(cfg.squad, 'pentest')
  })

  test('returns correct leader for stocks squad (CHANAKYA)', () => {
    const cfg = loader.loadSquadConfig('stocks')
    assert.equal(cfg.leader, 'CHANAKYA', `expected CHANAKYA, got ${cfg.leader}`)
    assert.equal(cfg.squad, 'stocks')
  })

  test('throws on unknown squad', () => {
    assert.throws(
      () => loader.loadSquadConfig('nonexistent-squad'),
      /No squad config found for "nonexistent-squad"/
    )
  })

  test('throws on empty squad name', () => {
    assert.throws(
      () => loader.loadSquadConfig(''),
      /squad must be a non-empty string/
    )
  })

  test('throws on null squad name', () => {
    assert.throws(
      () => loader.loadSquadConfig(null),
      /squad must be a non-empty string/
    )
  })

  test('modelTier values are valid (fast|balanced|powerful) for all 5 squads', () => {
    const validTiers = new Set(['fast', 'balanced', 'powerful'])
    for (const squad of loader.PRODUCTION_SQUADS) {
      const cfg = loader.loadSquadConfig(squad)
      assert.ok(
        validTiers.has(cfg.modelTier),
        `Squad "${squad}": modelTier "${cfg.modelTier}" is not valid (must be fast|balanced|powerful)`
      )
    }
  })

  test('effort values are valid for all 5 squads', () => {
    const validEfforts = new Set(['low', 'medium', 'high', 'xhigh', 'max'])
    for (const squad of loader.PRODUCTION_SQUADS) {
      const cfg = loader.loadSquadConfig(squad)
      assert.ok(
        validEfforts.has(cfg.effort),
        `Squad "${squad}": effort "${cfg.effort}" is not valid (must be low|medium|high|xhigh|max)`
      )
    }
  })

  test('all required fields present for each production squad', () => {
    const required = ['squad', 'version', 'leader', 'modelTier', 'effort']
    for (const squad of loader.PRODUCTION_SQUADS) {
      const cfg = loader.loadSquadConfig(squad)
      for (const field of required) {
        assert.ok(cfg[field] !== undefined && cfg[field] !== null && cfg[field] !== '',
          `Squad "${squad}": required field "${field}" is missing or empty`)
      }
    }
  })
})

describe('getAllSquadConfigs', () => {
  test('returns 5 entries with no nulls', () => {
    const all = loader.getAllSquadConfigs()
    const keys = Object.keys(all)
    assert.equal(keys.length, 5, `expected 5 squads, got ${keys.length}: ${keys.join(', ')}`)
    for (const [squad, cfg] of Object.entries(all)) {
      assert.notEqual(cfg, null, `squad "${squad}" config is null — file missing or invalid`)
    }
  })

  test('returns all 5 production squad names', () => {
    const all = loader.getAllSquadConfigs()
    const expected = ['pentest', 'stocks', 'cloud-security', 'network-pentest', 'code-review']
    for (const squad of expected) {
      assert.ok(squad in all, `missing squad "${squad}" from getAllSquadConfigs result`)
    }
  })
})

describe('clearCache + reload', () => {
  test('clearCache allows re-reading — returns same valid config after reload', () => {
    const first = loader.loadSquadConfig('pentest')
    assert.equal(first.leader, 'ATLAS')

    loader.clearCache()

    // After clearing, re-loading should succeed and return same values
    const second = loader.loadSquadConfig('pentest')
    assert.equal(second.leader, 'ATLAS')
    assert.equal(second.squad, 'pentest')
    assert.equal(second.modelTier, first.modelTier)
  })

  test('clearCache + getAllSquadConfigs still returns 5 valid entries', () => {
    // Prime the cache first
    loader.getAllSquadConfigs()

    // Clear and re-load
    loader.clearCache()
    const all = loader.getAllSquadConfigs()
    const nullSquads = Object.entries(all).filter(([, v]) => v === null).map(([k]) => k)
    assert.equal(nullSquads.length, 0, `after clearCache, these squads are null: ${nullSquads.join(', ')}`)
  })
})

describe('PRODUCTION_SQUADS constant', () => {
  test('is an array of 5 elements', () => {
    assert.ok(Array.isArray(loader.PRODUCTION_SQUADS), 'PRODUCTION_SQUADS should be an array')
    assert.equal(loader.PRODUCTION_SQUADS.length, 5)
  })

  test('matches quality-tracker PRODUCTION_SQUADS', () => {
    const qt = require((__roots.AGENTS_ROOT + '/agents/quality-tracker'))
    assert.deepEqual(
      [...loader.PRODUCTION_SQUADS].sort(),
      [...qt.PRODUCTION_SQUADS].sort(),
      'squad-config-loader and quality-tracker PRODUCTION_SQUADS must match'
    )
  })
})
