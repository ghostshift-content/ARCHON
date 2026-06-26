// agents/squad-config-loader.js
//
// Per-squad operational config loader. Reads agents/squads/{squad}/squad.json
// and provides a validated, cached config object.
//
// This is the first step toward consolidating hardcoded operational knobs
// (model tiers, severity profiles, effort levels, enabled phases) that are
// currently scattered across squad-framework.js, model-router.js,
// severity-profile.js, and event-bus.js.
//
// Spec: docs/research/2026-06-03-archon-THE-FRAMEWORK.md
// Built: 2026-06-05 (B5 — squad.yaml configs slice)

'use strict'

const fs = require('fs')
const path = require('path')

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PRODUCTION_SQUADS = ['pentest', 'stocks', 'cloud-security', 'network-pentest', 'code-review']

const SQUADS_DIR = path.join(__dirname, 'squads')

const VALID_MODEL_TIERS = new Set(['fast', 'balanced', 'powerful'])
const VALID_EFFORT_LEVELS = new Set(['low', 'medium', 'high', 'xhigh', 'max'])

// Required top-level fields for a valid config
const REQUIRED_FIELDS = ['squad', 'version', 'leader', 'modelTier', 'effort']

// ---------------------------------------------------------------------------
// In-process cache
// ---------------------------------------------------------------------------

/** @type {Map<string, object>} */
const _cache = new Map()

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/**
 * Validates a parsed squad config object.
 * Throws with a descriptive message if validation fails.
 *
 * @param {object} cfg - parsed JSON object
 * @param {string} squad - expected squad name (for error context)
 */
function _validate(cfg, squad) {
  if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) {
    throw new Error(`squad.json for "${squad}" is not a JSON object`)
  }

  for (const field of REQUIRED_FIELDS) {
    if (cfg[field] === undefined || cfg[field] === null || cfg[field] === '') {
      throw new Error(`squad.json for "${squad}" is missing required field: "${field}"`)
    }
  }

  if (typeof cfg.squad !== 'string') {
    throw new Error(`squad.json for "${squad}": "squad" must be a string`)
  }

  if (typeof cfg.leader !== 'string' || !cfg.leader.trim()) {
    throw new Error(`squad.json for "${squad}": "leader" must be a non-empty string`)
  }

  if (!VALID_MODEL_TIERS.has(cfg.modelTier)) {
    throw new Error(
      `squad.json for "${squad}": "modelTier" must be one of ${[...VALID_MODEL_TIERS].join('|')}, got "${cfg.modelTier}"`
    )
  }

  if (!VALID_EFFORT_LEVELS.has(cfg.effort)) {
    throw new Error(
      `squad.json for "${squad}": "effort" must be one of ${[...VALID_EFFORT_LEVELS].join('|')}, got "${cfg.effort}"`
    )
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Load and validate a single squad's config.
 * Result is cached in-process by squad name.
 *
 * @param {string} squad - squad name (e.g. 'pentest', 'stocks', 'cloud-security')
 * @returns {object} validated config object
 * @throws {Error} if the file is missing, unparseable, or fails validation
 */
function loadSquadConfig(squad) {
  if (!squad || typeof squad !== 'string') {
    throw new Error(`loadSquadConfig: squad must be a non-empty string, got: ${JSON.stringify(squad)}`)
  }

  if (_cache.has(squad)) {
    return _cache.get(squad)
  }

  const filePath = path.join(SQUADS_DIR, squad, 'squad.json')

  if (!fs.existsSync(filePath)) {
    throw new Error(
      `No squad config found for "${squad}". Expected: ${filePath}. Known production squads: ${PRODUCTION_SQUADS.join(', ')}.`
    )
  }

  let raw
  try {
    raw = fs.readFileSync(filePath, 'utf-8')
  } catch (e) {
    throw new Error(`Failed to read squad config for "${squad}" at ${filePath}: ${e.message}`)
  }

  let cfg
  try {
    cfg = JSON.parse(raw)
  } catch (e) {
    throw new Error(`Failed to parse squad.json for "${squad}" at ${filePath}: ${e.message}`)
  }

  _validate(cfg, squad)

  // Freeze to prevent accidental mutation of the cached object
  const frozen = Object.freeze(cfg)
  _cache.set(squad, frozen)
  return frozen
}

/**
 * Load all 5 production squad configs.
 * Fail-soft: a missing or invalid config yields null for that squad rather
 * than throwing. The caller can check for nulls.
 *
 * @returns {object} map of squad name → config object (or null on error)
 */
function getAllSquadConfigs() {
  const result = {}
  for (const squad of PRODUCTION_SQUADS) {
    try {
      result[squad] = loadSquadConfig(squad)
    } catch (e) {
      result[squad] = null
    }
  }
  return result
}

/**
 * Clear the in-process cache. Intended for tests and hot-reload scenarios.
 */
function clearCache() {
  _cache.clear()
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  PRODUCTION_SQUADS,
  loadSquadConfig,
  getAllSquadConfigs,
  clearCache,
}
