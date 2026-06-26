
const __roots = require('../paths') // portable roots (KURU_*_ROOT) — see paths.js
// scripts/g4-report.js
//
// G4 multi-model experiment results renderer + decision-criteria evaluator.
//
// Reads N metrics JSON records from /root/intel/g4-experiment/, pairs Opus
// runs with Sonnet runs by target name, applies decision criteria from spec
// §3.5, renders side-by-side markdown table + ADOPT/REJECT verdict.
//
// Decision criteria (ALL THREE must hold across all targets to ADOPT Sonnet):
//   1. Findings ratio within 20% of Opus (proxy for F1 within 5% pending
//      ground-truth lookup integration)
//   2. No new false-Critical findings (Sonnet's Critical count <= Opus's)
//   3. Cost reduction >= 60%
//
// Usage: node scripts/g4-report.js
//
// Spec: docs/superpowers/specs/2026-05-06-G4-multi-model-test-design.md
// Plan: docs/superpowers/plans/2026-05-06-G4-multi-model-test-plan.md (Task 4)

const fs = require('node:fs')
const path = require('node:path')

const EXPERIMENT_DIR = (__roots.INTEL_ROOT + '/g4-experiment')

/**
 * Wilson 95% confidence interval for a proportion (k successes out of n trials).
 * Per Raptor's per-model scorecard pattern (research §18.3.3) — gives us a
 * calibrated lower-bound rather than a raw point estimate.
 *
 * @param {number} k - successes
 * @param {number} n - trials
 * @returns {{point: number, lower: number, upper: number}}
 */
function wilsonInterval(k, n) {
  if (n === 0) return { point: 0, lower: 0, upper: 0 }
  const z = 1.96 // 95% CI
  const p = k / n
  const denom = 1 + (z * z) / n
  const center = (p + (z * z) / (2 * n)) / denom
  const halfWidth = (z * Math.sqrt((p * (1 - p) + (z * z) / (4 * n)) / n)) / denom
  return {
    point: p,
    lower: Math.max(0, center - halfWidth),
    upper: Math.min(1, center + halfWidth),
  }
}

/**
 * Group metrics records by target name, pairing each Opus run with its Sonnet
 * counterpart. Returns array of {opus, sonnet} pairs (only complete pairs).
 */
function pairBySource(metrics) {
  const byTarget = new Map()
  for (const m of metrics) {
    const targetKey = m.target
    if (!byTarget.has(targetKey)) byTarget.set(targetKey, {})
    const isOpus = m.model_profile === 'default' || m.krishna_model === 'claude-opus-4-7'
    if (isOpus) {
      byTarget.get(targetKey).opus = m
    } else {
      byTarget.get(targetKey).sonnet = m
    }
  }
  return Array.from(byTarget.values()).filter(p => p.opus && p.sonnet)
}

/**
 * Apply spec §3.5 decision criteria to each pair. Returns aggregate adopt
 * decision (true only if ALL pairs pass ALL three criteria) plus per-pair
 * detail for the rendered report.
 */
function applyDecisionCriteria(pairs) {
  const evaluations = pairs.map(({ opus, sonnet }) => {
    const opusFindings = opus.metrics.findings_total
    const sonnetFindings = sonnet.metrics.findings_total
    const opusCritical = opus.metrics.findings_by_severity.critical
    const sonnetCritical = sonnet.metrics.findings_by_severity.critical
    const opusCost = opus.metrics.cost_usd
    const sonnetCost = sonnet.metrics.cost_usd

    // Criterion 1: findings ratio within 20% (proxy for F1 within 5%)
    const findingsRatio = opusFindings === 0 ? 1 : sonnetFindings / opusFindings
    const criterion1 = findingsRatio >= 0.80 && findingsRatio <= 1.20

    // Criterion 2: No new false-Critical findings
    const criterion2 = sonnetCritical <= opusCritical

    // Criterion 3: cost reduction >=60%
    const costSavings = opusCost <= 0 ? 0 : (opusCost - sonnetCost) / opusCost
    const criterion3 = costSavings >= 0.60

    return {
      target: opus.target,
      criterion1, criterion2, criterion3,
      findings_ratio: findingsRatio,
      cost_savings: costSavings,
      detail: `Opus: ${opusFindings} findings (${opusCritical} crit) $${opusCost.toFixed(2)} | Sonnet: ${sonnetFindings} findings (${sonnetCritical} crit) $${sonnetCost.toFixed(2)}`,
    }
  })

  const adopt = evaluations.length > 0 && evaluations.every(e => e.criterion1 && e.criterion2 && e.criterion3)

  return { adopt, evaluations }
}

/**
 * Render the full markdown comparison report from N metrics records.
 */
function renderReport(metrics) {
  const pairs = pairBySource(metrics)
  const decision = applyDecisionCriteria(pairs)

  let out = '# G4 Multi-Model Experiment Results\n\n'
  out += `**Run pairs:** ${pairs.length}\n`
  out += `**Captured at:** ${new Date().toISOString()}\n\n`

  if (pairs.length === 0) {
    out += '⚠️ No complete Opus + Sonnet pairs found in metrics. Need at least one of each per target.\n'
    return out
  }

  out += '## Per-target comparison\n\n'
  for (const { opus, sonnet } of pairs) {
    out += `### ${opus.target}\n\n`
    out += '| Metric | Opus | Sonnet |\n|---|---|---|\n'
    out += `| Findings (total) | ${opus.metrics.findings_total} | ${sonnet.metrics.findings_total} |\n`
    out += `| Critical | ${opus.metrics.findings_by_severity.critical} | ${sonnet.metrics.findings_by_severity.critical} |\n`
    out += `| High | ${opus.metrics.findings_by_severity.high} | ${sonnet.metrics.findings_by_severity.high} |\n`
    out += `| Medium | ${opus.metrics.findings_by_severity.medium} | ${sonnet.metrics.findings_by_severity.medium} |\n`
    out += `| Low | ${opus.metrics.findings_by_severity.low} | ${sonnet.metrics.findings_by_severity.low} |\n`
    out += `| Cost (USD) | $${opus.metrics.cost_usd.toFixed(2)} | $${sonnet.metrics.cost_usd.toFixed(2)} |\n`
    out += `| Duration (s) | ${opus.metrics.duration_seconds} | ${sonnet.metrics.duration_seconds} |\n\n`
  }

  out += `## Decision\n\n`
  out += `**ADOPT Sonnet:** ${decision.adopt ? '🟢 YES — ALL criteria met across ALL targets' : '🔴 NO — at least one criterion failed'}\n\n`
  out += '### Per-target evaluation\n\n'
  out += '| Target | C1 (Findings ratio 0.8-1.2) | C2 (Critical no-regress) | C3 (Cost saving ≥60%) |\n'
  out += '|---|---|---|---|\n'
  for (const e of decision.evaluations) {
    const c1 = e.criterion1 ? '✅' : '❌'
    const c2 = e.criterion2 ? '✅' : '❌'
    const c3 = e.criterion3 ? '✅' : '❌'
    out += `| ${e.target} | ${c1} (${e.findings_ratio.toFixed(2)}) | ${c2} | ${c3} (${(e.cost_savings * 100).toFixed(1)}%) |\n`
  }

  out += '\n### Per-target detail\n\n'
  for (const e of decision.evaluations) {
    out += `- **${e.target}:** ${e.detail}\n`
  }

  // Wilson 95% CI on per-criterion pass rate (Raptor-inspired calibrated metric).
  // With small N (3 pairs), Wilson's lower bound is intentionally conservative.
  // This is informational — actual ADOPT decision still uses the all-pairs-pass rule.
  if (decision.evaluations.length > 0) {
    const n = decision.evaluations.length
    const c1pass = decision.evaluations.filter(e => e.criterion1).length
    const c2pass = decision.evaluations.filter(e => e.criterion2).length
    const c3pass = decision.evaluations.filter(e => e.criterion3).length
    const w1 = wilsonInterval(c1pass, n)
    const w2 = wilsonInterval(c2pass, n)
    const w3 = wilsonInterval(c3pass, n)
    out += '\n### Wilson 95% CI on criterion pass rate (informational, n=' + n + ')\n\n'
    out += '| Criterion | Pass | Point | Wilson 95% CI |\n|---|---|---|---|\n'
    out += `| C1 (findings ratio) | ${c1pass}/${n} | ${(w1.point * 100).toFixed(1)}% | [${(w1.lower * 100).toFixed(1)}%, ${(w1.upper * 100).toFixed(1)}%] |\n`
    out += `| C2 (no Critical regress) | ${c2pass}/${n} | ${(w2.point * 100).toFixed(1)}% | [${(w2.lower * 100).toFixed(1)}%, ${(w2.upper * 100).toFixed(1)}%] |\n`
    out += `| C3 (cost saving ≥60%) | ${c3pass}/${n} | ${(w3.point * 100).toFixed(1)}% | [${(w3.lower * 100).toFixed(1)}%, ${(w3.upper * 100).toFixed(1)}%] |\n`
    out += '\nNote: with n=3 pairs, Wilson lower bounds are intentionally conservative. To prove '
    out += 'a true population pass rate ≥95% with statistical confidence, scale to n≥10 pairs in '
    out += 'a follow-up experiment.\n'
  }

  return out
}

function main() {
  if (!fs.existsSync(EXPERIMENT_DIR)) {
    console.error(`No experiment data at ${EXPERIMENT_DIR}`)
    process.exit(1)
  }
  const files = fs.readdirSync(EXPERIMENT_DIR).filter(f => f.endsWith('-metrics.json'))
  if (files.length === 0) {
    console.error(`No metrics files in ${EXPERIMENT_DIR}`)
    process.exit(1)
  }

  const metrics = files
    .map(f => {
      try { return JSON.parse(fs.readFileSync(path.join(EXPERIMENT_DIR, f), 'utf-8')) }
      catch (e) { console.error(`skip ${f}: ${e.message}`); return null }
    })
    .filter(Boolean)

  const report = renderReport(metrics)
  const reportFile = path.join(EXPERIMENT_DIR, 'g4-decision.md')
  fs.writeFileSync(reportFile, report)
  console.log(report)
  console.log(`\n📄 Report written: ${reportFile}`)
}

if (require.main === module) main()

module.exports = { renderReport, applyDecisionCriteria, pairBySource, wilsonInterval }
