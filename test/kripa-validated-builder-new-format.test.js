'use strict'
const assert = require('node:assert')
const { test } = require('node:test')
const { parseVerdictLine, VERDICT_RE } = require('../agents/kripa-validated-builder')

test('new format: KILLED — free-text title (agent-IDs)', () => {
  const r = parseVerdictLine('KILLED — crossDomainLogout CSRF (EKLAVYA-025/SATYAKI-032)')
  assert.ok(r, 'parser should match new format')
  assert.strictEqual(r.verdict, 'KILLED')
  assert.match(r.title, /crossDomainLogout CSRF/)
  assert.ok(r.findingId.includes('EKLAVYA') || r.findingId.startsWith('KRIPA-'),
    `findingId should derive from agent-ID or hash, got: ${r.findingId}`)
})

test('new format: CONFIRMED — free-text title (single agent)', () => {
  const r = parseVerdictLine('CONFIRMED — SSRF via pgtUrl IPv6 (KRITAVARMA-001)')
  assert.ok(r, 'parser should match CONFIRMED with agent-IDs')
  assert.strictEqual(r.verdict, 'CONFIRMED')
})

test('legacy format: CONFIRMED — F-001: title', () => {
  const r = parseVerdictLine('CONFIRMED — F-001: No Account Lockout on VPN')
  assert.ok(r, 'parser should still match legacy format')
  assert.strictEqual(r.verdict, 'CONFIRMED')
  assert.strictEqual(r.findingId, 'F-001')
})

test('legacy format: KILLED — F-003: title (multi-agent parens)', () => {
  const r = parseVerdictLine('KILLED — F-003: Logout CSRF Bypass (Multiple Agents: NAKUL, SHIKHANDI)')
  assert.ok(r)
  assert.strictEqual(r.findingId, 'F-003')
})

test('non-verdict line returns null', () => {
  assert.strictEqual(parseVerdictLine('Some random log line'), null)
  assert.strictEqual(parseVerdictLine(''), null)
  assert.strictEqual(parseVerdictLine('CONFIRMED Finding: missing em-dash'), null)
})

test('finding ID is deterministic (same input → same ID)', () => {
  const r1 = parseVerdictLine('KILLED — Server version disclosure alone (ABHIMANYU-015)')
  const r2 = parseVerdictLine('KILLED — Server version disclosure alone (ABHIMANYU-015)')
  assert.strictEqual(r1.findingId, r2.findingId, 'same input must yield same findingId')
})

test('finding ID without parens (no agent-ID): hash-based fallback', () => {
  const r = parseVerdictLine('KILLED — Generic finding with no agent tag')
  assert.ok(r)
  assert.match(r.findingId, /^KRIPA-FN-/, 'should fall back to KRIPA-FN-{hash} format')
})

test('em-dash (U+2014) is required, not double-hyphen', () => {
  assert.strictEqual(parseVerdictLine('CONFIRMED -- F-001: title'), null,
    'double-hyphen must NOT match (KRIPA writes U+2014)')
})
