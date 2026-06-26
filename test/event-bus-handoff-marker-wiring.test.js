// test/event-bus-handoff-marker-wiring.test.js
//
// Sprint C.2 follow-up (2026-05-10): module-level grep tests confirming
// the handoff-marker post-processor is wired into the UNIVERSAL spawnAgent
// path in event-bus.js — NOT inside a pentest-only block.
//
// Same framework-wide discipline as the trajectory observer wiring: every
// squad (pentest, cloud-security, network-pentest, code-review, stocks)
// funnels through spawnAgent, so hooking the resolve path covers all of
// them with zero per-squad changes.

const assert = require('node:assert')
const { test } = require('node:test')
const fs = require('node:fs')
const path = require('node:path')

const SRC = fs.readFileSync(path.resolve(__dirname, '..', 'event-bus.js'), 'utf-8')

test('event-bus.js requires handoff-marker-parser module', () => {
  assert.match(SRC, /require\(['"]\.\/agents\/handoff-marker-parser['"]\)/,
    "event-bus.js must require './agents/handoff-marker-parser'")
})

test('event-bus.js calls extractHandoffMarkers', () => {
  assert.match(SRC, /extractHandoffMarkers\s*\(/,
    'extractHandoffMarkers must be invoked in event-bus.js')
})

test('extractHandoffMarkers call is fail-soft (try/catch wrapping)', () => {
  const idx = SRC.indexOf('extractHandoffMarkers(')
  assert.ok(idx > 0, 'extractHandoffMarkers call site not found')
  // 1500-char window each side — the post-processor body (per-marker dedup +
  // createHandoff + logging) takes a few hundred characters, then we close
  // with the outer `catch (_markerErr)` block. Matching either bare `catch {`
  // or `catch (...)` both satisfy the fail-soft invariant.
  const before = SRC.slice(Math.max(0, idx - 1500), idx)
  const after = SRC.slice(idx, idx + 1500)
  const hasTryBefore = /try\s*\{/.test(before)
  const hasCatchAfter = /catch\s*[\({]/.test(after) || /\.catch\s*\(/.test(after)
  assert.ok(hasTryBefore && hasCatchAfter,
    'extractHandoffMarkers call must be wrapped in try/catch (fail-soft)')
})

test('marker post-processor is wired in spawnAgent path (framework-wide)', () => {
  const spawnAgentIdx = SRC.indexOf('function spawnAgent')
  assert.ok(spawnAgentIdx > 0, 'function spawnAgent must exist in event-bus.js')
  const extractIdx = SRC.indexOf('extractHandoffMarkers(')
  // The extractHandoffMarkers call must live INSIDE spawnAgent. Compute
  // spawnAgent's end as the next top-level `function` declaration.
  const nextFnIdx = SRC.indexOf('\nfunction ', spawnAgentIdx + 50)
  const spawnAgentEnd = nextFnIdx > 0 ? nextFnIdx : SRC.length
  assert.ok(extractIdx > spawnAgentIdx && extractIdx < spawnAgentEnd,
    `extractHandoffMarkers must be inside spawnAgent (idx ${extractIdx} not in [${spawnAgentIdx}, ${spawnAgentEnd}])`)
})

test('marker post-processor wiring is NOT nestled inside pentest-only block', () => {
  // The wiring should be ABOVE / OUTSIDE any "Phase 2a:" pentest-specific
  // block. Same rule we apply to the trajectory observer.
  const extractIdx = SRC.indexOf('extractHandoffMarkers(')
  const phase2aIdx = SRC.indexOf('Phase 2a:')
  const phase2dIdx = SRC.indexOf('Phase 2d:')
  const inPhase2Block = phase2aIdx > 0
    && extractIdx > phase2aIdx
    && phase2dIdx > 0
    && extractIdx < phase2dIdx + 5000
  assert.ok(!inPhase2Block,
    'extractHandoffMarkers wiring must NOT be inside pentest Phase 2 block — must be framework-wide')
})

test('marker post-processor is near trajectory observer wiring (lives in same universal spawnAgent hook region)', () => {
  // Soft locality test: both observer + marker post-processor should live
  // in the same spawnAgent resolve path so future maintainers see them
  // together. Allow up to 6KB drift to accommodate other unrelated code.
  const obsIdx = SRC.indexOf('observeSpecialistOutput(')
  const extractIdx = SRC.indexOf('extractHandoffMarkers(')
  assert.ok(obsIdx > 0, 'observeSpecialistOutput call must exist')
  assert.ok(extractIdx > 0, 'extractHandoffMarkers call must exist')
  const drift = Math.abs(extractIdx - obsIdx)
  assert.ok(drift < 6000,
    `marker post-processor must live close to trajectory observer wiring (drift ${drift} > 6000)`)
})

test('A2A_HANDOFF_SECTION mentions <<HANDOFF marker syntax', () => {
  const m = SRC.match(/const\s+A2A_HANDOFF_SECTION\s*=\s*`((?:\\`|[\s\S])*?)`/)
  assert.ok(m, 'A2A_HANDOFF_SECTION constant must be defined')
  const section = m[1]
  assert.match(section, /<<HANDOFF/,
    'A2A_HANDOFF_SECTION must teach the marker syntax (<<HANDOFF)')
  assert.match(section, />>/,
    'A2A_HANDOFF_SECTION must show the closing >> marker')
})

test('A2A_HANDOFF_SECTION drops the obsolete "run --create CLI" instruction', () => {
  // NO MARKDOWN FALLBACK: the section must NOT instruct specialists to
  // shell out to `process-handoff.js --create` (that's the gap we are
  // fixing). The post-processor does the JSON drop automatically.
  const m = SRC.match(/const\s+A2A_HANDOFF_SECTION\s*=\s*`((?:\\`|[\s\S])*?)`/)
  assert.ok(m)
  const section = m[1]
  assert.ok(!/node\s+\/root\/agents\/scripts\/process-handoff\.js\s+--create/.test(section),
    'A2A_HANDOFF_SECTION must NOT instruct specialists to run process-handoff.js --create (use marker instead)')
})

test('A2A_HANDOFF_SECTION still preserves anti-sycophancy warning', () => {
  const m = SRC.match(/const\s+A2A_HANDOFF_SECTION\s*=\s*`((?:\\`|[\s\S])*?)`/)
  assert.ok(m)
  const section = m[1]
  assert.match(section, /raw artefacts|raw evidence|no analyst|sycophan/i,
    'anti-sycophancy guidance must remain in the section')
})

test('marker dedup happens at wiring layer (post-processor block references _dedupKey)', () => {
  // The wiring layer must dedupe identical markers within the same task —
  // a single specialist emitting the same marker twice should not create
  // two handoffs. Either we use the parser's _dedupKey property OR a
  // Set/Map keyed by (target_squad,target_capability,source_finding_id,question).
  const extractIdx = SRC.indexOf('extractHandoffMarkers(')
  // Look at the ~2KB region right after the call.
  const region = SRC.slice(extractIdx, extractIdx + 2500)
  const hasDedup = /_dedupKey/.test(region)
    || /seen\s*\.\s*has/.test(region)
    || /new\s+Set/.test(region)
  assert.ok(hasDedup,
    'marker post-processor must dedupe identical markers (look for _dedupKey or a Set/Map)')
})
