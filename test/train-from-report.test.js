#!/usr/bin/env node

const __roots = require('../paths') // portable roots (KURU_*_ROOT) — see paths.js
// Unit tests for train-from-report. Exercises extraction + category inference +
// append path offline (no network, no real curl fetch).
// Run: node /root/agents/test/train-from-report.test.js

const fs = require('fs')
const path = require('path')
const t = require('../src/learning/train-from-report')

let passed = 0, failed = 0
function ok(label, cond, extra = '') {
  if (cond) { console.log(`  ✓ ${label}`); passed++ }
  else      { console.log(`  ✗ ${label}${extra ? ' — ' + extra : ''}`); failed++ }
}

console.log('train-from-report tests:')

// 1. parseArgs
const a1 = t.parseArgs(['node', 'train', 'report.md', '--squad', 'stocks-squad', '--dry-run'])
ok('parseArgs sets src', a1.src === 'report.md')
ok('parseArgs squad flag', a1.squad === 'stocks-squad')
ok('parseArgs dryRun flag', a1.dryRun === true)

const a2 = t.parseArgs(['node', 'train', 'r.md', '--yes-to-all'])
ok('parseArgs yes-to-all flag', a2.yesToAll === true)
ok('parseArgs default squad is pentest', a2.squad === 'pentest-squad')

// 2. extractCandidates — markdown with multiple sections
const md = `# My Report

## Vulnerability 1 — SQL injection in /api/login
The endpoint /api/login accepts username+password, but does not parameterize the SQL query.
An attacker can inject ' OR '1'='1 to bypass authentication. This was confirmed via
curl request returning a 200 response with a valid session cookie.

## Vulnerability 2 — Stored XSS in profile.bio
The profile.bio field is rendered via innerHTML without sanitization. Payload <img src=x onerror=alert(1)>
executes on every user viewing the profile. dompurify is imported but not applied here.

## Summary
Too brief.
`
const candidates = t.extractCandidates(md)
ok('extracts 2 candidates (sub-threshold summary filtered)', candidates.length === 2,
   `got ${candidates.length}`)
ok('candidate 1 title matches SQLi header',
   candidates[0].title.toLowerCase().includes('sql injection'))
ok('candidate 1 category inferred as sqli',
   candidates[0].category === 'sqli', `got ${candidates[0].category}`)
ok('candidate 2 category inferred as xss',
   candidates[1].category === 'xss', `got ${candidates[1].category}`)

// 3. inferCategory — various texts
ok('inferCategory: IDOR text → access_control',
   t.inferCategory('IDOR in /api/users/123 via sequential ID enumeration') === 'access_control')
ok('inferCategory: Kerberoast text → network',
   t.inferCategory('Kerberoastable SPN found via impacket GetUserSPNs') === 'network')
ok('inferCategory: S3 bucket → cloud',
   t.inferCategory('Public S3 bucket with sensitive data accessible to anyone') === 'cloud')
ok('inferCategory: ambiguous text → general',
   t.inferCategory('The server responded with a 200 OK') === 'general')

// 4. appendToLessons — writes to a test file
const testSquad = 'pentest-squad'
const lessonsFile = `${__roots.INTEL_ROOT}/squad-lessons-${testSquad}.md`
const before = fs.existsSync(lessonsFile) ? fs.readFileSync(lessonsFile, 'utf-8') : ''
const approved = [
  { title: 'Test technique 1', body: 'test body content for technique 1', category: 'sqli', decision: 'y' },
]
const written = t.appendToLessons(testSquad, approved, 'test-source.md')
const after = fs.readFileSync(lessonsFile, 'utf-8')
ok('appendToLessons returns the target file path', written === lessonsFile)
ok('appendToLessons actually appends (file grew)', after.length > before.length)
ok('appendToLessons includes source in header', after.includes('Trained from test-source.md'))
ok('appendToLessons includes category tag', after.includes('**[sqli]**'))
ok('appendToLessons includes technique title', after.includes('Test technique 1'))

// Restore file to pre-test state (don't leave synthetic data in real lessons)
fs.writeFileSync(lessonsFile, before)

// 5. fetchSource rejects missing file
let missingFileCaught = false
try { t.fetchSource('/tmp/definitely-does-not-exist-' + Date.now() + '.md') } catch { missingFileCaught = true }
ok('fetchSource throws on missing file', missingFileCaught)

// 6. fetchSource accepts an existing file
const tmpFile = `/tmp/train-test-${process.pid}.md`
fs.writeFileSync(tmpFile, '## Test\n\nbody')
const fetched = t.fetchSource(tmpFile)
ok('fetchSource returns content + source for local file',
   fetched.content.includes('Test') && fetched.source === path.resolve(tmpFile))
try { fs.unlinkSync(tmpFile) } catch {}

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed > 0 ? 1 : 0)
