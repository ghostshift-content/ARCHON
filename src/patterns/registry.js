'use strict'
// M3: pattern registry + COMPATIBILITY loader. Layers new drop-in packs (src/patterns/builtin + custom) ON TOP
// of the existing catalog (common/patterns/*.json + index.json + the markdown catalogs) via src/intel/pattern-
// catalog.js. The legacy catalog stays the source of truth and keeps loading unchanged.
//
// INVARIANT: with no builtin/custom packs, classes()/patternsFor()/catalogPathsFor() return EXACTLY the legacy
// values. Custom-pack parse/validation errors are logged-and-skipped — they NEVER crash a scan (fail-soft).
//
// New-patterns root is env-overridable (ARCHON_PATTERNS_ROOT) for tests; defaults to <repo>/src/patterns.

const fs = require('fs')
const path = require('path')
const agentPaths = require('../../paths')
const legacy = require('../intel/pattern-catalog')

const NEW_ROOT = process.env.ARCHON_PATTERNS_ROOT || path.join(agentPaths.AGENTS_ROOT, 'src', 'patterns')
const BUILTIN_DIR = path.join(NEW_ROOT, 'builtin')
const CUSTOM_DIR = path.join(NEW_ROOT, 'custom')
const LEGACY_INDEX = path.join(agentPaths.AGENTS_ROOT, 'common', 'patterns', 'index.json')

const _warned = new Set()
function _warn(file, msg) { const k = file + msg; if (_warned.has(k)) return; _warned.add(k); try { console.warn(`⚠️ pattern-registry: skipping ${path.basename(file)} — ${msg}`) } catch {} }

// legacy class keys (from common/patterns/index.json) — the built-in class list
function _legacyClasses() {
  try { return Object.keys((JSON.parse(fs.readFileSync(LEGACY_INDEX, 'utf8')).classes) || {}) } catch { return [] }
}

// read every *.json under a dir (recursive, fail-soft). Returns [{file, json}].
function _readPacks(dir) {
  const out = []
  let entries; try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return out }
  for (const e of entries) {
    const full = path.join(dir, e.name)
    if (e.isDirectory()) { out.push(..._readPacks(full)); continue }
    if (!e.name.endsWith('.json')) continue
    let json; try { json = JSON.parse(fs.readFileSync(full, 'utf8')) } catch (err) { _warn(full, `invalid JSON (${err.message})`); continue }
    out.push({ file: full, json })
  }
  return out
}

// lightweight, dependency-free validation of one pattern object (matches common/schemas/pattern.schema.json's
// required fields). Fail-soft: returns null for an invalid pattern.
function _validPattern(p) {
  if (!p || typeof p !== 'object') return null
  if (!p.id || !p.name || !p.category) return null
  return p
}

// normalize a pack file to { class, mode, patterns:[...] }. Accepts a pack ({class|category, patterns:[]}) or a
// single pattern object. Invalid patterns are dropped (fail-soft).
function _normalizePack(file, json) {
  const cls = json.class || json.category
  let patterns = Array.isArray(json.patterns) ? json.patterns : (json.id ? [json] : [])
  patterns = patterns.map(_validPattern).filter(Boolean)
  if (!patterns.length) { _warn(file, 'no valid patterns'); return null }
  const packClass = cls || patterns[0].category
  return { class: String(packClass), mode: json.mode === 'override' ? 'override' : 'append', patterns, file }
}

function _newPacksFor(cls) {
  const packs = [..._readPacks(BUILTIN_DIR), ..._readPacks(CUSTOM_DIR)]
    .map((p) => _normalizePack(p.file, p.json)).filter(Boolean)
  return packs.filter((p) => p.class === cls)
}

// ── public API ──────────────────────────────────────────────────────────────

// union of legacy classes + any class that appears only in a new pack (recursive scan)
function classes() {
  const set = new Set(_legacyClasses())
  for (const p of [..._readPacks(BUILTIN_DIR), ..._readPacks(CUSTOM_DIR)]) {
    const n = _normalizePack(p.file, p.json); if (n) set.add(n.class)
  }
  return [...set]
}

// merged pattern list for a class: legacy ids + new packs, deduped by id. An `override` pack REPLACES the legacy
// set for that class; `append` (default) adds after. Returns [{id, name?, category, source}].
function patternsFor(cls) {
  const packs = _newPacksFor(cls)
  const override = packs.find((p) => p.mode === 'override')
  const byId = new Map()
  if (!override) {
    for (const id of (legacy.patternIds(cls) || [])) byId.set(id, { id, category: cls, source: 'legacy' })
  }
  for (const pk of packs) for (const p of pk.patterns) byId.set(p.id, { ...p, source: pk.file.includes(`${path.sep}custom${path.sep}`) ? 'custom' : 'builtin' })
  return [...byId.values()]
}

// just the ids (back-compat shape with legacy.patternIds)
function patternIds(cls) { return patternsFor(cls).map((p) => p.id) }

// catalog paths for a class: the legacy catalog + any new pack files (so audit tooling can point at both)
function catalogPathsFor(cls) {
  const out = []
  const lp = legacy.catalogPathFor(cls); if (lp) out.push(lp)
  for (const p of _newPacksFor(cls)) out.push(p.file)
  return out
}

// look up a single pattern by id across legacy + new
function patternFor(id) {
  const lp = legacy.patternFor(id); if (lp) return lp
  for (const cls of classes()) { const hit = patternsFor(cls).find((p) => p.id === id); if (hit) return hit }
  return null
}

module.exports = { classes, patternsFor, patternIds, catalogPathsFor, patternFor, BUILTIN_DIR, CUSTOM_DIR, NEW_ROOT }

// self-check
if (require.main === module) {
  const assert = require('node:assert')
  const cls = classes()
  assert.ok(cls.includes('xss') && cls.includes('access-control'), 'legacy classes present')
  assert.ok(patternIds('xss').length >= 1, 'xss has patterns')
  assert.deepStrictEqual(patternIds('xss'), legacy.patternIds('xss'), 'no packs ⇒ identical to legacy')
  console.log('ok — pattern registry: legacy catalog + drop-in packs, identical when empty')
}
