// test/g4-report.test.js
//
// Unit tests for scripts/g4-report.js — comparison renderer + decision criteria.
// Part of G4 Phase 1 build (Task 4/6).

const assert = require('node:assert')
const { test } = require('node:test')
const { renderReport, applyDecisionCriteria, pairBySource, wilsonInterval } = require('../scripts/g4-report')

function makeMetric(taskId, opts = {}) {
  return {
    task_id: taskId,
    target: opts.target || `Target-${taskId.split('-')[0]}`,
    model_profile: opts.profile || 'default',
    krishna_model: opts.krishna || 'claude-opus-4-7',
    captured_at: new Date().toISOString(),
    metrics: {
      findings_total: opts.findings ?? 12,
      findings_by_severity: {
        critical: opts.critical ?? 1,
        high: opts.high ?? 3,
        medium: opts.medium ?? 5,
        low: opts.low ?? 3,
        info: 0,
      },
      cost_usd: opts.cost ?? 142.30,
      duration_seconds: opts.duration ?? 3000,
    },
  }
}

test('renderReport produces side-by-side comparison string', () => {
  const opus = makeMetric('T1-opus', { target: 'Target-1' })
  const sonnet = makeMetric('T1-sonnet', {
    target: 'Target-1',
    profile: 'G4_test_sonnet',
    krishna: 'claude-sonnet-4-6',
    cost: 28.50,
    findings: 11,
  })
  const out = renderReport([opus, sonnet])
  assert.match(out, /Target-1/)
  assert.match(out, /Opus/)
  assert.match(out, /Sonnet/)
  assert.match(out, /142\.30/)
  assert.match(out, /28\.50/)
})

test('applyDecisionCriteria: ALL THREE pass → ADOPT', () => {
  const opus = makeMetric('T1-opus', { target: 'T1', cost: 142.30, findings: 12, critical: 1 })
  const sonnet = makeMetric('T1-sonnet', {
    target: 'T1', profile: 'G4_test_sonnet', krishna: 'claude-sonnet-4-6',
    cost: 28.50, findings: 11, critical: 1,
  })
  const decision = applyDecisionCriteria([{ opus, sonnet }])
  assert.strictEqual(decision.adopt, true, `should adopt; got: ${JSON.stringify(decision)}`)
})

test('applyDecisionCriteria: cost reduction <60% → REJECT', () => {
  const opus = makeMetric('T-opus', { target: 'T', cost: 142.30 })
  const sonnet = makeMetric('T-sonnet', {
    target: 'T', profile: 'G4_test_sonnet', krishna: 'claude-sonnet-4-6',
    cost: 100.00, // only 30% cheaper
  })
  const decision = applyDecisionCriteria([{ opus, sonnet }])
  assert.strictEqual(decision.adopt, false, `should reject (cost not 60%+ cheaper)`)
  assert.strictEqual(decision.evaluations[0].criterion3, false)
})

test('applyDecisionCriteria: new false-Critical → REJECT', () => {
  const opus = makeMetric('T-opus', { target: 'T', cost: 142.30, critical: 1 })
  const sonnet = makeMetric('T-sonnet', {
    target: 'T', profile: 'G4_test_sonnet', krishna: 'claude-sonnet-4-6',
    cost: 28.50, critical: 3, // more Criticals!
  })
  const decision = applyDecisionCriteria([{ opus, sonnet }])
  assert.strictEqual(decision.adopt, false, `should reject (Sonnet introduced 2 more Criticals)`)
  assert.strictEqual(decision.evaluations[0].criterion2, false)
})

test('applyDecisionCriteria: findings ratio >1.2 → REJECT', () => {
  const opus = makeMetric('T-opus', { target: 'T', cost: 142.30, findings: 10 })
  const sonnet = makeMetric('T-sonnet', {
    target: 'T', profile: 'G4_test_sonnet', krishna: 'claude-sonnet-4-6',
    cost: 28.50, findings: 25, // 2.5x more findings — too noisy!
  })
  const decision = applyDecisionCriteria([{ opus, sonnet }])
  assert.strictEqual(decision.adopt, false, `should reject (Sonnet too noisy)`)
  assert.strictEqual(decision.evaluations[0].criterion1, false)
})

test('applyDecisionCriteria: 3 targets, all pass → ADOPT', () => {
  const pairs = [1, 2, 3].map(i => ({
    opus: makeMetric(`T${i}-opus`, { target: `T${i}`, cost: 140, findings: 10, critical: 1 }),
    sonnet: makeMetric(`T${i}-sonnet`, {
      target: `T${i}`, profile: 'G4_test_sonnet', krishna: 'claude-sonnet-4-6',
      cost: 30, findings: 10, critical: 1,
    }),
  }))
  const decision = applyDecisionCriteria(pairs)
  assert.strictEqual(decision.adopt, true)
  assert.strictEqual(decision.evaluations.length, 3)
})

test('applyDecisionCriteria: 3 targets, 1 fails → REJECT', () => {
  const pairs = [1, 2, 3].map(i => ({
    opus: makeMetric(`T${i}-opus`, { target: `T${i}`, cost: 140, findings: 10, critical: 1 }),
    sonnet: makeMetric(`T${i}-sonnet`, {
      target: `T${i}`, profile: 'G4_test_sonnet', krishna: 'claude-sonnet-4-6',
      cost: i === 2 ? 80 : 30, // T2's cost reduction <60% — fails
      findings: 10, critical: 1,
    }),
  }))
  const decision = applyDecisionCriteria(pairs)
  assert.strictEqual(decision.adopt, false, 'one failure should reject the whole experiment')
})

test('pairBySource pairs Opus and Sonnet by target name', () => {
  const opus1 = makeMetric('T1-opus', { target: 'TargetA' })
  const sonnet1 = makeMetric('T1-sonnet', {
    target: 'TargetA', profile: 'G4_test_sonnet', krishna: 'claude-sonnet-4-6',
  })
  const opus2 = makeMetric('T2-opus', { target: 'TargetB' })
  const pairs = pairBySource([opus1, sonnet1, opus2])
  assert.strictEqual(pairs.length, 1, 'only complete pairs returned')
  assert.strictEqual(pairs[0].opus.target, 'TargetA')
  assert.strictEqual(pairs[0].sonnet.target, 'TargetA')
})

test('renderReport handles empty metrics gracefully', () => {
  const out = renderReport([])
  assert.match(out, /No complete Opus \+ Sonnet pairs/)
})

test('applyDecisionCriteria with empty pairs → adopt=false', () => {
  const decision = applyDecisionCriteria([])
  assert.strictEqual(decision.adopt, false, 'no data → not adopt')
})

// ── Wilson 95% confidence interval (Raptor-inspired) ──

test('wilsonInterval: n=0 returns zeros', () => {
  const w = wilsonInterval(0, 0)
  assert.strictEqual(w.point, 0)
  assert.strictEqual(w.lower, 0)
  assert.strictEqual(w.upper, 0)
})

test('wilsonInterval: 0/3 → point 0, lower 0, upper > 0', () => {
  const w = wilsonInterval(0, 3)
  assert.strictEqual(w.point, 0)
  assert.strictEqual(w.lower, 0, 'lower bound floors at 0')
  assert.ok(w.upper > 0 && w.upper < 1, 'upper bound between 0 and 1')
})

test('wilsonInterval: 3/3 → point 1, lower < 1, upper 1', () => {
  const w = wilsonInterval(3, 3)
  assert.strictEqual(w.point, 1)
  assert.strictEqual(w.upper, 1, 'upper bound caps at 1')
  // With n=3, all-pass, lower bound is intentionally conservative
  assert.ok(w.lower < 0.6, 'small-N Wilson lower is conservative even on perfect pass')
  assert.ok(w.lower > 0.3, 'but not catastrophically low')
})

test('wilsonInterval: 50/100 → point 0.5, CI roughly symmetric', () => {
  const w = wilsonInterval(50, 100)
  assert.strictEqual(w.point, 0.5)
  // For p=0.5, n=100, Wilson 95% CI is roughly [0.40, 0.60]
  assert.ok(w.lower > 0.35 && w.lower < 0.45)
  assert.ok(w.upper > 0.55 && w.upper < 0.65)
})

test('renderReport includes Wilson CI section when pairs exist', () => {
  const opus = {
    task_id: 'T1-opus', target: 'T1', model_profile: 'default',
    krishna_model: 'claude-opus-4-7', captured_at: '2026-05-06T00:00:00Z',
    metrics: {
      findings_total: 12,
      findings_by_severity: { critical: 1, high: 3, medium: 5, low: 3, info: 0 },
      cost_usd: 142.30, duration_seconds: 3000,
    },
  }
  const sonnet = {
    task_id: 'T1-sonnet', target: 'T1', model_profile: 'G4_test_sonnet',
    krishna_model: 'claude-sonnet-4-6', captured_at: '2026-05-06T00:00:00Z',
    metrics: {
      findings_total: 11,
      findings_by_severity: { critical: 1, high: 3, medium: 4, low: 3, info: 0 },
      cost_usd: 28.50, duration_seconds: 3000,
    },
  }
  const out = renderReport([opus, sonnet])
  assert.match(out, /Wilson 95% CI/)
  assert.match(out, /n=1/)
})
