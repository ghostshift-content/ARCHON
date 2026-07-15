'use strict'
// M2: agent registry — descriptive lookups over agent-registry.json. Maps EXISTING agent names to clean
// roles/specialties/modes so the new architecture (task board, session planner, UI) can reason about who does
// what, WITHOUT renaming or removing any agent. Fail-soft + mtime-cached (same discipline as pattern-catalog).
// Observe-only: nothing here changes execution.

const fs = require('fs')
const path = require('path')

const REGISTRY_FILE = path.join(__dirname, 'agent-registry.json')

let _cache = null // { mtime, data }
function _load() {
  try {
    const mtime = fs.statSync(REGISTRY_FILE).mtimeMs
    if (_cache && _cache.mtime === mtime) return _cache.data
    const json = JSON.parse(fs.readFileSync(REGISTRY_FILE, 'utf8'))
    const data = json.agents || {}
    _cache = { mtime, data }
    return data
  } catch { return (_cache && _cache.data) || {} }
}

const _up = (n) => String(n || '').toUpperCase()

// full record for an agent, or null
function get(name) { return _load()[_up(name)] || null }
// clean role for an agent (mission_lead | specialist | freehand_reviewer | recon_mapper | runtime_validator | triage | auditor | judge | reporter | coordination), or null
function roleOf(name) { const a = get(name); return a ? a.role : null }
function specialtiesOf(name) { const a = get(name); return (a && a.specialties) || [] }
function modesOf(name) { const a = get(name); return (a && a.modes) || [] }
// all agent names
function all() { return Object.keys(_load()) }
// agents whose role matches
function byRole(role) { const d = _load(); return Object.keys(d).filter((n) => d[n].role === role) }
// agents that list this vuln class / specialty (optionally restricted to a mode). Descriptive only.
function agentsForClass(cls, mode) {
  const d = _load(); const c = String(cls || '').toLowerCase()
  return Object.keys(d).filter((n) => (d[n].specialties || []).some((s) => String(s).toLowerCase() === c) && (!mode || (d[n].modes || []).includes(mode)))
}

module.exports = { get, roleOf, specialtiesOf, modesOf, all, byRole, agentsForClass, REGISTRY_FILE }

// self-check
if (require.main === module) {
  const assert = require('node:assert')
  assert.strictEqual(roleOf('curator'), 'mission_lead')
  assert.strictEqual(roleOf('MARSHAL'), 'specialist')
  assert.strictEqual(roleOf('quill'), 'freehand_reviewer')
  assert.ok(specialtiesOf('cipher').includes('xss'))
  assert.ok(byRole('reporter').includes('SCRIBE'))
  assert.ok(agentsForClass('xss').includes('CIPHER'))
  assert.strictEqual(get('nope'), null)
  assert.ok(all().length >= 20)
  console.log('ok — agent registry: role/specialty/mode lookups over the existing roster')
}
