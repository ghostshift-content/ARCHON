// test/squad-config-loader.test.js
// Unit tests for agents/squad-config-loader.js
// Run: node --test test/squad-config-loader.test.js  (or via npm test)

'use strict'
const __roots = require('../paths') // portable roots (KURU_*_ROOT) — see paths.js

const fs = require('node:fs')
const path = require('node:path')
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

  test('returns correct leader for code-review squad (CURATOR)', () => {
    const cfg = loader.loadSquadConfig('code-review')
    assert.equal(cfg.leader, 'CURATOR', `expected CURATOR, got ${cfg.leader}`)
    assert.equal(cfg.squad, 'code-review')
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

  test('modelTier values are valid (fast|balanced|powerful) for every production squad', () => {
    const validTiers = new Set(['fast', 'balanced', 'powerful'])
    for (const squad of loader.PRODUCTION_SQUADS) {
      const cfg = loader.loadSquadConfig(squad)
      assert.ok(
        validTiers.has(cfg.modelTier),
        `Squad "${squad}": modelTier "${cfg.modelTier}" is not valid (must be fast|balanced|powerful)`
      )
    }
  })

  test('effort values are valid for every production squad', () => {
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
  test('returns one entry per production squad, with no nulls', () => {
    const all = loader.getAllSquadConfigs()
    const keys = Object.keys(all)
    assert.equal(keys.length, loader.PRODUCTION_SQUADS.length,
      `expected ${loader.PRODUCTION_SQUADS.length} squads, got ${keys.length}: ${keys.join(', ')}`)
    for (const [squad, cfg] of Object.entries(all)) {
      assert.notEqual(cfg, null, `squad "${squad}" config is null — file missing or invalid`)
    }
  })

  test('returns exactly the production squad names', () => {
    const all = loader.getAllSquadConfigs()
    for (const squad of loader.PRODUCTION_SQUADS) {
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

  test('clearCache + getAllSquadConfigs still returns valid entries (no nulls)', () => {
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
  test('is a non-empty array', () => {
    assert.ok(Array.isArray(loader.PRODUCTION_SQUADS), 'PRODUCTION_SQUADS should be an array')
    assert.ok(loader.PRODUCTION_SQUADS.length > 0, 'PRODUCTION_SQUADS should be non-empty')
  })

  // Drift guard: the constant must match the squads that actually have a
  // squad.json on disk. Pins PRODUCTION_SQUADS so getAllSquadConfigs can never
  // silently return nulls, and forces the list to be updated when a squad is
  // added or removed. (Replaces the old assertion against the purged
  // agents/quality-tracker module.)
  test('matches the squads that actually have a squad.json on disk', () => {
    const squadsDir = path.join(__roots.AGENTS_ROOT, 'agents', 'squads')
    const onDisk = fs.readdirSync(squadsDir, { withFileTypes: true })
      .filter(d => d.isDirectory())
      .map(d => d.name)
      .filter(name => fs.existsSync(path.join(squadsDir, name, 'squad.json')))
      .sort()
    assert.deepEqual(
      [...loader.PRODUCTION_SQUADS].sort(),
      onDisk,
      'PRODUCTION_SQUADS must match the squad dirs that contain a squad.json'
    )
  })
})
