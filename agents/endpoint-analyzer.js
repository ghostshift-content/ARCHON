// agents/endpoint-analyzer.js
//
// Phase 1.8 Endpoint Analyzer — structured handoff between recon and Phase 2.
//
// Inspired by the Analyzer/Reviewer split from the multi-agent code-review
// pattern: split comprehension from adversarial thinking. Recon + Analyzer
// produce a structured EndpointModel per discovered endpoint, capturing
// facts AND implicit assumptions. Phase 2 specialists then operate in pure
// adversarial mode, distrusting the assumptions and attacking gaps.
//
// Why pure code, not LLM, for this module:
//   - Deterministic. Same recon → same EndpointModel. Reproducible.
//   - No cost. Doesn't burn LLM calls.
//   - No hallucination. Author assumptions extracted only from observed
//     evidence (missing validators, user-source paths, etc.).
//
// The LLM-driven version (Sonnet call) is a future option if Jay wants
// richer purpose/intent inference. For now we ship the rule-based core.

'use strict'

const REQUIRED_FIELDS = Object.freeze([
  'endpoint', 'purpose', 'inputs', 'auth_boundary', 'trust_zones', 'assumptions',
])

function validateEndpointModel(model) {
  if (!model || typeof model !== 'object') {
    return { ok: false, reason: 'not an object' }
  }
  for (const f of REQUIRED_FIELDS) {
    if (!(f in model)) {
      return { ok: false, reason: `missing required field: ${f}` }
    }
  }
  if (!Array.isArray(model.inputs)) return { ok: false, reason: 'inputs must be array' }
  if (!Array.isArray(model.assumptions)) return { ok: false, reason: 'assumptions must be array' }
  if (!model.trust_zones || typeof model.trust_zones !== 'object') {
    return { ok: false, reason: 'trust_zones must be object' }
  }
  return { ok: true }
}

// Extract structural assumptions from observed inputs + endpoint shape.
// Each entry is a sentence the Phase 2 specialist should challenge.
function extractAssumptions(model) {
  const assumptions = []
  const inputs = model.inputs || []

  // Pattern 1: User-source input with NO validators → unvalidated input
  for (const inp of inputs) {
    if (inp.source && /user/.test(inp.source) && (!inp.validators || inp.validators.length === 0)) {
      const typeNote = inp.type === 'number' ? ' (numeric — check range/sign)' : ''
      assumptions.push(
        `Author assumes ${inp.name} arrives well-formed — no validation in code${typeNote}. ` +
        `Unvalidated user input; test boundary values, negative, oversize, type-confused.`,
      )
    }
  }

  // Pattern 2: User-source identifier in path/query → BOLA/IDOR scope question
  const endpointStr = String(model.endpoint || '')
  for (const inp of inputs) {
    const isUserSource = inp.source && /user/.test(inp.source)
    const looksLikeId = /id|uuid|guid|key|token|_id$/i.test(inp.name)
    if (isUserSource && looksLikeId) {
      const auth = model.auth_boundary || 'unknown'
      if (auth !== 'public') {
        assumptions.push(
          `Author assumes ${inp.name} belongs to the authenticated caller — no ownership/scope check evident. ` +
          `BOLA/IDOR risk: try accessing another user's ${inp.name}.`,
        )
      }
    }
  }

  // Pattern 3: Auth-boundary mismatch — endpoint name suggests private but boundary is public
  const looksPrivate = /admin|internal|debug|management|config/i.test(endpointStr)
  if (looksPrivate && model.auth_boundary === 'public') {
    assumptions.push(
      `Endpoint name suggests private functionality (${endpointStr}) but auth_boundary=public. ` +
      `Verify if this should require authentication.`,
    )
  }

  return assumptions
}

// Build EndpointModel array from recon endpoint output. Inputs sub-array is
// best-effort — recon doesn't always know parameter names/types/sources, so
// we infer from URL shape (path params marked as user-path) when possible.
function buildEndpointModelsFromRecon(reconData) {
  const endpoints = (reconData && reconData.endpoints) || []
  const models = []
  for (const ep of endpoints) {
    const url = String(ep.url || '')
    const method = String(ep.method || 'GET').toUpperCase()
    // Strip scheme + host to keep a stable path key
    let pathPart = url
    try {
      const u = new URL(url)
      pathPart = decodeURIComponent(u.pathname) + (u.search || '')
    } catch { /* keep raw */ }
    const endpointKey = `${method} ${pathPart}`

    // Infer path params from {placeholder} or :placeholder shapes
    const inputs = []
    const pathParams = [
      ...pathPart.matchAll(/\{([a-zA-Z_][a-zA-Z0-9_]*)\}/g),
      ...pathPart.matchAll(/:([a-zA-Z_][a-zA-Z0-9_]*)/g),
    ].map(m => m[1])
    for (const name of pathParams) {
      inputs.push({ name, source: 'user-path', validators: [], type: 'string' })
    }

    const auth_boundary = ep.requires_auth ? 'session-required'
      : ep.auth_boundary || 'unknown'

    const model = {
      endpoint: endpointKey,
      purpose: ep.purpose || 'inferred from recon — Phase 2 should validate',
      inputs,
      auth_boundary,
      trust_zones: {
        user: inputs.filter(i => /user/.test(i.source)).map(i => i.name),
        server: [],
      },
      assumptions: [],
    }
    model.assumptions = extractAssumptions(model)
    models.push(model)
  }
  return models
}

module.exports = {
  REQUIRED_FIELDS,
  validateEndpointModel,
  extractAssumptions,
  buildEndpointModelsFromRecon,
}
