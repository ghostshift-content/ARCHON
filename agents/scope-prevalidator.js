// agents/scope-prevalidator.js
//
// 2026-05-15: Pre-dispatch scope hard-block. Borrowed pattern from
// bughunter-ai — runs BEFORE any specialist fires. Complements the
// existing post-finding scope-validator.js (shipped 2026-05-15 morning).
//
// Universal across all 5 squads via squadPolicy adapter (pentest /
// cloud-security / network-pentest / code-review / stocks).
//
// Fail-soft when scope config is missing — returns "warned", not
// "blocked". Reason: backward compat with legacy dispatches that
// pre-date the scope-config requirement.

'use strict'

const PREDISPATCH_STATUS = Object.freeze({
  ALLOWED: 'allowed',
  BLOCKED: 'blocked',
  WARNED: 'warned',
})

function validateDispatch(dispatch, squadPolicy, scopeConfig) {
  if (!dispatch || !squadPolicy) {
    return { status: PREDISPATCH_STATUS.BLOCKED, reason: 'missing dispatch or squad policy' }
  }
  if (!scopeConfig) {
    return {
      status: PREDISPATCH_STATUS.WARNED,
      reason: `no scope config for taskId=${dispatch.taskId || 'unknown'} — fail-open for backward compat`,
    }
  }
  const target = squadPolicy.extractTarget(dispatch)
  if (target === null || target === undefined || target === '' ||
      (Array.isArray(target) && target.length === 0)) {
    return {
      status: PREDISPATCH_STATUS.BLOCKED,
      reason: `no target extractable from dispatch (squad=${squadPolicy.squad})`,
    }
  }
  const inScope = squadPolicy.matchesScope(target, scopeConfig)
  if (inScope) {
    return {
      status: PREDISPATCH_STATUS.ALLOWED,
      reason: `target ${JSON.stringify(target)} matches scope (squad=${squadPolicy.squad})`,
    }
  }
  return {
    status: PREDISPATCH_STATUS.BLOCKED,
    reason: `target ${JSON.stringify(target)} not in scope (squad=${squadPolicy.squad})`,
  }
}

module.exports = { PREDISPATCH_STATUS, validateDispatch }
