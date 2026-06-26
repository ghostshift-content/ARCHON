#!/usr/bin/env node
// Unit tests for the CVSS 3.1 calculator (ui/cvss.js).
// Scores cross-checked against the official FIRST CVSS 3.1 calculator.
const assert = require('assert')
const { cvss31, sevFromScore, parseVector, cvssRoundup } = require('../ui/cvss')

let passed = 0, failed = 0
const ok = (label, cond, extra = '') => cond ? (console.log(`  ✓ ${label}`), passed++) : (console.log(`  ✗ ${label}${extra ? ' — ' + extra : ''}`), failed++)
const score = v => cvss31(parseVector(v)).score

console.log('CVSS 3.1 calculator:')

// Known vectors → official base scores
const vectors = [
  ['CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H', 9.8],  // critical, full impact
  ['CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:L/I:N/A:N', 5.3],  // info disclosure (RUDRA finding)
  ['CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:C/C:H/I:H/A:H', 10.0], // scope changed → 10.0
  ['CVSS:3.1/AV:L/AC:H/PR:H/UI:R/S:U/C:L/I:L/A:N', 2.9],  // low (local, high-complexity)
  ['CVSS:3.1/AV:N/AC:L/PR:L/UI:N/S:U/C:H/I:H/A:H', 8.8],  // authn RCE
  ['CVSS:3.1/AV:N/AC:L/PR:N/UI:R/S:C/C:L/I:L/A:N', 6.1],  // reflected XSS canonical
  ['CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:N/I:N/A:N', 0.0],  // no impact → 0
]
for (const [v, expected] of vectors) {
  const got = score(v)
  ok(`${v} → ${expected}`, got === expected, `got ${got}`)
}

// Vector round-trips through parseVector+cvss31
ok('vector string is preserved', cvss31(parseVector('CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H')).vector === 'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H')

// severity bands
ok('9.8 → Critical', sevFromScore(9.8) === 'Critical')
ok('7.0 → High', sevFromScore(7.0) === 'High')
ok('6.9 → Medium', sevFromScore(6.9) === 'Medium')
ok('4.0 → Medium', sevFromScore(4.0) === 'Medium')
ok('3.9 → Low', sevFromScore(3.9) === 'Low')
ok('0.1 → Low', sevFromScore(0.1) === 'Low')
ok('0 → Info', sevFromScore(0) === 'Info')

// roundup per CVSS spec (round UP to 1 decimal)
ok('roundup 4.02 → 4.1', cvssRoundup(4.02) === 4.1)
ok('roundup 4.00 → 4.0', cvssRoundup(4.0) === 4.0)

// parseVector defaults for missing/garbage input
ok('parseVector("") → all defaults', JSON.stringify(parseVector('')) === JSON.stringify({ AV: 'N', AC: 'L', PR: 'N', UI: 'N', S: 'U', C: 'N', I: 'N', A: 'N' }))
ok('parseVector partial keeps known', parseVector('CVSS:3.1/AV:L/C:H').AV === 'L' && parseVector('CVSS:3.1/AV:L/C:H').C === 'H')

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)
