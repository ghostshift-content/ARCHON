const assert = require('node:assert')
const { test } = require('node:test')
const fs = require('node:fs')

const SRC = fs.readFileSync(__dirname + '/../event-bus.js', 'utf-8')

// Regression guard for the "every full-roster scan aborts after Wave 1" bug.
//
// Wave 2 builds its specialist prompt as:
//   const prompt = basePrompt + (_batch1Critique || '') + (_fastVerifiedContext || '')
// `_fastVerifiedContext` is produced by Phase 2.5 (fast-verify), whose own comment
// says it "Runs BEFORE wave 2." A bad merge once buried the Phase 2.5 block (and its
// `let _fastVerifiedContext` declaration) inside the LATER "Conditional Batch 5" try,
// so Wave 2 referenced an identifier that wasn't declared in scope yet → ReferenceError
// → swallowed by the outer fail-soft catch → no Wave 2, no AUDITOR, no judge, no report.
// Focused scans (no Wave 2) survived, which is why it hid. These tests pin the ordering.

const DECL = "let _fastVerifiedContext = ''"
const WAVE2_REF = "const prompt = basePrompt + (_batch1Critique || '') + (_fastVerifiedContext || '')"
const PHASE25_BANNER = '// ── Phase 2.5: Fast-verify'
const WAVE2_BANNER = '// Wave 2: second-half specialists in parallel'
const CONDITIONAL_BATCH = '// ── Conditional Batch 5:'

test('_fastVerifiedContext is declared exactly once', () => {
  const matches = SRC.match(/let _fastVerifiedContext = ''/g) || []
  assert.strictEqual(matches.length, 1, 'expected a single declaration of _fastVerifiedContext')
})

test('_fastVerifiedContext is declared BEFORE Wave 2 consumes it', () => {
  const idxDecl = SRC.indexOf(DECL)
  const idxRef = SRC.indexOf(WAVE2_REF)
  assert.ok(idxDecl > 0, 'Phase 2.5 declaration missing')
  assert.ok(idxRef > 0, 'Wave 2 reference to _fastVerifiedContext missing')
  assert.ok(idxDecl < idxRef, 'declaration must precede the Wave 2 reference (else ReferenceError aborts the scan)')
})

test('Phase 2.5 runs BEFORE Wave 2, which runs BEFORE Conditional Batch 5', () => {
  const idxPhase25 = SRC.indexOf(PHASE25_BANNER)
  const idxWave2 = SRC.indexOf(WAVE2_BANNER)
  const idxConditional = SRC.indexOf(CONDITIONAL_BATCH)
  assert.ok(idxPhase25 > 0, 'Phase 2.5 banner missing')
  assert.ok(idxWave2 > 0, 'Wave 2 banner missing')
  assert.ok(idxConditional > 0, 'Conditional Batch 5 banner missing')
  assert.ok(idxPhase25 < idxWave2, 'Phase 2.5 must come BEFORE Wave 2')
  assert.ok(idxWave2 < idxConditional, 'Wave 2 must come BEFORE Conditional Batch 5')
})

test('the Phase 2.5 declaration is not buried inside Conditional Batch 5', () => {
  const idxDecl = SRC.indexOf(DECL)
  const idxConditional = SRC.indexOf(CONDITIONAL_BATCH)
  assert.ok(idxDecl < idxConditional, 'Phase 2.5 declaration must live above Conditional Batch 5')
})
