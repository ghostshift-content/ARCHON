// test/event-bus-phase-3-9-wiring.test.js
//
// Module-level grep test confirming Phase 3.9 (Judge Verifier) is wired
// between Phase 3.8 (browser-verifier) and Phase 4 (VYASA) in event-bus.js.
//
// Why a grep test, not a runtime test: event-bus.js is a long-running daemon
// with side-effecting init; integration testing it would require spinning up
// a full pipeline. A structural grep test is sufficient to catch accidental
// removal or reordering of the Phase 3.9 block.
//
// Spec: docs/superpowers/specs/2026-05-07-G1-phase-2-event-bus-wiring.md

const assert = require('node:assert')
const { test } = require('node:test')
const fs = require('node:fs')
const path = require('node:path')

const EVENT_BUS = fs.readFileSync(
  path.resolve(__dirname, '..', 'event-bus.js'),
  'utf-8',
)

test('event-bus.js mentions Phase 3.9 (Judge Verifier)', () => {
  assert.match(EVENT_BUS, /Phase 3\.9/, 'must declare Phase 3.9')
  assert.match(EVENT_BUS, /Judge Verifier|judge-verifier|run-judge-verifier/i,
    'must reference the judge module')
})

test('event-bus.js calls runJudge from scripts/run-judge-verifier', () => {
  assert.match(EVENT_BUS, /run-judge-verifier/, 'must require the runner')
  assert.match(EVENT_BUS, /\brunJudge\s*\(/, 'must call runJudge()')
})

test('event-bus.js Phase 3.9 hook sits between Phase 3.8 and Phase 4', () => {
  const idx38 = EVENT_BUS.indexOf('PHASE 3.8')
  const idx39 = EVENT_BUS.search(/PHASE 3\.9|Phase 3\.9: Judge Verifier/)
  const idx4 = EVENT_BUS.indexOf('PHASE 4: Report')
  assert.ok(idx38 > 0, 'Phase 3.8 marker present')
  assert.ok(idx39 > 0, 'Phase 3.9 marker present')
  assert.ok(idx4 > 0, 'Phase 4 marker present')
  assert.ok(idx38 < idx39, 'Phase 3.9 must come AFTER Phase 3.8')
  assert.ok(idx39 < idx4, 'Phase 3.9 must come BEFORE Phase 4 VYASA')
})

test('event-bus.js Phase 3.9 has env-flag rollback path', () => {
  // KURUKSHETRA_PHASE_3_9 disabled → skip the hook (rollback for emergencies)
  assert.match(EVENT_BUS, /KURUKSHETRA_PHASE_3_9/, 'must support env-flag rollback')
})

test('event-bus.js Phase 3.9 is fail-soft (try/catch wrap)', () => {
  // The hook must be inside a try/catch so an LLM error doesn't kill the dispatch.
  // Grep for 'Phase 3.9' followed within ~50 lines by a catch block.
  const phase39Match = EVENT_BUS.match(/PHASE 3\.9[\s\S]{0,3000}?\}\s*catch\s*\(/i)
  assert.ok(phase39Match, 'Phase 3.9 hook must be wrapped in try/catch (fail-soft)')
})

test('event-bus.js Phase 3.9 uses Critical/High severity filter (promotion mode)', () => {
  // 2026-05-12: Anchor to the literal hook marker `PHASE 3.9:` (with colon)
  // so earlier comments mentioning "Phase 3.9" don't confuse the slice.
  // Severity filtering is implemented via promotionMode (Sprint Promotion-1):
  // Critical/High get standard judging, Medium gets the stricter promotion
  // rubric. The cost-optimization is in PROMOTION_CAP, not a hard severity
  // filter — the test now validates the promotion-gate wiring instead.
  const phase39Region = EVENT_BUS.match(/PHASE 3\.9:[\s\S]{0,5000}?PHASE 4/i)?.[0] || ''
  assert.ok(phase39Region.length > 100, 'Phase 3.9: block not found')
  assert.match(phase39Region, /promotionMode|severityFilter|Critical.*High|High.*Critical/,
    'Phase 3.9 must filter via promotionMode or explicit severity filter')
})
