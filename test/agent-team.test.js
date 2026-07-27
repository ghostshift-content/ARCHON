'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const team = require('../src/runtime/agent-team')

test('canonical team has five roles and no specialist control-flow roles', () => {
  assert.deepEqual(Object.keys(team.ROLES).sort(), ['EXPLORE', 'INVENTORY', 'LEAD', 'RESEARCHER', 'VERIFIER'])
  assert.deepEqual(team.VERIFIER_LENSES, ['REACHABILITY', 'IMPACT', 'DEFENSES'])
})

test('one holistic researcher is created per coherent workstream', () => {
  const plan = team.buildResearchPlan({
    mode: 'static',
    workstreams: [
      { id: 'ws-1', features: ['login', 'sessions'], files: ['auth.rb'] },
      { id: 'ws-2', features: ['refund'], files: ['payment.rb'] },
    ],
    applicableSkills: ['access-control', 'business-logic', 'xss'],
  })
  assert.equal(plan.researcher_count, 2)
  assert.equal(plan.assignments.length, 2)
  assert.ok(plan.assignments.every(assignment => assignment.skill_families.length === 3))
  assert.ok(plan.assignments.every(assignment => assignment.max_explore_children === 2))
  assert.equal(plan.compatibility.legacy_agents_are_persona_bundles, true)
  assert.ok(plan.assignments[0].persona_bundles.some(persona => persona.id === 'MARSHAL'))
})

test('candidate dedupe is mode-aware and merges evidence', () => {
  const candidates = team.dedupeCandidates([
    { class: 'BOLA', method: 'GET', endpoint: '/users/123', parameter: 'id', evidence_refs: ['E1'] },
    { class: 'bola', method: 'get', endpoint: '/users/456', parameter: 'id', evidence_refs: ['E2'] },
  ], 'blackbox')
  assert.equal(candidates.length, 1)
  assert.equal(candidates[0].observation_count, 2)
  assert.deepEqual(candidates[0].evidence_refs.sort(), ['E1', 'E2'])
})

test('verifier batches use three lenses per batch, not three agents per candidate', () => {
  const candidates = Array.from({ length: 17 }, (_, index) => ({ id: `C${index + 1}` }))
  const plan = team.buildResearchPlan({ mode: 'whitebox', workstreams: [], candidates, verifierBatchSize: 8 })
  assert.equal(plan.verifier.batches.length, 3)
  assert.equal(plan.verifier.assignments.length, 9)
})

test('deterministic vote tally requires an exact three-lens panel and two true votes', () => {
  const candidates = [{ id: 'C1' }, { id: 'C2' }]
  const votes = [
    { candidate_id: 'C1', lens: 'REACHABILITY', verdict: 'TRUE_POSITIVE' },
    { candidate_id: 'C1', lens: 'IMPACT', verdict: 'TRUE_POSITIVE' },
    { candidate_id: 'C1', lens: 'DEFENSES', verdict: 'FALSE_POSITIVE' },
    { candidate_id: 'C2', lens: 'REACHABILITY', verdict: 'TRUE_POSITIVE' },
    { candidate_id: 'C2', lens: 'IMPACT', verdict: 'TRUE_POSITIVE' },
  ]
  const result = team.tallyVerifierVotes(candidates, votes, 'static')
  assert.equal(result.admitted.length, 1)
  assert.equal(result.decisions[0].validation_status, 'SOURCE_CONFIRMED')
  assert.equal(result.decisions[1].admitted, false)
  assert.equal(result.decisions[1].validation_status, 'NEEDS_LIVE_VALIDATION')
})

test('coverage requires every applicable skill family to be terminally accounted', () => {
  const incomplete = team.validateCoverage(
    [{ skill_family: 'xss', status: 'no_issue' }],
    ['xss', 'access-control'],
  )
  assert.equal(incomplete.complete, false)
  assert.deepEqual(incomplete.missing, ['access-control'])
  const complete = team.validateCoverage([
    { skill_family: 'xss', status: 'no_issue' },
    { skill_family: 'access-control', status: 'candidate' },
  ], ['xss', 'access-control'])
  assert.equal(complete.complete, true)
})
