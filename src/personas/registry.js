'use strict'
// M4: persona registry. Built-in personas (src/personas/builtin, read-only) + custom (src/personas/custom,
// user/UI-editable). Fail-soft, dependency-free validation. Descriptive/observe-only — a persona shapes planning
// downstream (M8+) but is NEVER a safety bypass, and "no persona" ⇒ current behavior (the 'default' persona).
//
// Root is env-overridable (ARCHON_PERSONAS_ROOT) for tests; defaults to <repo>/src/personas.

const fs = require('fs')
const path = require('path')
const agentPaths = require('../../paths')

const NEW_ROOT = process.env.ARCHON_PERSONAS_ROOT || path.join(agentPaths.AGENTS_ROOT, 'src', 'personas')
const BUILTIN_DIR = path.join(NEW_ROOT, 'builtin')
const CUSTOM_DIR = path.join(NEW_ROOT, 'custom')

const _warned = new Set()
function _warn(file, msg) { const k = file + msg; if (_warned.has(k)) return; _warned.add(k); try { console.warn(`⚠️ persona-registry: skipping ${path.basename(file)} — ${msg}`) } catch {} }

function _readDir(dir, builtin) {
  const out = []
  let entries; try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return out }
  for (const e of entries) {
    const full = path.join(dir, e.name)
    if (e.isDirectory()) { out.push(..._readDir(full, builtin)); continue }
    if (!e.name.endsWith('.json')) continue
    let json; try { json = JSON.parse(fs.readFileSync(full, 'utf8')) } catch (err) { _warn(full, `invalid JSON (${err.message})`); continue }
    if (!json || !json.id || !json.name) { _warn(full, 'missing id/name'); continue }
    out.push({ ...json, id: String(json.id).toLowerCase(), builtin: !!builtin, _file: full })
  }
  return out
}

// custom personas OVERRIDE built-ins of the same id; built-ins are always read-only.
function _all() {
  const map = new Map()
  for (const p of _readDir(BUILTIN_DIR, true)) map.set(p.id, p)
  for (const p of _readDir(CUSTOM_DIR, false)) { const prev = map.get(p.id); map.set(p.id, { ...p, builtin: false, overrides_builtin: !!(prev && prev.builtin) }) }
  return map
}

function all() { return [..._all().values()] }
function builtin() { return all().filter((p) => p.builtin) }
function custom() { return all().filter((p) => !p.builtin) }
function get(id) { return _all().get(String(id || '').toLowerCase()) || null }
function isBuiltin(id) { const p = get(id); return !!(p && p.builtin) }
// the effective persona for a run: an explicit id, else 'default' (⇒ current behavior)
function resolve(id) { return get(id) || get('default') || null }

module.exports = { all, builtin, custom, get, isBuiltin, resolve, BUILTIN_DIR, CUSTOM_DIR, NEW_ROOT }

// self-check
if (require.main === module) {
  const assert = require('node:assert')
  assert.ok(builtin().length >= 6, 'six built-in personas ship')
  assert.strictEqual(get('bug-bounty-hunter').report_style, 'bug_bounty')
  assert.ok(isBuiltin('default'))
  assert.strictEqual(resolve(null).id, 'default', 'no persona ⇒ default (current behavior)')
  console.log('ok — persona registry: 6 built-ins (read-only) + custom overlay, default fallback')
}
