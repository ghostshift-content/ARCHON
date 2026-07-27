'use strict'

// One source of truth for black-box phase selection. Application mapping is
// mandatory in every strategy; "direct" skips only infrastructure/service recon.

const STRATEGIES = Object.freeze({
  DIRECT: 'direct',
  SMART_AUTO: 'smart_auto',
  FULL_RECON: 'full_recon',
})

function normalizeStrategy(meta = {}) {
  const requested = String(meta.scanStrategy || '').trim().toLowerCase().replace(/-/g, '_')
  if (Object.values(STRATEGIES).includes(requested)) return requested
  if (meta.skipRecon === true) return STRATEGIES.DIRECT
  if (meta.testType === 'feature' || meta.featureFocus || meta.customFocus ||
      (Array.isArray(meta.focusClasses) && meta.focusClasses.length)) return STRATEGIES.SMART_AUTO
  return STRATEGIES.FULL_RECON
}

function phasePlan(meta = {}) {
  const strategy = normalizeStrategy(meta)
  return {
    strategy,
    runInfrastructureRecon: strategy === STRATEGIES.FULL_RECON,
    runReconAgents: strategy !== STRATEGIES.DIRECT,
    runStandaloneFingerprintProbes: strategy !== STRATEGIES.DIRECT,
    runApplicationMapping: true,
    runSpecialists: true,
    scopeEnforced: true,
    reason: strategy === STRATEGIES.DIRECT
      ? 'Direct application test: skip Nmap, SCOUT/RANGER, and standalone WAF/auth fingerprint probes; retain TRACER website/API mapping'
      : strategy === STRATEGIES.SMART_AUTO
        ? 'Evidence-driven recon: skip broad port scanning; retain targeted recon and application mapping'
        : 'Full authorized infrastructure recon followed by application mapping and testing',
  }
}

module.exports = { STRATEGIES, normalizeStrategy, phasePlan }
