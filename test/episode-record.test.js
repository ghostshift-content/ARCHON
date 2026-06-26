// test/episode-record.test.js
// Unit tests for agents/episode-record.js
// Run: bun test test/episode-record.test.js
//
// All tests are OFFLINE — no LLM calls. Uses temp dirs for isolation.

'use strict'

const assert = require('node:assert')
const { test } = require('node:test')
const fs = require('fs')
const path = require('path')
const os = require('os')

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'episode-record-test-'))
}

function readJsonlLines(file) {
  if (!fs.existsSync(file)) return []
  const raw = fs.readFileSync(file, 'utf8').trim()
  if (!raw) return []
  return raw.split('\n').filter(Boolean).map((l) => JSON.parse(l))
}

function loadModule() {
  const modPath = require.resolve('../agents/episode-record')
  delete require.cache[modPath]
  return require('../agents/episode-record')
}

// ---------------------------------------------------------------------------
// Test 1: emitEpisode writes JSONL to temp dir with all expected fields + epVersion='1'
// ---------------------------------------------------------------------------

test('emitEpisode writes JSONL with all expected fields + epVersion=1', async () => {
  const er = loadModule()
  const outDir = makeTempDir()

  er.emitEpisode({
    taskId: 'task-001',
    squad: 'pentest',
    agentName: 'SCOUT',
    phase: 'specialist',
    outcome: 'completed',
    gradeScore: 0.85,
    costUsd: 0.0512,
    durationMs: 12000,
    adapterUsed: 'cli',
    suppressionCount: 2,
    findingCount: 3,
    errorMessage: null,
    outDir,
  })

  const episodesFile = path.join(outDir, 'episodes', 'episodes.jsonl')
  assert.ok(fs.existsSync(episodesFile), 'episodes.jsonl should exist')

  const lines = readJsonlLines(episodesFile)
  assert.strictEqual(lines.length, 1, 'should have 1 line')

  const line = lines[0]
  assert.strictEqual(line.epVersion, '1', 'epVersion should be "1"')
  assert.ok(line.ts, 'ts should be set')
  assert.strictEqual(line.taskId, 'task-001')
  assert.strictEqual(line.squad, 'pentest')
  assert.strictEqual(line.agentName, 'SCOUT')
  assert.strictEqual(line.phase, 'specialist')
  assert.strictEqual(line.outcome, 'completed')
  assert.strictEqual(line.gradeScore, 0.85)
  assert.strictEqual(line.costUsd, 0.0512)
  assert.strictEqual(line.durationMs, 12000)
  assert.strictEqual(line.adapterUsed, 'cli')
  assert.strictEqual(line.suppressionCount, 2)
  assert.strictEqual(line.findingCount, 3)
  assert.strictEqual(line.errorMessage, null)

  fs.rmSync(outDir, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// Test 2: readEpisodes returns empty array on missing file
// ---------------------------------------------------------------------------

test('readEpisodes returns empty array on missing file', async () => {
  const er = loadModule()
  const outDir = makeTempDir()

  const result = er.readEpisodes({ outDir })
  assert.ok(Array.isArray(result), 'should return an array')
  assert.strictEqual(result.length, 0, 'should be empty when file missing')

  fs.rmSync(outDir, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// Test 3: readEpisodes skips malformed lines
// ---------------------------------------------------------------------------

test('readEpisodes skips malformed lines gracefully', async () => {
  const er = loadModule()
  const outDir = makeTempDir()
  const episodesDir = path.join(outDir, 'episodes')
  fs.mkdirSync(episodesDir, { recursive: true })
  const episodesFile = path.join(episodesDir, 'episodes.jsonl')

  const recentTs = new Date().toISOString()
  // Good line, then malformed, then good line
  fs.writeFileSync(episodesFile, [
    JSON.stringify({ epVersion: '1', ts: recentTs, taskId: 't1', squad: 'pentest', agentName: 'X', phase: 'specialist', outcome: 'completed', gradeScore: 0.8, costUsd: 0.01, durationMs: 1000, adapterUsed: 'cli', suppressionCount: 0, findingCount: 0, errorMessage: null }),
    '{this is not valid json',
    JSON.stringify({ epVersion: '1', ts: recentTs, taskId: 't2', squad: 'pentest', agentName: 'Y', phase: 'specialist', outcome: 'failed', gradeScore: 0.3, costUsd: 0.02, durationMs: 2000, adapterUsed: 'cli', suppressionCount: 0, findingCount: 0, errorMessage: null }),
  ].join('\n') + '\n', 'utf8')

  const result = er.readEpisodes({ outDir })
  assert.strictEqual(result.length, 2, 'should return 2 valid lines, skip 1 malformed')
  assert.strictEqual(result[0].taskId, 't1')
  assert.strictEqual(result[1].taskId, 't2')

  fs.rmSync(outDir, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// Test 4: readEpisodes filters by windowDays (old entries excluded)
// ---------------------------------------------------------------------------

test('readEpisodes filters out episodes older than windowDays', async () => {
  const er = loadModule()
  const outDir = makeTempDir()
  const episodesDir = path.join(outDir, 'episodes')
  fs.mkdirSync(episodesDir, { recursive: true })
  const episodesFile = path.join(episodesDir, 'episodes.jsonl')

  const recentTs = new Date().toISOString()
  const oldTs = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString() // 10 days ago

  fs.writeFileSync(episodesFile, [
    JSON.stringify({ epVersion: '1', ts: recentTs, taskId: 'recent', squad: 'pentest', agentName: 'X', phase: 'specialist', outcome: 'completed', gradeScore: 0.9, costUsd: 0.01, durationMs: 1000, adapterUsed: 'cli', suppressionCount: 0, findingCount: 0, errorMessage: null }),
    JSON.stringify({ epVersion: '1', ts: oldTs, taskId: 'old', squad: 'pentest', agentName: 'X', phase: 'specialist', outcome: 'failed', gradeScore: 0.4, costUsd: 0.02, durationMs: 2000, adapterUsed: 'cli', suppressionCount: 0, findingCount: 0, errorMessage: null }),
  ].join('\n') + '\n', 'utf8')

  // windowDays=7: only recent should appear
  const result7 = er.readEpisodes({ outDir, windowDays: 7 })
  assert.strictEqual(result7.length, 1, 'should only return recent episode within 7 days')
  assert.strictEqual(result7[0].taskId, 'recent')

  // windowDays=15: both should appear
  const result15 = er.readEpisodes({ outDir, windowDays: 15 })
  assert.strictEqual(result15.length, 2, 'should return both episodes within 15 days')

  fs.rmSync(outDir, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// Test 5: validateOutcome — 'completed' → true, 'nonsense' → false
// ---------------------------------------------------------------------------

test('validateOutcome returns true for known outcomes, false for unknown', async () => {
  const er = loadModule()

  assert.strictEqual(er.validateOutcome('completed'), true, 'completed should be valid')
  assert.strictEqual(er.validateOutcome('failed'), true, 'failed should be valid')
  assert.strictEqual(er.validateOutcome('timeout'), true, 'timeout should be valid')
  assert.strictEqual(er.validateOutcome('cancelled'), true, 'cancelled should be valid')
  assert.strictEqual(er.validateOutcome('rate-limited'), true, 'rate-limited should be valid')

  assert.strictEqual(er.validateOutcome('nonsense'), false, 'nonsense should be invalid')
  assert.strictEqual(er.validateOutcome(''), false, 'empty string should be invalid')
  assert.strictEqual(er.validateOutcome(null), false, 'null should be invalid')
  assert.strictEqual(er.validateOutcome(undefined), false, 'undefined should be invalid')
})

// ---------------------------------------------------------------------------
// Test 6: emitEpisode never throws even with bad outDir (silently fails)
// ---------------------------------------------------------------------------

test('emitEpisode never throws even with completely invalid outDir', async () => {
  const er = loadModule()

  // Should not throw — fail-soft
  assert.doesNotThrow(() => {
    er.emitEpisode({
      taskId: 'x',
      squad: 'pentest',
      agentName: 'X',
      phase: 'specialist',
      outcome: 'completed',
      gradeScore: 0.8,
      costUsd: 0.01,
      durationMs: 1000,
      adapterUsed: 'cli',
      suppressionCount: 0,
      findingCount: 0,
      outDir: '/this/path/definitely/does/not/exist/and/cannot/be/created/\x00invalid',
    })
  }, 'emitEpisode must never throw even with invalid outDir')
})

// ---------------------------------------------------------------------------
// Test 7: EPISODE_VERSION and EPISODE_OUTCOMES are exported correctly
// ---------------------------------------------------------------------------

test('EPISODE_VERSION is "1" and EPISODE_OUTCOMES has expected values', async () => {
  const er = loadModule()

  assert.strictEqual(er.EPISODE_VERSION, '1', 'EPISODE_VERSION should be "1"')
  assert.ok(Array.isArray(er.EPISODE_OUTCOMES), 'EPISODE_OUTCOMES should be an array')

  const expected = ['completed', 'failed', 'timeout', 'cancelled', 'rate-limited']
  for (const o of expected) {
    assert.ok(er.EPISODE_OUTCOMES.includes(o), `EPISODE_OUTCOMES should include: ${o}`)
  }
})
