'use strict'

// Cross-engagement memory contains sanitized strategy outcomes only. Target
// identifiers, source, credentials, evidence, requests, responses, and findings
// are rejected rather than redacted ambiguously.

const fs = require('fs')
const path = require('path')
const agentPaths = require('../../paths')

const FORBIDDEN = /target|host|url|source|file|path|credential|token|cookie|request|response|evidence|finding|payload|secret|username|password/i
const ALLOWED = new Set([
  'schema_version', 'recorded_at', 'mode', 'strategy', 'skill_family',
  'technology_family', 'outcome', 'duration_bucket', 'cost_bucket',
  'coverage_delta', 'success_rate', 'sample_count', 'notes',
])

function memoryPath(dir) { return path.join(dir || agentPaths.INTEL_ROOT, 'strategy-memory.jsonl') }
function sanitize(input = {}) {
  const out = { schema_version: '1', recorded_at: new Date().toISOString() }
  for (const [key, value] of Object.entries(input)) {
    if (!ALLOWED.has(key) || FORBIDDEN.test(key)) continue
    if (typeof value === 'string') out[key] = value.slice(0, 160)
    else if (typeof value === 'number' && Number.isFinite(value)) out[key] = value
    else if (typeof value === 'boolean') out[key] = value
  }
  if (!out.mode || !out.skill_family || !out.outcome) return null
  return out
}
function append(input, dir) {
  const record = sanitize(input)
  if (!record) return false
  const file = memoryPath(dir)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.appendFileSync(file, JSON.stringify(record) + '\n')
  return record
}
function load(dir) {
  try {
    return fs.readFileSync(memoryPath(dir), 'utf8').split('\n').filter(Boolean)
      .map(line => { try { return sanitize(JSON.parse(line)) } catch { return null } }).filter(Boolean)
  } catch { return [] }
}
function rank(mode, skillFamilies = [], dir) {
  const rows = load(dir).filter(row => row.mode === mode && skillFamilies.includes(row.skill_family))
  const score = new Map(skillFamilies.map(id => [id, 0]))
  for (const row of rows) {
    const delta = row.outcome === 'success' ? 2 : row.outcome === 'no_issue' ? 0.25 : row.outcome === 'failed' ? -1 : 0
    score.set(row.skill_family, (score.get(row.skill_family) || 0) + delta)
  }
  return [...skillFamilies].sort((a, b) => (score.get(b) || 0) - (score.get(a) || 0) || a.localeCompare(b))
}

module.exports = { FORBIDDEN, ALLOWED, memoryPath, sanitize, append, load, rank }
