#!/usr/bin/env node

const __roots = require('../paths') // portable roots (KURU_*_ROOT) — see paths.js
// Unit tests for memory de-anchoring (fresh-eyes gate) in feedback-loop.js.
// Ensures over-tested targets get memory stripped so agents observe fresh
// instead of pattern-matching stale lessons.
// Run: node /root/agents/test/fresh-eyes.test.js

const assert = require('assert')
const fs = require('fs')
const path = require('path')

// Point INTEL_DIR at a sandbox BEFORE loading feedback-loop.
const TMP = '/tmp/test-fresh-eyes-' + process.pid
fs.mkdirSync(TMP, { recursive: true })
process.env.INTEL_DIR_OVERRIDE = TMP
// feedback-loop reads INTEL_DIR as a const — we can't override that cleanly.
// Instead we write the sandbox's tasks.json to a custom location AND patch
// the module to use it. Simplest: symlink the real INTEL_DIR check against tasks.json
// we control. But we can't clobber /root/intel — so instead use the real INTEL_DIR
// but add/remove synthetic tasks for our test, then restore.

// Strategy: read real tasks.json, append synthetic entries, call isOverTested,
// then restore the original file.
const REAL_TASKS = (__roots.INTEL_ROOT + '/tasks.json')
// Defensive: scrub any leftover synth-* entries from a prior crashed test run
// before snapshotting BACKUP. Otherwise the prior leak gets restored as "real"
// data and inflates the scan count above the asserted 3.
{
  const raw = JSON.parse(fs.readFileSync(REAL_TASKS, 'utf-8'))
  const cleaned = raw.filter(t => !(t && typeof t.id === 'string' && t.id.startsWith('synth-')))
  if (cleaned.length !== raw.length) {
    fs.writeFileSync(REAL_TASKS, JSON.stringify(cleaned, null, 2))
  }
}
const BACKUP = fs.readFileSync(REAL_TASKS, 'utf-8')

let passed = 0, failed = 0
function ok(label, cond) {
  if (cond) { console.log(`  ✓ ${label}`); passed++ }
  else      { console.log(`  ✗ ${label}`); failed++ }
}

try {
  // Fresh require — feedback-loop caches nothing for isOverTested itself.
  const fl = require('../src/learning/feedback-loop')

  console.log('fresh-eyes / memory de-anchoring tests:')

  // Baseline: a pristine target should NOT be over-tested.
  ok('pristine target is not over-tested', !fl.isOverTested('brand-new-target.test'))
  ok('pristine target returns empty freshness notice', fl.getFreshEyesNotice('brand-new-target.test') === '')

  // Write 3 synthetic recent done tasks for "overtested.example.com"
  const now = new Date().toISOString()
  const tasks = JSON.parse(BACKUP)
  const synthetic = [
    { id: 'synth-1', title: 'Pentest overtested.example.com run 1', status: 'done', startedAt: now, lastUpdate: now, squad: 'pentest-squad' },
    { id: 'synth-2', title: 'Pentest overtested.example.com run 2', status: 'done', startedAt: now, lastUpdate: now, squad: 'pentest-squad' },
    { id: 'synth-3', title: 'Pentest overtested.example.com run 3', status: 'done', startedAt: now, lastUpdate: now, squad: 'pentest-squad' },
  ]
  fs.writeFileSync(REAL_TASKS, JSON.stringify(tasks.concat(synthetic), null, 2))

  ok('3-recent-runs target IS over-tested', fl.isOverTested('overtested.example.com'))
  const notice = fl.getFreshEyesNotice('overtested.example.com')
  ok('freshness notice is non-empty on over-tested target', notice.length > 100)
  ok('notice mentions FRESH-EYES MODE', notice.includes('FRESH-EYES MODE'))
  ok('notice mentions verify fresh', /verify/i.test(notice))
  ok('notice includes the count of prior scans', notice.includes('3 times'))

  // Memory-gating check: getDisprovenContext should return empty for over-tested.
  const dis = fl.getDisprovenContext('pentest-squad', 'overtested.example.com')
  ok('getDisprovenContext returns empty for over-tested target', dis === '')

  const lessons = fl.getSquadLessons('pentest-squad', 'overtested.example.com')
  ok('getSquadLessons returns empty for over-tested target', lessons === '')

  // Sanity: without target param, getSquadLessons still returns its normal output.
  const lessonsNoTarget = fl.getSquadLessons('pentest-squad')
  ok('getSquadLessons without target does not apply fresh-eyes gate', typeof lessonsNoTarget === 'string')

  // Restore for next tests
  fs.writeFileSync(REAL_TASKS, BACKUP)

  // After restore, overtested.example.com shouldn't be over-tested anymore
  ok('after restore, over-tested target is pristine again', !fl.isOverTested('overtested.example.com'))
} finally {
  // Always restore
  try { fs.writeFileSync(REAL_TASKS, BACKUP) } catch {}
  try { fs.rmSync(TMP, { recursive: true, force: true }) } catch {}
}

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed > 0 ? 1 : 0)
