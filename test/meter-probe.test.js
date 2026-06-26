// test/meter-probe.test.js
// Unit tests for agents/runner/meter-probe.js
// Run: bun test test/meter-probe.test.js
//
// All tests are OFFLINE — no real LLM calls. Fake runAgent + temp dirs.

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
  return fs.mkdtempSync(path.join(os.tmpdir(), 'meter-probe-test-'))
}

function readJsonlLines(file) {
  if (!fs.existsSync(file)) return []
  const raw = fs.readFileSync(file, 'utf8').trim()
  if (!raw) return []
  return raw.split('\n').map((l) => JSON.parse(l))
}

// Fake runAgent that captures all received specs and resolves with a realistic ok response
function makeFakeRunAgentOk() {
  const capturedSpecs = []
  const fn = (spec) => {
    capturedSpecs.push(spec)
    return Promise.resolve({
      text: 'PROBE-OK',
      usage: {
        input_tokens: 10,
        output_tokens: 5,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
      model: 'claude-haiku-4-5-20251001',
      raw: {},
    })
  }
  fn.capturedSpecs = capturedSpecs
  return fn
}

// Fake runAgent that rejects (simulates adapter failure)
function fakeRunAgentFail() {
  return Promise.reject(new Error('simulated adapter failure'))
}

// ---------------------------------------------------------------------------
// Lazy-require meter-probe AFTER we can inject outDir
// ---------------------------------------------------------------------------

let meterProbe, collectUsageLedger, _setOutDir

function loadModule() {
  // Clear require cache so each test gets a fresh module if needed
  const modPath = require.resolve('../agents/runner/meter-probe')
  delete require.cache[modPath]
  const mod = require('../agents/runner/meter-probe')
  meterProbe = mod.meterProbe
  collectUsageLedger = mod.collectUsageLedger
  _setOutDir = mod._setOutDir
}

// ---------------------------------------------------------------------------
// Test 1: meterProbe writes 3 lines (cli ok, sdk ok, interactive stub)
//         AND assert probe INPUTS (what spec was sent to _runAgent)
// ---------------------------------------------------------------------------

test('meterProbe writes 3 lines with correct shapes AND asserts probe inputs', async () => {
  loadModule()
  const outDir = makeTempDir()
  _setOutDir(outDir)

  const fakeRunAgentOk = makeFakeRunAgentOk()
  await meterProbe({ _runAgent: fakeRunAgentOk })

  // --- assert probe INPUTS ---
  const specs = fakeRunAgentOk.capturedSpecs
  // Only cli and sdk call _runAgent (interactive is a stub, no call)
  assert.strictEqual(specs.length, 2, `Expected 2 _runAgent calls (cli+sdk), got ${specs.length}`)

  const adaptersInOrder = specs.map((s) => s.adapter)
  assert.deepStrictEqual(adaptersInOrder, ['cli', 'sdk'], 'adapters must be called in order: cli then sdk')

  for (const spec of specs) {
    assert.ok(
      spec.adapter === 'cli' || spec.adapter === 'sdk',
      `spec.adapter must be 'cli' or 'sdk', got '${spec.adapter}'`
    )
    assert.strictEqual(spec.model, 'claude-haiku-4-5-20251001', `spec.model should be haiku, got ${spec.model}`)
    assert.ok(
      typeof spec.userPrompt === 'string' && spec.userPrompt.includes('PROBE-OK'),
      `spec.userPrompt should contain 'PROBE-OK', got '${spec.userPrompt}'`
    )
    assert.strictEqual(spec.timeoutMs, 120000, `spec.timeoutMs should be 120000, got ${spec.timeoutMs}`)
    assert.strictEqual(spec.agentName, 'METER-PROBE', `spec.agentName should be 'METER-PROBE', got ${spec.agentName}`)
    assert.ok(spec.taskId, `spec.taskId should be set, got '${spec.taskId}'`)
  }

  // --- assert OUTPUT shapes ---
  const probeFile = path.join(outDir, 'billing-probe.jsonl')
  const lines = readJsonlLines(probeFile)

  assert.strictEqual(lines.length, 3, `Expected 3 lines, got ${lines.length}`)

  // --- cli line ---
  const cliLine = lines.find((l) => l.adapter === 'cli')
  assert.ok(cliLine, 'cli adapter line missing')
  assert.strictEqual(cliLine.ok, true, 'cli line should be ok')
  assert.strictEqual(cliLine.poolDrawn, 'capped-sdk', 'cli poolDrawn should be capped-sdk')
  assert.strictEqual(cliLine.basis, 'static-policy-mapping-2026-06')
  assert.ok(cliLine.ts, 'cli line should have ts')
  assert.ok(cliLine.model, 'cli line should have model')
  assert.ok(cliLine.tokens, 'cli line should have tokens')
  assert.strictEqual(typeof cliLine.tokens.input, 'number')
  assert.strictEqual(typeof cliLine.tokens.output, 'number')

  // --- sdk line ---
  const sdkLine = lines.find((l) => l.adapter === 'sdk')
  assert.ok(sdkLine, 'sdk adapter line missing')
  assert.strictEqual(sdkLine.ok, true, 'sdk line should be ok')
  assert.strictEqual(sdkLine.poolDrawn, 'capped-sdk', 'sdk poolDrawn should be capped-sdk')
  assert.strictEqual(sdkLine.basis, 'static-policy-mapping-2026-06')

  // --- interactive stub line ---
  const interactiveLine = lines.find((l) => l.adapter === 'interactive')
  assert.ok(interactiveLine, 'interactive stub line missing')
  assert.strictEqual(interactiveLine.ok, false, 'interactive line should be ok=false')
  assert.strictEqual(interactiveLine.poolDrawn, 'interactive')
  assert.strictEqual(interactiveLine.basis, 'static-policy-mapping-2026-06')
  assert.ok(interactiveLine.error, 'interactive line should have error field')
})

// ---------------------------------------------------------------------------
// Test 2: one adapter failure → its line has ok:false, other still ok:true
// ---------------------------------------------------------------------------

test('one adapter throwing records ok:false for that adapter, ok:true for the other', async () => {
  loadModule()
  const outDir = makeTempDir()
  _setOutDir(outDir)

  // First call (cli) ok, second call (sdk) fails
  let callCount = 0
  const capturedSpecs = []
  const mixedRunAgent = (spec) => {
    capturedSpecs.push(spec)
    callCount++
    if (callCount === 1) {
      return Promise.resolve({
        text: 'PROBE-OK',
        usage: { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
        model: 'claude-haiku-4-5-20251001',
        raw: {},
      })
    }
    return fakeRunAgentFail()                            // sdk
  }

  await meterProbe({ _runAgent: mixedRunAgent })

  const probeFile = path.join(outDir, 'billing-probe.jsonl')
  const lines = readJsonlLines(probeFile)

  assert.strictEqual(lines.length, 3)

  const cliLine = lines.find((l) => l.adapter === 'cli')
  assert.strictEqual(cliLine.ok, true, 'cli should succeed')

  const sdkLine = lines.find((l) => l.adapter === 'sdk')
  assert.strictEqual(sdkLine.ok, false, 'sdk should record failure')
  assert.ok(sdkLine.error, 'sdk failure line should have error field')
  assert.strictEqual(sdkLine.poolDrawn, 'unknown', 'failed sdk should use unknown poolDrawn')
})

// ---------------------------------------------------------------------------
// Test 3: poolDrawn mapping is correct
// ---------------------------------------------------------------------------

test('poolDrawn mapping: cli→capped-sdk, sdk→capped-sdk on success', async () => {
  loadModule()
  const outDir = makeTempDir()
  _setOutDir(outDir)

  const fakeRunAgentOk = makeFakeRunAgentOk()
  await meterProbe({ _runAgent: fakeRunAgentOk })

  const probeFile = path.join(outDir, 'billing-probe.jsonl')
  const lines = readJsonlLines(probeFile)

  const cliLine = lines.find((l) => l.adapter === 'cli')
  const sdkLine = lines.find((l) => l.adapter === 'sdk')

  assert.strictEqual(cliLine.poolDrawn, 'capped-sdk')
  assert.strictEqual(sdkLine.poolDrawn, 'capped-sdk')
})

// ---------------------------------------------------------------------------
// Test 4: ledger idempotency — two runs same day, same window → one snapshot line
// ---------------------------------------------------------------------------

test('collectUsageLedger is idempotent — same-day same-window double-run yields one line', async () => {
  loadModule()
  const outDir = makeTempDir()
  _setOutDir(outDir)

  // Create a minimal fixture ACTIVITY-LOG in outDir (relative timestamps for cutoff safety)
  const fixtureActivity = path.join(outDir, 'ACTIVITY-LOG.jsonl')
  const recentTs2 = (m) => new Date(Date.now() - m * 60 * 1000).toISOString()
  const sampleEvents = [
    { ts: recentTs2(30), agent: 'BHISHMA', type: 'cost', squad: 'stocks-squad', taskId: '111', details: 'Model: claude-sonnet-4-6\nTokens: 0\nTotal: $1.0000' },
    { ts: recentTs2(29), agent: 'ARJUN', type: 'cost', squad: 'pentest-squad', taskId: '222', details: 'Model: claude-sonnet-4-6\nTokens: 0\nTotal: $2.0000' },
  ]
  fs.writeFileSync(fixtureActivity, sampleEvents.map((e) => JSON.stringify(e)).join('\n') + '\n')

  await collectUsageLedger({ activityLogPath: fixtureActivity, windowDays: 1 })
  await collectUsageLedger({ activityLogPath: fixtureActivity, windowDays: 1 })

  const ledgerFile = path.join(outDir, 'usage-ledger.jsonl')
  const lines = readJsonlLines(ledgerFile)

  assert.strictEqual(lines.length, 1, `Expected 1 snapshot line (idempotent), got ${lines.length}`)
  assert.strictEqual(lines[0].kind, 'daily-snapshot')
  assert.strictEqual(lines[0].windowDays, 1)
})

// ---------------------------------------------------------------------------
// Test 4b: ledger idempotency — different windows coexist on the same day
// ---------------------------------------------------------------------------

test('collectUsageLedger — different windowDays coexist on same day', async () => {
  loadModule()
  const outDir = makeTempDir()
  _setOutDir(outDir)

  const fixtureActivity = path.join(outDir, 'ACTIVITY-LOG.jsonl')
  const recentTs3 = (m) => new Date(Date.now() - m * 60 * 1000).toISOString()
  const sampleEvents = [
    { ts: recentTs3(20), agent: 'BHISHMA', type: 'cost', squad: 'stocks-squad', taskId: '111', details: 'Model: claude-sonnet-4-6\nTokens: 0\nTotal: $1.0000' },
  ]
  fs.writeFileSync(fixtureActivity, sampleEvents.map((e) => JSON.stringify(e)).join('\n') + '\n')

  // Run windowDays=1 twice and windowDays=7 twice
  await collectUsageLedger({ activityLogPath: fixtureActivity, windowDays: 1 })
  await collectUsageLedger({ activityLogPath: fixtureActivity, windowDays: 7 })
  await collectUsageLedger({ activityLogPath: fixtureActivity, windowDays: 1 }) // duplicate — should be skipped
  await collectUsageLedger({ activityLogPath: fixtureActivity, windowDays: 7 }) // duplicate — should be skipped

  const ledgerFile = path.join(outDir, 'usage-ledger.jsonl')
  const lines = readJsonlLines(ledgerFile)

  // Expect exactly 2 lines: one for window=1, one for window=7
  assert.strictEqual(lines.length, 2, `Expected 2 snapshot lines (one per window), got ${lines.length}`)

  const win1 = lines.find((l) => l.windowDays === 1)
  const win7 = lines.find((l) => l.windowDays === 7)
  assert.ok(win1, 'windowDays=1 snapshot missing')
  assert.ok(win7, 'windowDays=7 snapshot missing')
  assert.strictEqual(win1.kind, 'daily-snapshot')
  assert.strictEqual(win7.kind, 'daily-snapshot')
})

// ---------------------------------------------------------------------------
// Test 5: ledger tallies fixture ACTIVITY-LOG correctly (perSquad + perAgent)
// ---------------------------------------------------------------------------

test('collectUsageLedger tallies costs per squad and per agent correctly', async () => {
  loadModule()
  const outDir = makeTempDir()
  _setOutDir(outDir)

  const fixtureActivity = path.join(outDir, 'ACTIVITY-LOG.jsonl')
  // Use relative timestamps (1h ago) so the 1-day cutoff window always includes them
  const recentTs = (offsetMinutes) => new Date(Date.now() - offsetMinutes * 60 * 1000).toISOString()
  const sampleEvents = [
    { ts: recentTs(60), agent: 'BHISHMA', type: 'cost', squad: 'stocks-squad', taskId: '111', details: 'Model: claude-sonnet-4-6\nTokens: 0\nTotal: $1.5000' },
    { ts: recentTs(59), agent: 'DRONA',   type: 'cost', squad: 'stocks-squad', taskId: '111', details: 'Model: claude-sonnet-4-6\nTokens: 0\nTotal: $0.5000' },
    { ts: recentTs(58), agent: 'ARJUN',   type: 'cost', squad: 'pentest-squad', taskId: '222', details: 'Model: claude-sonnet-4-6\nTokens: 0\nTotal: $3.2000' },
    // non-cost event, should not count
    { ts: recentTs(57), agent: 'SANJAY', type: 'dispatch', squad: 'stocks-squad', taskId: '111', details: '' },
  ]
  fs.writeFileSync(fixtureActivity, sampleEvents.map((e) => JSON.stringify(e)).join('\n') + '\n')

  await collectUsageLedger({ activityLogPath: fixtureActivity })

  const ledgerFile = path.join(outDir, 'usage-ledger.jsonl')
  const lines = readJsonlLines(ledgerFile)

  assert.strictEqual(lines.length, 1)
  const snap = lines[0]

  assert.strictEqual(snap.kind, 'daily-snapshot')
  assert.strictEqual(snap.windowDays, 1)
  assert.ok(snap.ts, 'snapshot must have ts')
  assert.ok(snap.perSquad, 'snapshot must have perSquad')
  assert.ok(snap.perAgent, 'snapshot must have perAgent')
  assert.ok(snap.totals, 'snapshot must have totals')
  assert.strictEqual(typeof snap.costData, 'boolean')
  assert.ok(snap.source, 'snapshot must have source')

  // Check squad tallies
  const stocksData = snap.perSquad['stocks-squad']
  assert.ok(stocksData, 'stocks-squad should be in perSquad')
  assert.strictEqual(stocksData.events, 2, 'stocks should have 2 cost events')
  assert.ok(Math.abs(stocksData.totalCostUSD - 2.0) < 0.001, `stocks cost should be ~$2.00, got ${stocksData.totalCostUSD}`)

  const pentestData = snap.perSquad['pentest-squad']
  assert.ok(pentestData, 'pentest-squad should be in perSquad')
  assert.strictEqual(pentestData.events, 1)
  assert.ok(Math.abs(pentestData.totalCostUSD - 3.2) < 0.001, `pentest cost should be ~$3.20, got ${pentestData.totalCostUSD}`)

  assert.ok(Math.abs(snap.totals.totalCostUSD - 5.2) < 0.001, `total cost should be ~$5.20, got ${snap.totals.totalCostUSD}`)
  assert.strictEqual(snap.costData, true)

  // Check agent tallies (perAgent)
  const bhishmaData = snap.perAgent['BHISHMA']
  assert.ok(bhishmaData, 'BHISHMA should be in perAgent')
  assert.strictEqual(bhishmaData.events, 1, 'BHISHMA should have 1 cost event')
  assert.ok(Math.abs(bhishmaData.totalCostUSD - 1.5) < 0.001, `BHISHMA cost should be ~$1.50, got ${bhishmaData.totalCostUSD}`)

  const dronaData = snap.perAgent['DRONA']
  assert.ok(dronaData, 'DRONA should be in perAgent')
  assert.strictEqual(dronaData.events, 1, 'DRONA should have 1 cost event')
  assert.ok(Math.abs(dronaData.totalCostUSD - 0.5) < 0.001, `DRONA cost should be ~$0.50, got ${dronaData.totalCostUSD}`)

  const arjunData = snap.perAgent['ARJUN']
  assert.ok(arjunData, 'ARJUN should be in perAgent')
  assert.strictEqual(arjunData.events, 1, 'ARJUN should have 1 cost event')
  assert.ok(Math.abs(arjunData.totalCostUSD - 3.2) < 0.001, `ARJUN cost should be ~$3.20, got ${arjunData.totalCostUSD}`)

  // SANJAY's dispatch event must NOT appear in perAgent (non-cost event)
  assert.ok(!snap.perAgent['SANJAY'], 'SANJAY dispatch event must not appear in perAgent')
})

// ---------------------------------------------------------------------------
// Test 6: both real adapters throw → returned lines both ok:false (exit-1 condition)
// ---------------------------------------------------------------------------

test('meterProbe — both adapters throw → returned lines both ok:false', async () => {
  loadModule()
  const outDir = makeTempDir()
  _setOutDir(outDir)

  // Both cli and sdk fail
  const allFailRunAgent = () => Promise.reject(new Error('both adapters down'))

  const writtenLines = await meterProbe({ _runAgent: allFailRunAgent })

  // meterProbe should still resolve (not throw) and return 3 lines
  assert.strictEqual(writtenLines.length, 3, `Expected 3 written lines, got ${writtenLines.length}`)

  // The real adapter lines (cli + sdk) should both be ok:false
  const realAdapters = writtenLines.filter((l) => l.adapter !== 'interactive')
  assert.strictEqual(realAdapters.length, 2, 'Expected 2 real adapter lines')
  assert.ok(
    realAdapters.every((l) => !l.ok),
    'Both real adapter lines must be ok:false when both throw'
  )

  // Verify the exit-1 condition fires on the return value
  assert.ok(
    realAdapters.every((l) => !l.ok),
    'exit-1 condition: realAdapters.every(l => !l.ok) must be true'
  )

  // Confirm lines were also written to the probe file
  const probeFile = path.join(outDir, 'billing-probe.jsonl')
  const fileLines = readJsonlLines(probeFile)
  assert.strictEqual(fileLines.length, 3, 'probe file should have 3 lines')
  const fileRealAdapters = fileLines.filter((l) => l.adapter !== 'interactive')
  assert.ok(fileRealAdapters.every((l) => !l.ok), 'file lines also reflect both failures')
})
