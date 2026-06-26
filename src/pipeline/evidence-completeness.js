// Evidence-Completeness Discipline — pure-function module.
//
// Owns:
//   - PIPELINE_MIN_LAYERS: per-squad minimum layers a 'full' trace must cover.
//   - validateCandidateSchema(candidate): returns {valid, errors, normalized}.
//     Normalizes missing evidence_completeness to 'local_only' (safe default).
//     Rejects identical TP/FP signatures (specialist didn't think through FPs).
//   - capSeverity(claimed, evidenceCompleteness): returns capped severity
//     following the 3-tier policy: full=Critical OK, partial=max Medium,
//     local_only=max Low.
//   - downgradeReason(claimed, capped, evidenceCompleteness): human string
//     explaining why KRIPA downgraded — for audit + VYASA report rendering.
//   - pipelineTraceMeetsMinimum(trace, squad): checks layer count ≥ min.
//
// No I/O. Safe to import from event-bus.js prompt builders, KRIPA verdict logic,
// and tests. Do not add side effects.

const VALID_EC_VALUES = new Set(['full', 'partial', 'local_only'])
const VALID_SEVERITIES = ['Critical', 'High', 'Medium', 'Low', 'Informational']

// Tunable per-squad minimum layers a 'full' pipeline_trace must cover before
// KRIPA accepts the specialist's 'full' claim. Values from spec §5.
const PIPELINE_MIN_LAYERS = {
  'code-review': 3,
  'cloud-security': 2,
  'network-pentest': 2,
  'pentest': 2,
  'red-team': 2,
  'stocks': 0,
  'ai-security': 3,
}

// 3-tier severity cap per spec §3 (KRIPA severity cap table).
const SEVERITY_CAPS = {
  full: 'Critical',
  partial: 'Medium',
  local_only: 'Low',
}

function severityRank(s) {
  const idx = VALID_SEVERITIES.indexOf(s)
  return idx === -1 ? VALID_SEVERITIES.length : idx  // unknown → weakest
}

function validateCandidateSchema(candidate) {
  const errors = []
  if (!candidate || typeof candidate !== 'object') {
    return { valid: false, errors: ['candidate is not an object'], normalized: null }
  }

  let ec = candidate.evidence_completeness
  let normalized = null
  if (ec === undefined || ec === null) {
    normalized = 'local_only'
    ec = 'local_only'
  } else if (!VALID_EC_VALUES.has(ec)) {
    errors.push(`evidence_completeness must be one of: ${[...VALID_EC_VALUES].join(', ')}, got: ${ec}`)
  }

  if (candidate.expected_true_positive_signature &&
      candidate.expected_false_positive_signature &&
      candidate.expected_true_positive_signature === candidate.expected_false_positive_signature) {
    errors.push('expected_true_positive_signature and expected_false_positive_signature are identical')
  }

  return { valid: errors.length === 0, errors, normalized }
}

function capSeverity(claimed, evidenceCompleteness, opts = {}) {
  const ec = VALID_EC_VALUES.has(evidenceCompleteness) ? evidenceCompleteness : 'local_only'
  const ceiling = SEVERITY_CAPS[ec]
  const ceilingRank = severityRank(ceiling)
  const claimedRank = severityRank(claimed)

  if (claimedRank < ceilingRank) {
    return {
      cappedSeverity: ceiling,
      wasCapped: true,
      reason: `evidence_completeness=${ec} caps severity at ${ceiling}; specialist claimed ${claimed}`,
      ...(opts.extraReason ? { detail: opts.extraReason } : {}),
    }
  }
  return { cappedSeverity: claimed, wasCapped: false, reason: null }
}

function downgradeReason(claimed, capped, ec, extras = {}) {
  const parts = [`evidence_completeness=${ec}`, `specialist_claimed=${claimed}`, `kripa_capped_to=${capped}`]
  if (extras.trace_too_short) parts.push(`trace_too_short=${extras.minLayers}_required_got_${extras.actualLayers}`)
  if (extras.missing_verification_command) parts.push('missing_runtime_verification_command')
  if (extras.unverifiable_by_design) parts.push('unverifiable_by_design')
  return parts.join(' ; ')
}

function pipelineTraceMeetsMinimum(pipelineTrace, squad) {
  const min = PIPELINE_MIN_LAYERS[squad]
  if (typeof min !== 'number') return true
  const len = Array.isArray(pipelineTrace) ? pipelineTrace.length : 0
  return len >= min
}

// ─── v2 (2026-04-23): Threat-model discipline ─────────────────────────────
// Stacked sub-rule caps that compose with v1's evidence_completeness cap.
// Per spec §3 Layer 4 — each rule returns an independent ceiling; KRIPA
// applies MIN(all ceilings) as the final effective severity.

// Per-privilege maximum severity. null = no cap (unauth and authenticated
// attacks can still hit Critical if they truly escalate).
const ATTACKER_PRIVILEGE_CAPS = {
  unauth: null,
  authenticated: null,
  privileged: 'High',
  admin: 'Medium',
  superuser: 'Low',
}

// Trust-boundary modifier as tier-delta. +N = bumps ceiling up N tiers
// (undoes admin cap when the attack genuinely escalates). -N = tightens.
const TRUST_BOUNDARY_MODIFIERS = {
  'none': -1,
  'cross-user': 0,
  'cross-tenant': +1,
  'privilege-escalation': +1,
  'unauth-to-auth': +1,
  'cross-org': +1,
}

const VALID_PRIVILEGES = new Set(Object.keys(ATTACKER_PRIVILEGE_CAPS))
const VALID_BOUNDARIES = new Set(Object.keys(TRUST_BOUNDARY_MODIFIERS))

// Apply a tier delta to a severity. Positive = more severe, negative = less.
// Clamps at Critical (top) and Informational (bottom — no negative levels).
function shiftSeverity(sev, delta) {
  const order = ['Critical', 'High', 'Medium', 'Low', 'Informational']
  const idx = order.indexOf(sev)
  if (idx === -1) return sev
  const newIdx = Math.max(0, Math.min(order.length - 1, idx - delta))
  return order[newIdx]
}

// Returns the lower (less severe) of two severities.
function minSeverity(a, b) {
  if (a === null || a === undefined) return b
  if (b === null || b === undefined) return a
  const order = ['Critical', 'High', 'Medium', 'Low', 'Informational']
  return (order.indexOf(a) >= order.indexOf(b)) ? a : b
}

// Core threat-model cap composer. Returns { cappedSeverity, wasCapped,
// appliedRules } where appliedRules is an array of { rule, effect } pairs
// for audit trail.
function capSeverityByThreatModel(claimed, threatModel, opts = {}) {
  const tm = threatModel || {}
  const applied = []
  let ceiling = claimed

  // Rule 1: attacker_privilege
  const priv = tm.attacker_privilege
  if (priv && VALID_PRIVILEGES.has(priv)) {
    const privCap = ATTACKER_PRIVILEGE_CAPS[priv]
    if (privCap) {
      const before = ceiling
      ceiling = minSeverity(ceiling, privCap)
      if (ceiling !== before) applied.push({ rule: 'attacker_privilege', value: priv, cap: privCap })
    }
  }

  // Rule 2: trust_boundary_crossed (tier-delta modifier, applied AFTER privilege cap)
  const boundary = tm.trust_boundary_crossed
  if (boundary && VALID_BOUNDARIES.has(boundary)) {
    const delta = TRUST_BOUNDARY_MODIFIERS[boundary]
    if (delta !== 0) {
      const before = ceiling
      ceiling = shiftSeverity(ceiling, delta)
      if (ceiling !== before) applied.push({ rule: 'trust_boundary_crossed', value: boundary, delta })
    }
  }

  // Rule 3: documented_as_intended → -1 tier
  if (tm.documented_as_intended === true) {
    const before = ceiling
    ceiling = shiftSeverity(ceiling, -1)
    if (ceiling !== before) applied.push({ rule: 'documented_as_intended', value: true, delta: -1 })
  }

  // Rule 4: toolchain_presence_verified (only when claim depends on toolchain)
  if (opts.claimDependsOnToolchain && tm.toolchain_presence_verified === false) {
    const before = ceiling
    ceiling = minSeverity(ceiling, 'Low')
    if (ceiling !== before) applied.push({ rule: 'toolchain_presence_verified', value: false, cap: 'Low' })
  }

  // Rule 5: validation_layers_checked (only when claim is "validation gap")
  if (opts.claimIsValidationGap) {
    const layers = Array.isArray(tm.validation_layers_checked) ? tm.validation_layers_checked : []
    if (layers.length < 3) {
      const before = ceiling
      ceiling = minSeverity(ceiling, 'Medium')
      if (ceiling !== before) applied.push({
        rule: 'validation_layers_checked', value: layers.length, cap: 'Medium',
        note: `only ${layers.length} layers inspected; need >=3 for validation-gap claim`,
      })
    }
  }

  return {
    cappedSeverity: ceiling,
    wasCapped: ceiling !== claimed,
    appliedRules: applied,
    reason: applied.length === 0 ? null : applied.map(a =>
      a.cap ? `${a.rule}=${a.value} (-> ${a.cap})` : `${a.rule}=${a.value} (D${a.delta >= 0 ? '+' : ''}${a.delta})`
    ).join(' ; '),
  }
}

// Validates a threat_model object. Returns { valid, errors, normalized }.
// Normalizes missing object to SAFE defaults that DOWNGRADE (never inflate).
function validateThreatModelSchema(threatModel, candidateContext = {}) {
  const errors = []

  if (!threatModel || typeof threatModel !== 'object') {
    // SAFE DEFAULTS: strictest assumption that downgrades severity
    const normalized = {
      attacker_privilege: 'admin',
      trust_boundary_crossed: 'none',
      documented_as_intended: true,
      toolchain_presence_verified: null,
      validation_layers_checked: [],
      prerequisite_actions: [],
    }
    return { valid: true, errors: [], normalized }
  }

  if (threatModel.attacker_privilege &&
      !VALID_PRIVILEGES.has(threatModel.attacker_privilege)) {
    errors.push(`attacker_privilege must be one of: ${[...VALID_PRIVILEGES].join(', ')}; got: ${threatModel.attacker_privilege}`)
  }
  if (threatModel.trust_boundary_crossed &&
      !VALID_BOUNDARIES.has(threatModel.trust_boundary_crossed)) {
    errors.push(`trust_boundary_crossed must be one of: ${[...VALID_BOUNDARIES].join(', ')}; got: ${threatModel.trust_boundary_crossed}`)
  }

  // Incoherence check: unauth attacker on /admin/ path is suspicious
  const filePath = candidateContext.file || threatModel.file || ''
  if (threatModel.attacker_privilege === 'unauth' && /\/admin\//.test(filePath)) {
    errors.push(`attacker_privilege=unauth claimed on admin-path finding (${filePath}); admin routes require at minimum authenticated access`)
  }

  return { valid: errors.length === 0, errors, normalized: null }
}

// Compose v1 evidence_completeness cap + v2 threat_model caps.
// KRIPA calls this at verdict time; MIN of all ceilings wins.
function composeAllCaps(claimed, evidenceCompleteness, threatModel, opts = {}) {
  const v1 = capSeverity(claimed, evidenceCompleteness)
  const afterV1 = v1.cappedSeverity
  const v2 = capSeverityByThreatModel(afterV1, threatModel, opts)
  const final = v2.cappedSeverity
  const all = []
  if (v1.wasCapped) all.push({ layer: 'v1', rule: 'evidence_completeness', value: evidenceCompleteness, cap: v1.cappedSeverity })
  all.push(...(v2.appliedRules || []).map(r => ({ layer: 'v2', ...r })))
  return {
    finalSeverity: final,
    wasCapped: final !== claimed,
    allAppliedRules: all,
    v1Rule: v1.wasCapped ? v1 : null,
    v2Rules: v2.appliedRules || [],
    reason: [v1.reason, v2.reason].filter(Boolean).join(' ;; '),
  }
}

module.exports = {
  VALID_EC_VALUES,
  VALID_SEVERITIES,
  PIPELINE_MIN_LAYERS,
  SEVERITY_CAPS,
  validateCandidateSchema,
  capSeverity,
  downgradeReason,
  pipelineTraceMeetsMinimum,
  // v2 threat-model
  ATTACKER_PRIVILEGE_CAPS,
  TRUST_BOUNDARY_MODIFIERS,
  VALID_PRIVILEGES,
  VALID_BOUNDARIES,
  shiftSeverity,
  minSeverity,
  capSeverityByThreatModel,
  validateThreatModelSchema,
  composeAllCaps,
}
