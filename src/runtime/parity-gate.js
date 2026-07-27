'use strict'

function _set(values) { return new Set((values || []).map(String)) }
function _diff(a, b) { return [...a].filter(value => !b.has(value)) }
function compare(legacy = {}, candidate = {}) {
  const dimensions = {}
  for (const key of ['task_keys', 'candidate_keys', 'evidence_refs', 'finding_keys', 'status_keys']) {
    const a = _set(legacy[key]); const b = _set(candidate[key])
    dimensions[key] = { missing: _diff(a, b), unexpected: _diff(b, a) }
  }
  for (const key of ['coverage_complete', 'report_eligible']) {
    dimensions[key] = { legacy: Boolean(legacy[key]), candidate: Boolean(candidate[key]), match: Boolean(legacy[key]) === Boolean(candidate[key]) }
  }
  const failures = Object.entries(dimensions).filter(([, row]) =>
    row.match === false || (row.missing && row.missing.length) || (row.unexpected && row.unexpected.length))
  return { pass: failures.length === 0, dimensions, failures: failures.map(([key]) => key) }
}

module.exports = { compare }
