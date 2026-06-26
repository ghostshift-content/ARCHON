#!/usr/bin/env node
// Unit tests for threat-model discipline v2. Pure functions, no I/O.
// Tests the new severity caps added on top of evidence-completeness v1.

const ec = require('../src/pipeline/evidence-completeness')

let passed = 0, failed = 0
function ok(label, cond, extra = '') {
  if (cond) { console.log(`  ✓ ${label}`); passed++ }
  else      { console.log(`  ✗ ${label}${extra ? ' — ' + extra : ''}`); failed++ }
}

console.log('threat-model tests:')

// Constants
ok('ATTACKER_PRIVILEGE_CAPS defined', ec.ATTACKER_PRIVILEGE_CAPS && typeof ec.ATTACKER_PRIVILEGE_CAPS === 'object')
ok('TRUST_BOUNDARY_MODIFIERS defined', ec.TRUST_BOUNDARY_MODIFIERS && typeof ec.TRUST_BOUNDARY_MODIFIERS === 'object')
ok('admin caps at Medium', ec.ATTACKER_PRIVILEGE_CAPS.admin === 'Medium')
ok('superuser caps at Low', ec.ATTACKER_PRIVILEGE_CAPS.superuser === 'Low')
ok('unauth has no cap (null)', ec.ATTACKER_PRIVILEGE_CAPS.unauth === null)

// capSeverityByThreatModel basic sub-rules
ok('admin + none boundary → Low (stacked -1)', ec.capSeverityByThreatModel('Critical', {
  attacker_privilege: 'admin',
  trust_boundary_crossed: 'none',
  documented_as_intended: false,
  toolchain_presence_verified: null,
  validation_layers_checked: [],
}).cappedSeverity === 'Low')

ok('admin + privilege-escalation boundary → High (admin cap undone)', ec.capSeverityByThreatModel('Critical', {
  attacker_privilege: 'admin',
  trust_boundary_crossed: 'privilege-escalation',
  documented_as_intended: false,
  toolchain_presence_verified: null,
  validation_layers_checked: [],
}).cappedSeverity === 'High')

ok('authenticated + cross-user → Critical uncapped', ec.capSeverityByThreatModel('Critical', {
  attacker_privilege: 'authenticated',
  trust_boundary_crossed: 'cross-user',
  documented_as_intended: false,
  toolchain_presence_verified: null,
  validation_layers_checked: [],
}).cappedSeverity === 'Critical')

// Stacking: admin + documented_as_intended → Medium then -1 = Low
ok('admin + documented → Low (Medium cap, -1 tier)', ec.capSeverityByThreatModel('Critical', {
  attacker_privilege: 'admin',
  trust_boundary_crossed: 'cross-user',
  documented_as_intended: true,
  toolchain_presence_verified: null,
  validation_layers_checked: [],
}).cappedSeverity === 'Low')

// Full stack — admin + none + documented → Informational
ok('admin + none + documented → Informational', ec.capSeverityByThreatModel('Critical', {
  attacker_privilege: 'admin',
  trust_boundary_crossed: 'none',
  documented_as_intended: true,
  toolchain_presence_verified: null,
  validation_layers_checked: [],
}).cappedSeverity === 'Informational')

// Toolchain cap only applies when claim depends on toolchain
ok('toolchain=false but not a toolchain claim → not capped',
   ec.capSeverityByThreatModel('High', {
     attacker_privilege: 'authenticated',
     trust_boundary_crossed: 'cross-user',
     documented_as_intended: false,
     toolchain_presence_verified: false,
     validation_layers_checked: ['router','middleware','controller'],
   }, { claimDependsOnToolchain: false }).cappedSeverity === 'High')

ok('toolchain=false + claim depends on toolchain → Low', ec.capSeverityByThreatModel('High', {
  attacker_privilege: 'authenticated',
  trust_boundary_crossed: 'cross-user',
  documented_as_intended: false,
  toolchain_presence_verified: false,
  validation_layers_checked: [],
}, { claimDependsOnToolchain: true }).cappedSeverity === 'Low')

// validation_layers_checked cap — only applies to validation-gap claims
ok('validation < 3 layers on validation-gap claim → Medium', ec.capSeverityByThreatModel('High', {
  attacker_privilege: 'authenticated',
  trust_boundary_crossed: 'cross-user',
  documented_as_intended: false,
  toolchain_presence_verified: null,
  validation_layers_checked: ['controller'],
}, { claimIsValidationGap: true }).cappedSeverity === 'Medium')

ok('validation <3 but not a validation claim → not capped',
   ec.capSeverityByThreatModel('High', {
     attacker_privilege: 'authenticated',
     trust_boundary_crossed: 'cross-user',
     documented_as_intended: false,
     toolchain_presence_verified: null,
     validation_layers_checked: ['controller'],
   }, { claimIsValidationGap: false }).cappedSeverity === 'High')

// Audit trail
const multi = ec.capSeverityByThreatModel('Critical', {
  attacker_privilege: 'admin',
  trust_boundary_crossed: 'none',
  documented_as_intended: true,
  toolchain_presence_verified: null,
  validation_layers_checked: [],
})
ok('audit trail records >= 3 applied rules', multi.appliedRules.length >= 3)
ok('reason string contains all three rule names',
   multi.reason.includes('attacker_privilege') &&
   multi.reason.includes('trust_boundary_crossed') &&
   multi.reason.includes('documented_as_intended'))

// Schema validator — incoherence detection
ok('validateThreatModelSchema accepts well-formed object', ec.validateThreatModelSchema({
  attacker_privilege: 'admin',
  trust_boundary_crossed: 'none',
  documented_as_intended: false,
  toolchain_presence_verified: null,
  validation_layers_checked: [],
}).valid)

ok('validateThreatModelSchema rejects invalid privilege',
   !ec.validateThreatModelSchema({ attacker_privilege: 'god-mode' }).valid)

ok('validateThreatModelSchema rejects invalid boundary',
   !ec.validateThreatModelSchema({ trust_boundary_crossed: 'imaginary-layer' }).valid)

ok('validateThreatModelSchema flags admin-URL+unauth incoherence',
   !ec.validateThreatModelSchema({
     attacker_privilege: 'unauth',
   }, { file: 'app/controllers/admin/users_controller.rb' }).valid)

ok('validateThreatModelSchema missing field returns SAFE defaults', (() => {
  const r = ec.validateThreatModelSchema(undefined)
  return r.valid && r.normalized &&
         r.normalized.documented_as_intended === true &&
         r.normalized.validation_layers_checked.length === 0
})())

// composeAllCaps — v1 + v2 stacking
ok('composeAllCaps: full evidence + admin + none → Low',
   ec.composeAllCaps('Critical', 'full', {
     attacker_privilege: 'admin',
     trust_boundary_crossed: 'none',
     documented_as_intended: false,
     toolchain_presence_verified: null,
     validation_layers_checked: [],
   }).finalSeverity === 'Low')

ok('composeAllCaps: local_only + admin → Low (same, both cap at Low)',
   ec.composeAllCaps('Critical', 'local_only', {
     attacker_privilege: 'admin',
     trust_boundary_crossed: 'cross-user',
     documented_as_intended: false,
     toolchain_presence_verified: null,
     validation_layers_checked: [],
   }).finalSeverity === 'Low')

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)
