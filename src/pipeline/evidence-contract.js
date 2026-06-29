// src/pipeline/evidence-contract.js
//
// "No captured evidence → not CONFIRMED." A finding may only carry
// validation_status CONFIRMED if it actually has evidence a human could replay:
//   - a reproduction method (curl/command/steps) and/or a reproduction result, OR
//   - a non-trivial proof blob, OR
//   - a gated Exploit-Prover proof_of_execution that was nonce-confirmed.
// Anything claiming CONFIRMED without that is demoted to NEEDS-LIVE (kept for
// review, but NOT treated as proven by the judge/report). This kills the
// "agent asserts a vuln it can't show" failure mode. Pure.

'use strict'

const MIN_PROOF_LEN = 20

function _nonEmpty(v) { return typeof v === 'string' && v.trim().length > 0 }

// True iff the finding carries replayable evidence.
function hasEvidence(finding) {
  if (!finding || typeof finding !== 'object') return false
  if (finding.proof_of_execution && finding.proof_of_execution.confirmed === true) return true
  if (_nonEmpty(finding.reproduction_method) || _nonEmpty(finding.reproduction_result)) return true
  if (_nonEmpty(finding.reproduction)) return true
  if (typeof finding.proof === 'string' && finding.proof.trim().length >= MIN_PROOF_LEN) return true
  return false
}

// Enforce the contract on a record. Returns the (possibly demoted) record.
// CONFIRMED without evidence → NEEDS-LIVE + an evidence_demoted reason.
function enforceContract(record) {
  if (!record || typeof record !== 'object') return record
  const status = String(record.validation_status || '').toUpperCase()
  if (status === 'CONFIRMED' && !hasEvidence(record)) {
    return {
      ...record,
      validation_status: 'NEEDS-LIVE',
      evidence_demoted: true,
      evidence_demoted_reason: 'CONFIRMED claimed without replayable evidence (no reproduction/proof) — needs live confirmation',
    }
  }
  return record
}

module.exports = { hasEvidence, enforceContract, MIN_PROOF_LEN }
