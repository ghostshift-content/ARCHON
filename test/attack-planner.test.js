// test/attack-planner.test.js
//
// Stage 1 Strategist: normalize ATLAS's attack plan — parse JSON (even wrapped),
// drop noise, clamp priority, rank desc, cap, and bucket by vuln class.

const assert = require('node:assert')
const { test } = require('node:test')
const { normalizePlan, planForClasses, buildAttackPlanPrompt, planSummary } = require('../src/pipeline/attack-planner')

test('parses + ranks by priority desc', () => {
  const plan = normalizePlan(JSON.stringify([
    { endpoint: '/a', vuln_class: 'xss', hypothesis: 'reflected in q', priority: 2 },
    { endpoint: '/b', vuln_class: 'sqli', hypothesis: 'id param', priority: 5 },
    { endpoint: '/c', vuln_class: 'idor', hypothesis: 'obj id', priority: 4 },
  ]))
  assert.deepStrictEqual(plan.map(h => h.priority), [5, 4, 2])
  assert.strictEqual(plan[0].vuln_class, 'sqli')
  assert.strictEqual(plan[0].id, 'H-1')
})

test('drops entries with no hypothesis; coerces unknown class to other', () => {
  const plan = normalizePlan([
    { vuln_class: 'xss', hypothesis: '' },          // dropped (no hypothesis)
    { vuln_class: 'nonsense', hypothesis: 'try it' }, // class → other
  ])
  assert.strictEqual(plan.length, 1)
  assert.strictEqual(plan[0].vuln_class, 'other')
})

test('clamps priority into 1-5 (default 3 when missing/NaN)', () => {
  const plan = normalizePlan([
    { vuln_class: 'rce', hypothesis: 'a', priority: 99 },
    { vuln_class: 'rce', hypothesis: 'b', priority: -4 },
    { vuln_class: 'rce', hypothesis: 'c' },
  ])
  const byHyp = Object.fromEntries(plan.map(h => [h.hypothesis, h.priority]))
  assert.strictEqual(byHyp.a, 5)
  assert.strictEqual(byHyp.b, 1)
  assert.strictEqual(byHyp.c, 3)
})

test('fails soft on garbage → empty plan', () => {
  for (const bad of [null, '', 'no array', '{not an array}', 42]) {
    assert.deepStrictEqual(normalizePlan(bad), [])
  }
})

test('planForClasses buckets by class (string or array)', () => {
  const plan = normalizePlan([
    { vuln_class: 'idor', hypothesis: 'a' },
    { vuln_class: 'access-control', hypothesis: 'b' },
    { vuln_class: 'xss', hypothesis: 'c' },
  ])
  assert.strictEqual(planForClasses(plan, 'xss').length, 1)
  assert.strictEqual(planForClasses(plan, ['idor', 'access-control']).length, 2)
  assert.strictEqual(planForClasses(plan, 'sqli').length, 0)
})

test('caps at 30 entries', () => {
  const big = Array.from({ length: 50 }, (_, i) => ({ vuln_class: 'xss', hypothesis: 'h' + i, priority: 3 }))
  assert.ok(normalizePlan(big).length <= 30)
})

test('prompt references the product + WAF for stack-specific guidance', () => {
  const p = buildAttackPlanPrompt({ targetUrl: 'https://x.test', fingerprint: { product: 'Adobe AEM', waf: { present: true, vendor: 'Akamai' } } })
  assert.match(p, /Adobe AEM/)
  assert.match(p, /Akamai/)
  assert.match(p, /JSON array/)
})

test('planSummary is empty for empty plan', () => {
  assert.strictEqual(planSummary([]), '')
  assert.match(planSummary(normalizePlan([{ vuln_class: 'sqli', hypothesis: 'x', priority: 5 }])), /1 hypotheses/)
})
