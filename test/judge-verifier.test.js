// test/judge-verifier.test.js
//
// Unit tests for agents/judge-verifier.js — G1 Phase 1 build.

const assert = require('node:assert')
const { test } = require('node:test')
const {
  STAGE_DOWNGRADE,
  SEVERITY_RANK,
  buildJudgePrompt,
  parseJudgeResponse,
  applyJudgeResult,
  downgradeSeverity,
  normalizeSeverity,
  judgeFindings,
} = require('../agents/judge-verifier')

// ── Helpers ──

test('STAGE_DOWNGRADE map has all 4 stages', () => {
  for (const s of ['A', 'B', 'C', 'D']) {
    assert.ok(STAGE_DOWNGRADE[s], `stage ${s} has downgrade target`)
  }
  assert.strictEqual(STAGE_DOWNGRADE.A, 'Info')
  assert.strictEqual(STAGE_DOWNGRADE.B, 'Medium')
  assert.strictEqual(STAGE_DOWNGRADE.C, 'Low')
  assert.strictEqual(STAGE_DOWNGRADE.D, 'Info')
})

test('SEVERITY_RANK orders correctly', () => {
  assert.ok(SEVERITY_RANK.Critical > SEVERITY_RANK.High)
  assert.ok(SEVERITY_RANK.High > SEVERITY_RANK.Medium)
  assert.ok(SEVERITY_RANK.Medium > SEVERITY_RANK.Low)
  assert.ok(SEVERITY_RANK.Low > SEVERITY_RANK.Info)
})

test('normalizeSeverity handles common cases', () => {
  assert.strictEqual(normalizeSeverity('Critical'), 'Critical')
  assert.strictEqual(normalizeSeverity('critical'), 'Critical')
  assert.strictEqual(normalizeSeverity('CRITICAL'), 'Critical')
  assert.strictEqual(normalizeSeverity('high (CVSS 8.5)'), 'High')
  assert.strictEqual(normalizeSeverity(''), 'Medium')  // safe default
  assert.strictEqual(normalizeSeverity(null), 'Medium')
})

// ── downgradeSeverity ──

test('downgradeSeverity: stage A failure on Critical → Info', () => {
  assert.strictEqual(downgradeSeverity('Critical', 'A'), 'Info')
})

test('downgradeSeverity: stage B failure on Critical → Medium', () => {
  assert.strictEqual(downgradeSeverity('Critical', 'B'), 'Medium')
})

test('downgradeSeverity: stage C failure on High → Low', () => {
  assert.strictEqual(downgradeSeverity('High', 'C'), 'Low')
})

test('downgradeSeverity: never elevates — Low + stage B (Medium target) stays Low', () => {
  assert.strictEqual(downgradeSeverity('Low', 'B'), 'Low',
    'downgrade is MIN(current, target) — never elevates')
})

test('downgradeSeverity: Info stays Info on any stage', () => {
  for (const s of ['A', 'B', 'C', 'D']) {
    assert.strictEqual(downgradeSeverity('Info', s), 'Info')
  }
})

// ── buildJudgePrompt ──

test('buildJudgePrompt includes finding fields', () => {
  const f = {
    title: 'SQL Injection in /search',
    severity: 'High',
    description: 'unfiltered user input',
    evidence: "curl -X POST '/search?q=\"; DROP TABLE users--'",
    url: 'https://target.com/search',
  }
  const p = buildJudgePrompt(f, 'https://target.com')
  assert.match(p, /SQL Injection/)
  assert.match(p, /unfiltered user input/)
  assert.match(p, /Stage A — Pattern Noise/)
  assert.match(p, /Stage B — Attacker Prerequisites/)
  assert.match(p, /Stage C — Reachability/)
  assert.match(p, /Stage D — Finality/)
  assert.match(p, /STRICT JSON ONLY/)
})

test('buildJudgePrompt anti-sycophancy: no agent name or task framing', () => {
  const f = { title: 'X', severity: 'High' }
  const p = buildJudgePrompt(f, 'https://target.com')
  // Should NOT contain words that would prime confirmation bias.
  // Agent names and "verify this finding" / "confirm the exploit" framing
  // would tell the judge what answer to give.
  // Note: stage rubric LEGITIMATELY mentions exploitation as an analytical concept.
  assert.doesNotMatch(p, /ATLAS|SCOUT|adversary/, 'no agent names')
  assert.doesNotMatch(p, /verify this finding|confirm this finding|confirm the exploit/i,
    'no confirmation-bias framing')
})

test('buildJudgePrompt handles minimal finding', () => {
  const p = buildJudgePrompt({}, '')
  assert.match(p, /\(no title\)/)
  assert.match(p, /Stage A/)
})

// ── Real production schema fields (caught by retro validation 2026-05-07) ──
// VALIDATED-FINDINGS files in /root/intel/ use `proof`, `impact`, `bypass_url`,
// `gate12` field names — NOT `evidence` / `reproduction_method`. Earlier prompt
// only read the latter, so judge saw blank evidence on real findings and
// (correctly given empty input) cried "no evidence provided" on Stage A.
// These tests lock in support for the real schema.

test('buildJudgePrompt: when finding has `proof` (no `evidence`), the proof flows in', () => {
  const f = {
    id: 'AUDITOR-V-001',
    title: 'Akamai WAF Bypass',
    severity: 'High',
    description: 'Main returns 403, locale subdomain returns 200',
    proof: "curl -o/dev/null -w '%{http_code}' https://support.example.com → 403. curl -o/dev/null -w '%{http_code}' https://en-us.support.example.com → 200 (47970 bytes).",
    url: 'https://support.example.com',
  }
  const p = buildJudgePrompt(f, 'https://support.example.com')
  assert.match(p, /47970 bytes/, 'proof body must appear in the prompt')
  assert.doesNotMatch(p, /\(no evidence\)/, 'must not show "(no evidence)" when proof is present')
})

test('buildJudgePrompt: anti-sycophancy — analyst `impact` claim is NOT shown to judge', () => {
  // Why: `impact` is analyst's confident assertion of severity ("Attacker CAN..."),
  // which primes Stage B/C to defer. Retro validation 2026-05-07 caught that including
  // it flipped 7/8 downgrades → 0/8 confirms by anchoring. Judge must derive impact
  // from evidence, not inherit it from analyst.
  const f = {
    title: 'Bypass', severity: 'High', description: 'd',
    impact: 'Attacker CAN access full Oracle RightNow application bypassing WAF',
  }
  const p = buildJudgePrompt(f, '')
  assert.doesNotMatch(p, /Oracle RightNow/, 'impact field must NOT appear (sycophancy guard)')
  assert.doesNotMatch(p, /Attacker CAN/, 'analyst confidence assertions must not prime judge')
})

test('buildJudgePrompt: anti-sycophancy — gate12 threat-model classification is NOT shown', () => {
  // Why: gate12.attacker_privilege / trust_boundary are analyst's prior threat-model
  // classification. Showing them anchors the judge on Stage B before independent
  // reasoning. Stage B must derive from evidence (e.g., proof shows no Cookie header
  // → unauthenticated), not from analyst's claim.
  const f = {
    title: 'X', severity: 'High', description: 'd',
    gate12: { attacker_privilege: 'unauthenticated', trust_boundary: 'authentication_boundary' },
  }
  const p = buildJudgePrompt(f, '')
  assert.doesNotMatch(p, /attacker_privilege/, 'gate12 keys must NOT appear (sycophancy guard)')
  assert.doesNotMatch(p, /trust_boundary/, 'gate12 keys must NOT appear (sycophancy guard)')
})

test('buildJudgePrompt: bypass_url appears separately when present (alt entry point)', () => {
  const f = {
    title: 'X', severity: 'High', description: 'd',
    url: 'https://main.example.com',
    bypass_url: 'https://en-us.example.com',
  }
  const p = buildJudgePrompt(f, '')
  assert.match(p, /en-us\.example\.com/, 'bypass_url must appear (informs Stage C reachability)')
})

test('buildJudgePrompt: still reads `evidence` field (legacy schema)', () => {
  const f = {
    title: 'X', severity: 'High', description: 'd',
    evidence: 'OLD_SCHEMA_EVIDENCE_MARKER',
  }
  const p = buildJudgePrompt(f, '')
  assert.match(p, /OLD_SCHEMA_EVIDENCE_MARKER/, 'must remain back-compatible with `evidence` field')
})

// ── Sprint A foundation fix: object-shaped evidence (production reality) ──
//
// Real specialists (DECOY etc.) emit `evidence` as a structured OBJECT
// like { baseline_command, csrf_command, control_command, key_difference }.
// The original prompt-builder used `f.proof || f.evidence || f.repro_method`
// then template-literal interpolated the result — coercing objects to the
// literal string "[object Object]". Stage A then reasoned "evidence malformed
// → downgrade", masking real Highs as a serialization accident, not validation.
// Caught during round-6 retro 2026-05-09 (3/48 findings affected on motorola).
// Schema reality (jq audit on /root/intel/pentest/VALIDATED-FINDINGS.jsonl):
//   proof:                null on 48/48
//   evidence (object):    3/48
//   evidence (string):    0/48
//   reproduction_method:  string on 45/48  ← actual evidence carrier
//   reproduction_result:  string on 45/48  ← actual evidence carrier

test('buildJudgePrompt: object-shaped evidence is JSON-stringified, NOT coerced to "[object Object]"', () => {
  const f = {
    title: 'CSRF on doLogin',
    severity: 'High',
    description: 'CSRF protection bypass on vi-vn locale',
    evidence: {
      baseline_command: 'curl -X POST /doLogin -d "x=1" → 200',
      csrf_command: 'curl -X POST /doLogin -H "Origin: evil.com" → 200',
      key_difference: 'no f_tok validation server-side',
    },
  }
  const p = buildJudgePrompt(f, '')
  assert.doesNotMatch(p, /\[object Object\]/,
    'object-shaped evidence must NOT be coerced to "[object Object]" via template literal')
  assert.match(p, /baseline_command/, 'object keys must appear in stringified form')
  assert.match(p, /no f_tok validation/, 'nested values must be visible to the judge')
})

test('buildJudgePrompt: reads reproduction_method when evidence/proof are null (production schema)', () => {
  const f = {
    title: 'Supply chain: chat config points to external domain',
    severity: 'High',
    description: 'Moli chat config.js loads MF_API_HOST from cube.zhaopin.com',
    proof: null,
    evidence: null,
    reproduction_method: 'Direct HTTP GET to https://us-llm.moli.lenovo.com/callcenterv2/config.js',
    reproduction_result: 'HTTP 200, MF_API_HOST=https://cube.zhaopin.com confirmed',
  }
  const p = buildJudgePrompt(f, '')
  assert.match(p, /us-llm\.moli\.lenovo\.com/,
    'reproduction_method must appear when proof/evidence are null (45/48 findings hit this path)')
  assert.match(p, /cube\.zhaopin\.com/, 'reproduction_result must also appear (carries response data)')
  assert.doesNotMatch(p, /\(no evidence\)/, 'must not show "(no evidence)" when reproduction_* fields are populated')
})

test('buildJudgePrompt: combines multiple evidence carriers when both populated', () => {
  const f = {
    title: 'X', severity: 'High',
    evidence: { command: 'curl evil.com → 200' },
    reproduction_result: 'response body matches injection',
  }
  const p = buildJudgePrompt(f, '')
  assert.match(p, /curl evil\.com/, 'evidence object must appear')
  assert.match(p, /response body matches injection/, 'reproduction_result must also appear')
})

test('buildJudgePrompt: anti-sycophancy still holds — analyst notes/threat_model NOT included', () => {
  // notes, false_positive_check, threat_model are ANALYST commentary
  // (claims about severity, FP-check, attacker model). Including them would
  // re-introduce the sycophancy bug fixed by retro 2026-05-07. Evidence-only
  // fields (proof, evidence, reproduction_method, reproduction_result) are OK.
  const f = {
    title: 'X', severity: 'High',
    notes: 'CRITICAL_ANALYST_OPINION_MARKER analyst claims this is exploitable',
    false_positive_check: 'FP_CHECK_MARKER analyst confirmed this is NOT a false positive',
    threat_model: { verified_attack: 'THREAT_MODEL_MARKER analyst claim' },
  }
  const p = buildJudgePrompt(f, '')
  assert.doesNotMatch(p, /CRITICAL_ANALYST_OPINION_MARKER/, 'notes must NOT appear (analyst claim → sycophancy)')
  assert.doesNotMatch(p, /FP_CHECK_MARKER/, 'false_positive_check must NOT appear (self-reinforcing)')
  assert.doesNotMatch(p, /THREAT_MODEL_MARKER/, 'threat_model must NOT appear (analyst claim)')
})

// ── Sprint B.1: parse-error hardening ("No PoC = No Report") ──
//
// Strix-style discipline: when the judge LLM returns garbage (empty/malformed/
// markdown-only response), the original behavior fell back to verdict='confirmed'
// — i.e. tool failure quietly upgraded findings. Sprint B.1 changes this to
// verdict='indeterminate' so Critical/High that can't be validated by the
// judge don't ride through on tool flakiness alone. Downgrade to Medium is
// applied later (Sprint B publication gate) — the parse layer just reports
// honestly.

test('parseJudgeResponse: empty input returns indeterminate (not confirmed)', () => {
  const r = parseJudgeResponse('')
  assert.strictEqual(r.verdict, 'indeterminate', 'empty response must NOT be silently confirmed')
})

test('parseJudgeResponse: null input returns indeterminate', () => {
  const r = parseJudgeResponse(null)
  assert.strictEqual(r.verdict, 'indeterminate')
})

test('parseJudgeResponse: response with no JSON block returns indeterminate', () => {
  const r = parseJudgeResponse('I think this looks fine, no JSON here')
  assert.strictEqual(r.verdict, 'indeterminate', 'narrative-only response must NOT be silently confirmed')
})

test('parseJudgeResponse: malformed JSON returns indeterminate with error context', () => {
  const r = parseJudgeResponse('{broken: not valid json')
  assert.strictEqual(r.verdict, 'indeterminate')
  assert.ok(r.error, 'parse error must be reported in result.error for triage')
})

test('parseJudgeResponse: valid stage results infer confirmed correctly (no regression)', () => {
  const r = parseJudgeResponse(JSON.stringify({
    stage_a: { pass: true, reason: 'real bug' },
    stage_b: { pass: true, reason: 'no auth' },
    stage_c: { pass: true, reason: 'reachable' },
    stage_d: { pass: true, reason: 'production' },
  }))
  assert.strictEqual(r.verdict, 'confirmed', 'valid all-pass response still confirms')
})

test('parseJudgeResponse: valid stage failure infers downgraded correctly (no regression)', () => {
  const r = parseJudgeResponse(JSON.stringify({
    stage_a: { pass: false, reason: 'pattern noise' },
    stage_b: { pass: true },
    stage_c: { pass: true },
    stage_d: { pass: true },
  }))
  assert.strictEqual(r.verdict, 'downgraded')
  assert.strictEqual(r.first_failed_stage, 'A')
})

// ── Sprint B.1: applyJudgeResult publication-gate behavior on indeterminate ──

test('applyJudgeResult: indeterminate verdict on Critical → downgrade to Medium', () => {
  // Strix discipline: if the judge can't validate (LLM crashed, parse error,
  // empty response), don't ride Critical/High through on analyst's claim alone.
  // Auto-downgrade to Medium with audit trail.
  const f = { id: 'X', severity: 'Critical' }
  const judgement = { verdict: 'indeterminate', error: 'empty response', first_failed_stage: null }
  const r = applyJudgeResult(f, judgement)
  assert.strictEqual(r.severity, 'Medium', 'Critical+indeterminate must downgrade to Medium')
  assert.strictEqual(r.severity_original, 'Critical', 'original severity preserved for audit')
  assert.strictEqual(r.judge_verdict, 'indeterminate')
})

test('applyJudgeResult: indeterminate verdict on High → downgrade to Medium', () => {
  const f = { id: 'X', severity: 'High' }
  const r = applyJudgeResult(f, { verdict: 'indeterminate', error: 'parse failed' })
  assert.strictEqual(r.severity, 'Medium', 'High+indeterminate must downgrade to Medium')
})

test('applyJudgeResult: indeterminate verdict on Medium → keep Medium (no upgrade)', () => {
  const f = { id: 'X', severity: 'Medium' }
  const r = applyJudgeResult(f, { verdict: 'indeterminate' })
  assert.strictEqual(r.severity, 'Medium', 'Medium stays Medium under indeterminate (no harm)')
})

test('applyJudgeResult: indeterminate verdict on Low → keep Low', () => {
  const f = { id: 'X', severity: 'Low' }
  const r = applyJudgeResult(f, { verdict: 'indeterminate' })
  assert.strictEqual(r.severity, 'Low', 'Low stays Low under indeterminate')
})

// ── severityFilter (G1 Phase 2 cost optimization) ──
//
// In production (Phase 3.9 hook), only Critical/High should hit the LLM.
// Medium/Low/Info pass through unchanged with judge_verdict='not-judged'.
// Saves ~50% of LLM calls per pentest task.

test('judgeFindings: severityFilter passes through findings below threshold', async () => {
  const findings = [
    { id: 'F1', severity: 'Critical', title: 'crit' },
    { id: 'F2', severity: 'Medium', title: 'med' },
    { id: 'F3', severity: 'Low', title: 'low' },
    { id: 'F4', severity: 'High', title: 'high' },
  ]
  let llmCalls = 0
  const callLLM = async () => {
    llmCalls++
    return JSON.stringify({
      stage_a: { pass: true }, stage_b: { pass: true },
      stage_c: { pass: true }, stage_d: { pass: true },
      verdict: 'confirmed', first_failed_stage: null,
    })
  }
  const { results, summary } = await judgeFindings(findings, {
    target: 'https://t', callLLM,
    severityFilter: ['Critical', 'High'],
  })
  assert.strictEqual(llmCalls, 2, 'only Critical+High hit LLM (2 of 4 findings)')
  assert.strictEqual(summary.total, 4)
  assert.strictEqual(summary.confirmed, 2, 'only judged findings counted as confirmed')
  // Pass-through findings keep severity unchanged + get not-judged marker
  const f2 = results.find(r => r.id === 'F2')
  assert.strictEqual(f2.judge_verdict, 'not-judged')
  assert.strictEqual(f2.severity, 'Medium', 'severity preserved')
})

test('judgeFindings: severityFilter empty/null behaves as no filter (backwards compat)', async () => {
  const findings = [
    { id: 'F1', severity: 'Low', title: 'low' },
  ]
  let llmCalls = 0
  const callLLM = async () => {
    llmCalls++
    return JSON.stringify({
      stage_a: { pass: true }, stage_b: { pass: true },
      stage_c: { pass: true }, stage_d: { pass: true },
      verdict: 'confirmed', first_failed_stage: null,
    })
  }
  const r1 = await judgeFindings(findings, { callLLM })
  assert.strictEqual(llmCalls, 1, 'no filter → all judged')
  llmCalls = 0
  const r2 = await judgeFindings(findings, { callLLM, severityFilter: null })
  assert.strictEqual(llmCalls, 1, 'null filter → all judged')
})

test('judgeFindings: severityFilter is case-insensitive on input severity', async () => {
  const findings = [
    { id: 'F1', severity: 'CRITICAL', title: 'shouty crit' },
    { id: 'F2', severity: 'high', title: 'lowercase high' },
  ]
  let llmCalls = 0
  const callLLM = async () => {
    llmCalls++
    return JSON.stringify({
      stage_a: { pass: true }, stage_b: { pass: true },
      stage_c: { pass: true }, stage_d: { pass: true },
      verdict: 'confirmed', first_failed_stage: null,
    })
  }
  await judgeFindings(findings, { callLLM, severityFilter: ['Critical', 'High'] })
  assert.strictEqual(llmCalls, 2, 'normalized severity matches filter case-insensitively')
})

// ── parseJudgeResponse ──

test('parseJudgeResponse: all-pass response → confirmed', () => {
  const json = JSON.stringify({
    stage_a: { pass: true, reason: 'real vuln' },
    stage_b: { pass: true, reason: 'no auth needed' },
    stage_c: { pass: true, reason: 'reachable' },
    stage_d: { pass: true, reason: 'production' },
    verdict: 'confirmed',
    first_failed_stage: null,
  })
  const parsed = parseJudgeResponse(json)
  assert.strictEqual(parsed.verdict, 'confirmed')
  assert.strictEqual(parsed.first_failed_stage, null)
})

test('parseJudgeResponse: stage A fail → downgraded', () => {
  const json = JSON.stringify({
    stage_a: { pass: false, reason: 'test code' },
    stage_b: { pass: true, reason: '' },
    stage_c: { pass: true, reason: '' },
    stage_d: { pass: true, reason: '' },
    verdict: 'downgraded',
    first_failed_stage: 'A',
  })
  const parsed = parseJudgeResponse(json)
  assert.strictEqual(parsed.verdict, 'downgraded')
  assert.strictEqual(parsed.first_failed_stage, 'A')
})

test('parseJudgeResponse: tolerates markdown fences', () => {
  const wrapped = '```json\n' + JSON.stringify({
    stage_a: { pass: true }, stage_b: { pass: true }, stage_c: { pass: true }, stage_d: { pass: true },
    verdict: 'confirmed', first_failed_stage: null,
  }) + '\n```'
  const parsed = parseJudgeResponse(wrapped)
  assert.strictEqual(parsed.verdict, 'confirmed')
})

test('parseJudgeResponse: tolerates leading commentary', () => {
  const text = 'Here is the analysis:\n\n' + JSON.stringify({
    stage_a: { pass: false }, stage_b: { pass: true }, stage_c: { pass: true }, stage_d: { pass: true },
    verdict: 'downgraded', first_failed_stage: 'A',
  })
  const parsed = parseJudgeResponse(text)
  assert.strictEqual(parsed.verdict, 'downgraded')
})

test('parseJudgeResponse: missing verdict → infers from stages', () => {
  const json = JSON.stringify({
    stage_a: { pass: false, reason: 'test code' },
    stage_b: { pass: true }, stage_c: { pass: true }, stage_d: { pass: true },
  })
  const parsed = parseJudgeResponse(json)
  assert.strictEqual(parsed.verdict, 'downgraded', 'infer downgrade from stage_a fail')
  assert.strictEqual(parsed.first_failed_stage, 'A')
})

// Sprint B.1 (2026-05-09): updated from confirmed→indeterminate. The original
// "fail-open" stance silently let high-severity findings ride through tool
// flakiness. New stance: if the judge can't read the response, mark
// indeterminate so applyJudgeResult can apply the publication-gate downgrade.
test('parseJudgeResponse: malformed → indeterminate (publication-gate handles severity cap)', () => {
  const parsed = parseJudgeResponse('not json at all')
  assert.strictEqual(parsed.verdict, 'indeterminate', 'malformed must surface as indeterminate, not silent confirm')
  assert.ok(parsed.error)
})

test('parseJudgeResponse: empty input → indeterminate', () => {
  const parsed = parseJudgeResponse('')
  assert.strictEqual(parsed.verdict, 'indeterminate')
})

// ── applyJudgeResult ──

test('applyJudgeResult: confirmed verdict preserves severity', () => {
  const f = { id: '1', severity: 'Critical', title: 'T' }
  const j = {
    verdict: 'confirmed', first_failed_stage: null,
    stage_a: { pass: true }, stage_b: { pass: true }, stage_c: { pass: true }, stage_d: { pass: true },
  }
  const out = applyJudgeResult(f, j)
  assert.strictEqual(out.severity, 'Critical')
  assert.strictEqual(out.severity_original, 'Critical')
  assert.strictEqual(out.judge_verdict, 'confirmed')
  assert.strictEqual(out.judge_first_failed_stage, null)
})

test('applyJudgeResult: downgraded — stage A on Critical → Info', () => {
  const f = { id: '1', severity: 'Critical', title: 'T' }
  const j = {
    verdict: 'downgraded', first_failed_stage: 'A',
    stage_a: { pass: false, reason: 'test code' }, stage_b: { pass: true },
    stage_c: { pass: true }, stage_d: { pass: true },
  }
  const out = applyJudgeResult(f, j)
  assert.strictEqual(out.severity, 'Info')
  assert.strictEqual(out.severity_original, 'Critical')
  assert.strictEqual(out.judge_first_failed_stage, 'A')
  assert.strictEqual(out.judge_stages.a.pass, false)
})

test('applyJudgeResult: judge_stages preserved', () => {
  const f = { id: '1', severity: 'High' }
  const j = {
    verdict: 'downgraded', first_failed_stage: 'B',
    stage_a: { pass: true, reason: 'A-OK' },
    stage_b: { pass: false, reason: 'needs admin' },
    stage_c: { pass: true, reason: 'reachable' },
    stage_d: { pass: true, reason: 'prod' },
  }
  const out = applyJudgeResult(f, j)
  assert.strictEqual(out.judge_stages.b.reason, 'needs admin')
  assert.strictEqual(out.judge_stages.a.reason, 'A-OK')
})

// ── judgeFindings (orchestration) ──

test('judgeFindings: empty input → empty results', async () => {
  const { results, summary } = await judgeFindings([])
  assert.strictEqual(results.length, 0)
  assert.strictEqual(summary.total, 0)
})

test('judgeFindings: 3 findings, all confirmed via mock', async () => {
  const findings = [
    { id: 'F1', severity: 'Critical', title: 'SQLi' },
    { id: 'F2', severity: 'High', title: 'XSS' },
    { id: 'F3', severity: 'Medium', title: 'CSP' },
  ]
  const allPass = JSON.stringify({
    stage_a: { pass: true }, stage_b: { pass: true }, stage_c: { pass: true }, stage_d: { pass: true },
    verdict: 'confirmed', first_failed_stage: null,
  })
  const { results, summary } = await judgeFindings(findings, {
    target: 'https://example.com',
    mockResponses: { F1: allPass, F2: allPass, F3: allPass },
  })
  assert.strictEqual(results.length, 3)
  assert.strictEqual(summary.confirmed, 3)
  assert.strictEqual(summary.downgraded, 0)
  for (const r of results) {
    assert.strictEqual(r.judge_verdict, 'confirmed')
    assert.strictEqual(r.severity, r.severity_original)
  }
})

test('judgeFindings: stage A fail downgrades Critical to Info', async () => {
  const findings = [{ id: 'F1', severity: 'Critical', title: 'Likely test code' }]
  const stageAFail = JSON.stringify({
    stage_a: { pass: false, reason: 'in test/' },
    stage_b: { pass: true }, stage_c: { pass: true }, stage_d: { pass: true },
    verdict: 'downgraded', first_failed_stage: 'A',
  })
  const { results, summary } = await judgeFindings(findings, {
    mockResponses: { F1: stageAFail },
  })
  assert.strictEqual(results[0].severity, 'Info')
  assert.strictEqual(results[0].severity_original, 'Critical')
  assert.strictEqual(summary.downgraded, 1)
  assert.strictEqual(summary.downgraded_by_stage.A, 1)
})

test('judgeFindings: stage B fail caps Critical at Medium', async () => {
  const findings = [{ id: 'F1', severity: 'Critical', title: 'Auth bypass' }]
  const stageBFail = JSON.stringify({
    stage_a: { pass: true }, stage_b: { pass: false, reason: 'requires admin' },
    stage_c: { pass: true }, stage_d: { pass: true },
    verdict: 'downgraded', first_failed_stage: 'B',
  })
  const { results, summary } = await judgeFindings(findings, {
    mockResponses: { F1: stageBFail },
  })
  assert.strictEqual(results[0].severity, 'Medium', 'B-fail caps at Medium')
  assert.strictEqual(summary.downgraded_by_stage.B, 1)
})

test('judgeFindings: LLM error → indeterminate, severity preserved', async () => {
  const findings = [{ id: 'F1', severity: 'Critical', title: 'X' }]
  const erroringLLM = async () => { throw new Error('rate limit') }
  const { results, summary } = await judgeFindings(findings, { callLLM: erroringLLM })
  assert.strictEqual(results[0].judge_verdict, 'indeterminate')
  assert.strictEqual(results[0].judge_error, 'rate limit')
  assert.strictEqual(summary.indeterminate, 1)
})

// Sprint B.1 (2026-05-09): updated semantics. Was "fail-open on parse error";
// now indeterminate + publication-gate cap (Critical/High → Medium).
test('judgeFindings: malformed LLM response → indeterminate, High caps at Medium', async () => {
  const findings = [{ id: 'F1', severity: 'High' }]
  const { results } = await judgeFindings(findings, { mockResponses: { F1: 'gibberish' } })
  assert.strictEqual(results[0].judge_verdict, 'indeterminate', 'parse failure surfaces honestly')
  assert.strictEqual(results[0].severity, 'Medium', 'High auto-downgrades to Medium under publication gate')
  assert.strictEqual(results[0].severity_original, 'High', 'audit trail preserved')
})

test('judgeFindings: 6 findings — mixed verdicts → correct summary', async () => {
  const findings = [
    { id: 'A1', severity: 'Critical' },
    { id: 'A2', severity: 'Critical' },
    { id: 'A3', severity: 'High' },
    { id: 'A4', severity: 'High' },
    { id: 'A5', severity: 'Medium' },
    { id: 'A6', severity: 'Medium' },
  ]
  const allPass = JSON.stringify({
    stage_a: { pass: true }, stage_b: { pass: true }, stage_c: { pass: true }, stage_d: { pass: true },
    verdict: 'confirmed', first_failed_stage: null,
  })
  const failA = JSON.stringify({
    stage_a: { pass: false }, stage_b: { pass: true }, stage_c: { pass: true }, stage_d: { pass: true },
    verdict: 'downgraded', first_failed_stage: 'A',
  })
  const failB = JSON.stringify({
    stage_a: { pass: true }, stage_b: { pass: false }, stage_c: { pass: true }, stage_d: { pass: true },
    verdict: 'downgraded', first_failed_stage: 'B',
  })

  const { summary } = await judgeFindings(findings, {
    mockResponses: { A1: allPass, A2: failA, A3: allPass, A4: failB, A5: allPass, A6: allPass },
  })
  assert.strictEqual(summary.total, 6)
  assert.strictEqual(summary.confirmed, 4)
  assert.strictEqual(summary.downgraded, 2)
  assert.strictEqual(summary.downgraded_by_stage.A, 1)
  assert.strictEqual(summary.downgraded_by_stage.B, 1)
})
