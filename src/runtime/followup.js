'use strict'
// F11: follow-up classification. A discovery during review is NOT automatically a new feature. Typing it stops
// the "map nonexistent files forever" loop: only NEW_FEATURE enters feature mapping; a missing symbol/file first
// triggers repo-wide resolution, and if truly absent becomes a SOURCE_COVERAGE_GAP on the affected feature.

const fs = require('fs')
const path = require('path')

const TYPES = Object.freeze(['NEW_FEATURE', 'MISSING_DEPENDENCY', 'SHARED_CONTROL', 'SOURCE_COVERAGE_GAP', 'LIVE_VALIDATION_TASK', 'ATTACK_CHAIN_LEAD'])

// Only a genuine NEW_FEATURE is added to the feature queue for mapping.
function entersFeatureMapping(type) { return type === 'NEW_FEATURE' }

// Classify a follow-up. Accepts { kind?, name, reason?, feature?, needs_runtime? }. An explicit valid `kind`
// wins; else infer from the name/reason.
function classify(fu = {}) {
  const k = String(fu.kind || '').toUpperCase()
  if (TYPES.includes(k)) return k
  const name = String(fu.name || fu.symbol || '').trim()
  const reason = String(fu.reason || '').toLowerCase()
  if (fu.needs_runtime || /runtime|live|request\/response|exploit|reproduc/.test(reason)) return 'LIVE_VALIDATION_TASK'
  if (/chain|combine|pivot|escalat/.test(reason)) return 'ATTACK_CHAIN_LEAD'
  // a capitalized class/const or a file path that "isn't here" → a missing dependency, not a feature
  if (/^[A-Z][A-Za-z0-9_]*$/.test(name) || /\.(rb|py|js|ts|go|java|php)$/.test(name) || /missing|not found|undefined|absent|referenced/.test(reason)) return 'MISSING_DEPENDENCY'
  if (/middleware|application_?controller|auth|tenancy|config|routing|shared/.test(reason) || /application_?controller/i.test(name)) return 'SHARED_CONTROL'
  if (name) return 'NEW_FEATURE'
  return 'SOURCE_COVERAGE_GAP'
}

// Try to resolve a missing dependency repo-wide (fail-soft). Returns 'resolved' (a file names/defines it) or
// 'coverage_gap' (truly absent → attach to the affected feature; do NOT invent a feature).
function resolveMissingDependency(name, sourceDir) {
  const needle = String(name || '').trim(); if (!needle || !sourceDir) return 'coverage_gap'
  const found = { hit: false }
  const walk = (dir) => {
    if (found.hit) return
    let entries; try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      if (found.hit) return
      const full = path.join(dir, e.name)
      if (e.isDirectory()) { if (!['node_modules', '.git', 'vendor', 'dist', 'build'].includes(e.name)) walk(full); continue }
      if (!/\.(rb|py|js|ts|go|java|php|erb|haml)$/.test(e.name)) continue
      try { if (fs.readFileSync(full, 'utf8').includes(needle)) { found.hit = true; return } } catch {}
    }
  }
  walk(sourceDir)
  return found.hit ? 'resolved' : 'coverage_gap'
}

module.exports = { TYPES, entersFeatureMapping, classify, resolveMissingDependency }

// self-check
if (require.main === module) {
  const assert = require('node:assert')
  assert.strictEqual(classify({ name: 'checkout-flow' }), 'NEW_FEATURE')
  assert.strictEqual(classify({ name: 'ApplicationController' }), 'MISSING_DEPENDENCY')
  assert.strictEqual(classify({ name: 'x', reason: 'needs runtime request/response' }), 'LIVE_VALIDATION_TASK')
  assert.strictEqual(classify({ kind: 'ATTACK_CHAIN_LEAD' }), 'ATTACK_CHAIN_LEAD')
  assert.ok(entersFeatureMapping('NEW_FEATURE') && !entersFeatureMapping('MISSING_DEPENDENCY'))
  console.log('ok — followup: typed classification; only NEW_FEATURE enters mapping; missing deps → resolve/coverage-gap')
}
