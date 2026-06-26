// test/specialist-prompt-handoff.test.js
//
// Sprint C.2 Task 6 (2026-05-10): module-level grep tests confirming
// buildSpecialistPrompt teaches Phase 2 specialists how to fire a
// cross-squad handoff into /root/intel/handoffs/inbox/.
//
// Without this section, the Sprint C.2 watcher (already LIVE) has no input —
// no specialist would ever know to write a handoff JSON.
//
// Spec: docs/superpowers/specs/2026-05-10-sprint-c2-a2a-design.md
// Locked decisions: max 3 handoffs per finding, evidence is raw artefacts
// only (no analyst opinion — anti-sycophancy).
//
// Implementation choice (2026-05-10): teaching block is extracted into a
// top-level constant `A2A_HANDOFF_SECTION` and injected into all four
// specialist prompt builders (pentest, cloud, network, code-review). Tests
// validate (a) the constant carries the required teaching, AND (b) the
// target function body interpolates it.

const assert = require('node:assert')
const { test } = require('node:test')
const fs = require('node:fs')

const SRC = fs.readFileSync(__dirname + '/../event-bus.js', 'utf-8')

function getFunctionBody(fnName) {
  const start = SRC.indexOf(`function ${fnName}`)
  assert.ok(start > 0, `${fnName} not found in event-bus.js`)
  const next = SRC.indexOf('\nfunction ', start + fnName.length + 10)
  return SRC.slice(start, next > 0 ? next : start + 8000)
}

function getA2aSection() {
  // Extract the A2A_HANDOFF_SECTION constant body.
  // The section contains escaped backticks (\`...\`) inside the template
  // literal — naive non-greedy `([\s\S]*?)` stops at the first `\``. Allow
  // either an escaped backtick OR any single character so the extractor
  // walks past internal backticks and only halts at the unescaped closing one.
  const m = SRC.match(/const\s+A2A_HANDOFF_SECTION\s*=\s*`((?:\\`|[\s\S])*?)`/)
  assert.ok(m, 'A2A_HANDOFF_SECTION constant must be defined in event-bus.js')
  return m[1]
}

test('buildSpecialistPrompt result includes a HANDOFF section (via A2A_HANDOFF_SECTION)', () => {
  const body = getFunctionBody('buildSpecialistPrompt')
  assert.match(body, /A2A_HANDOFF_SECTION|HANDOFF|handoff/,
    'buildSpecialistPrompt body must reference the HANDOFF teaching block')
  // And the constant itself must contain the heading.
  const section = getA2aSection()
  assert.match(section, /HANDOFF|handoff/,
    'A2A_HANDOFF_SECTION must contain the HANDOFF heading')
})

test('handoff section names the inbox path /root/intel/handoffs/inbox/', () => {
  const section = getA2aSection()
  assert.match(section, /\/root\/intel\/handoffs\/inbox/,
    'must name the inbox path so specialists know where to drop the JSON')
})

test('handoff section names a representative target capability', () => {
  const section = getA2aSection()
  assert.match(section, /data-residency|iam-audit|s3-bucket-audit|dns-attribution/,
    'must reference a target-squad capability so specialists know what to ask for')
})

test('handoff section warns against analyst notes in evidence (anti-sycophancy)', () => {
  const section = getA2aSection()
  assert.match(section, /raw artefacts|raw evidence|no analyst|no opinion|don't.+include.+(opinion|conclusion|analyst)|not.+(include|put).+(analysis|opinion|conclusion)|sycophantic|anti-sycophancy/i,
    'must teach anti-sycophancy: handoff request.evidence carries raw artefacts only')
})

test('handoff section enforces the max-3-handoffs-per-finding rule', () => {
  const section = getA2aSection()
  assert.match(section, /max.{0,8}3|3.{0,15}handoffs|MAX_HANDOFFS/i,
    'must state the max-3-per-finding constraint')
})

test('handoff section is concise (≤60 lines of content, focused pointer)', () => {
  // 2026-05-10: cap raised from 50 → 60 after commit 14bcdb4 added a worked
  // JSON example inline (per pentest 1778394458903 — FORGE wrote a
  // markdown sibling because the previous one-line `--create '<handoff-json>'`
  // helper left specialists reverse-engineering the JSON schema). The worked
  // example is intentional UX, but we still cap to keep the section a focused
  // pointer rather than a treatise. We trim leading/trailing blank-line
  // artefacts of the multiline template literal before counting.
  const section = getA2aSection().replace(/^\n+|\n+$/g, '')
  const lines = section.split('\n').length
  assert.ok(lines <= 60,
    `A2A_HANDOFF_SECTION is ${lines} lines — must stay concise (≤60 lines) per spec`)
})

test('HANDOFF teaching is framework-wide — buildSpecialistPrompt injects it unconditionally', () => {
  const body = getFunctionBody('buildSpecialistPrompt')
  // The template literal must reference A2A_HANDOFF_SECTION.
  assert.match(body, /\$\{A2A_HANDOFF_SECTION\}/,
    'buildSpecialistPrompt must interpolate A2A_HANDOFF_SECTION into its return value')
  // Anti-pattern: the interpolation should NOT be inside an `if (squad === '<one-squad>')`
  // branch. We assert it sits in the top-level `return \`...\`` template.
  const idx = body.indexOf('${A2A_HANDOFF_SECTION}')
  const before = body.slice(0, idx)
  const lastIf = before.lastIndexOf('if (')
  if (lastIf >= 0) {
    const sliceBetween = before.slice(lastIf)
    const opens = (sliceBetween.match(/\{/g) || []).length
    const closes = (sliceBetween.match(/\}/g) || []).length
    if (opens > closes && /squad\s*===\s*['"][a-z-]+['"]/.test(sliceBetween.slice(0, 200))) {
      assert.fail('A2A_HANDOFF_SECTION interpolation appears to be inside `if (squad === "<one>")` — must be framework-wide')
    }
  }
})
