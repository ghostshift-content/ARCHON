// test/severity-profile.test.js
'use strict'
const assert = require('node:assert')
const { test } = require('node:test')
const sp = require('../agents/severity-profile')

// Write suppression-ledger entries to a TEMP dir, never the production ledger.
// (Before this, every gate run wrote test fixtures into /root/intel/suppression-ledger.jsonl.)
const _TMP = require('node:fs').mkdtempSync(require('node:path').join(require('node:os').tmpdir(), 'sevprof-'))

const PENTEST_POLICY = {
  squad: 'pentest',
  cvssOf: f => Number(f.cvss || 0),
  severityKey: f => (f.severity || 'low').toLowerCase(),
}

test('bounty profile keeps CVSS >= 8.0', () => {
  const findings = [
    { id: 'F-1', cvss: 9.1, severity: 'critical', title: 'SQLi RCE' },
    { id: 'F-2', cvss: 5.5, severity: 'medium', title: 'Open redirect' },
  ]
  const r = sp.filterFindings(findings, 'bounty', PENTEST_POLICY, { outDir: _TMP })
  assert.strictEqual(r.reported.length, 1)
  assert.strictEqual(r.reported[0].id, 'F-1')
  assert.strictEqual(r.archived.length, 1)
  assert.strictEqual(r.archived[0].id, 'F-2')
})

test('bounty profile bypasses floor for zero-day indicator', () => {
  const findings = [
    { id: 'F-1', cvss: 4.0, severity: 'medium', title: 'Pre-auth RCE in webhook' },
  ]
  const r = sp.filterFindings(findings, 'bounty', PENTEST_POLICY, { outDir: _TMP })
  assert.strictEqual(r.reported.length, 1, 'zero-day indicator must bypass CVSS floor')
  assert.match(r.reported[0].profile_reason, /zero[- ]day/i)
})

test('pentest profile keeps CVSS >= 4.0', () => {
  const findings = [
    { id: 'F-1', cvss: 7.0 }, { id: 'F-2', cvss: 4.0 }, { id: 'F-3', cvss: 2.0 },
  ]
  const r = sp.filterFindings(findings, 'pentest', PENTEST_POLICY, { outDir: _TMP })
  assert.strictEqual(r.reported.length, 2)
  assert.strictEqual(r.archived.length, 1)
})

test('comprehensive profile keeps everything', () => {
  const findings = [
    { id: 'F-1', cvss: 9.0 }, { id: 'F-2', cvss: 5.0 }, { id: 'F-3', cvss: 1.0 },
  ]
  const r = sp.filterFindings(findings, 'comprehensive', PENTEST_POLICY, { outDir: _TMP })
  assert.strictEqual(r.reported.length, 3)
  assert.strictEqual(r.archived.length, 0)
})

test('DOWNGRADE-NOT-DROP: total count is preserved', () => {
  const findings = Array.from({ length: 10 }, (_, i) => ({ id: `F-${i}`, cvss: i }))
  const r = sp.filterFindings(findings, 'bounty', PENTEST_POLICY, { outDir: _TMP })
  assert.strictEqual(r.reported.length + r.archived.length, 10,
    'every finding must be either reported or archived — never discarded')
})

test('archived findings carry archive_reason for audit', () => {
  const findings = [{ id: 'F-1', cvss: 3.0, severity: 'low' }]
  const r = sp.filterFindings(findings, 'pentest', PENTEST_POLICY, { outDir: _TMP })
  assert.strictEqual(r.archived.length, 1)
  assert.match(r.archived[0].archive_reason, /below.*pentest.*floor.*4/i)
})

test('reported findings carry profile_reason', () => {
  const findings = [{ id: 'F-1', cvss: 9.0, severity: 'critical', title: 'RCE' }]
  const r = sp.filterFindings(findings, 'bounty', PENTEST_POLICY, { outDir: _TMP })
  assert.match(r.reported[0].profile_reason, /cvss.*9/i)
})

test('classifyFinding returns decision + reason for single finding', () => {
  const c = sp.classifyFinding({ id: 'F-1', cvss: 9.5 }, 'bounty', PENTEST_POLICY, { outDir: _TMP })
  assert.strictEqual(c.decision, 'report')
  assert.match(c.reason, /cvss/i)
})

test('zero-day indicator phrases work case-insensitively in title or details', () => {
  for (const text of [
    'Account Takeover via token leak',
    'STORED XSS IN ADMIN PANEL',
    'IDOR on sensitive customer PII',
    'privilege escalation via insecure deserialization',
  ]) {
    const c = sp.classifyFinding({ id: 'F-X', cvss: 3.0, title: text }, 'bounty', PENTEST_POLICY, { outDir: _TMP })
    assert.strictEqual(c.decision, 'report', `expected report for "${text}"`)
  }
})

test('summarize counts reported, archived, total', () => {
  const findings = [
    { id: 'F-1', cvss: 9.0 }, { id: 'F-2', cvss: 5.0 }, { id: 'F-3', cvss: 1.0 },
  ]
  const r = sp.filterFindings(findings, 'bounty', PENTEST_POLICY, { outDir: _TMP })
  const s = sp.summarize(r)
  assert.strictEqual(s.reported, 1)
  assert.strictEqual(s.archived, 2)
  assert.strictEqual(s.total, 3)
})

test('unknown profile name falls back to pentest with warning', () => {
  const findings = [{ id: 'F-1', cvss: 5.0 }]
  const r = sp.filterFindings(findings, 'gibberish', PENTEST_POLICY, { outDir: _TMP })
  assert.strictEqual(r.reported.length, 1, 'unknown profile defaults to pentest (CVSS>=4)')
  assert.ok(r.warnings && r.warnings.length > 0)
})

test('exports PROFILES and ZERO_DAY_INDICATORS for inspection', () => {
  assert.ok(sp.PROFILES.bounty)
  assert.ok(sp.PROFILES.pentest)
  assert.ok(sp.PROFILES.comprehensive)
  assert.ok(Array.isArray(sp.ZERO_DAY_INDICATORS))
})

test('resolveProfile: explicit severity_profile wins over program_type', () => {
  const sp = require('../agents/severity-profile')
  assert.strictEqual(
    sp.resolveProfile({ severity_profile: 'bounty', program_type: 'kudos' }),
    'bounty'
  )
})

test('resolveProfile: program_type=kudos → pentest', () => {
  const sp = require('../agents/severity-profile')
  assert.strictEqual(sp.resolveProfile({ program_type: 'kudos' }), 'pentest')
})

test('resolveProfile: program_type=paid_bounty → bounty', () => {
  const sp = require('../agents/severity-profile')
  assert.strictEqual(sp.resolveProfile({ program_type: 'paid_bounty' }), 'bounty')
})

test('resolveProfile: program_type=internal_audit → comprehensive', () => {
  const sp = require('../agents/severity-profile')
  assert.strictEqual(sp.resolveProfile({ program_type: 'internal_audit' }), 'comprehensive')
})

test('resolveProfile: nothing set → pentest default', () => {
  const sp = require('../agents/severity-profile')
  assert.strictEqual(sp.resolveProfile({}), 'pentest')
  assert.strictEqual(sp.resolveProfile(null), 'pentest')
  assert.strictEqual(sp.resolveProfile(undefined), 'pentest')
})

test('resolveProfile: unknown program_type → pentest default', () => {
  const sp = require('../agents/severity-profile')
  assert.strictEqual(sp.resolveProfile({ program_type: 'unknown_kind' }), 'pentest')
})

test('classifyFinding + filterFindings behave consistently for unknown profile', () => {
  const sp = require('../agents/severity-profile')
  const policy = { cvssOf: () => 5.0 }
  const r1 = sp.classifyFinding({ severity: 'Medium', title: 'X', details: '' }, 'mystery_profile', policy)
  const r2 = sp.filterFindings([{ severity: 'Medium', title: 'X', details: '' }], 'mystery_profile', policy, { outDir: _TMP })
  // Both must default to pentest internally → CVSS 5 ≥ 4 → 'report'
  assert.strictEqual(r1.decision, 'report')
  assert.strictEqual(r2.reported.length, 1)
  // filterFindings must surface the warning
  assert.ok(r2.warnings.length > 0, 'filterFindings should warn on unknown profile')
  assert.match(r2.warnings[0], /unknown profile/)
})
