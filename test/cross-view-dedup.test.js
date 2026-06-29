// test/cross-view-dedup.test.js
//
// Deterministic cross-view de-dup for combined white-box + black-box reports:
// exact duplicates within a view collapse to one; a vuln-class present in BOTH
// views becomes a merge candidate; unrelated findings stay separate.

const assert = require('node:assert')
const { test } = require('node:test')
const { correlate, deriveVulnClass, findingLocus, findingParam } = require('../src/pipeline/cross-view-dedup')

test('deriveVulnClass maps titles to canonical classes', () => {
  assert.strictEqual(deriveVulnClass('Reflected XSS in search box'), 'xss')
  assert.strictEqual(deriveVulnClass('SQL injection on /api/users'), 'sqli')
  assert.strictEqual(deriveVulnClass('IDOR lets users read others invoices'), 'idor')
  assert.strictEqual(deriveVulnClass('Server-Side Request Forgery via webhook'), 'ssrf')
  assert.strictEqual(deriveVulnClass('Something totally novel'), 'other')
})

test('findingLocus prefers file basename, falls back to URL path', () => {
  assert.strictEqual(findingLocus({ file: 'app/models/User.rb', url: '' }), 'user.rb')
  assert.strictEqual(findingLocus({ url: 'https://x.test/api/users?id=1' }), '/api/users')
})

test('findingParam pulls the first query key', () => {
  assert.strictEqual(findingParam({ url: 'https://x.test/s?q=1&p=2' }), 'q')
})

test('exact duplicates within the same view collapse to one (keep + dropped)', () => {
  const findings = [
    { id: 'A', kind: 'blackbox', cls: 'xss', locus: '/search', param: 'q' },
    { id: 'B', kind: 'blackbox', cls: 'xss', locus: '/search', param: 'q' },
    { id: 'C', kind: 'blackbox', cls: 'sqli', locus: '/users', param: 'id' },
  ]
  const { exact_duplicate_groups } = correlate(findings)
  assert.strictEqual(exact_duplicate_groups.length, 1)
  assert.strictEqual(exact_duplicate_groups[0].keep, 'A')
  assert.deepStrictEqual(exact_duplicate_groups[0].dropped, ['B'])
})

test('a vuln-class in BOTH views becomes a cross-view merge candidate', () => {
  const findings = [
    { id: 'W1', kind: 'whitebox', cls: 'sqli', locus: 'user.rb', param: '', title: 'SQLi in User model' },
    { id: 'B1', kind: 'blackbox', cls: 'sqli', locus: '/api/users', param: 'id', title: 'SQLi on /api/users' },
    { id: 'W2', kind: 'whitebox', cls: 'xss', locus: 'view.erb', param: '', title: 'XSS in template' }, // whitebox only
  ]
  const { cross_view_candidates } = correlate(findings)
  assert.strictEqual(cross_view_candidates.length, 1, 'only sqli is in both views')
  assert.strictEqual(cross_view_candidates[0].vuln_class, 'sqli')
  assert.strictEqual(cross_view_candidates[0].whitebox[0].id, 'W1')
  assert.strictEqual(cross_view_candidates[0].blackbox[0].id, 'B1')
})

test('no false correlation when a class is only in one view', () => {
  const findings = [
    { id: 'W1', kind: 'whitebox', cls: 'xss', locus: 'a.erb', param: '' },
    { id: 'W2', kind: 'whitebox', cls: 'sqli', locus: 'b.rb', param: '' },
  ]
  const { cross_view_candidates } = correlate(findings)
  assert.strictEqual(cross_view_candidates.length, 0)
})
