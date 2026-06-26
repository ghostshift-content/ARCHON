#!/usr/bin/env node
// Regression: simulates the GitLab DH-AC-001 false positive from 2026-04-23.
// With evidence-completeness discipline active, the unreformed Critical BFLA
// claim MUST downgrade to Low at the severity-cap layer.
//
// This test does NOT invoke real LLM specialists — it constructs the exact
// candidate that the pre-discipline DHRISHTADYUMNA emitted in the 2026-04-23
// GitLab run and asserts the cap logic catches it.

const ec = require('../src/pipeline/evidence-completeness')

let passed = 0, failed = 0
function ok(l, c, extra = '') { if (c) { console.log('  ✓ ' + l); passed++ } else { console.log('  ✗ ' + l + (extra ? ' — ' + extra : '')); failed++ } }

console.log('GitLab DH-AC-001 BFLA regression test:')

// The candidate that 2026-04-23 DHRISHTADYUMNA actually emitted
// (paraphrased from FINAL-REPORT-crv2-1776935900.md).
const candidateV1 = {
  id: 'DH-AC-001',
  framework: 'access-control',
  pattern: 'K-0',
  severity: 'Critical',
  title: 'BroadcastMessagesController: Missing Admin Authorization Gate',
  file: 'app/controllers/admin/broadcast_messages_controller.rb',
  line: 4,
  source: 'params (authenticated non-admin user)',
  sink: 'BroadcastMessage.create (admin operation)',
  gap: 'class inherits ApplicationController, not Admin::ApplicationController',
  evidence: 'controller class declaration on line 4',
  needs_live_validation: false,
  // No evidence_completeness, no pipeline_trace, no signatures — pre-discipline candidate.
}

// Step 1: schema normalization treats missing field as local_only
const v = ec.validateCandidateSchema(candidateV1)
ok('missing evidence_completeness normalizes to local_only', v.normalized === 'local_only')

// Step 2: severity cap drops Critical to Low (local_only → Low per spec)
const capped = ec.capSeverity(candidateV1.severity, v.normalized || 'local_only')
ok('local_only caps Critical → Low', capped.cappedSeverity === 'Low')
ok('capped flag is set', capped.wasCapped === true)
ok('reason mentions local_only', capped.reason.includes('local_only'))

// Step 3: even if specialist had claimed partial with only 1 layer traced,
// pipeline min-layer check rejects "full" for code-review
const candidateV2 = {
  ...candidateV1,
  evidence_completeness: 'full',
  pipeline_trace: ['controller_class_declaration'],  // only 1 layer
}
ok('single-layer trace fails code-review minimum (3)',
   !ec.pipelineTraceMeetsMinimum(candidateV2.pipeline_trace, 'code-review'))

// Step 4: properly "full" candidate (all 8 layers inspected) allows Critical
const candidateProperlyDone = {
  ...candidateV1,
  evidence_completeness: 'full',
  pipeline_trace: ['router_constraint', 'middleware_stack', 'controller_ancestors',
                   'framework_convention', 'before_actions', 'policy_check',
                   'model_scope', 'sink'],
  runtime_verification_command: 'curl -b "session=NON_ADMIN" http://target/admin/broadcast_messages',
  expected_true_positive_signature: 'HTTP 200 + body contains "Broadcast Messages"',
  expected_false_positive_signature: 'HTTP 404 with X-Gitlab-Custom-Error, or HTTP 302 to /users/sign_in',
}
const vProper = ec.validateCandidateSchema(candidateProperlyDone)
ok('properly-documented candidate is valid schema', vProper.valid, JSON.stringify(vProper.errors))
const cappedProper = ec.capSeverity('Critical', candidateProperlyDone.evidence_completeness)
ok('full + pipeline_trace ≥ 3 allows Critical', cappedProper.cappedSeverity === 'Critical' && !cappedProper.wasCapped)

// Step 5: Key regression assertion — if we replay 2026-04-23 unreformed candidate,
// the report CANNOT render it as Critical (would have been 4 Critical findings).
ok('2026-04-23 replay: DH-AC-001 renders as Low (not Critical)', capped.cappedSeverity === 'Low')

console.log('\n' + passed + ' passed, ' + failed + ' failed')
process.exit(failed ? 1 : 0)
