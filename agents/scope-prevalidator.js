// agents/scope-prevalidator.js
//
// 2026-05-15: Pre-dispatch scope hard-block. Borrowed pattern from
// bughunter-ai — runs BEFORE any specialist fires. Complements the
// existing post-finding scope-validator.js (shipped 2026-05-15 morning).
//
// Universal across squads via the squadPolicy adapter (pentest / code-review).
//
// Fail-CLOSED when scope config is missing — returns "blocked". A pentest tool
// must never fire at a target with no declared scope. The normal product flow
// always writes scope-<taskId>.json, so a missing config means an injected or
// buggy dispatch — exactly when a hard stop is wanted. An operator who really
// wants a scope-less run sets ARCHON_SCOPE_OVERRIDE=1 (downgrades to "warned").

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
    if (process.env.ARCHON_SCOPE_OVERRIDE === '1') {
      return {
        status: PREDISPATCH_STATUS.WARNED,
        reason: `no scope config for taskId=${dispatch.taskId || 'unknown'} — allowed via ARCHON_SCOPE_OVERRIDE`,
      }
    }
    return {
      status: PREDISPATCH_STATUS.BLOCKED,
      reason: `no scope config for taskId=${dispatch.taskId || 'unknown'} — fail-closed (set ARCHON_SCOPE_OVERRIDE=1 to allow a scope-less dispatch)`,
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
