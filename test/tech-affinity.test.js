// test/tech-affinity.test.js
//
// Tech-affinity downgrade: when the detected tech stack doesn't include
// the agent's primary affinity, demote the agent to a cheaper family.
// Respects the "NEVER restricts specialist roster" invariant — we only
// change WHICH MODEL the specialist uses, not whether they run.

const assert = require('node:assert')
const { test } = require('node:test')
const ta = require('../agents/tech-affinity')

test('universal specialists (XSS, SQLi, SSRF) never demoted', () => {
  for (const agent of ['abhimanyu', 'arjun', 'ashwattama', 'ashwatthama']) {
    const r = ta.computeAffinityDowngrade(agent, ['Node.js'])
    assert.strictEqual(r.demote, false,
      `universal agent ${agent} should never demote, got ${JSON.stringify(r)}`)
  }
})

test('PHP-specific specialist demoted when PHP not detected', () => {
  const r = ta.computeAffinityDowngrade('karna', ['Node.js'])
  assert.strictEqual(r.demote, true)
  assert.strictEqual(r.target_family, 'fast')
  assert.match(r.reason, /php/i)
})

test('PHP-specific specialist NOT demoted when PHP detected', () => {
  const r = ta.computeAffinityDowngrade('karna', ['PHP', 'Node.js'])
  assert.strictEqual(r.demote, false)
})

test('Java-specific specialist demoted when Java not detected', () => {
  const r = ta.computeAffinityDowngrade('bheem', ['Python', 'Node.js'])
  assert.strictEqual(r.demote, true)
  assert.strictEqual(r.target_family, 'fast')
})

test('Java-specific specialist NOT demoted when Java detected', () => {
  const r = ta.computeAffinityDowngrade('bheem', ['Java', 'Node.js'])
  assert.strictEqual(r.demote, false)
})

test('unknown agent never demoted (fail-safe)', () => {
  const r = ta.computeAffinityDowngrade('unknown_agent_xyz', [])
  assert.strictEqual(r.demote, false)
})

test('empty detected stacks demote nothing (fail-safe — fingerprint may be wrong)', () => {
  for (const agent of ['karna', 'bheem']) {
    const r = ta.computeAffinityDowngrade(agent, [])
    assert.strictEqual(r.demote, false,
      `empty stack should not demote ${agent} — fingerprint may be incomplete`)
  }
})

test('protected agents are never demoted', () => {
  // dharma, dharmaraj, kripa, vyasa must always run on Sonnet/Opus
  for (const protectedAgent of ['dharma', 'dharmaraj', 'kripa', 'vyasa']) {
    const r = ta.computeAffinityDowngrade(protectedAgent, [])
    assert.strictEqual(r.demote, false, `${protectedAgent} must never demote`)
  }
})

test('exports AFFINITY_MAP for introspection', () => {
  assert.ok(typeof ta.AFFINITY_MAP === 'object')
  assert.ok('karna' in ta.AFFINITY_MAP)
  assert.ok(Array.isArray(ta.AFFINITY_MAP.karna.requires_any))
})
