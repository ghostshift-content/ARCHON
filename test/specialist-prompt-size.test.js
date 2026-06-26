
const __roots = require('../paths') // portable roots (KURU_*_ROOT) — see paths.js
// test/specialist-prompt-size.test.js
//
// FIX 3 (2026-05-09): specialist prompt audit — trim noise without removing
// safety-critical instructions. Lock in:
//   - upper byte ceilings as regression guards
//   - presence of REQUIRED content (HANDOFF, MUST_GATES markers, schema)
//   - absence of REMOVED content (specific bullets we cut)
//
// We render each builder's output via an extracted-helper module pattern so
// we can inspect actual rendered bytes (not just source bytes).

const assert = require('node:assert')
const { test } = require('node:test')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')

const SRC_PATH = path.resolve(__dirname, '..', 'event-bus.js')
const SRC = fs.readFileSync(SRC_PATH, 'utf-8')

function extractFn(src, name) {
  const idx = src.indexOf(`function ${name}`)
  if (idx < 0) throw new Error(`fn ${name} not found`)
  let depth = 0, started = false, end = idx
  for (let i = idx; i < src.length; i++) {
    const c = src[i]
    if (c === '{') { depth++; started = true }
    else if (c === '}') { depth--; if (started && depth === 0) { end = i + 1; break } }
  }
  return src.slice(idx, end)
}

function patch(fn) {
  return fn
    .replace(/require\(['"]\.\/agents\/handoff-protocol['"]\)/g, "require('/root/agents/agents/handoff-protocol')")
    .replace(/require\(['"]\.\/agents\/trajectory-observer['"]\)/g, "require('/root/agents/agents/trajectory-observer')")
    .replace(/require\(['"]\.\/src\/learning\/feedback-loop['"]\)/g, "require('/root/agents/src/learning/feedback-loop')")
}

function buildHelperModule() {
  const a2aMatch = SRC.match(/const\s+A2A_HANDOFF_SECTION\s*=\s*`([\s\S]*?)`/)
  if (!a2aMatch) throw new Error('A2A_HANDOFF_SECTION not found')
  const a2a = a2aMatch[1]

  let MUST_GATES = ''
  try { MUST_GATES = require((__roots.AGENTS_ROOT + '/src/core/squad-framework')).MUST_GATES || '' } catch {}

  const stubs = `
const fs = require('node:fs')
const path = require('node:path')
const agentPaths = require('${__roots.AGENTS_ROOT}/paths') // Phase-1 resolver — prompt builders reference it
function scrubBaselineFromGoal(g) { return g || '' }
function getSquadFinalReportPath() { return '/x' }
function getDisprovenContext() { return '' }
function getSquadLessons() { return '' }
function getFreshEyesNotice() { return '' }
const targetClassifier = null
const promptRenderer = null
const attackGraph = { getGraphContextForAgent: () => '' }
const A2A_HANDOFF_SECTION = ${JSON.stringify(a2a)}
const MUST_GATES = ${JSON.stringify(MUST_GATES)}
`
  const code = stubs + '\n' +
    patch(extractFn(SRC, 'buildPentestSpecialistPrompt')) + '\n' +
    patch(extractFn(SRC, 'buildCloudSpecialistPrompt')) + '\n' +
    patch(extractFn(SRC, 'buildNetworkSpecialistPrompt')) + '\n' +
    patch(extractFn(SRC, 'buildSpecialistPrompt')) + '\n' +
    'module.exports = { buildPentestSpecialistPrompt, buildCloudSpecialistPrompt, buildNetworkSpecialistPrompt, buildSpecialistPrompt };'
  const tmpPath = path.join(os.tmpdir(), `_specialist-size-${process.pid}.js`)
  fs.writeFileSync(tmpPath, code)
  return tmpPath
}

let helperPath
let H

test('setup: extract helper module', () => {
  helperPath = buildHelperModule()
  H = require(helperPath)
})

// ── Render each builder ───────────────────────────────────────────────────

function renderPentest() {
  return H.buildPentestSpecialistPrompt('viper', 'task', 't1', 'p1', 'pentest', 'goal', 'https://x.com', 'cloudflare', 'php', null)
}
function renderCloud() {
  return H.buildCloudSpecialistPrompt('agni', 'task', 't1', 'p1', 'cloud-security', 'goal', 'acct1', 'aws', ['us-east-1'])
}
function renderNetwork() {
  return H.buildNetworkSpecialistPrompt('indra', 'task', 't1', 'p1', 'network-pentest', 'goal', { cidr: '10.0.0.0/16' }, '/tmp/hosts', 'ad')
}
function renderCodeReview() {
  return H.buildSpecialistPrompt('cipher', 'task', 't1', 'p1', 'code-review', 'goal', '/src', 'react')
}

// ── Size ceilings (regression guard) ──────────────────────────────────────
//
// Pre-trim sizes (measured 2026-05-09):
//   buildPentestSpecialistPrompt: 8970 bytes
//   buildCloudSpecialistPrompt:   7196
//   buildNetworkSpecialistPrompt: 7395
//   buildSpecialistPrompt:       15579
//
// Post-trim ceilings (10% slack):

test('buildPentestSpecialistPrompt under regression ceiling', () => {
  const p = renderPentest()
  // 2026-05-14: ceiling raised 8500→9000 (EndpointModel handoff block)
  // 2026-06-05: ceiling raised 9000→10500 (GATE-13 confidence+reproduction field
  //   added to MUST_GATES — mandatory quality gate that improves ARBITER evidence)
  const ceiling = 10500
  assert.ok(p.length <= ceiling,
    `buildPentestSpecialistPrompt grew to ${p.length} bytes — ceiling is ${ceiling}`)
})

test('buildCloudSpecialistPrompt under regression ceiling', () => {
  const p = renderCloud()
  // 2026-06-05: ceiling raised 7300→8500 (GATE-13 added to MUST_GATES)
  const ceiling = 8500
  assert.ok(p.length <= ceiling,
    `buildCloudSpecialistPrompt grew to ${p.length} bytes — ceiling is ${ceiling}`)
})

test('buildNetworkSpecialistPrompt under regression ceiling', () => {
  const p = renderNetwork()
  // 2026-06-05: ceiling raised 7500→9000 (GATE-13 added to MUST_GATES)
  const ceiling = 9000
  assert.ok(p.length <= ceiling,
    `buildNetworkSpecialistPrompt grew to ${p.length} bytes — ceiling is ${ceiling}`)
})

test('buildSpecialistPrompt under regression ceiling', () => {
  const p = renderCodeReview()
  // External pipeline + threat model contexts inflate this builder; ceiling is generous.
  // 2026-06-05: ceiling raised 16000→17500 (GATE-13 added to MUST_GATES)
  const ceiling = 17500
  assert.ok(p.length <= ceiling,
    `buildSpecialistPrompt grew to ${p.length} bytes — ceiling is ${ceiling}`)
})

// ── Required-content presence (safety-critical) ───────────────────────────

test('all 4 builders include the HANDOFF section', () => {
  for (const [name, fn] of [['pentest', renderPentest], ['cloud', renderCloud], ['network', renderNetwork], ['code-review', renderCodeReview]]) {
    const p = fn()
    assert.match(p, /HANDOFF|handoff/, `${name}: must include HANDOFF section (Sprint C.2)`)
    assert.match(p, /\/root\/intel\/handoffs\/inbox/, `${name}: must reference handoffs inbox path`)
  }
})

test('all 4 builders include MUST_GATES (anti-sycophancy)', () => {
  for (const [name, fn] of [['pentest', renderPentest], ['cloud', renderCloud], ['network', renderNetwork], ['code-review', renderCodeReview]]) {
    const p = fn()
    assert.match(p, /GATE-1|MANDATORY VERIFICATION GATES|ASSUME-EXPLOIT/i,
      `${name}: must include MUST_GATES anti-sycophancy block`)
  }
})

test('pentest builder includes finding-emit schema (live-findings or ACTIVITY-LOG)', () => {
  const p = renderPentest()
  assert.match(p, /live-findings|ACTIVITY-LOG/,
    'pentest specialist must know where to write findings (schema instruction)')
})

test('cloud builder names canonical findings output path', () => {
  const p = renderCloud()
  assert.match(p, /\/root\/intel\/cloud\/findings\//,
    'cloud specialist must know the findings output path')
})

test('network builder names canonical findings output path', () => {
  const p = renderNetwork()
  assert.match(p, /\/root\/intel\/network\/findings\//,
    'network specialist must know the findings output path')
})

test('code-review builder names canonical findings output path', () => {
  const p = renderCodeReview()
  assert.match(p, /\/root\/intel\/code-review\/findings\//,
    'code-review specialist must know the findings output path')
})

// ── Removed-content absence (cuts we made) ────────────────────────────────

test('pentest builder no longer contains the verbose CREATIVE 8-bullet list (cut)', () => {
  const p = renderPentest()
  // We removed items 3-8 of the CREATIVE ATTACK PHASE bullet list (basic
  // pentest 101 already covered by skill files). Keep items 1-2 (chain +
  // assumption-breaking) which are framework-level habits.
  // Specifically: "HTTP verb tampering" was item 4, "double-URL-encoding"
  // was item 6 — both gone now.
  assert.ok(!p.includes('HTTP verb tampering: GET→POST→PUT→DELETE→PATCH'),
    'verbose HTTP verb tampering bullet must be removed (skill territory)')
  assert.ok(!p.includes('double-URL-encoding'),
    'double-URL-encoding bullet must be removed (skill territory)')
})

test('pentest builder no longer contains the duplicated live-findings example JSON', () => {
  const p = renderPentest()
  // Pre-trim: schema + a worked example "Found web app with email+pin login on stacktype X"
  // Post-trim: schema only.
  assert.ok(!p.includes('email+pin login on stacktype X'),
    'duplicated worked-example must be removed (schema is sufficient)')
})

test('pentest builder no longer contains the duplicate "DO NOT fabricate" line', () => {
  const p = renderPentest()
  // Pre-trim: a standalone "DO NOT fabricate findings. Only report what you can prove..."
  // line that duplicates GATE-3 PROOF-REQUIRED. Removed.
  // We allow the GATE-3 text itself (it lives in MUST_GATES and uses different wording).
  assert.ok(!p.includes('DO NOT fabricate findings. Only report what you can prove with real HTTP responses.'),
    'duplicated DO-NOT-fabricate line must be removed (covered by GATE-3)')
})

test('cleanup: remove helper module', () => {
  try { fs.unlinkSync(helperPath) } catch {}
})
