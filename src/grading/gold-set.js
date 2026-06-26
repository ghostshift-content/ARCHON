
const __roots = require('../../paths') // portable roots (KURU_*_ROOT) — see paths.js
// /root/agents/gold-set.js
//
// Gold-set infrastructure: known-correct grader outcomes used for regression
// testing and drift detection. Each entry has:
//   - expectation (string) — rubric item the grader sees
//   - evidence_quote (string) — literal substring from activity (empty if expected_passed=false)
//   - expected_passed (boolean) — what a correct grader must return
//
// Usage:
//   Load gold entries:  node gold-set.js list
//   Add via CLI:        node gold-set.js add --squad pentest --vuln-class xss --pass --expectation "..." --quote "..." --notes "..."
//   Replay against current grader:  node gold-set.js replay
//
// Replay mode exercises grader.verifyEvidenceQuote + stub-grade for each entry and
// reports % matching expected_passed. A drop in that % over time is grader drift.

const fs = require('fs')
const path = require('path')

const GOLD_PATH = (__roots.INTEL_ROOT + '/gold-set.jsonl')

function readAll() {
  try {
    return fs.readFileSync(GOLD_PATH, 'utf-8')
      .split('\n')
      .filter(l => l.trim())
      .map(l => { try { return JSON.parse(l) } catch { return null } })
      .filter(Boolean)
  } catch { return [] }
}

function appendEntry(entry) {
  if (!entry.id) entry.id = `gold-${Date.now()}`
  if (!entry.expectation) throw new Error('expectation required')
  if (typeof entry.expected_passed !== 'boolean') throw new Error('expected_passed must be boolean')
  fs.appendFileSync(GOLD_PATH, JSON.stringify(entry) + '\n')
  return entry
}

function removeEntry(id) {
  const kept = readAll().filter(e => e.id !== id)
  const tmp = GOLD_PATH + '.tmp'
  fs.writeFileSync(tmp, kept.map(e => JSON.stringify(e)).join('\n') + (kept.length > 0 ? '\n' : ''))
  fs.renameSync(tmp, GOLD_PATH)
  return kept.length
}

// Gold-set schema note: entries may optionally include `activity_sample` — a short
// excerpt of actual agent activity text from which evidence_quote was extracted.
// When present, replay() uses it as the haystack for a meaningful drift check.
// When absent, replay() checks basic shape validity (non-empty quote, reasonable length).

// Replay: run the grader's pure functions (verifyEvidenceQuote + basic shape check)
// against each gold entry. Records match/mismatch; full LLM refinement is optional
// (expensive) and gated behind --llm flag.
async function replay(opts = {}) {
  const grader = require('./grader')
  const entries = readAll()
  const results = []

  for (const e of entries) {
    const observed = {
      id: e.id, squad: e.squad, expected_passed: e.expected_passed,
      quote_valid: null, grader_would_pass: null,
    }

    if (e.expected_passed === true) {
      if (!e.evidence_quote || e.evidence_quote.trim().length === 0) {
        // A PASS entry with no evidence_quote is invalid
        observed.quote_valid = false
        observed.grader_would_pass = false
      } else if (e.activity_sample) {
        // When the entry has an activity_sample, use it as the real haystack.
        // This is the meaningful check: does the grader accept the quote from real activity?
        const valid = grader.verifyEvidenceQuote(e.evidence_quote, e.activity_sample)
        observed.quote_valid = valid
        observed.grader_would_pass = valid
      } else {
        // No activity_sample: can only do basic shape validation.
        // Check quote is non-trivially long (≥10 chars) and looks like a real finding fragment.
        const isSubstantive = e.evidence_quote.trim().length >= 10
        observed.quote_valid = isSubstantive
        observed.grader_would_pass = isSubstantive
        observed.note = 'no activity_sample — only shape-checked; add activity_sample for full drift detection'
      }
    } else {
      // Negative: should NOT have a passable quote — verify evidence_quote is empty
      const hasQuote = e.evidence_quote && e.evidence_quote.trim().length > 0
      observed.quote_valid = !hasQuote // valid means: correctly has no quote
      observed.grader_would_pass = false
    }

    observed.match = observed.grader_would_pass === observed.expected_passed
    results.push(observed)
  }

  const matched = results.filter(r => r.match).length
  const kappaReport = computeKappa(results)
  return { entries: entries.length, matched, kappa: kappaReport, results }
}

// (2026-04-20) Cohen's kappa — agreement between grader and human labels,
// corrected for chance agreement. Industry targets from Judge's Verdict (arxiv 2510.09738):
//   κ ≥ 0.61 = substantial agreement (minimum useful)
//   κ ≥ 0.81 = near-human (what top grader platforms ship)
//   κ < 0.40 = poor agreement → grader can't be trusted
//
// Sample-size guidance: n ≥ 97 for 10% margin at 95% CI. Below ~30 entries
// the kappa estimate has wide uncertainty — report but don't gate on it yet.
//
// Returns: { kappa, agreement_pct, chance_agreement, interpretation, n, confidence }
function computeKappa(results) {
  const n = results.length
  if (n === 0) return { kappa: null, n: 0, interpretation: 'no data' }
  // 2x2 confusion: human pass/fail × grader pass/fail
  let a = 0, b = 0, c = 0, d = 0
  for (const r of results) {
    const human = r.expected_passed ? 1 : 0
    const grader = r.grader_would_pass ? 1 : 0
    if (human === 1 && grader === 1) a++       // true positive (both pass)
    else if (human === 0 && grader === 0) d++  // true negative (both fail)
    else if (human === 1 && grader === 0) b++  // false negative (grader missed)
    else c++                                    // false positive (grader over-passed)
  }
  const po = (a + d) / n                                      // observed agreement
  const pHumanPass = (a + b) / n
  const pGraderPass = (a + c) / n
  const pe = (pHumanPass * pGraderPass) + ((1 - pHumanPass) * (1 - pGraderPass)) // chance agreement
  const kappa = pe === 1 ? 1 : (po - pe) / (1 - pe)
  let interpretation
  if (n < 30) interpretation = `TENTATIVE (n=${n}<30, wide CI) — grow gold set to 50+ before trusting κ`
  else if (kappa >= 0.81) interpretation = 'near-human agreement — grader is trustworthy'
  else if (kappa >= 0.61) interpretation = 'substantial agreement — production-usable with monitoring'
  else if (kappa >= 0.41) interpretation = 'moderate — grader needs tuning'
  else if (kappa >= 0.21) interpretation = 'fair — grader is barely better than chance'
  else interpretation = 'poor — grader CANNOT be trusted, human review required'
  return {
    kappa: Math.round(kappa * 1000) / 1000,
    agreement_pct: Math.round(po * 100),
    chance_agreement: Math.round(pe * 100) / 100,
    interpretation,
    n,
    confusion: { true_pos: a, false_neg: b, false_pos: c, true_neg: d },
    confidence: n >= 97 ? 'high (n ≥ 97)' : n >= 30 ? 'medium' : 'low',
  }
}

module.exports = { GOLD_PATH, readAll, appendEntry, removeEntry, replay, computeKappa }

// CLI
if (require.main === module) {
  const [cmd, ...rest] = process.argv.slice(2)
  const argv = {}
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]
    if (a.startsWith('--')) {
      const k = a.slice(2)
      const v = (!rest[i + 1] || rest[i + 1].startsWith('--')) ? true : rest[++i]
      argv[k] = v
    }
  }
  ;(async () => {
    try {
      if (cmd === 'list' || !cmd) {
        const all = readAll()
        console.log(`${all.length} gold entries:`)
        for (const e of all) {
          console.log(`  ${e.id}  squad=${e.squad}  pass=${e.expected_passed}  ${String(e.expectation).slice(0, 60)}...`)
        }
      } else if (cmd === 'add') {
        const entry = {
          squad: argv.squad || 'pentest',
          vuln_class: argv['vuln-class'] || 'generic',
          severity: argv.severity || 'Medium',
          expected_passed: !!argv.pass,
          expectation: argv.expectation || '',
          evidence_quote: argv.quote || '',
          notes: argv.notes || '',
        }
        const added = appendEntry(entry)
        console.log(`added ${added.id}`)
      } else if (cmd === 'rm') {
        const n = removeEntry(argv.id)
        console.log(`${n} entries remaining`)
      } else if (cmd === 'replay') {
        const { entries, matched, kappa, results } = await replay(argv)
        console.log(`${matched}/${entries} gold entries match expected grader verdict (${Math.round(matched / entries * 100)}%)`)
        for (const r of results) {
          if (!r.match) console.log(`  ✗ ${r.id} expected=${r.expected_passed} grader-would=${r.grader_would_pass}`)
        }
        if (kappa) {
          console.log(`\nCohen's κ = ${kappa.kappa}  (n=${kappa.n}, agreement=${kappa.agreement_pct}%, chance=${kappa.chance_agreement})`)
          console.log(`confusion: TP=${kappa.confusion.true_pos}  FN=${kappa.confusion.false_neg}  FP=${kappa.confusion.false_pos}  TN=${kappa.confusion.true_neg}`)
          console.log(`interpretation: ${kappa.interpretation}`)
          console.log(`confidence: ${kappa.confidence}`)
        }
        process.exit(matched === entries ? 0 : 1)
      } else if (cmd === 'kappa') {
        const { kappa } = await replay(argv)
        if (!kappa) { console.log('no data'); process.exit(1) }
        console.log(JSON.stringify(kappa, null, 2))
      } else {
        console.error(`unknown command: ${cmd}. Use: list | add | rm | replay | kappa`)
        process.exit(2)
      }
    } catch (e) {
      console.error(e.message)
      process.exit(1)
    }
  })()
}
