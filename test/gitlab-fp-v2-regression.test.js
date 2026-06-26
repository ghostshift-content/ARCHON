#!/usr/bin/env node
// Regression: replays 5 CONFIRMED findings from the 2026-04-23 GitLab live
// verification. Asserts v2 threat-model discipline assigns realistic severity
// caps matching what GitLab's security team would actually accept.
//
// Context: today's live verification found 0/13 findings acceptable at
// Critical/High by realistic vendor triage. v2 discipline collapses these
// to their honest tiers.

const ec = require('../src/pipeline/evidence-completeness')

let passed = 0, failed = 0
function ok(l, c, extra = '') { if (c) { console.log('  ✓ ' + l); passed++ } else { console.log('  ✗ ' + l + (extra ? ' — ' + extra : '')); failed++ } }

console.log('GitLab v2 FP-regression — 5 CONFIRMED findings from 2026-04-23:')

// VI-AC-001 silent email change (claimed High)
// Reality: admin feature, boundary=none, documented as admin rescue
const r1 = ec.composeAllCaps('High', 'full', {
  attacker_privilege: 'admin',
  trust_boundary_crossed: 'none',
  documented_as_intended: true,
  toolchain_presence_verified: null,
  validation_layers_checked: ['controller', 'model'],
})
ok('VI-AC-001 silent email change → Informational (was High)',
   r1.finalSeverity === 'Informational',
   `got ${r1.finalSeverity} via ${r1.reason}`)

// VI-AC-002 silent 2FA destroy — same shape
const r2 = ec.composeAllCaps('High', 'full', {
  attacker_privilege: 'admin',
  trust_boundary_crossed: 'none',
  documented_as_intended: true,
  toolchain_presence_verified: null,
  validation_layers_checked: [],
})
ok('VI-AC-002 silent 2FA destroy → Informational',
   r2.finalSeverity === 'Informational',
   `got ${r2.finalSeverity}`)

// VI-AC-003 OAuth identity injection — admin CAN escalate (attacker gains new login path)
const r3 = ec.composeAllCaps('High', 'full', {
  attacker_privilege: 'admin',
  trust_boundary_crossed: 'privilege-escalation',
  documented_as_intended: false,
  toolchain_presence_verified: null,
  validation_layers_checked: ['controller', 'model'],
})
ok('VI-AC-003 OAuth identity injection → High (admin cap undone by escalation)',
   r3.finalSeverity === 'High',
   `got ${r3.finalSeverity}`)

// BA-SS-001 allow_local_requests default = true
const r4 = ec.composeAllCaps('High', 'full', {
  attacker_privilege: 'admin',
  trust_boundary_crossed: 'none',
  documented_as_intended: true,
  toolchain_presence_verified: null,
  validation_layers_checked: [],
})
ok('BA-SS-001 SSRF default=true → Informational (documented tradeoff)',
   r4.finalSeverity === 'Informational',
   `got ${r4.finalSeverity}`)

// BA-SS-002 hook test reflection
const r5 = ec.composeAllCaps('High', 'full', {
  attacker_privilege: 'admin',
  trust_boundary_crossed: 'none',
  documented_as_intended: true,
  toolchain_presence_verified: null,
  validation_layers_checked: [],
})
ok('BA-SS-002 hook test reflection → Informational',
   r5.finalSeverity === 'Informational',
   `got ${r5.finalSeverity}`)

// DR-RC-001 ImageTragick — toolchain NOT verified
const r6 = ec.composeAllCaps('High', 'full', {
  attacker_privilege: 'admin',
  trust_boundary_crossed: 'none',
  documented_as_intended: false,
  toolchain_presence_verified: false,
  validation_layers_checked: [],
}, { claimDependsOnToolchain: true })
ok('DR-RC-001 ImageTragick (toolchain unverified) → Low',
   r6.finalSeverity === 'Low',
   `got ${r6.finalSeverity}`)

// VI-AC-004 impersonation token scopes — only controller inspected
const r7 = ec.composeAllCaps('High', 'full', {
  attacker_privilege: 'admin',
  trust_boundary_crossed: 'cross-user',
  documented_as_intended: false,
  toolchain_presence_verified: null,
  validation_layers_checked: ['controller'],
}, { claimIsValidationGap: true })
ok('VI-AC-004 impersonation scopes (only controller checked) → Medium',
   r7.finalSeverity === 'Medium',
   `got ${r7.finalSeverity}`)

console.log('')
const newFinals = [r1, r2, r3, r4, r5, r6, r7].map(r => r.finalSeverity)
ok('v2 scorecard: all admin-design findings → Informational/Low, escalation → High',
   newFinals.filter(s => s === 'Critical').length === 0 &&
   newFinals.filter(s => s === 'High').length === 1,
   `got ${newFinals.join(', ')}`)

// Schema validator incoherence check
ok('schema rejects admin-URL + unauth incoherence',
   !ec.validateThreatModelSchema({
     attacker_privilege: 'unauth',
   }, { file: 'app/controllers/admin/users_controller.rb' }).valid)

ok('missing threat_model → SAFE defaults', (() => {
  const r = ec.validateThreatModelSchema(undefined)
  return r.valid && r.normalized.attacker_privilege === 'admin' &&
         r.normalized.documented_as_intended === true
})())

console.log('\n' + passed + ' passed, ' + failed + ' failed')
process.exit(failed ? 1 : 0)
