#!/usr/bin/env node

const __roots = require('../paths') // portable roots (KURU_*_ROOT) — see paths.js
// Guard: ARBITER verification prompt must include
//   (a) both action + details (not just truncated action)
//   (b) VALIDATED-FINDINGS.jsonl structured block for pentest tasks
// These ensure ARBITER has enough evidence to reproduce findings precisely
// instead of running generic probes. Regression guard for 2026-04-23 fix.
// Run: node /root/agents/test/arbiter-verify-prompt.test.js

const fs = require('fs')

let passed = 0, failed = 0
function ok(label, cond) {
  if (cond) { console.log(`  ✓ ${label}`); passed++ }
  else      { console.log(`  ✗ ${label}`); failed++ }
}

console.log('ARBITER verify-prompt tests:')

const src = fs.readFileSync((__roots.AGENTS_ROOT + '/event-bus.js'), 'utf-8')

// (1) The verification builder must include the details field, not just the action headline.
//     Before the 2026-04-23 fix, line was: `[${e.agent}] ${(e.action || '').slice(0, 200)}`
//     After fix it includes a details segment: `└─ ${details}`.
ok('verify prompt includes finding details (└─ marker)', src.includes('└─ ${details}'))

// (2) The verification builder must reference VALIDATED-FINDINGS.jsonl for structured data.
ok('verify prompt loads VALIDATED-FINDINGS.jsonl for pentest squad', /VALIDATED-FINDINGS\.jsonl/.test(src))
ok('structured findings block is gated by squad=pentest', /String\(squad\)\.includes\('pentest'\)/.test(src))
ok('structuredFindings interpolated into verificationPrompt',
   /\$\{taskActivity\}\s*\n\$\{structuredFindings\}/.test(src))

// (3) The prompt still hard-requires independent reproduction (unchanged instruction).
ok('independence instruction still present', src.includes('REPRODUCE IT YOURSELF'))
ok('verify command + exact output still required', /run an actual command\/probe to verify/i.test(src))

// (4) ARBITER must NOT read the goal text (goal-leak isolation).
//     The verification prompt builder does not include goalContext parameter.
const verifyBuilder = src.match(/const verificationPrompt = `[\s\S]{0,4000}/)
ok('verification prompt builder exists', !!verifyBuilder)
if (verifyBuilder) {
  ok('verify prompt does NOT embed goalContext', !/goalContext|USER GOAL:/.test(verifyBuilder[0]))
  ok('verify prompt does NOT embed baseline numbers',
     !/\b\d+\s+(?:CRIT|HIGH|MED|LOW)\b.*\+/.test(verifyBuilder[0]))
}

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed > 0 ? 1 : 0)
