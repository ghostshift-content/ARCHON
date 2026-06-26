// agents/isa-grader.js
//
// Per-task "Ideal State Artifact" grading (2026-06-10, PAI-inspired).
//
// A dispatch can declare task-SPECIFIC success criteria (ISCs — "what *done* looks
// like for THIS task") beyond the squad's GENERIC eval rubric. Two wins:
//   1. The criteria are injected into the squad leader's prompt → the agent targets
//      them up-front (the "give the full spec up front" principle).
//   2. Grading scores the FINAL REPORT against each criterion, so a direct dispatch is
//      gradeable even when no squad eval matches — sharpening the learning-loop signal
//      revived by GATE-144.
//
// Each criterion is graded by a SINGLE structured-output Haiku call: we reuse the
// run-judge-verifier `callRealLLM` (CLI `--json-schema` → envelope.structured_output),
// so the verdict is GUARANTEED schema-valid JSON — no regex parsing, no fallback class.
//
// Fail-soft: any error returns a null-passRate result (never throws into the pipeline).

'use strict'

const MAX_REPORT_CHARS = 60000 // bound the report context handed to Haiku

const ISA_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  required: ['results'],
  properties: {
    results: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['index', 'met', 'evidence'],
        properties: {
          index: { type: 'integer' },
          met: { type: 'boolean' },
          evidence: { type: 'string' },
        },
      },
    },
  },
})

function _normalizeCriteria(criteria) {
  if (!Array.isArray(criteria)) return []
  return criteria.map(c => (typeof c === 'string' ? c.trim() : '')).filter(Boolean)
}

function buildIsaPrompt(criteria, reportText) {
  const list = criteria.map((c, i) => `${i + 1}. ${c}`).join('\n')
  const report = String(reportText || '').slice(0, MAX_REPORT_CHARS)
  return `You are grading a FINISHED report against EXPLICIT, task-specific success criteria.
For EACH criterion decide STRICTLY whether the REPORT satisfies it — judge only on what the report
actually contains, not on what you would expect a good report to contain. "Partially" or "implied" = NOT met.

SUCCESS CRITERIA:
${list}

REPORT:
${report}

Return one result per criterion: index = the 1-based number above, met = true ONLY if the report
clearly and verifiably satisfies it, evidence = a short quote or locator from the report (or, if not
met, one sentence on what is missing). Be skeptical — automated agents over-claim coverage.`
}

/**
 * Grade a report against per-task success criteria.
 *
 * @param {string[]} criteria - the ISCs (task-specific success criteria)
 * @param {string}   reportText - the final published report
 * @param {object}   opts - { callLLM, model? } — callLLM(prompt, {model, jsonSchema}) → JSON string
 * @returns {Promise<null | {passRate:number|null, met:number, total:number, criteria:Array, error?:string}>}
 *          null when there are no criteria to grade.
 */
async function gradeSuccessCriteria(criteria, reportText, opts = {}) {
  const list = _normalizeCriteria(criteria)
  if (!list.length) return null
  if (typeof opts.callLLM !== 'function') {
    return { passRate: null, met: 0, total: list.length, error: 'no callLLM provided', criteria: list.map(c => ({ criterion: c, met: null })) }
  }
  let parsed
  try {
    const raw = await opts.callLLM(buildIsaPrompt(list, reportText), {
      model: opts.model || 'claude-haiku-4-5',
      jsonSchema: ISA_SCHEMA,
    })
    parsed = typeof raw === 'string' ? JSON.parse(raw) : raw
  } catch (e) {
    return { passRate: null, met: 0, total: list.length, error: String(e && e.message || e), criteria: list.map(c => ({ criterion: c, met: null })) }
  }
  const results = Array.isArray(parsed && parsed.results) ? parsed.results : []
  // Robust criterion→result mapping. Trust `index` ONLY when the results cleanly cover 1..N;
  // otherwise fall back to POSITIONAL order when the count matches. If neither holds, the result
  // is unreliable → return a null pass-rate so the caller fails SOFT to the generic grade rather
  // than blending a confident-but-wrong 0 (model index-drift must never tank a good run's grade).
  const byIndex = new Map(results.map(r => [Number(r.index), r]))
  let resolveResult
  if (list.every((_, i) => byIndex.has(i + 1))) {
    resolveResult = (i) => byIndex.get(i + 1)
  } else if (results.length === list.length) {
    resolveResult = (i) => results[i]
  } else {
    return { passRate: null, met: 0, total: list.length, error: 'isa: result indices do not map to criteria (drift) — failing soft', criteria: list.map(c => ({ criterion: c, met: null })) }
  }
  const graded = list.map((c, i) => {
    const r = resolveResult(i) || {}
    return { criterion: c, met: r.met === true, evidence: typeof r.evidence === 'string' ? r.evidence.slice(0, 300) : '' }
  })
  const met = graded.filter(g => g.met).length
  return { passRate: Math.round((met / list.length) * 100), met, total: list.length, criteria: graded }
}

module.exports = { ISA_SCHEMA, buildIsaPrompt, gradeSuccessCriteria, _normalizeCriteria }
