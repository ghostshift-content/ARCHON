#!/usr/bin/env node
// Unit tests for /root/agents/grader.js — hybrid grader.
// Run: node /root/agents/test/grader.test.js
//
// These tests do NOT hit the Anthropic API. They verify the pure-function pieces:
//   - config loading + rollback flag
//   - evidence_quote substring verification (hallucination guard)
//   - refineWithLLM respects rollback_mode and returns disabled result
//   - refineWithLLM filters passed/skipped/short entries
//   - applySeverityMultiplier integrates with target-profile
//   - grade tool schema has all required fields
//
// End-to-end LLM calls are NOT tested here (require real API key + cost). They
// are validated in staging by running a real pentest task.

const assert = require('assert')
const fs = require('fs')
const grader = require('../src/grading/grader')

let failures = 0
let passed = 0
function test(name, fn) {
  try {
    fn()
    console.log(`  ✓ ${name}`)
    passed++
  } catch (e) {
    console.log(`  ✗ ${name}`)
    console.log(`    ${e.stack || e.message}`)
    failures++
  }
}
async function testAsync(name, fn) {
  try {
    await fn()
    console.log(`  ✓ ${name}`)
    passed++
  } catch (e) {
    console.log(`  ✗ ${name}`)
    console.log(`    ${e.stack || e.message}`)
    failures++
  }
}

(async () => {
  console.log('grader tests:')

  grader.resetCache()

  test('config loads + has enabled flag + rollback_mode', () => {
    const cfg = grader.loadConfig()
    assert.ok(cfg, 'config must load')
    assert.ok('enabled' in cfg, 'enabled flag must exist')
    assert.ok('rollback_mode' in cfg, 'rollback_mode must exist')
    assert.ok(cfg.llm_fallback, 'llm_fallback section required')
    assert.ok(cfg.squad_grading_notes._default, '_default grading notes required')
  })

  test('GRADE_TOOL schema has required fields', () => {
    const t = grader.GRADE_TOOL
    assert.strictEqual(t.name, 'grade_expectation')
    for (const f of ['passed', 'confidence', 'evidence_quote', 'reason']) {
      assert.ok(t.input_schema.properties[f], `missing schema property: ${f}`)
      assert.ok(t.input_schema.required.includes(f), `'${f}' must be required`)
    }
  })

  test('verifyEvidenceQuote rejects when quote not in activity', () => {
    const activity = 'The server responded with 500 Internal Server Error.'
    assert.strictEqual(grader.verifyEvidenceQuote('200 OK', activity), false)
  })

  test('verifyEvidenceQuote accepts literal substring match', () => {
    const activity = "Found SQL injection at /api/users?id=1 using payload ' OR 1=1 --"
    assert.strictEqual(grader.verifyEvidenceQuote('SQL injection at /api/users', activity), true)
  })

  test('verifyEvidenceQuote is case-insensitive + whitespace-tolerant', () => {
    const activity = 'Detected\t XSS  in \n search field'
    assert.strictEqual(grader.verifyEvidenceQuote('detected xss in search field', activity), true)
  })

  test('verifyEvidenceQuote rejects quotes under 10 chars', () => {
    const activity = 'some evidence of an issue here'
    assert.strictEqual(grader.verifyEvidenceQuote('some', activity), false)
  })

  test('verifyEvidenceQuote handles null/empty inputs', () => {
    assert.strictEqual(grader.verifyEvidenceQuote(null, 'x'), false)
    assert.strictEqual(grader.verifyEvidenceQuote('', 'x'), false)
    assert.strictEqual(grader.verifyEvidenceQuote('abc def ghij', ''), false)
    assert.strictEqual(grader.verifyEvidenceQuote('abc def ghij', null), false)
  })

  await testAsync('refineWithLLM returns disabled when rollback_mode=regex-only', async () => {
    // Temporarily patch config on disk
    const cfgPath = grader.CONFIG_PATH
    const original = fs.readFileSync(cfgPath, 'utf-8')
    try {
      const raw = JSON.parse(original)
      raw.rollback_mode = 'regex-only'
      fs.writeFileSync(cfgPath, JSON.stringify(raw))
      grader.resetCache()
      const out = await grader.refineWithLLM(
        [{ text: 'expectation text that is long enough to qualify for refinement', passed: false, matchRate: 0 }],
        'some activity evidence that is long enough to be meaningful for grading purposes here',
        { squad: 'pentest', taskId: 'test-t1' }
      )
      assert.strictEqual(out.disabled, true)
      assert.strictEqual(out.llmRefined, 0)
    } finally {
      fs.writeFileSync(cfgPath, original)
      grader.resetCache()
    }
  })

  await testAsync('refineWithLLM returns empty when nothing to refine', async () => {
    const out = await grader.refineWithLLM(
      [
        { text: 'already passed', passed: true, matchRate: 100 },
        { text: 'skipped', passed: true, skipped: true },
      ],
      'activity '.repeat(50),
      { squad: 'pentest' }
    )
    assert.strictEqual(out.llmRefined, 0)
    assert.strictEqual(out.reason, 'nothing-to-refine')
  })

  await testAsync('refineWithLLM respects min_expectation_length (short expectations skipped)', async () => {
    const out = await grader.refineWithLLM(
      [{ text: 'short', passed: false, matchRate: 0 }],
      'activity '.repeat(50),
      { squad: 'pentest' }
    )
    assert.strictEqual(out.llmRefined, 0)
    assert.strictEqual(out.reason, 'nothing-to-refine')
  })

  await testAsync('refineWithLLM returns insufficient-evidence when activity too short', async () => {
    const out = await grader.refineWithLLM(
      [{ text: 'expectation text long enough to qualify for refinement', passed: false, matchRate: 0 }],
      'short',
      { squad: 'pentest' }
    )
    assert.strictEqual(out.reason, 'insufficient-evidence')
    assert.strictEqual(out.llmRefined, 0)
  })

  test('applySeverityMultiplier returns 1.0 when no profile exists', () => {
    const out = grader.applySeverityMultiplier(75, 'nonexistent-task-' + Date.now())
    assert.strictEqual(out.multiplier, 1.0)
    assert.strictEqual(out.adjusted, 75)
  })

  test('applySeverityMultiplier applies profile multiplier when profile exists', () => {
    // Write a fintech/prod profile
    const tc = require('../src/routing/target-classifier')
    const testTask = 'grader-test-' + Date.now()
    const profile = tc.classify({ userHints: { environment: 'prod', domain: 'fintech' } })
    tc.saveProfile(testTask, profile)
    try {
      const out = grader.applySeverityMultiplier(50, testTask)
      assert.ok(out.multiplier > 1.0, `expected fintech/prod > 1.0, got ${out.multiplier}`)
      assert.ok(out.adjusted > 50, 'adjusted should be higher than raw')
    } finally {
      try { fs.unlinkSync(tc.profilePath(testTask)) } catch {}
    }
  })

  test('applySeverityMultiplier respects floor/ceiling', () => {
    // Config has floor=0.3, ceiling=1.5 — verify results bounded
    const tc = require('../src/routing/target-classifier')
    const testTask = 'grader-test-bounds-' + Date.now()
    const profile = tc.classify({ userHints: { environment: 'sandbox', domain: 'marketing' } })
    tc.saveProfile(testTask, profile)
    try {
      const out = grader.applySeverityMultiplier(100, testTask)
      assert.ok(out.multiplier >= 0.3, `multiplier ${out.multiplier} below floor`)
      assert.ok(out.multiplier <= 1.5, `multiplier ${out.multiplier} above ceiling`)
    } finally {
      try { fs.unlinkSync(tc.profilePath(testTask)) } catch {}
    }
  })

  test('buildRefinerPrompt includes squad grading notes', () => {
    const prompt = grader.buildRefinerPrompt(
      'Find SQL injection vulnerabilities',
      'evidence body here...',
      'pentest',
      ''
    )
    assert.ok(prompt.includes('pentest') || prompt.includes('concrete HTTP request'),
      'prompt must include pentest-specific grading notes')
    assert.ok(prompt.includes('grade_expectation'), 'prompt must mention tool name')
    assert.ok(prompt.includes('LITERAL'), 'prompt must require literal quote')
  })

  test('buildRefinerPrompt falls back to _default for unknown squad', () => {
    const prompt = grader.buildRefinerPrompt(
      'Some expectation',
      'evidence',
      'nonexistent-squad',
      ''
    )
    // Should include _default notes
    assert.ok(prompt.includes('concrete, verifiable evidence'),
      'prompt must include _default grading notes for unknown squad')
  })

  // ── Batch API tests (Anthropic Batches — 50% cost reduction) ──────────
  // These mock the SDK client so no real API is hit. We set ANTHROPIC_API_KEY
  // to a dummy value so the key-check doesn't short-circuit, then install a
  // test client via _setClientForTests.

  function makeMockClient({ onCreate, onRetrieve, onResults, onCancel } = {}) {
    const calls = { create: 0, retrieve: 0, results: 0, cancel: 0 }
    const client = {
      messages: {
        create: async () => { throw new Error('messages.create not stubbed in this mock') },
        batches: {
          create: async (body) => { calls.create++; return onCreate ? onCreate(body) : { id: 'b1', processing_status: 'ended', request_counts: { succeeded: (body.requests || []).length } } },
          retrieve: async (id) => { calls.retrieve++; return onRetrieve ? onRetrieve(id) : { id, processing_status: 'ended', request_counts: { succeeded: 0 } } },
          results: async (id) => {
            calls.results++
            const items = onResults ? onResults(id) : []
            // Return an async-iterable that the grader can `for await` over
            return {
              [Symbol.asyncIterator]: async function* () { for (const it of items) yield it },
            }
          },
          cancel: async (id) => { calls.cancel++; return onCancel ? onCancel(id) : { id, processing_status: 'canceling' } },
        },
      },
    }
    return { client, calls }
  }

  // Helper: set env API key (bypasses anthropic-key.getAnthropicApiKey null-return)
  // and reset anthropic-key cache so the new env value is picked up.
  function withTestApiKey(fn) {
    const prev = process.env.ANTHROPIC_API_KEY
    process.env.ANTHROPIC_API_KEY = 'sk-ant-test-key-for-mock'
    try { require('../src/integrations/anthropic-key').resetCache() } catch {}
    return Promise.resolve(fn()).finally(() => {
      if (prev === undefined) delete process.env.ANTHROPIC_API_KEY
      else process.env.ANTHROPIC_API_KEY = prev
      try { require('../src/integrations/anthropic-key').resetCache() } catch {}
    })
  }

  // Patch config on disk (min_expectations_for_batch / use_batch_api) for a test, restore after.
  async function withPatchedConfig(patch, fn) {
    const cfgPath = grader.CONFIG_PATH
    const original = fs.readFileSync(cfgPath, 'utf-8')
    try {
      const raw = JSON.parse(original)
      raw.llm_fallback = { ...(raw.llm_fallback || {}), ...patch }
      fs.writeFileSync(cfgPath, JSON.stringify(raw))
      grader.resetCache()
      await fn()
    } finally {
      fs.writeFileSync(cfgPath, original)
      grader.resetCache()
    }
  }

  const longActivity = ('This is a representative activity log with enough body to clear the 100-char floor. '.repeat(5))
  const longExpectation = 'A detailed expectation that is comfortably longer than the 20-char minimum length.'
  const makeFailedExpectations = (n) => Array.from({ length: n }, (_, i) => ({
    text: `${longExpectation} Item #${i + 1}`, passed: false, matchRate: 0,
  }))

  await testAsync('batch API NOT called when expectations.length < min_expectations_for_batch', async () => {
    const { client, calls } = makeMockClient()
    grader._setClientForTests(client)
    try {
      await withPatchedConfig({ use_batch_api: true, min_expectations_for_batch: 3 }, async () => {
        await withTestApiKey(async () => {
          // Only 2 failed — below the 3-item batch threshold. Should go sync per-call path.
          // Sync path will attempt client.messages.create which our mock throws on → each returns llm-exception.
          // Key invariant: batches.create NEVER called.
          const out = await grader.refineWithLLM(
            makeFailedExpectations(2),
            longActivity,
            { squad: 'pentest' }
          )
          assert.strictEqual(calls.create, 0, `batches.create must not be called (got ${calls.create})`)
          assert.ok(out.expectations, 'result must include expectations array')
        })
      })
    } finally {
      grader._setClientForTests(null)
    }
  })

  await testAsync('batch API NOT called when use_batch_api=false', async () => {
    const { client, calls } = makeMockClient()
    grader._setClientForTests(client)
    try {
      await withPatchedConfig({ use_batch_api: false, min_expectations_for_batch: 3 }, async () => {
        await withTestApiKey(async () => {
          // 5 failed items — well above threshold, but flag is off → must take sync path.
          const out = await grader.refineWithLLM(
            makeFailedExpectations(5),
            longActivity,
            { squad: 'pentest' }
          )
          assert.strictEqual(calls.create, 0, `batches.create must not be called when use_batch_api=false (got ${calls.create})`)
          assert.ok(out.expectations, 'result must include expectations array')
        })
      })
    } finally {
      grader._setClientForTests(null)
    }
  })

  await testAsync('batch response parsing handles errored results (per-item errors dont crash)', async () => {
    const evidenceQuote = longActivity.slice(0, 80) // valid literal substring → hallucination guard passes
    const { client, calls } = makeMockClient({
      onCreate: () => ({ id: 'b-mixed', processing_status: 'ended', request_counts: { succeeded: 2, errored: 1 } }),
      onRetrieve: (id) => ({ id, processing_status: 'ended' }),
      onResults: () => [
        // exp_0 → errored (per-item failure should be annotated, not crash)
        { custom_id: 'exp_0', result: { type: 'errored', error: { error: { message: 'invalid_request' } } } },
        // exp_1 → succeeded PASS with valid literal quote
        {
          custom_id: 'exp_1',
          result: {
            type: 'succeeded',
            message: {
              content: [{ type: 'tool_use', name: 'grade_expectation', input: {
                passed: true, confidence: 0.9, evidence_quote: evidenceQuote, reason: 'solid evidence',
              } }],
              usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 500, cache_creation_input_tokens: 0 },
            },
          },
        },
        // exp_2 → succeeded FAIL (LLM agreed with regex)
        {
          custom_id: 'exp_2',
          result: {
            type: 'succeeded',
            message: {
              content: [{ type: 'tool_use', name: 'grade_expectation', input: {
                passed: false, confidence: 0.8, evidence_quote: '', reason: 'no evidence',
              } }],
              usage: { input_tokens: 90, output_tokens: 15 },
            },
          },
        },
      ],
    })
    grader._setClientForTests(client)
    try {
      await withPatchedConfig({ use_batch_api: true, min_expectations_for_batch: 3 }, async () => {
        await withTestApiKey(async () => {
          const out = await grader.refineWithLLMBatch(
            makeFailedExpectations(3),
            longActivity,
            { squad: 'pentest' }
          )
          assert.strictEqual(calls.create, 1, 'batches.create called exactly once')
          assert.strictEqual(calls.results, 1, 'batches.results called exactly once')
          assert.strictEqual(out.llmRefined, 1, `expected 1 refinement (exp_1), got ${out.llmRefined}`)
          // exp_0 → errored annotation
          assert.strictEqual(out.expectations[0].source, 'llm-batch-errored', `exp_0 source=${out.expectations[0].source}`)
          // exp_1 → passed via LLM
          assert.strictEqual(out.expectations[1].passed, true)
          assert.strictEqual(out.expectations[1].source, 'llm')
          // exp_2 → LLM reviewed but FAIL
          assert.strictEqual(out.expectations[2].refined, true)
          // batchCost accumulated
          assert.ok(out.batchCost, 'batchCost should be populated')
          assert.strictEqual(out.batchCost.cache_read_tokens, 500)
        })
      })
    } finally {
      grader._setClientForTests(null)
    }
  })

  await testAsync('timeout path — wait exceeds batch_max_wait_seconds → falls back to per-call', async () => {
    const { client, calls } = makeMockClient({
      onCreate: () => ({ id: 'b-slow', processing_status: 'in_progress', request_counts: { succeeded: 0 } }),
      // Always returns in_progress — will trigger timeout.
      onRetrieve: (id) => ({ id, processing_status: 'in_progress', request_counts: { succeeded: 0 } }),
    })
    // Also stub client.messages.create so the fallback sync path doesn't crash on the mock.
    client.messages.create = async () => ({
      content: [{ type: 'tool_use', name: 'grade_expectation', input: {
        passed: false, confidence: 0.5, evidence_quote: '', reason: 'sync fallback',
      } }],
      usage: { input_tokens: 10, output_tokens: 5 },
    })
    grader._setClientForTests(client)
    try {
      // Force timeout by setting batch_max_wait_seconds to 0 — first poll-iteration timeout check fires immediately.
      await withPatchedConfig({
        use_batch_api: true, min_expectations_for_batch: 3, batch_max_wait_seconds: 0,
      }, async () => {
        await withTestApiKey(async () => {
          const out = await grader.refineWithLLMBatch(
            makeFailedExpectations(3),
            longActivity,
            { squad: 'pentest' }
          )
          assert.strictEqual(calls.create, 1, 'batches.create called once')
          assert.strictEqual(calls.cancel, 1, 'timeout must trigger cancel (best-effort)')
          // Fell back to sync path — result should be well-formed expectations, not a throw.
          assert.ok(Array.isArray(out.expectations), 'expectations must be array after fallback')
          assert.strictEqual(out.expectations.length, 3)
        })
      })
    } finally {
      grader._setClientForTests(null)
    }
  })

  // ── _refineViaCLIInner via AgentRunner port (DI seam: opts._runAgent) ──
  // These verify the migrated grader CLI refiner maps adapter results/throws
  // to the same envelopes the old spawn path used — no real claude spawn.
  const _cliCfg = { llm_fallback: { model_alias: 'fast', timeout_ms: 45000, min_evidence_quote_length: 15, require_evidence_quote: true } }
  const _cliActivity = 'Found SQL injection at /api/users?id=1 returning the full users table dump in the response body.'

  await testAsync('_refineViaCLIInner: adapter success → llm pass with valid evidence_quote', async () => {
    const fakeRunAgent = async () => ({
      text: JSON.stringify({ passed: true, confidence: 0.9, evidence_quote: 'SQL injection at /api/users', reason: 'confirmed' }),
    })
    const out = await grader._refineViaCLIInner('exp', _cliActivity, 'pentest', '', _cliCfg, { _runAgent: fakeRunAgent })
    assert.strictEqual(out.source, 'llm')
    assert.strictEqual(out.passed, true)
    assert.strictEqual(out.evidence_quote, 'SQL injection at /api/users')
  })

  await testAsync('_refineViaCLIInner: hallucinated quote → fail (defense intact)', async () => {
    const fakeRunAgent = async () => ({
      text: JSON.stringify({ passed: true, confidence: 0.9, evidence_quote: 'totally fabricated evidence string', reason: 'x' }),
    })
    const out = await grader._refineViaCLIInner('exp', _cliActivity, 'pentest', '', _cliCfg, { _runAgent: fakeRunAgent })
    assert.strictEqual(out.source, 'llm-cli')
    assert.strictEqual(out.passed, false)
    assert.ok(/hallucinated/.test(out.reason))
  })

  await testAsync('_refineViaCLIInner: adapter throw "timed out" → llm-cli-timeout envelope', async () => {
    const fakeRunAgent = async () => { throw new Error('[cli][GRADER] timed out after 45000ms') }
    const out = await grader._refineViaCLIInner('exp', _cliActivity, 'pentest', '', _cliCfg, { _runAgent: fakeRunAgent })
    assert.strictEqual(out.source, 'llm-cli-timeout')
    assert.strictEqual(out.passed, false)
  })

  await testAsync('_refineViaCLIInner: adapter throw (non-timeout) → llm-cli-error envelope', async () => {
    const fakeRunAgent = async () => { throw new Error('[cli][GRADER] claude exited with non-zero code 1') }
    const out = await grader._refineViaCLIInner('exp', _cliActivity, 'pentest', '', _cliCfg, { _runAgent: fakeRunAgent })
    assert.strictEqual(out.source, 'llm-cli-error')
    assert.strictEqual(out.passed, false)
  })

  await testAsync('_refineViaCLIInner: no JSON in reply → llm-cli-parse-fail envelope', async () => {
    const fakeRunAgent = async () => ({ text: 'I refuse to answer in JSON.' })
    const out = await grader._refineViaCLIInner('exp', _cliActivity, 'pentest', '', _cliCfg, { _runAgent: fakeRunAgent })
    assert.strictEqual(out.source, 'llm-cli-parse-fail')
    assert.strictEqual(out.passed, false)
  })

  console.log(`\n${passed} passed, ${failures} failed`)
  process.exit(failures > 0 ? 1 : 0)
})()
