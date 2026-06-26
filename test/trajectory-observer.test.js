
const __roots = require('../paths') // portable roots (KURU_*_ROOT) — see paths.js
// test/trajectory-observer.test.js
const assert = require('node:assert')
const { test } = require('node:test')
const {
  SCHEMA_VERSION,
  VERDICTS,
  FAILURE_DIMS,
  DEFAULT_LOG_PATH,
} = require('../agents/trajectory-observer')

test('SCHEMA_VERSION is "1"', () => {
  assert.strictEqual(SCHEMA_VERSION, '1')
})

test('VERDICTS includes the four canonical values', () => {
  assert.deepStrictEqual(
    VERDICTS.slice().sort(),
    ['crashed', 'indeterminate', 'off-track', 'on-track']
  )
})

test('FAILURE_DIMS lists the three rubric dimensions in order', () => {
  assert.deepStrictEqual(FAILURE_DIMS, ['goal-alignment', 'evidence-quality', 'coherence'])
})

test('DEFAULT_LOG_PATH points at the canonical subdir /root/intel/trajectory/observations.jsonl', () => {
  // FIX 3 (2026-05-09): moved from /root/intel/trajectory-observations.jsonl
  // to a subdir so specialists are less likely to write to it via shell echo
  // (live pentest 1778394458903 polluted the legacy file with non-canonical
  // schemas — verdict='HONEST'/'CONFIRMED'/etc).
  assert.strictEqual(DEFAULT_LOG_PATH, (__roots.INTEL_ROOT + '/trajectory/observations.jsonl'))
})

const { buildObserverPrompt } = require('../agents/trajectory-observer')

test('buildObserverPrompt includes agent goal and output', () => {
  const prompt = buildObserverPrompt({
    agent: 'DRILL',
    goal: 'Probe discovered endpoints for SQL injection',
    output: 'Tested /search?q= with quote — got 500 error in 2.1s, sqlmap confirmed boolean blind.',
  })
  assert.match(prompt, /DRILL/)
  assert.match(prompt, /SQL injection/)
  assert.match(prompt, /sqlmap confirmed boolean blind/)
  assert.match(prompt, /STRICT JSON ONLY/)
})

test('buildObserverPrompt rubric mentions the three dimensions in order', () => {
  const prompt = buildObserverPrompt({ agent: 'X', goal: 'Y', output: 'Z' })
  const goalIdx = prompt.indexOf('Goal alignment')
  const evidenceIdx = prompt.indexOf('Evidence quality')
  const coherenceIdx = prompt.indexOf('Coherence')
  assert.ok(goalIdx > 0 && evidenceIdx > goalIdx && coherenceIdx > evidenceIdx,
    'rubric must list dimensions in goal/evidence/coherence order')
})

test('buildObserverPrompt anti-sycophancy: NO downstream verdicts visible', () => {
  const prompt = buildObserverPrompt({
    agent: 'X', goal: 'Y', output: 'Z',
    // These are EVERYTHING that would prime the observer.
    // The function must IGNORE them even if passed.
    auditor_verdict: 'CONFIRMED',
    judge_verdict: 'confirmed',
    notes: 'analyst says this is critical',
    severity_original: 'High',
  })
  assert.doesNotMatch(prompt, /CONFIRMED/, 'AUDITOR verdict must not appear')
  assert.doesNotMatch(prompt, /critical/, 'analyst notes must not appear')
  assert.doesNotMatch(prompt, /severity_original/, 'severity must not anchor')
})

test('buildObserverPrompt truncates very long outputs to ~3KB', () => {
  const big = 'X'.repeat(50_000)
  const prompt = buildObserverPrompt({ agent: 'A', goal: 'G', output: big })
  // Prompt should not include all 50KB; truncate marker must appear
  assert.ok(prompt.length < 10_000, `prompt should be truncated, got ${prompt.length} bytes`)
  assert.match(prompt, /\[truncated\]/, 'truncation marker must be visible')
})

test('buildObserverPrompt accepts empty/null output as crashed-candidate', () => {
  const prompt1 = buildObserverPrompt({ agent: 'A', goal: 'G', output: '' })
  const prompt2 = buildObserverPrompt({ agent: 'A', goal: 'G', output: null })
  assert.match(prompt1, /\(no output\)/)
  assert.match(prompt2, /\(no output\)/)
})

const { parseObserverResponse } = require('../agents/trajectory-observer')

test('parseObserverResponse: clean JSON returns parsed object', () => {
  const r = parseObserverResponse(JSON.stringify({
    verdict: 'on-track', first_failed_dim: null, reason: 'looks good',
  }))
  assert.strictEqual(r.verdict, 'on-track')
  assert.strictEqual(r.first_failed_dim, null)
})

test('parseObserverResponse: strips markdown fences', () => {
  const r = parseObserverResponse('```json\n{"verdict":"off-track","first_failed_dim":"goal-alignment","reason":"x"}\n```')
  assert.strictEqual(r.verdict, 'off-track')
  assert.strictEqual(r.first_failed_dim, 'goal-alignment')
})

test('parseObserverResponse: invalid verdict normalizes to indeterminate', () => {
  const r = parseObserverResponse(JSON.stringify({ verdict: 'maybe', reason: 'x' }))
  assert.strictEqual(r.verdict, 'indeterminate')
  assert.ok(r.error, 'error reason should be set when verdict is unknown')
})

test('parseObserverResponse: empty/null input returns indeterminate (Strix-style)', () => {
  assert.strictEqual(parseObserverResponse('').verdict, 'indeterminate')
  assert.strictEqual(parseObserverResponse(null).verdict, 'indeterminate')
  assert.strictEqual(parseObserverResponse(undefined).verdict, 'indeterminate')
})

test('parseObserverResponse: malformed JSON returns indeterminate with error', () => {
  const r = parseObserverResponse('{this is broken')
  assert.strictEqual(r.verdict, 'indeterminate')
  assert.ok(r.error)
})

test('parseObserverResponse: invalid first_failed_dim is nulled', () => {
  const r = parseObserverResponse(JSON.stringify({
    verdict: 'off-track', first_failed_dim: 'made-up-dim', reason: 'x',
  }))
  assert.strictEqual(r.verdict, 'off-track')
  assert.strictEqual(r.first_failed_dim, null,
    'unrecognized dim must be nulled rather than passed through')
})

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { logObservation } = require('../agents/trajectory-observer')

test('logObservation: appends one JSON line to the file', () => {
  const tmp = path.join(os.tmpdir(), `traj-obs-${Date.now()}-${Math.random().toString(36).slice(2)}.jsonl`)
  try {
    logObservation({
      task_id: 'T1', agent: 'DRILL', verdict: 'on-track',
      first_failed_dim: null, reason: 'good', output_bytes: 100, elapsed_ms: 1000, model: 'claude-haiku-4-5',
    }, tmp)
    const lines = fs.readFileSync(tmp, 'utf-8').split('\n').filter(Boolean)
    assert.strictEqual(lines.length, 1)
    const parsed = JSON.parse(lines[0])
    assert.strictEqual(parsed.task_id, 'T1')
    assert.strictEqual(parsed.agent, 'DRILL')
    assert.strictEqual(parsed.verdict, 'on-track')
    assert.strictEqual(parsed.schema_version, '1')
    assert.ok(parsed.observed_at, 'observed_at must be set')
    assert.match(parsed.observed_at, /^\d{4}-\d{2}-\d{2}T/, 'observed_at must be ISO timestamp')
  } finally {
    if (fs.existsSync(tmp)) fs.unlinkSync(tmp)
  }
})

test('logObservation: multiple appends preserve order', () => {
  const tmp = path.join(os.tmpdir(), `traj-obs-${Date.now()}-${Math.random().toString(36).slice(2)}.jsonl`)
  try {
    for (const a of ['A', 'B', 'C']) {
      logObservation({ task_id: 'T1', agent: a, verdict: 'on-track' }, tmp)
    }
    const lines = fs.readFileSync(tmp, 'utf-8').split('\n').filter(Boolean)
    assert.strictEqual(lines.length, 3)
    assert.strictEqual(JSON.parse(lines[0]).agent, 'A')
    assert.strictEqual(JSON.parse(lines[1]).agent, 'B')
    assert.strictEqual(JSON.parse(lines[2]).agent, 'C')
  } finally {
    if (fs.existsSync(tmp)) fs.unlinkSync(tmp)
  }
})

test('logObservation: creates parent directory if missing', () => {
  const tmpDir = path.join(os.tmpdir(), `traj-obs-dir-${Date.now()}`)
  const tmp = path.join(tmpDir, 'nested', 'log.jsonl')
  try {
    assert.ok(!fs.existsSync(tmpDir), 'parent must not exist beforehand')
    logObservation({ task_id: 'T1', agent: 'X', verdict: 'on-track' }, tmp)
    assert.ok(fs.existsSync(tmp), 'log file must be created with parents')
  } finally {
    if (fs.existsSync(tmp)) fs.unlinkSync(tmp)
    if (fs.existsSync(path.dirname(tmp))) fs.rmdirSync(path.dirname(tmp))
    if (fs.existsSync(tmpDir)) fs.rmdirSync(tmpDir)
  }
})

test('logObservation: never throws — fail-soft for caller', () => {
  // Pass an unwriteable path. Must not throw.
  let threw = false
  try {
    logObservation({ task_id: 'T1', agent: 'X', verdict: 'on-track' }, '/proc/self/cmdline/cannot-write')
  } catch {
    threw = true
  }
  assert.strictEqual(threw, false, 'logObservation must never throw — caller is mid-pipeline')
})

const { observeSpecialistOutput } = require('../agents/trajectory-observer')

test('observeSpecialistOutput: end-to-end with mock LLM returns observation', async () => {
  const tmp = path.join(os.tmpdir(), `obs-e2e-${Date.now()}-${Math.random().toString(36).slice(2)}.jsonl`)
  try {
    const callLLM = async () => JSON.stringify({
      verdict: 'on-track', first_failed_dim: null, reason: 'looks good',
    })
    const obs = await observeSpecialistOutput({
      agent: 'DRILL', taskId: 'T1', goal: 'find SQLi',
      output: 'tested /search?q= got 500',
      callLLM, logFile: tmp,
    })
    assert.strictEqual(obs.verdict, 'on-track')
    assert.strictEqual(obs.agent, 'DRILL')
    assert.strictEqual(obs.task_id, 'T1')
    assert.ok(obs.output_bytes > 0)
    assert.ok(obs.observed_at)
    // Should also be persisted
    const lines = fs.readFileSync(tmp, 'utf-8').split('\n').filter(Boolean)
    assert.strictEqual(lines.length, 1)
  } finally {
    if (fs.existsSync(tmp)) fs.unlinkSync(tmp)
  }
})

test('observeSpecialistOutput: LLM throw returns indeterminate, still logs', async () => {
  const tmp = path.join(os.tmpdir(), `obs-err-${Date.now()}-${Math.random().toString(36).slice(2)}.jsonl`)
  try {
    const callLLM = async () => { throw new Error('rate limit') }
    const obs = await observeSpecialistOutput({
      agent: 'X', taskId: 'T2', goal: 'g', output: 'o',
      callLLM, logFile: tmp,
    })
    assert.strictEqual(obs.verdict, 'indeterminate')
    assert.ok(obs.error, 'error must be captured on the observation')
    const lines = fs.readFileSync(tmp, 'utf-8').split('\n').filter(Boolean)
    assert.strictEqual(lines.length, 1, 'still logs even on LLM error — telemetry should be complete')
  } finally {
    if (fs.existsSync(tmp)) fs.unlinkSync(tmp)
  }
})

test('observeSpecialistOutput: never throws (fail-soft for caller)', async () => {
  // Even with a bad logFile, must not throw
  const callLLM = async () => 'not-json-at-all'
  let threw = false
  try {
    await observeSpecialistOutput({
      agent: 'X', taskId: 'T3', goal: 'g', output: 'o',
      callLLM, logFile: '/proc/self/cmdline/blocked',
    })
  } catch {
    threw = true
  }
  assert.strictEqual(threw, false, 'observeSpecialistOutput must never throw')
})

test('observeSpecialistOutput: respects elapsed_ms passed in (telemetry input)', async () => {
  const tmp = path.join(os.tmpdir(), `obs-elapsed-${Date.now()}-${Math.random().toString(36).slice(2)}.jsonl`)
  try {
    const callLLM = async () => JSON.stringify({ verdict: 'on-track', first_failed_dim: null, reason: 'x' })
    const obs = await observeSpecialistOutput({
      agent: 'X', taskId: 'T4', goal: 'g', output: 'o',
      callLLM, logFile: tmp, elapsedMs: 12345, model: 'claude-haiku-4-5',
    })
    assert.strictEqual(obs.elapsed_ms, 12345)
    assert.strictEqual(obs.model, 'claude-haiku-4-5')
  } finally {
    if (fs.existsSync(tmp)) fs.unlinkSync(tmp)
  }
})

// ── FIX 3 (2026-05-09): readTrajectoryLog filters by schema_version ──
//
// Live pentest 1778394458903 polluted the trajectory log with
// non-canonical specialist-written entries (verdicts like "HONEST",
// "CONFIRMED", "DISPROVEN" — none of which are our canonical verdict
// set; schema_version absent or "0"). Polluted entries don't break
// anything because readers can filter by schema_version, but they make
// the file untrustworthy.
//
// readTrajectoryLog(filePath) returns ONLY records where
// schema_version === SCHEMA_VERSION (canonical only). Skips/silently
// drops malformed lines and missing files.

const { readTrajectoryLog } = require('../agents/trajectory-observer')

test('readTrajectoryLog: returns only canonical schema_version entries', () => {
  const tmp = path.join(os.tmpdir(), `traj-read-${Date.now()}-${Math.random().toString(36).slice(2)}.jsonl`)
  try {
    const lines = [
      // Canonical entries (must be returned)
      JSON.stringify({ schema_version: '1', task_id: 'T1', agent: 'DRILL', verdict: 'on-track' }),
      JSON.stringify({ schema_version: '1', task_id: 'T2', agent: 'SCOUT', verdict: 'off-track' }),
      // Polluted: missing schema_version
      JSON.stringify({ task_id: 'T3', agent: 'FORGE', verdict: 'CONFIRMED' }),
      // Polluted: wrong schema_version
      JSON.stringify({ schema_version: '0', task_id: 'T4', agent: 'X', verdict: 'HONEST' }),
      // Polluted: numeric instead of string
      JSON.stringify({ schema_version: 1, task_id: 'T5', agent: 'X', verdict: 'DISPROVEN' }),
      // Canonical again
      JSON.stringify({ schema_version: '1', task_id: 'T6', agent: 'RELAY', verdict: 'crashed' }),
    ]
    fs.writeFileSync(tmp, lines.join('\n') + '\n')
    const records = readTrajectoryLog(tmp)
    assert.strictEqual(records.length, 3, `expected 3 canonical, got ${records.length}`)
    assert.deepStrictEqual(records.map(r => r.task_id).sort(), ['T1', 'T2', 'T6'])
  } finally {
    if (fs.existsSync(tmp)) fs.unlinkSync(tmp)
  }
})

test('readTrajectoryLog: silently skips malformed lines (broken JSON)', () => {
  const tmp = path.join(os.tmpdir(), `traj-bad-${Date.now()}-${Math.random().toString(36).slice(2)}.jsonl`)
  try {
    const content = [
      JSON.stringify({ schema_version: '1', task_id: 'T1', agent: 'A', verdict: 'on-track' }),
      'this is not json{{{',
      JSON.stringify({ schema_version: '1', task_id: 'T2', agent: 'B', verdict: 'on-track' }),
      '',
      JSON.stringify({ schema_version: '1', task_id: 'T3', agent: 'C', verdict: 'on-track' }),
    ].join('\n')
    fs.writeFileSync(tmp, content)
    const records = readTrajectoryLog(tmp)
    assert.strictEqual(records.length, 3)
  } finally {
    if (fs.existsSync(tmp)) fs.unlinkSync(tmp)
  }
})

test('readTrajectoryLog: returns empty array for missing file (fail-soft)', () => {
  const records = readTrajectoryLog('/tmp/this-file-cannot-exist-' + Date.now() + '.jsonl')
  assert.deepStrictEqual(records, [])
})

test('readTrajectoryLog: returns empty array for empty file', () => {
  const tmp = path.join(os.tmpdir(), `traj-empty-${Date.now()}.jsonl`)
  try {
    fs.writeFileSync(tmp, '')
    const records = readTrajectoryLog(tmp)
    assert.deepStrictEqual(records, [])
  } finally {
    if (fs.existsSync(tmp)) fs.unlinkSync(tmp)
  }
})

test('readTrajectoryLog: defaults to DEFAULT_LOG_PATH when called with no arg', () => {
  // Just verifying the call signature accepts no argument; real path may not
  // exist, in which case we get [] (fail-soft).
  const records = readTrajectoryLog()
  assert.ok(Array.isArray(records), 'must return an array even with no arg')
})

test('readTrajectoryLog: never throws — fail-soft (file may be in flux)', () => {
  // Pass an unreadable path. Must not throw.
  let threw = false
  try {
    readTrajectoryLog('/proc/self/cmdline/cannot-read')
  } catch {
    threw = true
  }
  assert.strictEqual(threw, false, 'readTrajectoryLog must never throw')
})

test('readTrajectoryLog: filters real pollution sample (live pentest 1778394458903)', () => {
  // Synthesize the exact pattern observed in the live pentest:
  // canonical observer entries interleaved with specialist-written
  // shell-echo entries that used non-canonical verdicts.
  const tmp = path.join(os.tmpdir(), `traj-live-${Date.now()}-${Math.random().toString(36).slice(2)}.jsonl`)
  try {
    const lines = [
      JSON.stringify({ schema_version: '1', task_id: '1778394458903', agent: 'DRILL', verdict: 'on-track', reason: 'concrete artefact' }),
      // The shell-echo pollution shape:
      JSON.stringify({ task_id: '1778394458903', specialist: 'FORGE', verdict: 'CONFIRMED', evidence: '...' }),
      JSON.stringify({ task_id: '1778394458903', specialist: 'RANGER', verdict: 'HONEST', evidence: '...' }),
      JSON.stringify({ task_id: '1778394458903', specialist: 'SCOUT', verdict: 'DISPROVEN', evidence: '...' }),
      JSON.stringify({ schema_version: '1', task_id: '1778394458903', agent: 'RELAY', verdict: 'off-track', reason: 'wrong domain' }),
    ].join('\n')
    fs.writeFileSync(tmp, lines)
    const records = readTrajectoryLog(tmp)
    assert.strictEqual(records.length, 2, 'only canonical observer entries should survive')
    for (const r of records) {
      assert.strictEqual(r.schema_version, '1')
      assert.ok(['on-track', 'off-track', 'crashed', 'indeterminate'].includes(r.verdict),
        `non-canonical verdict slipped through: ${r.verdict}`)
    }
  } finally {
    if (fs.existsSync(tmp)) fs.unlinkSync(tmp)
  }
})
