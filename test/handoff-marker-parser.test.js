// test/handoff-marker-parser.test.js
//
// Sprint C.2 follow-up (2026-05-10): UNIVERSAL output-marker pattern that
// converts specialist stdout `<<HANDOFF ... >>` blocks into canonical handoff
// JSON in /root/intel/handoffs/inbox/. Solves the prompt-to-action gap where
// specialists read the "use --create CLI" instruction as documentation
// instead of executing it.
//
// Anti-sycophancy: parser STRIPS analyst commentary fields (rationale,
// my_analysis, severity_claim) if present — the canonical handoff carries
// raw evidence only.

const assert = require('node:assert')
const { test } = require('node:test')
const {
  extractHandoffMarkers,
  convertMarkerToHandoffArgs,
} = require('../agents/handoff-marker-parser')

const SINGLE_MARKER = `
Here is my analysis. I found PII flowing to a foreign host.

<<HANDOFF
target_squad: cloud-security
target_capability: data-residency
source_finding_id: ASH-CONFIG-001
question: Is PII flowing to cube.zhaopin.com a GDPR violation?
evidence:
  api_host: cube.zhaopin.com
  config_url: https://us-llm.moli.lenovo.com/callcenterv2/config.js
  dns_chain: cube.zhaopin.com → it-hw-waf → Huawei Cloud China
expected_artifacts: compliance-verdict, geographic-routing-confirmation
>>

Continuing my pentest work...
`

test('extractHandoffMarkers returns array of marker objects from single block', () => {
  const markers = extractHandoffMarkers(SINGLE_MARKER)
  assert.strictEqual(markers.length, 1, 'must extract exactly one marker')
  const m = markers[0]
  assert.strictEqual(m.target_squad, 'cloud-security')
  assert.strictEqual(m.target_capability, 'data-residency')
  assert.strictEqual(m.source_finding_id, 'ASH-CONFIG-001')
  assert.match(m.question, /GDPR violation/)
})

test('extractHandoffMarkers handles multiple markers in same output', () => {
  const txt = SINGLE_MARKER + `\n\n<<HANDOFF
target_squad: network-pentest
target_capability: dns-attribution
source_finding_id: ASH-DNS-002
question: Is this DNS chain attacker-controlled?
evidence:
  dns_chain: foo.bar → it-hw-waf
expected_artifacts: dns-verdict
>>\n`
  const markers = extractHandoffMarkers(txt)
  assert.strictEqual(markers.length, 2, 'must extract both markers')
  assert.strictEqual(markers[0].target_squad, 'cloud-security')
  assert.strictEqual(markers[1].target_squad, 'network-pentest')
})

test('extractHandoffMarkers returns [] when no markers present', () => {
  const markers = extractHandoffMarkers('just a normal report with no markers here')
  assert.deepStrictEqual(markers, [])
})

test('extractHandoffMarkers returns [] for null/undefined/empty input', () => {
  assert.deepStrictEqual(extractHandoffMarkers(null), [])
  assert.deepStrictEqual(extractHandoffMarkers(undefined), [])
  assert.deepStrictEqual(extractHandoffMarkers(''), [])
})

test('extractHandoffMarkers handles nested key: nested-value YAML-ish form', () => {
  const txt = `<<HANDOFF
target_squad: cloud-security
target_capability: iam-audit
source_finding_id: F-1
question: Is role X over-privileged?
evidence:
  role_arn: arn:aws:iam::123:role/foo
  policy_doc: arn:aws:iam::aws:policy/AdminAccess
expected_artifacts: iam-verdict
>>`
  const markers = extractHandoffMarkers(txt)
  assert.strictEqual(markers.length, 1)
  const ev = markers[0].evidence
  assert.ok(typeof ev === 'object', 'evidence must be an object')
  assert.strictEqual(ev.role_arn, 'arn:aws:iam::123:role/foo')
  assert.strictEqual(ev.policy_doc, 'arn:aws:iam::aws:policy/AdminAccess')
})

test('extractHandoffMarkers ANTI-SYCOPHANCY: strips rationale/my_analysis/severity_claim', () => {
  const txt = `<<HANDOFF
target_squad: cloud-security
target_capability: data-residency
source_finding_id: F-1
question: Is this a violation?
evidence:
  api_host: foo.example.com
my_analysis: I think this is critical because of XYZ
severity_claim: Critical
rationale: My reasoning says it's bad
expected_artifacts: verdict
>>`
  const markers = extractHandoffMarkers(txt)
  assert.strictEqual(markers.length, 1)
  const m = markers[0]
  // Stripped at the top level
  assert.ok(!('my_analysis' in m), 'my_analysis must be stripped')
  assert.ok(!('severity_claim' in m), 'severity_claim must be stripped')
  assert.ok(!('rationale' in m), 'rationale must be stripped')
  // Evidence preserved + does not contain those keys either
  assert.ok(m.evidence)
  assert.ok(!('my_analysis' in m.evidence))
  assert.strictEqual(m.evidence.api_host, 'foo.example.com')
})

test('extractHandoffMarkers skips malformed marker (missing target_squad)', () => {
  const txt = `<<HANDOFF
target_capability: data-residency
source_finding_id: F-1
question: ?
evidence:
  k: v
expected_artifacts: x
>>`
  const markers = extractHandoffMarkers(txt)
  // Either skipped entirely OR returned with a `_invalid` marker — must NOT crash
  // and must NOT silently convert a bad marker to a valid handoff downstream.
  for (const m of markers) {
    if (!m.target_squad) {
      assert.ok(m._invalid, 'marker without target_squad must be flagged invalid')
    }
  }
})

test('extractHandoffMarkers handles expected_artifacts as comma-separated list', () => {
  const markers = extractHandoffMarkers(SINGLE_MARKER)
  const m = markers[0]
  assert.ok(Array.isArray(m.expected_artifacts), 'expected_artifacts must be an array')
  assert.ok(m.expected_artifacts.length >= 1)
  assert.ok(m.expected_artifacts.includes('compliance-verdict'))
})

test('extractHandoffMarkers handles marker with NO closing `>>` (graceful fallback)', () => {
  const txt = `<<HANDOFF
target_squad: cloud-security
target_capability: data-residency
source_finding_id: F-1
question: ?
evidence:
  k: v
expected_artifacts: x
(no closing marker — agent's output truncated)`
  // Must not throw; must either skip or salvage.
  const markers = extractHandoffMarkers(txt)
  assert.ok(Array.isArray(markers), 'returns array even on unterminated marker')
})

test('extractHandoffMarkers handles >100 line marker without truncation', () => {
  const evidence = Array.from({ length: 120 }, (_, i) => `  key_${i}: value_${i}`).join('\n')
  const txt = `<<HANDOFF
target_squad: cloud-security
target_capability: data-residency
source_finding_id: BIG-1
question: Big marker?
evidence:
${evidence}
expected_artifacts: verdict
>>`
  const markers = extractHandoffMarkers(txt)
  assert.strictEqual(markers.length, 1, 'large marker must still extract')
  assert.ok(Object.keys(markers[0].evidence).length >= 100,
    'evidence with 120 keys must be preserved (≥100)')
})

test('convertMarkerToHandoffArgs maps marker → createHandoff camelCase args', () => {
  const marker = extractHandoffMarkers(SINGLE_MARKER)[0]
  const args = convertMarkerToHandoffArgs({
    marker,
    sourceTaskId: 'task-123',
    sourceSquad: 'pentest',
    sourceAgent: 'ASHWATTHAMA',
  })
  assert.strictEqual(args.sourceTaskId, 'task-123')
  assert.strictEqual(args.sourceSquad, 'pentest')
  assert.strictEqual(args.sourceAgent, 'ASHWATTHAMA')
  assert.strictEqual(args.sourceFindingId, 'ASH-CONFIG-001')
  assert.strictEqual(args.targetSquad, 'cloud-security')
  assert.strictEqual(args.targetCapability, 'data-residency')
  assert.ok(args.request)
  assert.match(args.request.question, /GDPR violation/)
  assert.ok(args.request.evidence)
  assert.ok(Array.isArray(args.request.expected_artifacts))
})

test('convertMarkerToHandoffArgs does NOT carry analyst commentary into request', () => {
  // Even if a malicious / accidental marker re-introduces analyst commentary
  // at the top level, convertMarkerToHandoffArgs must not leak it into the
  // canonical handoff request payload.
  const marker = {
    target_squad: 'cloud-security',
    target_capability: 'data-residency',
    source_finding_id: 'F-1',
    question: 'q?',
    evidence: { host: 'x' },
    expected_artifacts: ['v'],
    rationale: 'should not appear',
    my_analysis: 'should not appear',
    severity_claim: 'Critical',
  }
  const args = convertMarkerToHandoffArgs({
    marker,
    sourceTaskId: 't',
    sourceSquad: 'pentest',
    sourceAgent: 'A',
  })
  const flat = JSON.stringify(args.request)
  assert.ok(!/should not appear/i.test(flat),
    'analyst commentary must not leak into request payload')
  assert.ok(!/severity_claim/i.test(flat),
    'severity_claim must not appear in request payload')
})

test('extractHandoffMarkers DEDUPLICATES identical markers in same output', () => {
  // If a specialist accidentally emits the same marker twice (e.g. repeated
  // in a summary), the parser should report it once OR the wiring layer
  // should dedupe before creating handoffs. We expose the dedup primitive
  // by content-key (target_squad + target_capability + source_finding_id +
  // question).
  const dup = SINGLE_MARKER + '\n' + SINGLE_MARKER
  const markers = extractHandoffMarkers(dup)
  // The parser returns BOTH (dedup happens at wiring layer using a key).
  // We assert the dedup-key helper exists on the marker object.
  assert.ok(markers.length >= 1)
  // Convenience: each marker exposes a stable _dedupKey property.
  const keys = new Set(markers.map(m => m._dedupKey))
  assert.strictEqual(keys.size, 1, 'two identical markers must share the same _dedupKey')
})
