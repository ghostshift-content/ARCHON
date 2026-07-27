'use strict'

// Canonical ARCHON agent team. This module owns deterministic planning, candidate
// identity, verifier batching, and vote tallying. Models gather and assess evidence;
// code decides whether the panel is complete and whether a candidate is admitted.

const crypto = require('crypto')
const agentRegistry = require('../agents/registry')

const ROLES = Object.freeze({
  LEAD: 'ARCHON_LEAD',
  INVENTORY: 'INVENTORY',
  RESEARCHER: 'RESEARCHER',
  EXPLORE: 'EXPLORE',
  VERIFIER: 'VERIFIER',
})

const VERIFIER_LENSES = Object.freeze(['REACHABILITY', 'IMPACT', 'DEFENSES'])
const MODES = Object.freeze(['blackbox', 'static', 'whitebox'])
const TERMINAL_COVERAGE = Object.freeze(['candidate', 'no_issue', 'not_applicable', 'blocked_coverage_gap'])

function normalizeMode(mode) {
  const value = String(mode || '').trim().toLowerCase()
  if (value === 'code-review' || value === 'source' || value === 'sast') return 'static'
  if (value === 'white-box') return 'whitebox'
  if (value === 'black-box' || value === 'pentest') return 'blackbox'
  if (!MODES.includes(value)) throw new Error(`unsupported ARCHON mode: ${mode}`)
  return value
}

function _norm(value) {
  return String(value || '').trim().toLowerCase().replace(/\d+/g, '{id}').replace(/\s+/g, ' ')
}

function candidateIdentity(candidate = {}, mode) {
  const normalizedMode = normalizeMode(mode || candidate.mode || 'static')
  const parts = normalizedMode === 'blackbox'
    ? [
        normalizedMode, _norm(candidate.class || candidate.category), _norm(candidate.method),
        _norm(candidate.endpoint || candidate.path || candidate.asset), _norm(candidate.parameter),
        _norm(candidate.signature || candidate.sink),
      ]
    : [
        normalizedMode, _norm(candidate.class || candidate.category), _norm(candidate.file || candidate.source_file),
        Number(candidate.line) || 0, _norm(candidate.symbol), _norm(candidate.sink || candidate.signature),
        _norm(candidate.endpoint || candidate.path),
      ]
  return crypto.createHash('sha256').update(JSON.stringify(parts)).digest('hex')
}

function dedupeCandidates(candidates = [], mode) {
  const merged = new Map()
  for (const raw of candidates) {
    if (!raw || typeof raw !== 'object') continue
    const key = raw.duplicate_key || candidateIdentity(raw, mode)
    const current = merged.get(key)
    if (!current) {
      merged.set(key, {
        ...raw,
        duplicate_key: key,
        observation_count: Number(raw.observation_count) || 1,
        evidence_refs: [...new Set(raw.evidence_refs || [])],
      })
      continue
    }
    current.observation_count += Number(raw.observation_count) || 1
    current.evidence_refs = [...new Set([...(current.evidence_refs || []), ...(raw.evidence_refs || [])])]
    if (!current.exploit_hypothesis && raw.exploit_hypothesis) current.exploit_hypothesis = raw.exploit_hypothesis
    if (!current.recommendation && raw.recommendation) current.recommendation = raw.recommendation
  }
  return [...merged.values()].map((candidate, index) => ({
    ...candidate,
    id: candidate.id || `CAND-${index + 1}`,
  }))
}

function batchCandidates(candidates = [], batchSize = 8) {
  const size = Math.max(1, Math.min(25, Number(batchSize) || 8))
  const batches = []
  for (let index = 0; index < candidates.length; index += size) {
    batches.push({ id: `verify-batch-${batches.length + 1}`, candidates: candidates.slice(index, index + size) })
  }
  return batches
}

function legacyAgentAsPersona(name, mode) {
  const agent = agentRegistry.get(name)
  if (!agent) return null
  const normalizedMode = normalizeMode(mode)
  if (!(agent.modes || []).includes(normalizedMode)) return null
  return {
    id: String(name).toUpperCase(),
    role: agent.role,
    description: agent.description || null,
    skill_families: [...(agent.specialties || [])],
  }
}

function _personaBundles(names, mode) {
  const requested = Array.isArray(names) && names.length ? names : agentRegistry.all()
  return requested.map(name => legacyAgentAsPersona(name, mode)).filter(Boolean)
}

function buildResearchPlan(input = {}) {
  const mode = normalizeMode(input.mode)
  const workstreams = Array.isArray(input.workstreams) ? input.workstreams : []
  const applicableSkills = [...new Set((input.applicableSkills || []).map(s => typeof s === 'string' ? s : s.id).filter(Boolean))]
  const maxExploreChildren = Math.max(0, Math.min(2, Number.isFinite(input.maxExploreChildren) ? input.maxExploreChildren : 2))
  const personas = _personaBundles(input.personas, mode)

  const assignments = workstreams.map((workstream, index) => {
    const local = new Set([...(workstream.skill_families || []), ...applicableSkills])
    const matchingPersonas = personas
      .map(persona => ({ ...persona, score: persona.skill_families.filter(skill => local.has(skill)).length }))
      .filter(persona => persona.score > 0)
      .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
      .map(({ score, ...persona }) => persona)
    return {
      id: `research-${workstream.id || index + 1}`,
      role: ROLES.RESEARCHER,
      workstream_id: workstream.id || `workstream-${index + 1}`,
      context: {
        features: [...(workstream.features || [])],
        domains: [...(workstream.domains || [])],
        files: [...(workstream.files || [])],
        primary_files: [...(workstream.primary_files || [])],
        shared_context_files: [...(workstream.shared_context_files || [])],
        endpoints: [...(workstream.endpoints || [])],
      },
      skill_families: [...local],
      persona_bundles: matchingPersonas,
      max_explore_children: maxExploreChildren,
      oversized: Boolean(workstream.oversized),
    }
  })

  const verifierBatches = batchCandidates(input.candidates || [], input.verifierBatchSize)
  const verifierAssignments = verifierBatches.flatMap(batch => VERIFIER_LENSES.map(lens => ({
    id: `${batch.id}-${lens.toLowerCase()}`,
    role: ROLES.VERIFIER,
    lens,
    batch_id: batch.id,
    candidate_ids: batch.candidates.map(candidate => candidate.id),
    max_explore_children: maxExploreChildren,
  })))

  return {
    version: 1,
    mode,
    strategy: input.strategy || (mode === 'blackbox' ? 'smart_auto' : 'source'),
    roles: { ...ROLES },
    workstream_count: assignments.length,
    researcher_count: assignments.length,
    assignments,
    verifier: {
      lenses: [...VERIFIER_LENSES],
      batch_size: Math.max(1, Math.min(25, Number(input.verifierBatchSize) || 8)),
      batches: verifierBatches,
      assignments: verifierAssignments,
      admission_rule: 'complete three-lens panel and at least two TRUE_POSITIVE votes',
    },
    concurrency: {
      researcher_leads: Number(input.activeConcurrency) || Math.min(assignments.length, 3),
      max_explore_children_per_parent: maxExploreChildren,
    },
    compatibility: {
      legacy_agents_are_persona_bundles: true,
      persona_count: personas.length,
    },
  }
}

function tallyVerifierVotes(candidates = [], votes = [], mode) {
  const normalizedMode = normalizeMode(mode)
  const byCandidate = new Map(candidates.map(candidate => [candidate.id, new Map()]))
  const malformed = []

  for (const vote of votes) {
    if (!vote || !byCandidate.has(vote.candidate_id) || !VERIFIER_LENSES.includes(vote.lens)) {
      malformed.push(vote)
      continue
    }
    if (!['TRUE_POSITIVE', 'FALSE_POSITIVE', 'NEEDS_MORE_EVIDENCE'].includes(vote.verdict)) {
      malformed.push(vote)
      continue
    }
    const lensVotes = byCandidate.get(vote.candidate_id)
    if (lensVotes.has(vote.lens)) {
      malformed.push(vote)
      continue
    }
    lensVotes.set(vote.lens, vote)
  }

  const decisions = candidates.map(candidate => {
    const lensVotes = byCandidate.get(candidate.id) || new Map()
    const rows = VERIFIER_LENSES.map(lens => lensVotes.get(lens)).filter(Boolean)
    const trueVotes = rows.filter(vote => vote.verdict === 'TRUE_POSITIVE').length
    const complete = rows.length === VERIFIER_LENSES.length
    const admitted = complete && trueVotes >= 2
    let validationStatus = 'DISPROVEN'
    if (!complete || rows.some(vote => vote.verdict === 'NEEDS_MORE_EVIDENCE')) validationStatus = 'NEEDS_LIVE_VALIDATION'
    else if (admitted && normalizedMode === 'static') validationStatus = 'SOURCE_CONFIRMED'
    else if (admitted && candidate.runtime_evidence) validationStatus = 'RUNTIME_CONFIRMED'
    else if (admitted) validationStatus = 'NEEDS_LIVE_VALIDATION'
    return {
      candidate_id: candidate.id,
      admitted,
      complete,
      validation_status: validationStatus,
      confidence: admitted ? (trueVotes === 3 ? 'high' : 'medium') : 'low',
      tally: {
        true_positive: trueVotes,
        false_positive: rows.filter(vote => vote.verdict === 'FALSE_POSITIVE').length,
        needs_more_evidence: rows.filter(vote => vote.verdict === 'NEEDS_MORE_EVIDENCE').length,
        voters: rows.length,
      },
      votes: rows,
    }
  })

  return {
    decisions,
    admitted: decisions.filter(decision => decision.admitted),
    rejected: decisions.filter(decision => !decision.admitted),
    malformed_votes: malformed,
  }
}

function validateCoverage(rows = [], applicableSkills = []) {
  const applicable = new Set(applicableSkills)
  const accounted = new Map()
  const invalid = []
  for (const row of rows) {
    if (!row || !applicable.has(row.skill_family) || !TERMINAL_COVERAGE.includes(row.status)) {
      invalid.push(row)
      continue
    }
    if (!accounted.has(row.skill_family)) accounted.set(row.skill_family, row)
  }
  const missing = [...applicable].filter(skill => !accounted.has(skill))
  return {
    complete: missing.length === 0 && invalid.length === 0,
    accounted: [...accounted.values()],
    missing,
    invalid,
  }
}

module.exports = {
  ROLES,
  VERIFIER_LENSES,
  MODES,
  TERMINAL_COVERAGE,
  normalizeMode,
  candidateIdentity,
  dedupeCandidates,
  batchCandidates,
  legacyAgentAsPersona,
  buildResearchPlan,
  tallyVerifierVotes,
  validateCoverage,
}
