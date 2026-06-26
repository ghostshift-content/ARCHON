// test/run-agent-bridge.test.js
// Unit tests for the legacy shape translator (run-agent-bridge.js).
// Run: bun test test/run-agent-bridge.test.js  (or: node --test)
//
// Offline. The bridge is exercised via the _runAgent DI; the adapter
// abortController tests use the real adapters with DI'd spawn/query so we
// verify the abort plumbing added to cli.js + sdk.js in T7.

'use strict'

const assert = require('node:assert')
const { test } = require('node:test')

const { bridgeSpawnAgent, costFromEnvelope, buildSyntheticEnvelope } = require('../agents/runner/run-agent-bridge')
// REAL quota-manager — integration-assert the rate-limit regex fires on our output.
const quotaManager = require('../src/integrations/quota-manager')

// ---------------------------------------------------------------------------
// Fake runAgent factories
// ---------------------------------------------------------------------------

// SDK-shaped success: raw.result carries REAL total_cost_usd + modelUsage.
function makeOkRunAgent(text = 'hello', cost = 0.0042) {
  return async function fakeRunAgent(_spec) {
    return {
      text,
      usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 20 },
      model: 'claude-sonnet-4-6',
      raw: {
        result: {
          type: 'result',
          subtype: 'success',
          total_cost_usd: cost,
          usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 20 },
          modelUsage: { 'claude-sonnet-4-6': { inputTokens: 100, outputTokens: 50, costUSD: cost } },
        },
        apiKeySource: 'oauth',
      },
    }
  }
}

// cli-shaped success: raw is the original envelope STRING.
function makeOkRunAgentCliRaw(text = 'cli text', cost = 0.0011) {
  const envelope = JSON.stringify({
    type: 'result',
    subtype: 'success',
    is_error: false,
    result: text,
    usage: { input_tokens: 7, output_tokens: 3 },
    modelUsage: { 'claude-haiku-4-5': { inputTokens: 7, outputTokens: 3, costUSD: cost } },
    total_cost_usd: cost,
  })
  return async function fakeRunAgent(_spec) {
    return { text, usage: { input_tokens: 7, output_tokens: 3 }, model: 'claude-haiku-4-5', raw: envelope }
  }
}

function makeRejectRunAgent(message) {
  return async function fakeRunAgent(_spec) { throw new Error(message) }
}

// A fake that hangs until the bridge's abortController fires, then rejects with
// an 'aborted' message — models the real adapter's external-abort behavior.
function makeAbortableRunAgent() {
  return function fakeRunAgent(spec) {
    return new Promise((_, reject) => {
      const ac = spec.abortController
      if (ac) {
        if (ac.signal.aborted) return reject(new Error('[fake] aborted'))
        ac.signal.addEventListener('abort', () => reject(new Error('[fake] aborted')), { once: true })
      }
      // never resolves on its own
    })
  }
}

// ---------------------------------------------------------------------------
// 1. Success → synthetic envelope with REAL numbers (calculateCost-compatible)
// ---------------------------------------------------------------------------

test('success → output JSON-parses to a CLI envelope with REAL cost numbers; code 0', async () => {
  const res = await bridgeSpawnAgent(
    { agentName: 'ARJUN', taskId: 't1', model: 'claude-sonnet-4-6', userPrompt: 'hi' },
    { _runAgent: makeOkRunAgent('the answer', 0.0042) }
  )
  assert.strictEqual(res.code, 0)
  assert.strictEqual(res.model, 'claude-sonnet-4-6')

  const env = JSON.parse(res.output)
  // The SAME field expectations calculateCost (event-bus.js:2063-2091) has:
  assert.strictEqual(env.type, 'result')
  assert.strictEqual(env.total_cost_usd, 0.0042)             // REAL, not zero
  assert.strictEqual(env.usage.input_tokens, 100)
  assert.ok(env.modelUsage['claude-sonnet-4-6'])             // model is a modelUsage KEY
  assert.strictEqual(env.result, 'the answer')
})

test('success cost matches what calculateCost(output) would produce', async () => {
  const res = await bridgeSpawnAgent(
    { agentName: 'A', userPrompt: 'hi' },
    { _runAgent: makeOkRunAgent('x', 0.05) }
  )
  // cost recomputed from the synthetic envelope = same logic calculateCost uses.
  const recomputed = costFromEnvelope(JSON.parse(res.output))
  assert.deepStrictEqual(res.cost, recomputed)
  assert.strictEqual(res.cost.totalCost, 0.05)
  assert.strictEqual(res.cost.model, 'claude-sonnet-4-6')
})

test('success via cli-shaped raw STRING carries the real envelope numbers through', async () => {
  const res = await bridgeSpawnAgent(
    { agentName: 'A', userPrompt: 'hi' },
    { _runAgent: makeOkRunAgentCliRaw('cli body', 0.0011) }
  )
  assert.strictEqual(res.code, 0)
  const env = JSON.parse(res.output)
  assert.strictEqual(env.total_cost_usd, 0.0011)
  assert.ok(env.modelUsage['claude-haiku-4-5'])
  assert.strictEqual(res.cost.totalCost, 0.0011)
})

// ---------------------------------------------------------------------------
// 2. Timeout → code 143, empty output
// ---------------------------------------------------------------------------

test("timeout throw ('timed out') → code 143, output ''", async () => {
  const res = await bridgeSpawnAgent(
    { agentName: 'A', model: 'm', userPrompt: 'hi' },
    { _runAgent: makeRejectRunAgent('[sdk][A] timed out after 50ms') }
  )
  assert.strictEqual(res.code, 143)
  assert.strictEqual(res.output, '')
  assert.strictEqual(res.cost, null)
  assert.strictEqual(res.model, 'm')
  assert.match(res.error, /timed out/)
})

// ---------------------------------------------------------------------------
// 3. Rate-limit throw → code 2, message in output, real quotaManager regex fires
// ---------------------------------------------------------------------------

test('rate-limit throw → code 2, output contains message, quotaManager.isRateLimitError fires', async () => {
  const res = await bridgeSpawnAgent(
    { agentName: 'A', userPrompt: 'hi' },
    { _runAgent: makeRejectRunAgent('[sdk][A] assistant error: 429 rate limit exceeded') }
  )
  assert.strictEqual(res.code, 2)
  assert.match(res.output, /429 rate limit exceeded/)
  // Integration assert: the REAL daemon regex must actually trip on our output.
  assert.strictEqual(quotaManager.isRateLimitError(res.output), true)
})

// ---------------------------------------------------------------------------
// 4. Generic throw → code 2
// ---------------------------------------------------------------------------

test('generic throw → code 2, message in output (so spawnWithRetry can scan it)', async () => {
  const res = await bridgeSpawnAgent(
    { agentName: 'A', model: 'mm', userPrompt: 'hi' },
    { _runAgent: makeRejectRunAgent('boom something broke') }
  )
  assert.strictEqual(res.code, 2)
  assert.strictEqual(res.output, 'boom something broke')
  assert.strictEqual(res.cost, null)
  assert.strictEqual(res.model, 'mm')
  // A generic message must NOT trip the rate-limit regex.
  assert.strictEqual(quotaManager.isRateLimitError(res.output), false)
})

// ---------------------------------------------------------------------------
// 5. Kill handle: synchronous, mid-run kill → code 143, killed=true
// ---------------------------------------------------------------------------

test('onChildHandle is called SYNCHRONOUSLY before the run', async () => {
  let handleAtCallTime = null
  let calledSync = false
  // capture: by the time bridgeSpawnAgent returns its promise, the handle must
  // already have been delivered (synchronous, not on a microtask).
  const p = bridgeSpawnAgent(
    {
      agentName: 'A', userPrompt: 'hi',
      onChildHandle: (h) => { handleAtCallTime = h; calledSync = true },
    },
    { _runAgent: makeOkRunAgent() }
  )
  assert.strictEqual(calledSync, true, 'handle must be delivered synchronously')
  assert.ok(handleAtCallTime)
  assert.strictEqual(typeof handleAtCallTime.kill, 'function')
  assert.strictEqual(handleAtCallTime.pid, null)
  assert.strictEqual(handleAtCallTime.killed, false)
  await p
})

test('handle.kill() mid-run → resolves code 143, handle.killed=true', async () => {
  let handle = null
  const p = bridgeSpawnAgent(
    {
      agentName: 'A', model: 'mk', userPrompt: 'hi',
      onChildHandle: (h) => { handle = h },
    },
    { _runAgent: makeAbortableRunAgent() }
  )
  assert.ok(handle)
  // kill mid-run — the abortable fake rejects via the passed abortController.
  handle.kill('SIGTERM')
  const res = await p
  assert.strictEqual(res.code, 143)
  assert.strictEqual(res.output, '')
  assert.strictEqual(res.model, 'mk')
  assert.strictEqual(handle.killed, true)
})

// ---------------------------------------------------------------------------
// 6. NEVER rejects — even when the DI'd runAgent throws SYNCHRONOUSLY
// ---------------------------------------------------------------------------

test('never rejects: synchronously-throwing runAgent → resolves code 2', async () => {
  const res = await bridgeSpawnAgent(
    { agentName: 'A', userPrompt: 'hi' },
    { _runAgent: () => { throw new Error('synchronous explosion') } }
  )
  assert.strictEqual(res.code, 2)
  assert.match(res.output, /synchronous explosion/)
})

test('never rejects: a throwing onChildHandle does not break the run', async () => {
  const res = await bridgeSpawnAgent(
    { agentName: 'A', userPrompt: 'hi', onChildHandle: () => { throw new Error('cb boom') } },
    { _runAgent: makeOkRunAgent() }
  )
  assert.strictEqual(res.code, 0)
})

// ---------------------------------------------------------------------------
// 7. onProgress passthrough reaches the adapter spec
// ---------------------------------------------------------------------------

test('onProgress is passed through to the adapter spec', async () => {
  const fn = () => {}
  let seen = null
  await bridgeSpawnAgent(
    { agentName: 'A', userPrompt: 'hi', onProgress: fn },
    { _runAgent: async (spec) => { seen = spec; return (await makeOkRunAgent()()) } }
  )
  assert.strictEqual(seen.onProgress, fn)
  assert.ok(seen.abortController instanceof AbortController, 'abortController is plumbed to the adapter')
})

// ---------------------------------------------------------------------------
// 8. costFromEnvelope / buildSyntheticEnvelope unit edges
// ---------------------------------------------------------------------------

test('buildSyntheticEnvelope falls back to usage-derived modelUsage when raw is missing', () => {
  const env = buildSyntheticEnvelope({ text: 't', usage: { input_tokens: 5, output_tokens: 2 }, model: 'mX' })
  assert.strictEqual(env.total_cost_usd, 0)            // honest zero — no measured cost
  assert.ok(env.modelUsage['mX'])
  assert.strictEqual(env.modelUsage['mX'].inputTokens, 5)
})

test('costFromEnvelope returns null on a non-result envelope', () => {
  assert.strictEqual(costFromEnvelope({ type: 'assistant' }), null)
  assert.strictEqual(costFromEnvelope(null), null)
})

// ---------------------------------------------------------------------------
// 9. Adapter abortController plumbing — cli (real adapter, DI'd spawn)
// ---------------------------------------------------------------------------

test('cli adapter: external abort → group-kill attempted + descriptive throw', async () => {
  const cli = require('../agents/runner/adapters/cli')
  const { EventEmitter } = require('events')
  let killedPid = null
  const realKill = process.kill
  process.kill = (pid) => { killedPid = pid; return true } // capture, no real signal

  const ac = new AbortController()
  // fake spawn: a child that never closes on its own (models a hung CLI run).
  const fakeSpawn = () => {
    const child = new EventEmitter()
    child.stdout = new EventEmitter()
    child.stderr = new EventEmitter()
    child.pid = 4242
    return child
  }

  try {
    const p = cli.run({ agentName: 'A', userPrompt: 'hi', abortController: ac, _spawn: fakeSpawn })
    ac.abort()
    await assert.rejects(p, /aborted/)
    // The abort path must have attempted a process-group kill (negative pid).
    assert.strictEqual(killedPid, -4242)
  } finally {
    process.kill = realKill
  }
})

// ---------------------------------------------------------------------------
// 10. Adapter abortController plumbing — sdk (real adapter, DI'd query)
// ---------------------------------------------------------------------------

test('sdk adapter: external abort on a hanging stream → descriptive throw', async () => {
  const sdk = require('../agents/runner/adapters/sdk')
  const ac = new AbortController()
  // DI'd query: an async iterable that hangs forever (never yields a result).
  const hangingQuery = () => ({
    [Symbol.asyncIterator]() {
      return { next: () => new Promise(() => {}) } // never resolves
    },
    return: async () => ({ done: true, value: undefined }),
  })

  const p = sdk.run({
    agentName: 'A', userPrompt: 'hi', abortController: ac, _query: hangingQuery,
  })
  ac.abort()
  await assert.rejects(p, /aborted/)
})

test('sdk adapter: bridge over an aborting sdk run → code 143', async () => {
  // End-to-end: bridge → real sdk adapter (DI'd hanging query) → external abort → 143.
  const ac = new AbortController()
  const hangingQuery = () => ({
    [Symbol.asyncIterator]() { return { next: () => new Promise(() => {}) } },
    return: async () => ({ done: true, value: undefined }),
  })
  const sdk = require('../agents/runner/adapters/sdk')

  let handle = null
  const p = bridgeSpawnAgent(
    { agentName: 'A', model: 'mz', userPrompt: 'hi', onChildHandle: (h) => { handle = h } },
    { _runAgent: (spec) => sdk.run({ ...spec, _query: hangingQuery }) }
  )
  // The bridge's own abortController is the one passed into spec; kill() aborts it.
  handle.kill('SIGTERM')
  const res = await p
  assert.strictEqual(res.code, 143)
  assert.strictEqual(handle.killed, true)
})
