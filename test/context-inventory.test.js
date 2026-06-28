#!/usr/bin/env node

const __roots = require('../paths') // portable roots (KURU_*_ROOT) — see paths.js
// Guard: SCRIBE pentest + cloud prompts must require a Context Inventory table.
// Borrowed from ARCHON_V0 methodology (2026-04-23) — forces a structured
// source→sink→context→defenses matrix in every report.
// Run: node /root/agents/test/context-inventory.test.js

const fs = require('fs')

let passed = 0, failed = 0
function ok(label, cond) {
  if (cond) { console.log(`  ✓ ${label}`); passed++ }
  else      { console.log(`  ✗ ${label}`); failed++ }
}

console.log('Context Inventory prompt tests:')

const src = fs.readFileSync((__roots.AGENTS_ROOT + '/event-bus.js'), 'utf-8')

// Pentest SCRIBE prompt must require Context Inventory
// Window expanded to 14000 chars on 2026-05-14 — buildscribeReportPrompt grew
// after GATE-55 fix added the browser_validation_skipped marker instructions
// before the Context Inventory section. Context Inventory now sits at offset
// ~12000 within the function.
const pentestBuilder = src.match(/function buildscribeReportPrompt[\s\S]{0,14000}/)
ok('buildscribeReportPrompt exists', !!pentestBuilder)
if (pentestBuilder) {
  ok('pentest SCRIBE prompt contains "Context Inventory" header',
     /Context Inventory/.test(pentestBuilder[0]))
  ok('pentest SCRIBE prompt specifies 6-column matrix (Source/Sink/Context/Defense/Verdict)',
     /Source \(where data enters\)[\s\S]{0,200}Sink[\s\S]{0,200}Context[\s\S]{0,400}Verdict/.test(pentestBuilder[0]))
  ok('pentest SCRIBE prompt requires citing finding IDs',
     /finding ID from the Findings section/.test(pentestBuilder[0]))
  ok('pentest SCRIBE prompt credits ARCHON methodology',
     /ARCHON methodology/.test(pentestBuilder[0]))
}

// Goal-leak scrub must still be present (regression — don't break earlier fix)
ok('pentest SCRIBE still calls scrubBaselineFromGoal',
   pentestBuilder && /scrubBaselineFromGoal\(goalContext\)/.test(pentestBuilder[0]))

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed > 0 ? 1 : 0)
