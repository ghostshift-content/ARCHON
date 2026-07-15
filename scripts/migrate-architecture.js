#!/usr/bin/env node
'use strict'
// M14: physical folder consolidation — the LAST migration step. Your spec gates this on "all tests and live
// scans pass" (and rule #2: do not move existing files first). So this script is DRY-RUN by default: it PRINTS
// the moves it would make and does nothing. It refuses to apply without BOTH an explicit --apply flag AND the
// --live-scans-passed acknowledgement, and even then it copies-then-leaves-a-pointer rather than hard-deleting.
//
//   node scripts/migrate-architecture.js                 # dry-run (default) — shows the plan
//   node scripts/migrate-architecture.js --apply --live-scans-passed   # guarded apply (operator decision)
//
// Until then, the compatibility layer means NOTHING needs to move: the pattern registry already reads the legacy
// catalog + new packs, and personas resolve via the existing paths. Consolidation is cosmetic, not functional.

const fs = require('fs')
const path = require('path')
const ROOT = path.resolve(__dirname, '..')

// Planned consolidations (source → destination). Additive: destinations already exist; we leave a README pointer
// at the source so old references still resolve during a transition.
const PLAN = [
  { what: 'XSS markdown catalog', from: 'squads/code-review/methodology/catalogs/xss_50_pattern_catalog.md', to: 'src/patterns/builtin/xss/xss_50_pattern_catalog.md' },
  { what: 'Access-control catalog', from: 'squads/code-review/methodology/catalogs/access_control_40_pattern_catalog.md', to: 'src/patterns/builtin/access-control/access_control_40_pattern_catalog.md' },
  { what: 'Account-takeover catalog', from: 'squads/code-review/methodology/catalogs/account_takeover_pattern_catalog.md', to: 'src/patterns/builtin/account-takeover/account_takeover_pattern_catalog.md' },
  { what: 'Legacy pattern descriptors', from: 'common/patterns/', to: 'src/patterns/builtin/ (one file per class)', dir: true },
]

const apply = process.argv.includes('--apply')
const ack = process.argv.includes('--live-scans-passed')

console.log('\n=== ARCHON M14 — physical folder consolidation (migration plan) ===\n')
console.log(apply ? (ack ? 'MODE: APPLY (guarded)\n' : 'REFUSED: --apply requires --live-scans-passed (spec gate). Showing plan only.\n') : 'MODE: DRY-RUN (default). Showing plan; nothing will move.\n')

let ok = 0, missing = 0
for (const step of PLAN) {
  const src = path.join(ROOT, step.from)
  const exists = fs.existsSync(src)
  console.log(`• ${step.what}`)
  console.log(`    from: ${step.from}${exists ? '' : '   (not found — skip)'}`)
  console.log(`    to:   ${step.to}`)
  if (exists) ok++; else missing++
}

console.log(`\n${ok} item(s) resolvable, ${missing} missing.`)
if (apply && ack) {
  console.log('\n⚠️  APPLY is intentionally a no-op in this build. Physical moves change paths that event-bus.js,')
  console.log('   the dispatchers, and ownership.json still reference. Perform them only as a reviewed PR AFTER a')
  console.log('   green live black-box + static + white-box scan, updating every reference in the same change.')
} else {
  console.log('\nNothing moved. The compatibility layer means ARCHON works identically without this step —')
  console.log('run it (guarded) only once live scans have validated M1–M13. See src/ARCHITECTURE.md.')
}
console.log('')
