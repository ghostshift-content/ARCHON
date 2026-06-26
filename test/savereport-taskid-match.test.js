// test/savereport-taskid-match.test.js
//
// 2026-05-15: Regression test for the parallel-dispatch race condition where
// saveAgentReport scanned newest leader-named .md file and picked WRONG task's
// content. Bug: 3 of 5 parallel stocks had cross-contaminated reports.
// Fix: taskId-preferred selection before leader-name fallback.

'use strict'
const assert = require('node:assert')
const { test } = require('node:test')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')

// Helper extracted from event-bus.js saveAgentReport — see selectBestDossierFile
const { selectBestDossierFile } = require('../agents/dossier-selector')

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dossier-test-'))
  return dir
}

function makeFile(dir, name, content) {
  const fp = path.join(dir, name)
  fs.writeFileSync(fp, content)
  return fp
}

test('taskId-in-filename wins over leader-newest', () => {
  const dir = setup()
  // Two files: one with leader name + newer mtime, one with taskId match (older mtime).
  // The taskId-match file MUST win.
  const wrongFp = makeFile(dir, 'CHANAKYA-DAILY-WRONG.md', 'wrong content')
  const rightFp = makeFile(dir, 'JYOTIRES-ANALYSIS-1778844675579.md', 'right content')
  // Make wrong one newer by mtime
  const now = Date.now()
  fs.utimesSync(rightFp, new Date(now - 5000) / 1000, new Date(now - 5000) / 1000)
  fs.utimesSync(wrongFp, new Date(now) / 1000, new Date(now) / 1000)
  const result = selectBestDossierFile([dir], '1778844675579', 'CHANAKYA', now - 30 * 60 * 1000)
  assert.ok(result)
  assert.strictEqual(result.name, 'JYOTIRES-ANALYSIS-1778844675579.md', 'taskId-match must win')
})

test('leader-name in filename wins over content-taskId match when both present (priority 2 > priority 3)', () => {
  // 2026-05-16 sub-bug fix: priority order is now:
  //   1. Filename contains taskId
  //   2. Filename contains leader name  ← beats content-taskId
  //   3. Content has taskId in header   ← loses to leader-name
  //   4. Newest in window
  // A leader-named file is the canonical squad output; content-taskId metadata
  // is template boilerplate that challengers also include.
  const dir = setup()
  // Leader file: CHANAKYA in filename, no taskId in header
  const leaderFp = makeFile(dir, 'CHANAKYA-DAILY-LEADER.md', 'leader content, no taskId in header')
  // Challenger file: no leader name, taskId IS in content header
  const contentFp = makeFile(dir, 'JYOTIRES-2026-05-15-CIO-FINAL.md',
    '**Report Date:** 2026-05-15 | **Task ID:** 1778844675579\nright content')
  const now = Date.now()
  fs.utimesSync(contentFp, new Date(now - 5000) / 1000, new Date(now - 5000) / 1000)
  fs.utimesSync(leaderFp, new Date(now) / 1000, new Date(now) / 1000)
  const result = selectBestDossierFile([dir], '1778844675579', 'CHANAKYA', now - 30 * 60 * 1000)
  assert.ok(result)
  assert.strictEqual(result.name, 'CHANAKYA-DAILY-LEADER.md', 'leader-name must beat content-taskId')
})

test('content-taskId wins over newest when no leader-name match exists', () => {
  // When no leader-named file exists, content-taskId (priority 3) still beats
  // newest-in-window (priority 4).
  const dir = setup()
  const contentFp = makeFile(dir, 'JYOTIRES-2026-05-15-CIO-FINAL.md',
    '**Report Date:** 2026-05-15 | **Task ID:** 1778844675579\nright content')
  const newestFp = makeFile(dir, 'RANDOM-NEWEST.md', 'no taskId, no leader name')
  const now = Date.now()
  fs.utimesSync(contentFp, new Date(now - 5000) / 1000, new Date(now - 5000) / 1000)
  fs.utimesSync(newestFp, new Date(now) / 1000, new Date(now) / 1000)
  const result = selectBestDossierFile([dir], '1778844675579', 'CHANAKYA', now - 30 * 60 * 1000)
  assert.ok(result)
  assert.strictEqual(result.name, 'JYOTIRES-2026-05-15-CIO-FINAL.md', 'content-taskId must beat newest-in-window')
})

test('falls back to leader-name match when no taskId found', () => {
  const dir = setup()
  makeFile(dir, 'random-other.md', 'no leader, no taskId')
  const rightFp = makeFile(dir, 'CHANAKYA-RIGHT.md', 'leader content')
  const result = selectBestDossierFile([dir], '9999', 'CHANAKYA', Date.now() - 30 * 60 * 1000)
  assert.ok(result)
  assert.strictEqual(result.name, 'CHANAKYA-RIGHT.md')
})

test('falls back to newest when no taskId or leader match', () => {
  const dir = setup()
  const fp1 = makeFile(dir, 'older.md', 'older')
  const fp2 = makeFile(dir, 'newer.md', 'newer')
  const now = Date.now()
  fs.utimesSync(fp1, new Date(now - 5000) / 1000, new Date(now - 5000) / 1000)
  fs.utimesSync(fp2, new Date(now) / 1000, new Date(now) / 1000)
  const result = selectBestDossierFile([dir], '9999', 'NOBODY', now - 30 * 60 * 1000)
  assert.ok(result)
  assert.strictEqual(result.name, 'newer.md')
})

test('returns null when no files in cutoff window', () => {
  const dir = setup()
  const fp = makeFile(dir, 'too-old.md', 'old')
  const longAgo = Date.now() - 60 * 60 * 1000 // 1hr ago
  fs.utimesSync(fp, new Date(longAgo) / 1000, new Date(longAgo) / 1000)
  const result = selectBestDossierFile([dir], '9999', 'CHANAKYA', Date.now() - 30 * 60 * 1000)
  assert.strictEqual(result, null)
})

test('returns null for empty/nonexistent dirs', () => {
  assert.strictEqual(selectBestDossierFile([], '1', 'X', 0), null)
  assert.strictEqual(selectBestDossierFile(['/nonexistent-xyz-12345'], '1', 'X', 0), null)
})

test('multiple dirs: taskId-match wins across dirs', () => {
  const dir1 = setup()
  const dir2 = setup()
  makeFile(dir1, 'CHANAKYA-DAILY-WRONG.md', 'wrong')
  makeFile(dir2, 'JYOTIRES-1778844675579.md', 'right')
  const result = selectBestDossierFile([dir1, dir2], '1778844675579', 'CHANAKYA', Date.now() - 30 * 60 * 1000)
  assert.ok(result)
  assert.strictEqual(result.name, 'JYOTIRES-1778844675579.md')
})

test('numeric taskId converted to string match works', () => {
  const dir = setup()
  makeFile(dir, 'X-1778844675579-final.md', 'content')
  const result = selectBestDossierFile([dir], 1778844675579, 'CHANAKYA', Date.now() - 30 * 60 * 1000)
  assert.ok(result)
})

test('leader-name in filename wins over content-taskId match (Chennai 2026-05-16 regression)', () => {
  // SHAKUNI's prompt template includes TaskID: in header (line 2), but it's a
  // challenger document, not the canonical institutional dossier.
  // CHANAKYA's institutional-dossier template does NOT embed TaskID in header
  // but the filename includes "CHANAKYA". Leader-name signal must beat
  // content-taskId because filename naming is author-intentional while
  // content metadata is template boilerplate.
  const dir = setup()
  const shakuni = makeFile(dir, 'SHAKUNI-CONTRARIAN-2026-05-16-CHENNPETRO.md',
    '# SHAKUNI CONTRARIAN CHALLENGE\n## Devil\'s Advocate | TaskID: 1778914821917\nwrong content')
  const chanakya = makeFile(dir, 'CHANAKYA-FINAL-2026-05-16-CHENNPETRO.md',
    '# Chennai Petroleum Corporation\n## Institutional Equity Research Dossier — Final\nright content (no taskId in header)')
  const now = Date.now()
  fs.utimesSync(shakuni, new Date(now - 10000) / 1000, new Date(now - 10000) / 1000)
  fs.utimesSync(chanakya, new Date(now) / 1000, new Date(now) / 1000)
  const result = selectBestDossierFile([dir], '1778914821917', 'CHANAKYA', now - 30 * 60 * 1000)
  assert.ok(result, 'must select a file')
  assert.strictEqual(result.name, 'CHANAKYA-FINAL-2026-05-16-CHENNPETRO.md',
    'leader-name match must win over content-taskId match')
})

test('content-taskId still wins when no leader-name candidate exists', () => {
  // If only a challenger file exists (no canonical leader file), content-taskId
  // is still a useful fallback before newest-in-window.
  const dir = setup()
  const fileA = makeFile(dir, 'SOME-RANDOM-FILE.md', '**TaskID:** 1234567890\nrelevant')
  const fileB = makeFile(dir, 'OTHER-FILE.md', 'no taskId here, just newest')
  const now = Date.now()
  fs.utimesSync(fileA, new Date(now - 10000) / 1000, new Date(now - 10000) / 1000)
  fs.utimesSync(fileB, new Date(now) / 1000, new Date(now) / 1000)
  const result = selectBestDossierFile([dir], '1234567890', 'NOBODY', now - 30 * 60 * 1000)
  assert.ok(result)
  assert.strictEqual(result.name, 'SOME-RANDOM-FILE.md',
    'content-taskId wins over newest when no leader-name match')
})
