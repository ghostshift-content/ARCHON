// test/shadow-runner.test.js
// Unit tests for agents/runner/shadow-runner.js
// Run: bun test test/shadow-runner.test.js
//
// All tests are OFFLINE — no real LLM calls. Fake runAgent + temp outDir.
// The shadow runner NEVER writes to live state — every write must land under
// the injected temp outDir. NO-LIVE-LEAK is asserted structurally.

'use strict'
const __roots = require('../paths') // portable roots (KURU_*_ROOT) — see paths.js


const assert = require('node:assert')
const { test } = require('node:test')
const fs = require('fs')
const path = require('path')
const os = require('os')

const {
  maybeShadowRun,
  shouldSample,
  SHADOW_ROOT,
} = require('../agents/runner/shadow-runner')

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'shadow-runner-test-'))
}

// Collect EVERY file path under a dir, recursively.
function walkFiles(dir) {
  const out = []
  if (!fs.existsSync(dir)) return out
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...walkFiles(full))
    else out.push(full)
  }
  return out
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

// Fake runAgent that resolves with a realistic structured sdk result.
function makeFakeRunAgentOk(text = 'SHADOW-OK output text') {
  const captured = []
  const fn = (spec) => {
    captured.push(spec)
    return Promise.resolve({
      text,
      usage: { input_tokens: 10, output_tokens: 5 },
      model: spec.model || 'claude-sonnet-4-6',
      raw: {},
    })
  }
  fn.captured = captured
  return fn
}

// Fake runAgent that rejects (shadow adapter failed).
function makeFakeRunAgentErr(msg = 'sdk transport boom') {
  const captured = []
  const fn = (spec) => {
    captured.push(spec)
    return Promise.reject(new Error(msg))
  }
  fn.captured = captured
  return fn
}

// Pick a taskId that is sampled at the given K (hash % k === 0).
function findSampledTaskId(k) {
  for (let i = 0; i < 100000; i++) {
    const id = 'task-sampled-' + i
    if (shouldSample(id, k)) return id
  }
  throw new Error('could not find a sampled taskId — hashing broken')
}

// Pick a taskId that is NOT sampled at the given K.
function findUnsampledTaskId(k) {
  for (let i = 0; i < 100000; i++) {
    const id = 'task-skip-' + i
    if (!shouldSample(id, k)) return id
  }
  throw new Error('could not find an unsampled taskId — hashing broken')
}

// ---------------------------------------------------------------------------
// SHADOW_ROOT structural invariant
// ---------------------------------------------------------------------------

test('SHADOW_ROOT is the canonical shadow-runs dir constant', () => {
  assert.strictEqual(SHADOW_ROOT, (__roots.INTEL_ROOT + '/shadow-runs'))
})

// ---------------------------------------------------------------------------
// shouldSample — deterministic, stable, ~1/K distribution
// ---------------------------------------------------------------------------

test('shouldSample is deterministic for the same taskId + K', () => {
  const id = 'deterministic-task-42'
  const a = shouldSample(id, 5)
  const b = shouldSample(id, 5)
  const c = shouldSample(id, 5)
  assert.strictEqual(a, b)
  assert.strictEqual(b, c)
})

test('shouldSample distribution across many taskIds is roughly 1/K', () => {
  const K = 5
  const N = 5000
  let sampled = 0
  for (let i = 0; i < N; i++) {
    if (shouldSample('dist-task-' + i, K)) sampled++
  }
  const ratio = sampled / N
  // Expect ~0.20; allow generous slack so the test is not flaky.
  assert.ok(ratio > 0.12 && ratio < 0.28, `ratio ${ratio} not roughly 1/${K}`)
})

test('shouldSample K=1 samples everything', () => {
  for (let i = 0; i < 50; i++) {
    assert.strictEqual(shouldSample('k1-task-' + i, 1), true)
  }
})

test('shouldSample handles missing taskId gracefully (no throw)', () => {
  // Must not throw on undefined/null taskId — just returns a boolean.
  assert.strictEqual(typeof shouldSample(undefined, 5), 'boolean')
  assert.strictEqual(typeof shouldSample(null, 5), 'boolean')
  assert.strictEqual(typeof shouldSample('', 5), 'boolean')
})

// ---------------------------------------------------------------------------
// maybeShadowRun — sampled path writes both artifacts with correct shape
// ---------------------------------------------------------------------------

test('sampled run writes shadow-output.json + diff.json with correct shape', async () => {
  const outDir = makeTempDir()
  const k = 5
  const taskId = findSampledTaskId(k)
  const fakeRun = makeFakeRunAgentOk('hello from sdk shadow')

  const res = await maybeShadowRun(
    {
      agentName: 'SCOUT',
      taskId,
      model: 'claude-sonnet-4-6',
      systemPrompt: 'you are scout',
      userPrompt: 'find the bug',
      liveText: 'live cli text here that is longer than the shadow',
      liveOk: true,
    },
    { _runAgent: fakeRun, _outDir: outDir, _sampleK: k }
  )

  assert.strictEqual(res.sampled, true)

  // runAgent was asked for the sdk adapter
  assert.strictEqual(fakeRun.captured.length, 1)
  assert.strictEqual(fakeRun.captured[0].adapter, 'sdk')
  assert.strictEqual(fakeRun.captured[0].userPrompt, 'find the bug')
  assert.strictEqual(fakeRun.captured[0].systemPrompt, 'you are scout')

  // Per-agent subdir: shadow-runs/<runKey>/<agentName>/
  const runDir = path.join(outDir, taskId, 'SCOUT')
  const outputFile = path.join(runDir, 'shadow-output.json')
  const diffFile = path.join(runDir, 'diff.json')
  assert.ok(fs.existsSync(outputFile), 'shadow-output.json must exist')
  assert.ok(fs.existsSync(diffFile), 'diff.json must exist')

  const diff = readJson(diffFile)
  assert.strictEqual(diff.taskId, taskId)
  assert.strictEqual(diff.agentName, 'SCOUT')
  assert.strictEqual(diff.model, 'claude-sonnet-4-6')
  assert.strictEqual(diff.sampled, true)
  assert.strictEqual(diff.sameOutcome, true) // liveOk true, shadowOk true
  assert.ok(diff.ts, 'diff must carry a timestamp')
  assert.ok(diff.deltas, 'diff must carry deltas')
  assert.strictEqual(diff.deltas.liveOk, true)
  assert.strictEqual(diff.deltas.shadowOk, true)
  assert.strictEqual(typeof diff.deltas.textLengthDelta, 'number')
  assert.strictEqual(typeof diff.deltas.lengthRatio, 'number')
  assert.strictEqual(typeof diff.deltas.modelMatch, 'boolean')

  const shadowOut = readJson(outputFile)
  assert.strictEqual(shadowOut.text, 'hello from sdk shadow')
})

// ---------------------------------------------------------------------------
// NO-LIVE-LEAK: every write lands under the injected outDir
// ---------------------------------------------------------------------------

test('NO-LIVE-LEAK: all writes land under the injected outDir', async () => {
  const outDir = makeTempDir()
  const k = 5
  const taskId = findSampledTaskId(k)

  await maybeShadowRun(
    {
      agentName: 'DRILL',
      taskId,
      model: 'claude-opus-4-8',
      systemPrompt: 'sys',
      userPrompt: 'usr',
      liveText: 'live',
      liveOk: true,
    },
    { _runAgent: makeFakeRunAgentOk(), _outDir: outDir, _sampleK: k }
  )

  const files = walkFiles(outDir)
  assert.ok(files.length >= 2, 'expected at least 2 artifacts written')
  // EVERY written file must be under outDir (no escape, no live-state path).
  const resolvedOut = fs.realpathSync(outDir)
  for (const f of files) {
    const resolvedF = fs.realpathSync(f)
    assert.ok(
      resolvedF.startsWith(resolvedOut + path.sep),
      `write escaped outDir: ${resolvedF}`
    )
    // Hard guard: nothing under the real live SHADOW_ROOT during tests.
    assert.ok(
      !resolvedF.startsWith(SHADOW_ROOT + path.sep),
      `write leaked to live SHADOW_ROOT: ${resolvedF}`
    )
  }
})

// ---------------------------------------------------------------------------
// not-sampled path writes nothing
// ---------------------------------------------------------------------------

test('not-sampled run does no I/O and returns {sampled:false}', async () => {
  const outDir = makeTempDir()
  const k = 5
  const taskId = findUnsampledTaskId(k)
  const fakeRun = makeFakeRunAgentOk()

  const res = await maybeShadowRun(
    {
      agentName: 'RELAY',
      taskId,
      model: 'claude-sonnet-4-6',
      systemPrompt: 'sys',
      userPrompt: 'usr',
      liveText: 'live',
      liveOk: true,
    },
    { _runAgent: fakeRun, _outDir: outDir, _sampleK: k }
  )

  assert.strictEqual(res.sampled, false)
  assert.strictEqual(fakeRun.captured.length, 0, 'runAgent must NOT be called')
  assert.strictEqual(walkFiles(outDir).length, 0, 'no files must be written')
})

// ---------------------------------------------------------------------------
// shadow error → diff records error + sameOutcome false (when live ok)
// ---------------------------------------------------------------------------

test('shadow adapter error → diff.json has error + sameOutcome false (live ok)', async () => {
  const outDir = makeTempDir()
  const k = 5
  const taskId = findSampledTaskId(k)
  const fakeRun = makeFakeRunAgentErr('sdk exploded')

  const res = await maybeShadowRun(
    {
      agentName: 'VIPER',
      taskId,
      model: 'claude-sonnet-4-6',
      systemPrompt: 'sys',
      userPrompt: 'usr',
      liveText: 'live ok text',
      liveOk: true,
    },
    { _runAgent: fakeRun, _outDir: outDir, _sampleK: k }
  )

  assert.strictEqual(res.sampled, true)

  // Per-agent subdir: shadow-runs/<runKey>/<agentName>/
  const diffFile = path.join(outDir, taskId, 'VIPER', 'diff.json')
  assert.ok(fs.existsSync(diffFile))
  const diff = readJson(diffFile)
  assert.ok(diff.error, 'diff must record the shadow error')
  assert.match(diff.error, /sdk exploded/)
  assert.strictEqual(diff.deltas.shadowOk, false)
  assert.strictEqual(diff.deltas.liveOk, true)
  // liveOk(true) !== shadowOk(false) → not the same outcome
  assert.strictEqual(diff.sameOutcome, false)
})

test('both fail → sameOutcome true (live failed AND shadow failed)', async () => {
  const outDir = makeTempDir()
  const k = 5
  const taskId = findSampledTaskId(k)
  const fakeRun = makeFakeRunAgentErr('sdk down')

  await maybeShadowRun(
    {
      agentName: 'GATEWAY',
      taskId,
      model: 'claude-sonnet-4-6',
      systemPrompt: 'sys',
      userPrompt: 'usr',
      liveText: '',
      liveOk: false,
    },
    { _runAgent: fakeRun, _outDir: outDir, _sampleK: k }
  )

  // Per-agent subdir: shadow-runs/<runKey>/<agentName>/
  const diff = readJson(path.join(outDir, taskId, 'GATEWAY', 'diff.json'))
  assert.strictEqual(diff.deltas.liveOk, false)
  assert.strictEqual(diff.deltas.shadowOk, false)
  assert.strictEqual(diff.sameOutcome, true) // both failed → same outcome
})

// ---------------------------------------------------------------------------
// internal write failure must not throw to caller
// ---------------------------------------------------------------------------

test('internal write failure does not throw to caller', async () => {
  const k = 5
  const taskId = findSampledTaskId(k)
  // Point outDir at a path whose parent is a FILE → mkdir will fail.
  const blocker = path.join(makeTempDir(), 'iam-a-file')
  fs.writeFileSync(blocker, 'x')
  const brokenOutDir = path.join(blocker, 'cannot', 'make', 'this')

  // Must resolve (not reject) even though all writes fail.
  const res = await maybeShadowRun(
    {
      agentName: 'WARDEN',
      taskId,
      model: 'claude-sonnet-4-6',
      systemPrompt: 'sys',
      userPrompt: 'usr',
      liveText: 'live',
      liveOk: true,
    },
    { _runAgent: makeFakeRunAgentOk(), _outDir: brokenOutDir, _sampleK: k }
  )

  // It tried (sampled) but swallowed the write error.
  assert.strictEqual(res.sampled, true)
  assert.ok(res.error || res.swallowed, 'should signal it swallowed an error')
})

// ---------------------------------------------------------------------------
// runAgent receiving a malformed/throwing call still does not throw to caller
// ---------------------------------------------------------------------------

test('synchronously-throwing runAgent is caught (never throws to caller)', async () => {
  const outDir = makeTempDir()
  const k = 5
  const taskId = findSampledTaskId(k)
  const throwingRun = () => { throw new Error('sync throw before promise') }

  const res = await maybeShadowRun(
    {
      agentName: 'VAULT',
      taskId,
      model: 'claude-sonnet-4-6',
      systemPrompt: 'sys',
      userPrompt: 'usr',
      liveText: 'live',
      liveOk: true,
    },
    { _runAgent: throwingRun, _outDir: outDir, _sampleK: k }
  )

  assert.strictEqual(res.sampled, true)
  // diff.json should still be written with an error recorded.
  // Per-agent subdir: shadow-runs/<runKey>/<agentName>/
  const diffFile = path.join(outDir, taskId, 'VAULT', 'diff.json')
  assert.ok(fs.existsSync(diffFile))
  const diff = readJson(diffFile)
  assert.ok(diff.error, 'sync-throw must be recorded as an error')
  assert.strictEqual(diff.deltas.shadowOk, false)
})

// ---------------------------------------------------------------------------
// SHADOW_SAMPLE_K env default = 5 when no _sampleK injected
// ---------------------------------------------------------------------------

test('SHADOW_SAMPLE_K env controls K — pick a taskId that flips between env-K and default K=5', async () => {
  const outDir = makeTempDir()
  // Find a taskId whose sampling result DIFFERS between K=2 and K=5 (default).
  // If sampled(id, 2) !== sampled(id, 5), setting env K=2 must produce a different
  // outcome than what the default K=5 would give — proving env-K actually drives the decision.
  let diffTaskId = null
  for (let i = 0; i < 100000; i++) {
    const id = 'env-flip-task-' + i
    if (shouldSample(id, 2) !== shouldSample(id, 5)) {
      diffTaskId = id
      break
    }
  }
  assert.ok(diffTaskId, 'must find a taskId that differs between K=2 and K=5')

  // Determine what outcome we expect under K=2
  const expectedSampledUnderK2 = shouldSample(diffTaskId, 2)
  // And confirm it differs under K=5
  assert.notStrictEqual(expectedSampledUnderK2, shouldSample(diffTaskId, 5),
    'sanity: the two Ks must disagree for this taskId')

  const prev = process.env.SHADOW_SAMPLE_K
  process.env.SHADOW_SAMPLE_K = '2'
  try {
    const res = await maybeShadowRun(
      {
        agentName: 'TRACER',
        taskId: diffTaskId,
        model: 'claude-sonnet-4-6',
        systemPrompt: 'sys',
        userPrompt: 'usr',
        liveText: 'live',
        liveOk: true,
      },
      { _runAgent: makeFakeRunAgentOk(), _outDir: outDir } // no _sampleK → env K=2 drives it
    )
    assert.strictEqual(res.sampled, expectedSampledUnderK2,
      `env K=2 should give sampled=${expectedSampledUnderK2} for this taskId`)
  } finally {
    if (prev === undefined) delete process.env.SHADOW_SAMPLE_K
    else process.env.SHADOW_SAMPLE_K = prev
  }
})

// ---------------------------------------------------------------------------
// Fix 1: per-agent paths — two agents, same taskId, no clobber
// ---------------------------------------------------------------------------

test('two agents same taskId each write to their own subdir (no clobber)', async () => {
  const outDir = makeTempDir()
  const k = 5
  const taskId = findSampledTaskId(k)
  const fakeRunA = makeFakeRunAgentOk('output from SCOUT')
  const fakeRunB = makeFakeRunAgentOk('output from RELAY')

  // Both share the same taskId but have different agentNames.
  const [resA, resB] = await Promise.all([
    maybeShadowRun(
      { agentName: 'SCOUT', taskId, model: 'claude-sonnet-4-6', systemPrompt: 'sys', userPrompt: 'usr', liveText: 'live', liveOk: true },
      { _runAgent: fakeRunA, _outDir: outDir, _sampleK: k }
    ),
    maybeShadowRun(
      { agentName: 'RELAY', taskId, model: 'claude-sonnet-4-6', systemPrompt: 'sys', userPrompt: 'usr', liveText: 'live', liveOk: true },
      { _runAgent: fakeRunB, _outDir: outDir, _sampleK: k }
    ),
  ])

  assert.strictEqual(resA.sampled, true)
  assert.strictEqual(resB.sampled, true)

  // Each agent must have its own subdir with both artifacts.
  const scoutOutput = path.join(outDir, taskId, 'SCOUT', 'shadow-output.json')
  const scoutDiff   = path.join(outDir, taskId, 'SCOUT', 'diff.json')
  const relayOutput = path.join(outDir, taskId, 'RELAY', 'shadow-output.json')
  const relayDiff   = path.join(outDir, taskId, 'RELAY', 'diff.json')

  assert.ok(fs.existsSync(scoutOutput), 'SCOUT shadow-output.json must exist')
  assert.ok(fs.existsSync(scoutDiff),   'SCOUT diff.json must exist')
  assert.ok(fs.existsSync(relayOutput), 'RELAY shadow-output.json must exist')
  assert.ok(fs.existsSync(relayDiff),   'RELAY diff.json must exist')

  // Verify content is not cross-contaminated.
  assert.strictEqual(readJson(scoutOutput).text, 'output from SCOUT')
  assert.strictEqual(readJson(relayOutput).text, 'output from RELAY')
  assert.strictEqual(readJson(scoutDiff).agentName, 'SCOUT')
  assert.strictEqual(readJson(relayDiff).agentName, 'RELAY')
})

// ---------------------------------------------------------------------------
// Fix 2: TTL prune-on-write removes expired run dirs
// ---------------------------------------------------------------------------

test('TTL prune-on-write removes old run dirs and keeps new artifacts', async () => {
  const outDir = makeTempDir()
  const k = 5
  const taskId = findSampledTaskId(k)

  // Create a fake old run dir and backdate its mtime past TTL.
  const oldRunDir = path.join(outDir, 'old-run-to-prune')
  fs.mkdirSync(oldRunDir, { recursive: true })
  // Set mtime to 15 days ago (> default 14d TTL).
  const fifteenDaysAgo = new Date(Date.now() - 15 * 24 * 60 * 60 * 1000)
  fs.utimesSync(oldRunDir, fifteenDaysAgo, fifteenDaysAgo)

  assert.ok(fs.existsSync(oldRunDir), 'old dir should exist before run')

  // Run a sampled call — should prune the old dir and write new artifacts.
  const res = await maybeShadowRun(
    { agentName: 'KEYRING', taskId, model: 'claude-sonnet-4-6', systemPrompt: 'sys', userPrompt: 'usr', liveText: 'live', liveOk: true },
    { _runAgent: makeFakeRunAgentOk('prune test output'), _outDir: outDir, _sampleK: k }
  )

  assert.strictEqual(res.sampled, true)
  // Old dir must be gone.
  assert.ok(!fs.existsSync(oldRunDir), 'old run dir must be pruned')
  // New artifacts must be present.
  const newOutput = path.join(outDir, taskId, 'KEYRING', 'shadow-output.json')
  const newDiff   = path.join(outDir, taskId, 'KEYRING', 'diff.json')
  assert.ok(fs.existsSync(newOutput), 'new shadow-output.json must exist after prune')
  assert.ok(fs.existsSync(newDiff),   'new diff.json must exist after prune')
})
