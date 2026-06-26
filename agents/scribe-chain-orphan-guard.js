// agents/scribe-chain-orphan-guard.js
//
// Defensive guard preventing SCRIBE from publishing chains whose
// finding_ids have no entry in VALIDATED-FINDINGS.
//
// Motivation: 2026-05-22 account.motorola.com run published CHAIN-001
// CORS CRITICAL despite VALIDATED-FINDINGS being empty. Chain-verifier
// emitted "verified" on a 301-hop ACAO match; SCRIBE built the report
// from chain results alone. Defense in depth: even if chain-verifier
// or browser-verifier ever miss again, this guard ensures only chains
// with validated backing reach the report.
//
// Default policy: DROP chains lacking ANY of their declared backing
// (require ALL finding_ids to be validated). Returns { kept, dropped }
// with a reason on each dropped chain for logging.
//
// Sprint B Task B3.5 (2026-05-22): Constructor emits `finding_ids` per
// CHAIN_OUTPUT_SCHEMA, but historical / verifier-projected chains may
// carry the backing under a different shape (chain.steps[].finding_id,
// chain.stepResults[].finding_id, or chain.finding_id singular). The
// guard normalizes across all known shapes via _extractFindingIds so
// chains with real backing are not falsely dropped.

/**
 * Normalize the various chain shapes the Constructor / chain-verifier
 * pipeline can emit into a single canonical finding_ids[] array.
 *
 * Priority order (first non-empty wins):
 *   1. chain.finding_ids (array — explicit, takes precedence)
 *   2. chain.steps[].finding_id (Constructor per-step backing)
 *   3. chain.stepResults[].finding_id (post-Phase-3.6 projected)
 *   4. chain.finding_id (singular — older shape)
 *   5. [] (no backing — caller will drop the chain)
 *
 * Returns a fresh array (never mutates the chain).
 */
function _extractFindingIds(chain) {
  if (!chain || typeof chain !== 'object') return []

  // 1. Explicit finding_ids array — highest precedence.
  if (Array.isArray(chain.finding_ids)) {
    return chain.finding_ids.filter(Boolean)
  }

  // 2. steps[].finding_id
  if (Array.isArray(chain.steps)) {
    const fromSteps = chain.steps
      .map(s => s && typeof s === 'object' ? s.finding_id : null)
      .filter(Boolean)
    if (fromSteps.length > 0) return fromSteps
  }

  // 3. stepResults[].finding_id
  if (Array.isArray(chain.stepResults)) {
    const fromStepResults = chain.stepResults
      .map(s => s && typeof s === 'object' ? s.finding_id : null)
      .filter(Boolean)
    if (fromStepResults.length > 0) return fromStepResults
  }

  // 4. singular finding_id
  if (chain.finding_id) return [chain.finding_id]

  // 5. nothing
  return []
}

function filterChainsAgainstValidatedFindings(chains, validatedFindings) {
  const kept = []
  const dropped = []
  if (!Array.isArray(chains)) return { kept, dropped }
  const validatedIds = new Set(
    Array.isArray(validatedFindings)
      ? validatedFindings.map(f => f && f.id).filter(Boolean)
      : []
  )

  for (const chain of chains) {
    if (!chain || typeof chain !== 'object') continue

    // Detect whether ANY known shape carries backing IDs. We have to
    // distinguish "no shape present at all" (defensive-drop) from
    // "shape present but empty" (no-backing-drop) so the operator
    // logs tell the right story.
    const hasExplicitField =
      Array.isArray(chain.finding_ids) ||
      Array.isArray(chain.steps) ||
      Array.isArray(chain.stepResults) ||
      chain.finding_id !== undefined

    const ids = _extractFindingIds(chain)

    if (!hasExplicitField) {
      dropped.push({ ...chain, reason: 'finding_ids missing — defensive drop (no finding ids extractable)' })
      continue
    }
    if (ids.length === 0) {
      dropped.push({ ...chain, reason: 'finding_ids is empty — chain has no claimed backing' })
      continue
    }
    const missing = ids.filter(id => !validatedIds.has(id))
    if (missing.length > 0) {
      dropped.push({
        ...chain,
        reason: `no validated findings back this chain (missing: ${missing.join(', ')})`,
      })
      continue
    }
    kept.push(chain)
  }
  return { kept, dropped }
}

module.exports = { filterChainsAgainstValidatedFindings, _extractFindingIds }
