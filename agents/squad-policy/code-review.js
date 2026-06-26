// agents/squad-policy/code-review.js
'use strict'
const path = require('path')

const SEVERITY_MAP = Object.freeze({
  critical: 9.0, high: 7.5, medium: 5.0, low: 3.0, info: 1.0,
})

function extractTarget(dispatch) {
  return (dispatch && (dispatch.sourceDir || dispatch.target)) || null
}

function matchesScope(targetPath, scope) {
  if (!targetPath || !scope || !Array.isArray(scope.in_scope)) return false
  const normalized = path.resolve(targetPath)
  return scope.in_scope.some(allowed => {
    const allowedAbs = path.resolve(allowed)
    return normalized === allowedAbs || normalized.startsWith(allowedAbs + path.sep)
  })
}

function cvssOf(finding) {
  const sev = String((finding && finding.severity) || '').toLowerCase()
  return SEVERITY_MAP[sev] || 0
}

module.exports = { squad: 'code-review', extractTarget, matchesScope, cvssOf, SEVERITY_MAP }
