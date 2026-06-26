// agents/judge-verifier.js
//
// G1 Judge Verifier — 4-stage exploitation validator.
// Modeled on Raptor's Stage A-D structure (Gadi Evron, Halvar Flake et al).
//
// Each finding is independently evaluated through 4 stages:
//   A: Pattern Noise            — real vuln vs noise/test/example
//   B: Attacker Prerequisites   — what auth/access/conditions are needed
//   C: Reachability             — can external attacker reach the code path
//   D: Finality                 — test code? unrealistic conditions? mitigated?
//
// A finding must pass ALL FOUR to retain its original severity.
// Failing ANY stage downgrades to a stage-specific severity floor.
//
// Anti-sycophancy: the judge sees ONLY the finding + target context + rubric.
// It does NOT see the originating analyst agent name, ATLAS's framing,
// or prior verdicts (chain-verifier, browser-verifier). Forces independent
// reasoning — matches existing goal-scrub pattern.
//
// Spec: docs/superpowers/specs/2026-05-06-G1-judge-verifier-design.md
// Architecture: docs/architecture/2026-05-06-archon-quality-architecture.md (Layer A)

const STAGE_DOWNGRADE = Object.freeze({
  A: 'Info',     // pattern noise → not a real vulnerability
  B: 'Medium',   // unrealistic prerequisites → cap severity
  C: 'Low',      // unreachable from external entry → low impact
  D: 'Info',     // test code / mitigated upstream → not exploitable in production
})

// Promotion-tier filter (Sprint Promotion-1, 2026-05-09): Medium-only second pass.
// Stricter rubric — if all 4 stages pass, finding is PROMOTED to High.
const PROMOTION_TIER_FILTER = Object.freeze(['Medium'])
const STANDARD_TIER_FILTER = Object.freeze(['Critical', 'High'])
// Cost cap: max promotion-mode LLM calls per task. Haiku ~$0.005/call → cap @ 10
// keeps overhead under $0.05/task. 11th+ Medium passes through with
// judge_verdict='not-judged-cap-exceeded'.
const PROMOTION_CAP_DEFAULT = 10

// Structured-output schema for the standard 4-stage judge (2026-06-09). Mirrors the
// exact JSON the prompt requests (buildJudgePrompt OUTPUT block). Passed via the CLI
// --json-schema flag so the model emits GUARANTEED-valid JSON — retiring the
// regex-extract/parse-fallback in parseJudgeResponse that silently downgraded
// Critical/High to 'indeterminate' on any formatting wobble (a false-negative source).
const _STAGE = Object.freeze({
  type: 'object', additionalProperties: false, required: ['pass', 'reason'],
  properties: { pass: { type: 'boolean' }, reason: { type: 'string' } },
})
const JUDGE_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  required: ['stage_a', 'stage_b', 'stage_c', 'stage_d', 'verdict', 'first_failed_stage'],
  properties: {
    stage_a: _STAGE, stage_b: _STAGE, stage_c: _STAGE, stage_d: _STAGE,
    verdict: { type: 'string', enum: ['confirmed', 'downgraded'] },
    first_failed_stage: { anyOf: [{ type: 'string', enum: ['A', 'B', 'C', 'D'] }, { type: 'null' }] },
  },
})

const SEVERITY_RANK = Object.freeze({
  Info: 0,
  Low: 1,
  Medium: 2,
  High: 3,
  Critical: 4,
})

/**
 * Returns the downgraded severity given the original severity and a stage failure.
 * Downgrade target = MIN(current, stage's downgrade floor) — never elevates.
 */
function downgradeSeverity(currentSeverity, failedStage) {
  const target = STAGE_DOWNGRADE[failedStage]
  if (!target) return currentSeverity
  const currentRank = SEVERITY_RANK[normalizeSeverity(currentSeverity)] ?? 4
  const targetRank = SEVERITY_RANK[target]
  return targetRank < currentRank ? target : currentSeverity
}

function normalizeSeverity(s) {
  const m = String(s || '').match(/^(critical|high|medium|low|info)/i)
  if (!m) return 'Medium'
  const v = m[1].toLowerCase()
  return v.charAt(0).toUpperCase() + v.slice(1)
}

/**
 * Extract evidence-only fields from a finding into a single judge-readable string.
 *
 * Sprint A (2026-05-09): production schema audit on /root/intel/pentest/VALIDATED-FINDINGS.jsonl
 * showed the original `f.proof || f.evidence || f.reproduction_method` chain had two bugs:
 *   1. Object-shaped `evidence` (3/48 findings) was coerced to "[object Object]" by template
 *      literal. Stage A then "downgraded" on serialization noise, not real reasoning.
 *   2. `proof` is null on 48/48 real findings — the chain always fell through. Real evidence
 *      lives in `reproduction_method` (45/48) and `reproduction_result` (45/48).
 *
 * Fix: stringify objects via JSON, combine ALL populated evidence carriers, never silently drop.
 *
 * Anti-sycophancy preserved: only EVIDENCE fields included, never analyst CLAIMS
 * (notes, false_positive_check, threat_model, impact, gate12, severity_original).
 */
function extractEvidence(f) {
  const parts = []
  const pushIfNonEmpty = (label, val) => {
    if (val == null) return
    if (typeof val === 'string') {
      const trimmed = val.trim()
      if (trimmed) parts.push(label ? `${label}: ${trimmed}` : trimmed)
      return
    }
    if (typeof val === 'object') {
      // JSON.stringify catches both objects and arrays. Pretty-print for legibility.
      try {
        const json = JSON.stringify(val, null, 2)
        if (json && json !== '{}' && json !== '[]') {
          parts.push(label ? `${label}:\n${json}` : json)
        }
      } catch {
        // circular ref or non-serializable — skip rather than coerce to "[object Object]"
      }
    }
  }

  pushIfNonEmpty(null, f.proof)
  pushIfNonEmpty(null, f.evidence)
  pushIfNonEmpty('REPRODUCTION', f.reproduction_method)
  pushIfNonEmpty('RESULT', f.reproduction_result)

  return parts.length > 0 ? parts.join('\n\n') : '(no evidence)'
}

/**
 * Build the LLM prompt for evaluating a single finding through stages A-D.
 * Anti-sycophancy: deliberately omits originating agent name and prior verdicts.
 *
 * @param {object} finding
 * @param {string} target
 * @param {object} [opts]
 * @param {boolean} [opts.promotionMode=false] — if true, returns the stricter
 *   Medium→High promotion-tier prompt instead of the standard Critical/High prompt.
 */
function buildJudgePrompt(finding, target, opts = {}) {
  const f = finding || {}
  // Anti-sycophancy: include only RAW EVIDENCE/FACTS, never analyst's CLAIMS.
  // Specifically EXCLUDED:
  //   - f.impact            — analyst's severity assertion ("Attacker CAN...")
  //                           primes Stage B/C to defer
  //   - f.gate12.*          — analyst's threat-model classification
  //                           (attacker_privilege, trust_boundary) primes Stage B
  //   - f.severity_original — would re-anchor judge on analyst's severity
  //   - f.notes             — analyst commentary mixed with description, primes Stage D
  //   - f.false_positive_check — analyst's own FP-check, self-reinforcing
  //   - f.threat_model      — analyst's threat model (judge derives its own)
  // The judge must derive its own threat model from observable evidence.
  // Promotion mode adds: f.severity is shown but f.severity_original (if leaked
  // by callers) is NEVER included — same anti-sycophancy guarantee as standard.
  // (Documented after retro 2026-05-07 + Sprint A 2026-05-09 schema audit.)
  const evidenceText = extractEvidence(f)
  const bypassLine = f.bypass_url && f.bypass_url !== f.url ? `\n  Bypass URL:  ${f.bypass_url}` : ''

  if (opts.promotionMode) return buildPromotionPrompt(f, target, evidenceText, bypassLine)

  // Chain-verifier evidence bridge (2026-06-06): if Phase 3.6 ran real curl requests
  // and confirmed/denied reachability, surface that DETERMINISTIC evidence to ARBITER.
  // Anti-sycophancy is about not seeing the LLM agent's verdict — not about hiding curl output.
  // Real HTTP responses from chain-verifier are ground truth, not prior opinion.
  const chainEvidenceLine = f.chain_verified === true
    ? `\n  Chain-Verified: YES — deterministic curl execution confirmed this chain is reachable. Stage C should reflect this.`
    : f.chain_verified === false
    ? `\n  Chain-Verified: NO — deterministic curl execution FAILED to reproduce. Treat Stage C with skepticism.`
    : ''
  const chainDetailLine = f.chain_evidence
    ? `\n  Chain Evidence: ${String(f.chain_evidence).slice(0, 200)}`
    : ''

  return `You are the Judge Verifier. Evaluate the following security finding through 4 INDEPENDENT stages.

FINDING:
  Title:       ${f.title || '(no title)'}
  Severity:    ${f.severity || 'Medium'}
  Description: ${f.description || '(no description)'}
  Evidence:    ${evidenceText}
  URL:         ${f.url || target || '(no URL)'}${bypassLine}${chainEvidenceLine}${chainDetailLine}

TARGET CONTEXT: ${target || '(no target)'}

EVALUATE 4 STAGES:

Stage A — Pattern Noise:
  Is this pattern-matched noise (test code, examples, framework boilerplate, doc strings)
  or a real vulnerability in production code?
  PASS if: real, exploitable, in production code path
  FAIL if: it's a false-positive pattern match

Stage B — Attacker Prerequisites:
  What does an attacker need to exploit this? Authentication? Specific role?
  Network position? Race window? Sensitive user input?
  PASS if: prerequisites are realistic for an external attacker
  FAIL if: prerequisites are unrealistic (e.g., already-root, internal-only network, perfect timing)

Stage C — Reachability:
  Can the vulnerable code be reached from an external entry point
  (HTTP request, API call, file upload, message queue, scheduled job)?
  PASS if: there's a demonstrable path from external entry to the vulnerable code
  FAIL if: the code is internal-only, dead code, or unreachable

Stage D — Finality:
  Final sanity check: is this in test code? Are conditions unrealistic
  in production? Has it been mitigated upstream by another fix?
  PASS if: production code, realistic conditions, not mitigated elsewhere
  FAIL if: test code, unrealistic preconditions, already mitigated

OUTPUT STRICT JSON ONLY (no markdown fences, no commentary):
{
  "stage_a": {"pass": true|false, "reason": "<one sentence>"},
  "stage_b": {"pass": true|false, "reason": "<one sentence>"},
  "stage_c": {"pass": true|false, "reason": "<one sentence>"},
  "stage_d": {"pass": true|false, "reason": "<one sentence>"},
  "verdict": "confirmed" | "downgraded",
  "first_failed_stage": "A" | "B" | "C" | "D" | null
}

A finding is "confirmed" ONLY if ALL FOUR stages pass.
"first_failed_stage" is the FIRST stage that failed (A,B,C,D order), or null if confirmed.

Be skeptical. Findings come from automated agents that may over-flag.
Your job is to catch false positives. Do NOT confirm just because the title sounds serious.`
}

/**
 * Build the STRICTER Medium-tier promotion prompt (Sprint Promotion-1, 2026-05-09).
 *
 * Why a separate prompt: the standard rubric asks "is this real / reachable /
 * not test code". The promotion rubric asks the same questions BUT with stricter
 * acceptance — "is this a REAL exploitable bug (not just a hardening recommendation)
 * with MINIMAL prereqs (unauthenticated/low-privilege)". A Medium finding that
 * passes the stricter bar deserves promotion to High; one that doesn't either
 * downgrades (Stage A/B fail) or stays Medium (Stage C/D fail).
 *
 * Anti-sycophancy: NEVER references "specialist" / "analyst" / "Medium-tier" /
 * "the original severity is" — same discipline as standard. The judge must
 * decide independently from raw evidence.
 */
function buildPromotionPrompt(f, target, evidenceText, bypassLine) {
  return `You are the Judge Verifier in PROMOTION-TIER mode — a stricter second-pass gate.

This prompt evaluates a finding through 4 INDEPENDENT stages with a higher acceptance bar
than the standard tier. The promotion gate distinguishes high-quality bugs from low-quality
ones in the borderline pool. Be MORE skeptical than the standard rubric.

FINDING:
  Title:       ${f.title || '(no title)'}
  Description: ${f.description || '(no description)'}
  Evidence:    ${evidenceText}
  URL:         ${f.url || target || '(no URL)'}${bypassLine}

TARGET CONTEXT: ${target || '(no target)'}

EVALUATE 4 STAGES (STRICTER RUBRIC):

Stage A — Real Exploitable Bug (NOT a hardening recommendation):
  Is this a REAL exploitable bug — concrete, reproducible, with demonstrable security
  impact — OR is it a defense-in-depth / hardening recommendation (e.g. "should add
  HSTS", "could enable CSP", "missing security header", "rate-limit could be tighter")?
  PASS ONLY IF: there is a concrete, exploitable bug with security impact (data exposure,
                privilege escalation, account takeover, code execution, or similar).
  FAIL IF: this reads as a hardening recommendation, best-practice nudge, or "nice to have"
           rather than a real exploitable vulnerability.

Stage B — Minimal Attacker Prerequisites:
  In the promotion gate, prerequisites must be MINIMAL — unauthenticated or
  low-privilege only. An attacker who must already be admin, must already have
  creds, or must control internal infra does NOT pass this stricter bar.
  PASS ONLY IF: an unauthenticated or LOW-privilege external attacker can exploit.
  FAIL IF: prerequisites require authenticated user, admin role, internal network
           position, social engineering, perfect timing, or any non-trivial precondition.

Stage C — Reachable from External Entry:
  Can the vulnerable code be reached from an external entry point (HTTP request,
  API call, file upload, message queue, scheduled job)?
  PASS if: there's a demonstrable path from external entry to the vulnerable code.
  FAIL if: the code is internal-only, dead code, or unreachable.

Stage D — Production Code (NOT test/example):
  Final sanity check: is this in production code? Or is it test fixtures, examples,
  framework boilerplate, or already mitigated upstream?
  PASS if: production code, realistic conditions, not mitigated elsewhere.
  FAIL if: test code, example code, unrealistic preconditions, already mitigated.

OUTPUT STRICT JSON ONLY (no markdown fences, no commentary):
{
  "stage_a": {"pass": true|false, "reason": "<one sentence>"},
  "stage_b": {"pass": true|false, "reason": "<one sentence>"},
  "stage_c": {"pass": true|false, "reason": "<one sentence>"},
  "stage_d": {"pass": true|false, "reason": "<one sentence>"},
  "verdict": "confirmed" | "downgraded",
  "first_failed_stage": "A" | "B" | "C" | "D" | null
}

A finding is "confirmed" ONLY if ALL FOUR stages pass under the STRICTER rubric.
"first_failed_stage" is the FIRST stage that failed (A,B,C,D order), or null if confirmed.

Be MORE skeptical than the standard tier. The promotion gate is a high bar —
err on the side of NOT promoting. Hardening recommendations and authenticated-only
attacks should fail Stage A or Stage B respectively.`
}

/**
 * Parse the LLM response into a structured judgement.
 * Tolerant of common LLM JSON deviations (markdown fences, leading text).
 */
function parseJudgeResponse(text) {
  // Sprint B.1 (2026-05-09): Strix-style "No PoC = No Report" discipline.
  // When the LLM returns garbage (empty, non-JSON, malformed), the original
  // behavior fell back to verdict='confirmed' — which silently upgraded findings
  // through tool flakiness. We now return 'indeterminate' so the publication-
  // gate layer (applyJudgeResult) can downgrade unverifiable Critical/High to
  // Medium without losing the audit trail.
  if (!text || typeof text !== 'string') {
    return { error: 'empty response', verdict: 'indeterminate', first_failed_stage: null }
  }
  // Strip markdown fences
  let cleaned = text.trim()
  cleaned = cleaned.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '')
  // Try to extract first JSON object
  const jsonMatch = cleaned.match(/\{[\s\S]*\}/)
  if (!jsonMatch) {
    return { error: 'no JSON found', verdict: 'indeterminate', first_failed_stage: null }
  }
  try {
    const parsed = JSON.parse(jsonMatch[0])
    // Validate required fields
    if (!parsed.verdict || !['confirmed', 'downgraded', 'indeterminate'].includes(parsed.verdict)) {
      // Infer from stage results if verdict missing
      const allPass = ['stage_a', 'stage_b', 'stage_c', 'stage_d']
        .every(k => parsed[k]?.pass === true)
      parsed.verdict = allPass ? 'confirmed' : 'downgraded'
      if (!allPass) {
        for (const stage of ['a', 'b', 'c', 'd']) {
          if (parsed[`stage_${stage}`]?.pass === false) {
            parsed.first_failed_stage = stage.toUpperCase()
            break
          }
        }
      }
    }
    return parsed
  } catch (e) {
    return { error: `parse failed: ${e.message}`, verdict: 'indeterminate', first_failed_stage: null }
  }
}

/**
 * Apply judge result to a finding, producing the post-judge object.
 *
 * - verdict='confirmed':     severity unchanged.
 * - verdict='downgraded':    severity drops to the stage's downgrade target.
 * - verdict='indeterminate': Sprint B.1 (2026-05-09) Strix-style publication
 *                            gate. Critical/High auto-downgrade to Medium —
 *                            tool failure must NOT silently let high-severity
 *                            findings through. Medium/Low/Info kept as-is.
 *                            Original severity preserved in severity_original
 *                            for audit + manual review.
 */
function applyJudgeResult(finding, judgement) {
  const original = normalizeSeverity(finding.severity)
  const verdict = judgement.verdict || 'confirmed'
  const result = {
    ...finding,
    judge_verdict: verdict,
    judge_first_failed_stage: judgement.first_failed_stage || null,
    judge_stages: {
      a: judgement.stage_a || null,
      b: judgement.stage_b || null,
      c: judgement.stage_c || null,
      d: judgement.stage_d || null,
    },
    severity_original: original,
  }
  if (judgement.error) result.judge_error = judgement.error

  if (verdict === 'downgraded' && judgement.first_failed_stage) {
    result.severity = downgradeSeverity(original, judgement.first_failed_stage)
  } else if (verdict === 'indeterminate') {
    // Publication gate: cap unverifiable findings at Medium. SEVERITY_RANK
    // comparison ensures we never elevate (Low+indeterminate stays Low).
    const cap = SEVERITY_RANK.Medium
    const currentRank = SEVERITY_RANK[original] ?? cap
    result.severity = currentRank > cap ? 'Medium' : original
  } else {
    result.severity = original
  }
  return result
}

/**
 * Mock LLM caller for unit testing. Real implementation (Phase 2) will use
 * the Anthropic SDK via existing modelRouter pattern.
 *
 * @param {string} prompt - the judge prompt
 * @param {object} opts - { mockResponse } for testing, real {model, ...} for production
 */
async function callJudgeLLM(prompt, opts = {}) {
  if (opts.mockResponse !== undefined) {
    return opts.mockResponse
  }
  // Real implementation deferred to Phase 2 integration
  throw new Error('callJudgeLLM: real LLM integration not yet implemented; pass opts.mockResponse for testing')
}

/**
 * Run the judge over an array of findings. Returns per-finding results
 * + aggregate summary.
 *
 * @param {Array} findings - array from VALIDATED-FINDINGS-<taskId>.jsonl
 * @param {object} opts - { target, mockResponses?, callLLM? }
 * @returns {Promise<{results: Array, summary: object}>}
 */
async function judgeFindings(findings, opts = {}) {
  const target = opts.target || ''
  const callLLM = opts.callLLM || callJudgeLLM
  const mockResponses = opts.mockResponses || {}
  // severityFilter: when set (e.g., ['Critical', 'High']), only those severities
  // hit the LLM. Below-threshold findings pass through with judge_verdict='not-judged'.
  // Cost optimization for Phase 3.9 production wiring.
  const severityFilter = Array.isArray(opts.severityFilter) && opts.severityFilter.length > 0
    ? new Set(opts.severityFilter.map(normalizeSeverity))
    : null

  const results = []
  let confirmed = 0
  let downgraded = 0
  const downgradedByStage = { A: 0, B: 0, C: 0, D: 0 }

  for (const f of findings) {
    const sev = normalizeSeverity(f.severity)
    if (severityFilter && !severityFilter.has(sev)) {
      // Below threshold: pass-through, no LLM call
      results.push({
        ...f,
        severity: sev,
        judge_verdict: 'not-judged',
        judge_reason: `severity ${sev} below filter threshold`,
      })
      continue
    }

    const prompt = buildJudgePrompt(f, target)
    const findingId = f.id || `idx-${results.length}`
    let response
    try {
      // Structured output on the standard 4-stage judge (guaranteed schema-valid JSON).
      const llmOpts = mockResponses[findingId] !== undefined
        ? { mockResponse: mockResponses[findingId] }
        : { ...(opts.llmOpts || {}), jsonSchema: JUDGE_SCHEMA }
      response = await callLLM(prompt, llmOpts)
    } catch (e) {
      // LLM error → conservative: keep original severity, mark indeterminate
      results.push({ ...f, judge_verdict: 'indeterminate', judge_error: e.message })
      continue
    }
    const judgement = parseJudgeResponse(response)
    const applied = applyJudgeResult(f, judgement)
    results.push(applied)
    if (applied.judge_verdict === 'confirmed') confirmed++
    else if (applied.judge_verdict === 'downgraded') {
      downgraded++
      const stage = applied.judge_first_failed_stage
      if (stage && downgradedByStage[stage] !== undefined) downgradedByStage[stage]++
    }
  }

  return {
    results,
    summary: {
      total: findings.length,
      confirmed,
      downgraded,
      indeterminate: findings.length - confirmed - downgraded,
      downgraded_by_stage: downgradedByStage,
    },
  }
}

/**
 * Apply promotion-tier judge result to a Medium finding.
 *
 * Promotion mapping (different from standard applyJudgeResult):
 *   - All 4 stages PASS  → severity 'High',  judge_promotion=true,  verdict='confirmed'
 *   - Stage A or B fail  → downgrade per STAGE_DOWNGRADE (A→Info, B→Medium=no-op)
 *   - Stage C or D fail  → severity stays 'Medium' (kept-at-tier),  judge_promotion=false
 *   - indeterminate      → severity stays 'Medium' (publication gate keeps cap)
 *
 * Why C/D fail keeps Medium (instead of Low/Info): the spec says a Medium that
 * fails ONLY reachability or finality is still a real bug at its current tier;
 * we just don't promote. Stage A/B failures, by contrast, indicate the finding
 * was wrong at the substance level (no real bug / wrong threat model) and the
 * existing STAGE_DOWNGRADE table applies (A→Info, B→Medium).
 */
function applyPromotionResult(finding, judgement) {
  const original = normalizeSeverity(finding.severity)  // 'Medium' by precondition
  const verdict = judgement.verdict || 'confirmed'
  const result = {
    ...finding,
    judge_verdict: verdict,
    judge_first_failed_stage: judgement.first_failed_stage || null,
    judge_stages: {
      a: judgement.stage_a || null,
      b: judgement.stage_b || null,
      c: judgement.stage_c || null,
      d: judgement.stage_d || null,
    },
    judge_promotion: false,
    severity_original: original,
  }
  if (judgement.error) result.judge_error = judgement.error

  if (verdict === 'confirmed') {
    // All 4 stages passed under stricter rubric → PROMOTE Medium → High
    result.severity = 'High'
    result.judge_promotion = true
  } else if (verdict === 'downgraded' && judgement.first_failed_stage) {
    const stage = judgement.first_failed_stage
    if (stage === 'A' || stage === 'B') {
      // Substance failure: standard downgrade table applies
      result.severity = downgradeSeverity(original, stage)
    } else {
      // C or D failure: not promoted, but real bug at current tier — keep Medium
      result.severity = original
    }
  } else {
    // indeterminate or unknown — keep at Medium (no promotion, no demotion)
    result.severity = original
  }
  return result
}

/**
 * Run the judge with a promotion gate for Medium findings.
 *
 * Behavior:
 *   - Critical / High → standard tier (existing buildJudgePrompt + applyJudgeResult)
 *   - Medium          → promotion tier (buildPromotionPrompt + applyPromotionResult)
 *                       capped at PROMOTION_CAP_DEFAULT (10) per task; excess passes
 *                       through with judge_verdict='not-judged-cap-exceeded'.
 *   - Low / Info      → pass-through with judge_verdict='not-judged' (no LLM call)
 *
 * Anti-sycophancy: promotion-mode prompt does NOT see severity_original, specialist
 * names, or any framing that would prime confirmation — same discipline as standard.
 *
 * @param {Array} findings
 * @param {object} opts - { target, callLLM, mockResponses?, promotionCap?, llmOpts? }
 */
async function judgeFindingsWithPromotion(findings, opts = {}) {
  const target = opts.target || ''
  const callLLM = opts.callLLM || callJudgeLLM
  const mockResponses = opts.mockResponses || {}
  const promotionCap = typeof opts.promotionCap === 'number' ? opts.promotionCap : PROMOTION_CAP_DEFAULT

  const standardSet = new Set(STANDARD_TIER_FILTER.map(normalizeSeverity))
  const promotionSet = new Set(PROMOTION_TIER_FILTER.map(normalizeSeverity))

  const results = []
  let confirmed = 0
  let downgraded = 0
  let promoted = 0
  let promotionLLMCalls = 0
  const downgradedByStage = { A: 0, B: 0, C: 0, D: 0 }

  for (const f of findings) {
    const sev = normalizeSeverity(f.severity)
    const findingId = f.id || `idx-${results.length}`

    if (standardSet.has(sev)) {
      // Standard tier — existing behavior
      const prompt = buildJudgePrompt(f, target)
      let response
      try {
        const llmOpts = mockResponses[findingId] !== undefined
          ? { mockResponse: mockResponses[findingId] }
          : (opts.llmOpts || {})
        response = await callLLM(prompt, llmOpts)
      } catch (e) {
        results.push({ ...f, severity: sev, judge_verdict: 'indeterminate', judge_error: e.message })
        continue
      }
      const judgement = parseJudgeResponse(response)
      const applied = applyJudgeResult(f, judgement)
      results.push(applied)
      if (applied.judge_verdict === 'confirmed') confirmed++
      else if (applied.judge_verdict === 'downgraded') {
        downgraded++
        const st = applied.judge_first_failed_stage
        if (st && downgradedByStage[st] !== undefined) downgradedByStage[st]++
      }
      continue
    }

    if (promotionSet.has(sev)) {
      // Promotion tier — Medium findings
      if (promotionLLMCalls >= promotionCap) {
        // Cost cap exceeded: pass through unchanged
        results.push({
          ...f,
          severity: sev,
          judge_verdict: 'not-judged-cap-exceeded',
          judge_reason: `promotion-tier cap of ${promotionCap} exceeded for this task`,
        })
        continue
      }
      const prompt = buildJudgePrompt(f, target, { promotionMode: true })
      promotionLLMCalls++
      let response
      try {
        const llmOpts = mockResponses[findingId] !== undefined
          ? { mockResponse: mockResponses[findingId] }
          : (opts.llmOpts || {})
        response = await callLLM(prompt, llmOpts)
      } catch (e) {
        results.push({ ...f, severity: sev, judge_verdict: 'indeterminate', judge_error: e.message, judge_promotion: false })
        continue
      }
      const judgement = parseJudgeResponse(response)
      const applied = applyPromotionResult(f, judgement)
      results.push(applied)
      if (applied.judge_promotion === true) promoted++
      if (applied.judge_verdict === 'confirmed') confirmed++
      else if (applied.judge_verdict === 'downgraded') {
        downgraded++
        const st = applied.judge_first_failed_stage
        if (st && downgradedByStage[st] !== undefined) downgradedByStage[st]++
      }
      continue
    }

    // Below filter (Low/Info): pass-through, no LLM call
    results.push({
      ...f,
      severity: sev,
      judge_verdict: 'not-judged',
      judge_reason: `severity ${sev} below filter threshold`,
    })
  }

  return {
    results,
    summary: {
      total: findings.length,
      confirmed,
      downgraded,
      promoted,
      indeterminate: findings.length - confirmed - downgraded,
      downgraded_by_stage: downgradedByStage,
      promotion_llm_calls: promotionLLMCalls,
      promotion_cap: promotionCap,
    },
  }
}

// ---------------------------------------------------------------------------
// judgeWithConsensus — 3-judge majority vote for high-stakes findings
// ---------------------------------------------------------------------------
//
// Research (self-consistency sampling, 2024-2025): running the same judge prompt
// independently 3 times and taking majority vote improves accuracy by ~17.9% vs
// a single pass. Cost: 3× per finding. ROI: excellent for High/Critical only.
//
// Implementation: 3 callLLM calls with slight perspective variations to break
// symmetry — same evidence, same 4-stage rubric, different framing emphasis.
// Anti-sycophancy preserved: none of the 3 prompts mention prior verdicts.
//
// Returns: judge result with consensus_confidence field:
//   3/3 agree  → consensus_confidence: 'high'
//   2/3 agree  → consensus_confidence: 'medium'
// The majority verdict is applied. Tiebreak (impossible with 3 binary outcomes)
// is handled conservatively (downgrade wins ties).

const CONSENSUS_LENSES = [
  '', // lens 0: standard prompt (no preamble)
  '\n[REVIEWER LENS: Be strict. Your default is skepticism — confirm only if evidence is unambiguous.]',
  '\n[REVIEWER LENS: Be thorough. Look for edge cases where this finding could be a false positive.]',
]

async function judgeWithConsensus(finding, target, opts = {}) {
  const callLLM = opts.callLLM || callJudgeLLM
  const basePrompt = buildJudgePrompt(finding, target, opts)
  // Structured output on the High/Critical consensus path — each lens returns guaranteed
  // schema-valid JSON, so a formatting wobble can never flip a confirmed finding to indeterminate.
  const llmOpts = { ...(opts.llmOpts || {}), jsonSchema: JUDGE_SCHEMA }

  // Run 3 judges in parallel (different lens preambles for perspective diversity)
  const judgeResults = await Promise.all(CONSENSUS_LENSES.map(async (lens) => {
    const prompt = lens ? basePrompt + lens : basePrompt
    try {
      const response = await callLLM(prompt, llmOpts)
      return parseJudgeResponse(response)
    } catch (e) {
      return { verdict: 'indeterminate', first_failed_stage: null, error: e.message }
    }
  }))

  // Tally votes
  const votes = judgeResults.map(r => r.verdict || 'indeterminate')
  const confirmedCount = votes.filter(v => v === 'confirmed').length
  const downgradedCount = votes.filter(v => v === 'downgraded').length

  // Majority verdict (downgrade wins on tie since 3 judges can't tie on binary)
  const majorityVerdict = confirmedCount >= 2 ? 'confirmed' : 'downgraded'
  const consensusConfidence = (confirmedCount === 3 || downgradedCount === 3) ? 'high' : 'medium'

  // Use the representative result from the majority group for stage details
  const representativeResult = judgeResults.find(r => r.verdict === majorityVerdict)
    || judgeResults[0]

  return {
    ...representativeResult,
    verdict: majorityVerdict,
    consensus_votes: { confirmed: confirmedCount, downgraded: downgradedCount, total: 3 },
    consensus_confidence: consensusConfidence,
  }
}

/**
 * judgeFindings with optional 3-judge consensus for High/Critical findings.
 * Drop-in replacement for judgeFindings when opts.useConsensus=true.
 * Only High/Critical findings get the 3× treatment; Medium/Low pass through
 * normally (cost control — consensus ROI is highest on high-stakes decisions).
 */
async function judgeFindingsWithConsensus(findings, opts = {}) {
  const HIGH_STAKES = new Set(['critical', 'high'])
  const callLLM = opts.callLLM || callJudgeLLM
  const target = opts.target || ''

  const results = []
  let confirmed = 0, downgraded = 0

  for (const f of findings) {
    const sev = normalizeSeverity(f.severity)
    if (HIGH_STAKES.has(sev)) {
      // 3-judge consensus for High/Critical
      let judgeResult
      try {
        judgeResult = await judgeWithConsensus(f, target, { callLLM, llmOpts: opts.llmOpts || {} })
      } catch (e) {
        results.push({ ...f, judge_verdict: 'indeterminate', judge_error: e.message })
        continue
      }
      const applied = applyJudgeResult(f, judgeResult)
      applied.consensus_votes = judgeResult.consensus_votes
      applied.consensus_confidence = judgeResult.consensus_confidence
      results.push(applied)
      if (applied.judge_verdict === 'confirmed') confirmed++
      else if (applied.judge_verdict === 'downgraded') downgraded++
    } else {
      // Single-judge for Medium/Low (cost control)
      const prompt = buildJudgePrompt(f, target)
      let response
      try { response = await callLLM(prompt, opts.llmOpts || {}) }
      catch (e) { results.push({ ...f, judge_verdict: 'indeterminate', judge_error: e.message }); continue }
      const applied = applyJudgeResult(f, parseJudgeResponse(response))
      results.push(applied)
      if (applied.judge_verdict === 'confirmed') confirmed++
      else if (applied.judge_verdict === 'downgraded') downgraded++
    }
  }

  return {
    results,
    summary: { total: findings.length, confirmed, downgraded, indeterminate: findings.length - confirmed - downgraded },
  }
}

module.exports = {
  STAGE_DOWNGRADE,
  SEVERITY_RANK,
  PROMOTION_TIER_FILTER,
  STANDARD_TIER_FILTER,
  PROMOTION_CAP_DEFAULT,
  buildJudgePrompt,
  buildPromotionPrompt,
  parseJudgeResponse,
  applyJudgeResult,
  applyPromotionResult,
  downgradeSeverity,
  normalizeSeverity,
  judgeFindings,
  JUDGE_SCHEMA,
  judgeFindingsWithPromotion,
  judgeWithConsensus,
  judgeFindingsWithConsensus,
}
