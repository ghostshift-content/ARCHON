// test/agent-runner.test.js
// Unit tests for AgentRunner port + CLI floor adapter
// Run: bun test test/agent-runner.test.js
//
// Tests do NOT call the real claude binary — the cli adapter accepts
// spec._spawn for dependency injection in tests.

'use strict'
const __roots = require('../paths') // portable roots (KURU_*_ROOT) — see paths.js


const assert = require('node:assert')
const { test } = require('node:test')

// ---------------------------------------------------------------------------
// Fake spawn factories
// ---------------------------------------------------------------------------

/**
 * Build a fake spawn that resolves with a realistic claude --output-format json
 * envelope. The real CLI does NOT emit a top-level `model` field — the model
 * name lives as the key inside `modelUsage`.
 * The `result` field is the text the agent returned.
 */
function makeOkSpawn(resultText = 'hello world') {
  const envelope = JSON.stringify({
    type: 'result',
    subtype: 'success',
    is_error: false,
    result: resultText,
    usage: { input_tokens: 10, output_tokens: 5 },
    modelUsage: { 'claude-sonnet-4-6': { inputTokens: 10, outputTokens: 5, costUSD: 0.001 } },
    total_cost_usd: 0.001,
  })
  return function fakeSpawn(_bin, _args, _opts) {
    const { EventEmitter } = require('events')
    const stdout = new EventEmitter()
    const stderr = new EventEmitter()
    const child = new EventEmitter()
    child.stdout = stdout
    child.stderr = stderr
    child.pid = 12345 // required for process.kill(-child.pid, ...) on timeout
    process.nextTick(() => {
      stdout.emit('data', Buffer.from(envelope))
      child.emit('close', 0)
    })
    return child
  }
}

/**
 * Build a fake spawn with a multi-key modelUsage (two models used).
 * The higher-costUSD model should be selected.
 */
function makeMultiModelSpawn(resultText = 'multi model result') {
  const envelope = JSON.stringify({
    type: 'result',
    subtype: 'success',
    is_error: false,
    result: resultText,
    usage: { input_tokens: 20, output_tokens: 10 },
    modelUsage: {
      'claude-haiku-4-6': { inputTokens: 5, outputTokens: 2, costUSD: 0.0001 },
      'claude-opus-4-8': { inputTokens: 15, outputTokens: 8, costUSD: 0.025 },
    },
    total_cost_usd: 0.0251,
  })
  return function fakeSpawn(_bin, _args, _opts) {
    const { EventEmitter } = require('events')
    const stdout = new EventEmitter()
    const stderr = new EventEmitter()
    const child = new EventEmitter()
    child.stdout = stdout
    child.stderr = stderr
    child.pid = 12345
    process.nextTick(() => {
      stdout.emit('data', Buffer.from(envelope))
      child.emit('close', 0)
    })
    return child
  }
}

/**
 * Fake spawn that NEVER emits 'close' — used for timeout path tests.
 */
function makeHangingSpawn() {
  return function fakeSpawn(_bin, _args, _opts) {
    const { EventEmitter } = require('events')
    const stdout = new EventEmitter()
    const stderr = new EventEmitter()
    const child = new EventEmitter()
    child.stdout = stdout
    child.stderr = stderr
    child.pid = 12345 // used for process.kill(-child.pid, ...) assertion
    // Intentionally never emits 'close'
    return child
  }
}

/**
 * Fake spawn that emits an is_error envelope.
 */
function makeIsErrorSpawn(errorText = 'something went wrong') {
  const envelope = JSON.stringify({
    type: 'result',
    result: errorText,
    is_error: true,
  })
  return function fakeSpawn(_bin, _args, _opts) {
    const { EventEmitter } = require('events')
    const stdout = new EventEmitter()
    const stderr = new EventEmitter()
    const child = new EventEmitter()
    child.stdout = stdout
    child.stderr = stderr
    child.pid = 12345
    process.nextTick(() => {
      stdout.emit('data', Buffer.from(envelope))
      child.emit('close', 0)
    })
    return child
  }
}

/**
 * Fake spawn that emits malformed (non-JSON) output and exits 0.
 */
function makeMalformedJsonSpawn() {
  return function fakeSpawn(_bin, _args, _opts) {
    const { EventEmitter } = require('events')
    const stdout = new EventEmitter()
    const stderr = new EventEmitter()
    const child = new EventEmitter()
    child.stdout = stdout
    child.stderr = stderr
    child.pid = 12345
    process.nextTick(() => {
      stdout.emit('data', Buffer.from('not json at all'))
      child.emit('close', 0)
    })
    return child
  }
}

/**
 * Fake spawn that exits with a nonzero code.
 */
function makeNonzeroExitSpawn(code = 1) {
  return function fakeSpawn(_bin, _args, _opts) {
    const { EventEmitter } = require('events')
    const stdout = new EventEmitter()
    const stderr = new EventEmitter()
    const child = new EventEmitter()
    child.stdout = stdout
    child.stderr = stderr
    child.pid = 12345
    process.nextTick(() => {
      stdout.emit('data', Buffer.from('partial output'))
      child.emit('close', code)
    })
    return child
  }
}

/**
 * Fake spawn that captures the env passed to it for inspection.
 */
function makeEnvCapturingSpawn(resultText = 'ok') {
  const envelope = JSON.stringify({
    type: 'result',
    subtype: 'success',
    is_error: false,
    result: resultText,
    usage: { input_tokens: 5, output_tokens: 5 },
    modelUsage: { 'claude-haiku-4-6': { inputTokens: 5, outputTokens: 5, costUSD: 0.0001 } },
    total_cost_usd: 0.0001,
  })
  let capturedEnv = null
  function fakeSpawn(_bin, _args, opts) {
    capturedEnv = opts && opts.env ? { ...opts.env } : null
    const { EventEmitter } = require('events')
    const stdout = new EventEmitter()
    const stderr = new EventEmitter()
    const child = new EventEmitter()
    child.stdout = stdout
    child.stderr = stderr
    child.pid = 12345
    process.nextTick(() => {
      stdout.emit('data', Buffer.from(envelope))
      child.emit('close', 0)
    })
    return child
  }
  fakeSpawn.getCapturedEnv = () => capturedEnv
  return fakeSpawn
}

// ---------------------------------------------------------------------------
// Load module under test
// ---------------------------------------------------------------------------

const { runAgent } = require('../agents/runner/agent-runner')

// ---------------------------------------------------------------------------
// Tests (node:test API — bun test picks these up and reports real counts)
// ---------------------------------------------------------------------------

test('returns structured object { text, usage, model, raw } on success', async () => {
  const result = await runAgent({
    userPrompt: 'Hello',
    adapter: 'cli', _spawn: makeOkSpawn('the answer'),
  })
  assert.strictEqual(typeof result, 'object', 'result should be an object')
  assert.strictEqual(typeof result.text, 'string', 'result.text should be a string')
  assert.strictEqual(result.text, 'the answer', 'result.text should equal envelope.result')
  assert.ok('usage' in result, 'result should have usage field')
  assert.ok('model' in result, 'result should have model field')
  assert.ok('raw' in result, 'result should have raw field')
  // Fix 1: model is extracted from modelUsage key, NOT a top-level `model` field
  assert.strictEqual(result.model, 'claude-sonnet-4-6',
    'model should be extracted from the modelUsage key in the envelope')
})

test('throws on is_error: true in envelope', async () => {
  await assert.rejects(
    () => runAgent({ userPrompt: 'Hello', adapter: 'cli', _spawn: makeIsErrorSpawn('API rate limit') }),
    (e) => {
      assert.ok(e.message.length > 0, 'error message should not be empty')
      return true
    }
  )
})

test('throws on malformed JSON output (never silent empty string)', async () => {
  await assert.rejects(
    () => runAgent({ userPrompt: 'Hello', adapter: 'cli', _spawn: makeMalformedJsonSpawn() }),
    (e) => {
      assert.ok(e.message.length > 0, 'error message should not be empty')
      return true
    }
  )
})

test('throws on nonzero exit code', async () => {
  await assert.rejects(
    () => runAgent({ userPrompt: 'Hello', adapter: 'cli', _spawn: makeNonzeroExitSpawn(1) }),
    (e) => {
      assert.ok(
        e.message.includes('exit') || e.message.includes('code') || e.message.includes('1'),
        `error should mention the exit code, got: ${e.message}`)
      return true
    }
  )
})

test('env passed to spawn contains no secret-bearing keys even when present in process.env', async () => {
  const origAws = process.env.AWS_SECRET_ACCESS_KEY
  const origGithub = process.env.GITHUB_TOKEN
  const origTelegram = process.env.TELEGRAM_BOT_TOKEN

  process.env.AWS_SECRET_ACCESS_KEY = 'fake-aws-secret'
  process.env.GITHUB_TOKEN = 'ghp_faketoken'
  process.env.TELEGRAM_BOT_TOKEN = 'tg-bot-fake'

  try {
    const capturingSpawn = makeEnvCapturingSpawn('ok')
    await runAgent({ userPrompt: 'Hello', adapter: 'cli', _spawn: capturingSpawn })
    const env = capturingSpawn.getCapturedEnv()
    assert.ok(env !== null, 'env should have been captured')

    const envKeys = Object.keys(env)

    // Fix 4: positive assertions — required allowlist keys must be present
    // so a refactor that blanks the env entirely would fail here.
    for (const required of ['HOME', 'PATH', 'TERM']) {
      assert.ok(
        envKeys.includes(required),
        `env must contain required allowlist key "${required}" but it was absent`)
    }

    const secretPatterns = [/^AWS_/, /^GITHUB_TOKEN$/, /^TELEGRAM/, /^GH_TOKEN$/]
    for (const pattern of secretPatterns) {
      const matching = envKeys.filter(k => pattern.test(k))
      assert.strictEqual(matching.length, 0,
        `env should not contain keys matching ${pattern} but found: ${matching.join(', ')}`)
    }
  } finally {
    if (origAws === undefined) delete process.env.AWS_SECRET_ACCESS_KEY
    else process.env.AWS_SECRET_ACCESS_KEY = origAws
    if (origGithub === undefined) delete process.env.GITHUB_TOKEN
    else process.env.GITHUB_TOKEN = origGithub
    if (origTelegram === undefined) delete process.env.TELEGRAM_BOT_TOKEN
    else process.env.TELEGRAM_BOT_TOKEN = origTelegram
  }
})

test('default adapter routes to sdk (no adapter spec — PURE-SDK cutover)', async () => {
  // No adapter specified and no ADAPTER env → must select sdk. We DI the sdk
  // path via _query; if the default were still cli this would hang/throw
  // because the sdk fake (_query) is never consumed by the cli adapter.
  const origAdapter = process.env.ADAPTER
  delete process.env.ADAPTER
  try {
    const result = await runAgent({
      userPrompt: 'Test default routing',
      _query: makeOkQuery('sdk route confirmed', 'claude-sonnet-4-6'),
    })
    assert.strictEqual(result.text, 'sdk route confirmed')
    assert.strictEqual(result.model, 'claude-sonnet-4-6',
      'default-routed run goes through the sdk adapter (model from modelUsage key)')
  } finally {
    if (origAdapter === undefined) delete process.env.ADAPTER
    else process.env.ADAPTER = origAdapter
  }
})

test('ADAPTER=cli env forces the cli rollback floor (no adapter spec)', async () => {
  // Rollback path verified: with ADAPTER=cli the cli adapter consumes _spawn.
  const origAdapter = process.env.ADAPTER
  process.env.ADAPTER = 'cli'
  try {
    const result = await runAgent({
      userPrompt: 'Test rollback routing',
      _spawn: makeOkSpawn('cli rollback confirmed'),
    })
    assert.strictEqual(result.text, 'cli rollback confirmed')
    // makeOkSpawn envelope carries claude-sonnet-4-6 as its modelUsage key.
    assert.strictEqual(result.model, 'claude-sonnet-4-6',
      'ADAPTER=cli routes through the cli adapter (rollback floor intact)')
  } finally {
    if (origAdapter === undefined) delete process.env.ADAPTER
    else process.env.ADAPTER = origAdapter
  }
})

test('unknown adapter name throws listing known adapters', async () => {
  await assert.rejects(
    () => runAgent({ userPrompt: 'Hello', adapter: 'does_not_exist_999' }),
    (e) => {
      assert.ok(
        e.message.includes('does_not_exist_999') || e.message.toLowerCase().includes('unknown'),
        `error should mention the bad adapter name, got: ${e.message}`)
      assert.ok(e.message.includes('cli'),
        `error should list known adapters (cli), got: ${e.message}`)
      return true
    }
  )
})

test('missing userPrompt throws immediately', async () => {
  await assert.rejects(
    () => runAgent({ agentName: 'TEST' }),
    (e) => {
      assert.ok(
        e.message.toLowerCase().includes('userprompt') ||
        e.message.toLowerCase().includes('user prompt') ||
        e.message.toLowerCase().includes('required'),
        `error should mention userPrompt, got: ${e.message}`)
      return true
    }
  )
})

test('accepts optional agentName, taskId, model, timeoutMs', async () => {
  const result = await runAgent({
    userPrompt: 'Hello',
    agentName: 'ARJUN',
    taskId: 'task-123',
    model: 'claude-haiku-4-6',
    timeoutMs: 30000,
    adapter: 'cli', _spawn: makeOkSpawn('with options'),
  })
  assert.strictEqual(result.text, 'with options')
})

// Fix 1: multi-key modelUsage → picks the model with highest costUSD
test('multi-key modelUsage: picks model with highest costUSD', async () => {
  const result = await runAgent({
    userPrompt: 'Hello',
    adapter: 'cli', _spawn: makeMultiModelSpawn('multi result'),
  })
  assert.strictEqual(result.text, 'multi result')
  assert.strictEqual(result.model, 'claude-opus-4-8',
    'should pick claude-opus-4-8 (costUSD 0.025) over claude-haiku-4-6 (costUSD 0.0001)')
})

// Fix 3: timeout path — rejection message + group-kill attempted
test('times out after timeoutMs and rejects with agent label in message', async () => {
  const killCalls = []
  const origKill = process.kill
  process.kill = (pid, sig) => { killCalls.push({ pid, sig }) }
  try {
    await assert.rejects(
      () => runAgent({
        userPrompt: 'Hello',
        agentName: 'BHEEM',
        taskId: 'task-timeout-99',
        timeoutMs: 50,
        adapter: 'cli', _spawn: makeHangingSpawn(),
      }),
      (e) => {
        assert.ok(
          e.message.toLowerCase().includes('timed out'),
          `error message should mention "timed out", got: ${e.message}`)
        assert.ok(
          e.message.includes('BHEEM') || e.message.includes('task-timeout-99'),
          `error message should include agent label, got: ${e.message}`)
        return true
      }
    )
    // SIGTERM group-kill should have been attempted at -child.pid = -12345
    const sigtermCall = killCalls.find(c => c.pid === -12345 && c.sig === 'SIGTERM')
    assert.ok(sigtermCall, `process.kill(-12345, 'SIGTERM') should have been called, got: ${JSON.stringify(killCalls)}`)
  } finally {
    process.kill = origKill
  }
})

// Fix 2: env contains ANTHROPIC_API_KEY when anthropic-key returns a value
test('env contains ANTHROPIC_API_KEY when set via process.env', async () => {
  const origKey = process.env.ANTHROPIC_API_KEY
  // Reset the in-memory cache in anthropic-key module so it re-reads from env
  const anthropicKey = require('../src/integrations/anthropic-key')
  anthropicKey.resetCache()
  process.env.ANTHROPIC_API_KEY = 'sk-ant-testkey123'
  try {
    const capturingSpawn = makeEnvCapturingSpawn('ok')
    await runAgent({ userPrompt: 'Hello', adapter: 'cli', _spawn: capturingSpawn })
    const env = capturingSpawn.getCapturedEnv()
    assert.ok(env !== null, 'env should have been captured')
    assert.strictEqual(env.ANTHROPIC_API_KEY, 'sk-ant-testkey123',
      'ANTHROPIC_API_KEY should be forwarded when available via process.env')
  } finally {
    if (origKey === undefined) delete process.env.ANTHROPIC_API_KEY
    else process.env.ANTHROPIC_API_KEY = origKey
    anthropicKey.resetCache()
  }
})

// IS_SANDBOX forwarding: claude running as root requires IS_SANDBOX=1 for bypassPermissions
test('IS_SANDBOX is forwarded in spawn env when set in process.env', async () => {
  const origSandbox = process.env.IS_SANDBOX
  process.env.IS_SANDBOX = '1'
  try {
    const capturingSpawn = makeEnvCapturingSpawn('ok')
    await runAgent({ userPrompt: 'Hello', adapter: 'cli', _spawn: capturingSpawn })
    const env = capturingSpawn.getCapturedEnv()
    assert.ok(env !== null, 'env should have been captured')
    assert.strictEqual(env.IS_SANDBOX, '1',
      'IS_SANDBOX should be forwarded to spawn env when set in process.env')
  } finally {
    if (origSandbox === undefined) delete process.env.IS_SANDBOX
    else process.env.IS_SANDBOX = origSandbox
  }
})

test('IS_SANDBOX is absent from spawn env when not set in process.env', async () => {
  const origSandbox = process.env.IS_SANDBOX
  delete process.env.IS_SANDBOX
  try {
    const capturingSpawn = makeEnvCapturingSpawn('ok')
    await runAgent({ userPrompt: 'Hello', adapter: 'cli', _spawn: capturingSpawn })
    const env = capturingSpawn.getCapturedEnv()
    assert.ok(env !== null, 'env should have been captured')
    assert.ok(!('IS_SANDBOX' in env),
      'IS_SANDBOX should not be present in spawn env when absent from process.env')
  } finally {
    if (origSandbox !== undefined) process.env.IS_SANDBOX = origSandbox
  }
})

// ===========================================================================
// SDK adapter tests (adapter: 'sdk')
// ===========================================================================
// The sdk adapter drives the Agent SDK `query()` async stream. Tests DI the
// query function via spec._query — a factory that returns an async-iterable of
// SDK messages (mirrors the cli adapter's spec._spawn). All tests run offline.
//
// SDK message shapes (from node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts):
//   - system/init:  { type:'system', subtype:'init', apiKeySource, model, ... }
//   - assistant:    { type:'assistant', message: BetaMessage, error?: <authErr> }
//   - result OK:    { type:'result', subtype:'success', is_error:false, result,
//                     usage:<snake_case>, modelUsage:{ '<model>': { costUSD, ... } } }
//   - result error: { type:'result', subtype:'error_during_execution', is_error:true,
//                     errors:[...], ... }

/**
 * Turn an array of SDK messages into a _query factory: a function
 * (params) => async-iterable. Mirrors the real query({prompt,options}) shape;
 * the params are captured so tests can assert on the options passed.
 */
function makeQueryFactory(messages) {
  let capturedParams = null
  function factory(params) {
    capturedParams = params
    return (async function* () {
      for (const m of messages) yield m
    })()
  }
  factory.getCapturedParams = () => capturedParams
  return factory
}

/** A successful SDK stream: init → assistant → result(success). */
function makeOkQuery(resultText = 'hello from sdk', model = 'claude-sonnet-4-6') {
  return makeQueryFactory([
    { type: 'system', subtype: 'init', apiKeySource: 'oauth', model, tools: [] },
    { type: 'assistant', message: { content: [{ type: 'text', text: resultText }] } },
    {
      type: 'result',
      subtype: 'success',
      is_error: false,
      result: resultText,
      usage: { input_tokens: 11, output_tokens: 7, cache_read_input_tokens: 2, cache_creation_input_tokens: 1 },
      modelUsage: { [model]: { inputTokens: 11, outputTokens: 7, costUSD: 0.002 } },
      total_cost_usd: 0.002,
    },
  ])
}

/** Multi-model result stream — highest costUSD wins. */
function makeMultiModelQuery(resultText = 'multi sdk') {
  return makeQueryFactory([
    { type: 'system', subtype: 'init', apiKeySource: 'oauth', model: 'claude-haiku-4-6', tools: [] },
    {
      type: 'result',
      subtype: 'success',
      is_error: false,
      result: resultText,
      usage: { input_tokens: 30, output_tokens: 12 },
      modelUsage: {
        'claude-haiku-4-6': { inputTokens: 5, outputTokens: 2, costUSD: 0.0001 },
        'claude-opus-4-8': { inputTokens: 25, outputTokens: 10, costUSD: 0.04 },
      },
      total_cost_usd: 0.0401,
    },
  ])
}

/** Stream where the assistant message carries an error (auth/billing/etc). */
function makeAssistantErrorQuery(errKind = 'authentication_failed') {
  return makeQueryFactory([
    { type: 'system', subtype: 'init', apiKeySource: 'oauth', model: 'claude-sonnet-4-6', tools: [] },
    { type: 'assistant', message: { content: [] }, error: errKind },
  ])
}

/** Stream that ends with a result error subtype. */
function makeResultErrorQuery(subtype = 'error_during_execution') {
  return makeQueryFactory([
    { type: 'system', subtype: 'init', apiKeySource: 'oauth', model: 'claude-sonnet-4-6', tools: [] },
    {
      type: 'result',
      subtype,
      is_error: true,
      errors: ['the tool blew up'],
      usage: { input_tokens: 1, output_tokens: 0 },
      modelUsage: {},
      total_cost_usd: 0,
    },
  ])
}

/** Stream that ends WITHOUT any result message (truncated / silent-drop class). */
function makeNoResultQuery() {
  return makeQueryFactory([
    { type: 'system', subtype: 'init', apiKeySource: 'oauth', model: 'claude-sonnet-4-6', tools: [] },
    { type: 'assistant', message: { content: [{ type: 'text', text: 'partial' }] } },
  ])
}

/** Factory whose stream throws partway (SDK/transport error). */
function makeThrowingQuery(msg = 'transport exploded') {
  function factory(_params) {
    return (async function* () {
      yield { type: 'system', subtype: 'init', apiKeySource: 'oauth', model: 'claude-sonnet-4-6', tools: [] }
      throw new Error(msg)
    })()
  }
  return factory
}

test('[sdk] returns structured { text, usage, model, raw } on success', async () => {
  const result = await runAgent({
    adapter: 'sdk',
    userPrompt: 'Hello',
    _query: makeOkQuery('the sdk answer', 'claude-sonnet-4-6'),
  })
  assert.strictEqual(typeof result, 'object', 'result should be an object')
  assert.strictEqual(result.text, 'the sdk answer', 'text accumulated from the result message')
  assert.ok('usage' in result, 'has usage')
  assert.ok('model' in result, 'has model')
  assert.ok('raw' in result, 'has raw')
  assert.strictEqual(result.model, 'claude-sonnet-4-6', 'model extracted from modelUsage key')
})

test('[sdk] usage normalized to snake_case input_tokens/output_tokens', async () => {
  const result = await runAgent({
    adapter: 'sdk',
    userPrompt: 'Hello',
    _query: makeOkQuery('x', 'claude-sonnet-4-6'),
  })
  assert.strictEqual(result.usage.input_tokens, 11, 'input_tokens present (snake_case)')
  assert.strictEqual(result.usage.output_tokens, 7, 'output_tokens present (snake_case)')
  assert.strictEqual(result.usage.cache_read_input_tokens, 2, 'cache_read carried through')
  assert.strictEqual(result.usage.cache_creation_input_tokens, 1, 'cache_creation carried through')
})

test('[sdk] multi-key modelUsage: picks model with highest costUSD', async () => {
  const result = await runAgent({
    adapter: 'sdk',
    userPrompt: 'Hello',
    _query: makeMultiModelQuery('multi'),
  })
  assert.strictEqual(result.text, 'multi')
  assert.strictEqual(result.model, 'claude-opus-4-8',
    'should pick claude-opus-4-8 (0.04) over claude-haiku-4-6 (0.0001)')
})

test('[sdk] assistant message with error throws (never silent empty string)', async () => {
  await assert.rejects(
    () => runAgent({ adapter: 'sdk', userPrompt: 'Hello', _query: makeAssistantErrorQuery('authentication_failed') }),
    (e) => {
      assert.ok(e.message.length > 0, 'error message should not be empty')
      assert.ok(e.message.includes('authentication_failed'),
        `error should surface the SDK error kind, got: ${e.message}`)
      return true
    }
  )
})

test('[sdk] result error subtype throws with the error text', async () => {
  await assert.rejects(
    () => runAgent({ adapter: 'sdk', userPrompt: 'Hello', _query: makeResultErrorQuery('error_during_execution') }),
    (e) => {
      assert.ok(e.message.length > 0, 'error message should not be empty')
      assert.ok(
        e.message.includes('error_during_execution') || e.message.includes('the tool blew up'),
        `error should mention the failure, got: ${e.message}`)
      return true
    }
  )
})

test('[sdk] stream ends with no result message throws (never empty string)', async () => {
  await assert.rejects(
    () => runAgent({ adapter: 'sdk', userPrompt: 'Hello', _query: makeNoResultQuery() }),
    (e) => {
      assert.ok(e.message.length > 0, 'error message should not be empty')
      assert.ok(e.message.toLowerCase().includes('no result') || e.message.toLowerCase().includes('without'),
        `error should explain the missing result message, got: ${e.message}`)
      return true
    }
  )
})

test('[sdk] stream that throws mid-iteration surfaces as a thrown error', async () => {
  await assert.rejects(
    () => runAgent({ adapter: 'sdk', userPrompt: 'Hello', _query: makeThrowingQuery('transport exploded') }),
    (e) => {
      assert.ok(e.message.includes('transport exploded'),
        `error should wrap the underlying throw, got: ${e.message}`)
      assert.ok(e.message.includes('[sdk]['),
        `error should carry [sdk][label] prefix, got: ${e.message}`)
      assert.ok(e.message.includes('stream transport error'),
        `error should include 'stream transport error', got: ${e.message}`)
      return true
    }
  )
})

test('[sdk] passes an allowlist env to query() with no secret-bearing keys', async () => {
  const origAws = process.env.AWS_SECRET_ACCESS_KEY
  const origGithub = process.env.GITHUB_TOKEN
  const origTelegram = process.env.TELEGRAM_BOT_TOKEN
  process.env.AWS_SECRET_ACCESS_KEY = 'fake-aws-secret'
  process.env.GITHUB_TOKEN = 'ghp_faketoken'
  process.env.TELEGRAM_BOT_TOKEN = 'tg-bot-fake'
  try {
    const q = makeOkQuery('ok')
    await runAgent({ adapter: 'sdk', userPrompt: 'Hello', _query: q })
    const params = q.getCapturedParams()
    assert.ok(params && params.options && params.options.env,
      'query() should receive options.env (explicit allowlist)')
    const env = params.options.env
    const envKeys = Object.keys(env)

    for (const required of ['HOME', 'PATH', 'TERM']) {
      assert.ok(envKeys.includes(required),
        `query env must contain required allowlist key "${required}"`)
    }
    const secretPatterns = [/^AWS_/, /^GITHUB_TOKEN$/, /^TELEGRAM/, /^GH_TOKEN$/]
    for (const pattern of secretPatterns) {
      const matching = envKeys.filter(k => pattern.test(k))
      assert.strictEqual(matching.length, 0,
        `query env should not contain keys matching ${pattern} but found: ${matching.join(', ')}`)
    }
  } finally {
    if (origAws === undefined) delete process.env.AWS_SECRET_ACCESS_KEY
    else process.env.AWS_SECRET_ACCESS_KEY = origAws
    if (origGithub === undefined) delete process.env.GITHUB_TOKEN
    else process.env.GITHUB_TOKEN = origGithub
    if (origTelegram === undefined) delete process.env.TELEGRAM_BOT_TOKEN
    else process.env.TELEGRAM_BOT_TOKEN = origTelegram
  }
})

test('[sdk] sets bypassPermissions + allowDangerouslySkipPermissions in query options', async () => {
  const q = makeOkQuery('ok')
  await runAgent({ adapter: 'sdk', userPrompt: 'Hello', _query: q })
  const params = q.getCapturedParams()
  assert.strictEqual(params.options.permissionMode, 'bypassPermissions',
    'permissionMode should be bypassPermissions (matches cli adapter)')
  assert.strictEqual(params.options.allowDangerouslySkipPermissions, true,
    'allowDangerouslySkipPermissions must be true when bypassPermissions is set')
})

test('[sdk] maps systemPrompt to preset+append (faithful to --append-system-prompt)', async () => {
  const q = makeOkQuery('ok')
  await runAgent({ adapter: 'sdk', userPrompt: 'Hello', systemPrompt: 'Be terse.', _query: q })
  const params = q.getCapturedParams()
  assert.deepStrictEqual(params.options.systemPrompt,
    { type: 'preset', preset: 'claude_code', append: 'Be terse.' },
    'systemPrompt should append to the claude_code preset (mirrors CLI --append-system-prompt)')
})

test('[sdk] forwards model and prompt to query()', async () => {
  const q = makeOkQuery('ok', 'claude-haiku-4-5-20251001')
  await runAgent({
    adapter: 'sdk',
    userPrompt: 'Reply OK',
    model: 'claude-haiku-4-5-20251001',
    _query: q,
  })
  const params = q.getCapturedParams()
  assert.strictEqual(params.prompt, 'Reply OK', 'userPrompt forwarded as query prompt')
  assert.strictEqual(params.options.model, 'claude-haiku-4-5-20251001', 'model forwarded')
})

test('[sdk] IS_SANDBOX forwarded to query env when set', async () => {
  const origSandbox = process.env.IS_SANDBOX
  process.env.IS_SANDBOX = '1'
  try {
    const q = makeOkQuery('ok')
    await runAgent({ adapter: 'sdk', userPrompt: 'Hello', _query: q })
    const env = q.getCapturedParams().options.env
    assert.strictEqual(env.IS_SANDBOX, '1', 'IS_SANDBOX should be forwarded when set')
  } finally {
    if (origSandbox === undefined) delete process.env.IS_SANDBOX
    else process.env.IS_SANDBOX = origSandbox
  }
})

test('[sdk] sdk is a registered adapter (listed by unknown-adapter error)', async () => {
  await assert.rejects(
    () => runAgent({ userPrompt: 'Hello', adapter: 'definitely_not_real_xyz' }),
    (e) => {
      assert.ok(e.message.includes('sdk'),
        `known-adapters list should include sdk, got: ${e.message}`)
      return true
    }
  )
})

// Fix 2a: sdk timeout — generator that never yields must reject with '[sdk][' + 'timed out'
// and must NOT leave an unhandled-rejection (fire-and-forget stream.return() catches in place).
test('[sdk] times out when the query generator never yields, rejects with [sdk][ prefix and "timed out"', async () => {
  // A _query that returns an async generator that hangs forever (never yields)
  function makeHangingQuery() {
    return function factory(_params) {
      return (async function* () {
        await new Promise(() => {}) // never resolves
      })()
    }
  }

  await assert.rejects(
    () => runAgent({
      adapter: 'sdk',
      userPrompt: 'Hello',
      agentName: 'TIMEOUT-AGENT',
      taskId: 'task-sdk-timeout-01',
      timeoutMs: 50,
      _query: makeHangingQuery(),
    }),
    (e) => {
      assert.ok(
        e.message.toLowerCase().includes('timed out'),
        `error should contain "timed out", got: ${e.message}`)
      assert.ok(
        e.message.includes('[sdk]['),
        `error should carry [sdk][ prefix, got: ${e.message}`)
      return true
    }
  )
})

// Fix 2b: _query that throws synchronously when called → rejection message contains
// '[sdk][' and 'failed to start'
test('[sdk] _query that throws synchronously → rejects with [sdk][ and "failed to start"', async () => {
  function makeThrowOnCallQuery(msg = 'import exploded') {
    // Throws synchronously when the factory is called (not when iterating)
    return function factory(_params) {
      throw new Error(msg)
    }
  }

  await assert.rejects(
    () => runAgent({
      adapter: 'sdk',
      userPrompt: 'Hello',
      agentName: 'THROW-START',
      taskId: 'task-sdk-throw-start',
      _query: makeThrowOnCallQuery('import exploded'),
    }),
    (e) => {
      assert.ok(
        e.message.includes('[sdk]['),
        `error should carry [sdk][ prefix, got: ${e.message}`)
      assert.ok(
        e.message.toLowerCase().includes('failed to start'),
        `error should contain "failed to start", got: ${e.message}`)
      return true
    }
  )
})

// ===========================================================================
// T6 — adapter capabilities for cutover
// onProgress · effort · jsonSchema · addDirs · bare · envExtras · omitApiKey
// ===========================================================================

/**
 * Fake cli spawn that captures the args array (and env) and resolves OK.
 * Use .getCapturedArgs() / .getCapturedEnv() after the run resolves.
 */
function makeArgsCapturingSpawn(resultText = 'ok') {
  const envelope = JSON.stringify({
    type: 'result', subtype: 'success', is_error: false, result: resultText,
    usage: { input_tokens: 1, output_tokens: 1 },
    modelUsage: { 'claude-haiku-4-6': { inputTokens: 1, outputTokens: 1, costUSD: 0.0001 } },
    total_cost_usd: 0.0001,
  })
  let capturedArgs = null
  let capturedEnv = null
  function fakeSpawn(_bin, args, opts) {
    capturedArgs = Array.isArray(args) ? args.slice() : null
    capturedEnv = opts && opts.env ? { ...opts.env } : null
    const { EventEmitter } = require('events')
    const stdout = new EventEmitter()
    const stderr = new EventEmitter()
    const child = new EventEmitter()
    child.stdout = stdout
    child.stderr = stderr
    child.pid = 12345
    process.nextTick(() => {
      stdout.emit('data', Buffer.from(envelope))
      child.emit('close', 0)
    })
    return child
  }
  fakeSpawn.getCapturedArgs = () => capturedArgs
  fakeSpawn.getCapturedEnv = () => capturedEnv
  return fakeSpawn
}

/**
 * Fake cli spawn that emits several stdout chunks (to exercise onProgress
 * firing once per chunk) before closing OK.
 */
function makeMultiChunkSpawn(chunks = ['{"type":', '"result",', '"subtype":"success","is_error":false,"result":"multi","usage":{},"modelUsage":{}}']) {
  function fakeSpawn(_bin, _args, _opts) {
    const { EventEmitter } = require('events')
    const stdout = new EventEmitter()
    const stderr = new EventEmitter()
    const child = new EventEmitter()
    child.stdout = stdout
    child.stderr = stderr
    child.pid = 12345
    process.nextTick(() => {
      for (const c of chunks) stdout.emit('data', Buffer.from(c))
      child.emit('close', 0)
    })
    return child
  }
  return fakeSpawn
}

/** index of a flag in an args array (or -1). */
function argIdx(args, flag) { return args.indexOf(flag) }

// ── cli: effort ────────────────────────────────────────────────────────────
test('[cli] effort adds --effort <v> after the --model block', async () => {
  const spawn = makeArgsCapturingSpawn()
  await runAgent({ userPrompt: 'Hi', model: 'claude-haiku-4-6', effort: 'high', adapter: 'cli', _spawn: spawn })
  const args = spawn.getCapturedArgs()
  const ei = argIdx(args, '--effort')
  assert.ok(ei !== -1, `--effort should be present, got: ${args.join(' ')}`)
  assert.strictEqual(args[ei + 1], 'high', '--effort value should be "high"')
  // order: --effort comes AFTER the --model block, BEFORE --output-format
  const mi = argIdx(args, '--model')
  const oi = argIdx(args, '--output-format')
  assert.ok(mi !== -1 && mi < ei, '--effort should come after --model')
  assert.ok(ei < oi, '--effort should come before --output-format')
})

test('[cli] no --effort flag when effort unset', async () => {
  const spawn = makeArgsCapturingSpawn()
  await runAgent({ userPrompt: 'Hi', adapter: 'cli', _spawn: spawn })
  assert.strictEqual(argIdx(spawn.getCapturedArgs(), '--effort'), -1, 'no --effort when unset')
})

// ── cli: jsonSchema ──────────────────────────────────────────────────────────
test('[cli] jsonSchema object adds --json-schema <stringified>', async () => {
  const spawn = makeArgsCapturingSpawn()
  const schema = { type: 'object', properties: { x: { type: 'string' } } }
  await runAgent({ userPrompt: 'Hi', jsonSchema: schema, adapter: 'cli', _spawn: spawn })
  const args = spawn.getCapturedArgs()
  const ji = argIdx(args, '--json-schema')
  assert.ok(ji !== -1, `--json-schema should be present, got: ${args.join(' ')}`)
  assert.strictEqual(args[ji + 1], JSON.stringify(schema), 'object schema should be JSON.stringified')
})

test('[cli] jsonSchema string is passed through verbatim', async () => {
  const spawn = makeArgsCapturingSpawn()
  await runAgent({ userPrompt: 'Hi', jsonSchema: '/root/schemas/finding.json', adapter: 'cli', _spawn: spawn })
  const args = spawn.getCapturedArgs()
  const ji = argIdx(args, '--json-schema')
  assert.strictEqual(args[ji + 1], '/root/schemas/finding.json', 'string schema passed verbatim')
})

// ── cli: addDirs ─────────────────────────────────────────────────────────────
test('[cli] addDirs emits one --add-dir per entry', async () => {
  const spawn = makeArgsCapturingSpawn()
  await runAgent({ userPrompt: 'Hi', addDirs: [__roots.INTEL_ROOT, (__roots.AGENTS_ROOT + '/x/skills')], adapter: 'cli', _spawn: spawn })
  const args = spawn.getCapturedArgs()
  const addDirCount = args.filter(a => a === '--add-dir').length
  assert.strictEqual(addDirCount, 2, 'two --add-dir flags')
  const i1 = argIdx(args, '--add-dir')
  assert.strictEqual(args[i1 + 1], __roots.INTEL_ROOT, 'first add-dir value')
  assert.strictEqual(args[args.lastIndexOf('--add-dir') + 1], (__roots.AGENTS_ROOT + '/x/skills'), 'second add-dir value')
})

// ── cli: bare ────────────────────────────────────────────────────────────────
test('[cli] bare adds a leading --bare flag (before --permission-mode)', async () => {
  const spawn = makeArgsCapturingSpawn()
  await runAgent({ userPrompt: 'Hi', bare: true, adapter: 'cli', _spawn: spawn })
  const args = spawn.getCapturedArgs()
  const bi = argIdx(args, '--bare')
  assert.ok(bi !== -1, `--bare should be present, got: ${args.join(' ')}`)
  const pi = argIdx(args, '--permission-mode')
  assert.ok(bi < pi, '--bare should come before --permission-mode (leading flag)')
})

test('[cli] no --bare flag when bare is falsy', async () => {
  const spawn = makeArgsCapturingSpawn()
  await runAgent({ userPrompt: 'Hi', adapter: 'cli', _spawn: spawn })
  assert.strictEqual(argIdx(spawn.getCapturedArgs(), '--bare'), -1, 'no --bare when unset')
})

// ── cli: envExtras (allowlist) ───────────────────────────────────────────────
test('[cli] envExtras allowlisted key (AGENT_TASK_ID) passes into spawn env', async () => {
  const spawn = makeArgsCapturingSpawn()
  await runAgent({ userPrompt: 'Hi', envExtras: { AGENT_TASK_ID: 't6-x' }, adapter: 'cli', _spawn: spawn })
  const env = spawn.getCapturedEnv()
  assert.strictEqual(env.AGENT_TASK_ID, 't6-x', 'allowlisted extra key forwarded')
})

test('[cli] envExtras disallowed key THROWS (v2.1-A1 boundary)', async () => {
  await assert.rejects(
    () => runAgent({ userPrompt: 'Hi', envExtras: { AWS_SECRET_ACCESS_KEY: 'x' }, adapter: 'cli', _spawn: makeArgsCapturingSpawn() }),
    (e) => {
      assert.ok(/allowlist|not allowlisted/i.test(e.message),
        `error should mention allowlist, got: ${e.message}`)
      assert.ok(e.message.includes('AWS_SECRET_ACCESS_KEY'),
        `error should name the rejected key, got: ${e.message}`)
      return true
    }
  )
})

// ── cli: omitApiKey ──────────────────────────────────────────────────────────
test('[cli] omitApiKey suppresses ANTHROPIC_API_KEY even when configured', async () => {
  const origKey = process.env.ANTHROPIC_API_KEY
  const anthropicKey = require('../src/integrations/anthropic-key')
  anthropicKey.resetCache()
  process.env.ANTHROPIC_API_KEY = 'sk-ant-shouldnotappear'
  try {
    const spawn = makeArgsCapturingSpawn()
    await runAgent({ userPrompt: 'Hi', omitApiKey: true, adapter: 'cli', _spawn: spawn })
    const env = spawn.getCapturedEnv()
    assert.ok(!('ANTHROPIC_API_KEY' in env),
      'ANTHROPIC_API_KEY must be absent when omitApiKey:true')
  } finally {
    if (origKey === undefined) delete process.env.ANTHROPIC_API_KEY
    else process.env.ANTHROPIC_API_KEY = origKey
    anthropicKey.resetCache()
  }
})

test('[cli] without omitApiKey the configured key IS injected (control)', async () => {
  const origKey = process.env.ANTHROPIC_API_KEY
  const anthropicKey = require('../src/integrations/anthropic-key')
  anthropicKey.resetCache()
  process.env.ANTHROPIC_API_KEY = 'sk-ant-present'
  try {
    const spawn = makeArgsCapturingSpawn()
    await runAgent({ userPrompt: 'Hi', adapter: 'cli', _spawn: spawn })
    const env = spawn.getCapturedEnv()
    assert.strictEqual(env.ANTHROPIC_API_KEY, 'sk-ant-present',
      'control: key injected when omitApiKey not set')
  } finally {
    if (origKey === undefined) delete process.env.ANTHROPIC_API_KEY
    else process.env.ANTHROPIC_API_KEY = origKey
    anthropicKey.resetCache()
  }
})

// ── cli: onProgress ──────────────────────────────────────────────────────────
test('[cli] onProgress fires once per stdout chunk', async () => {
  let calls = 0
  await runAgent({
    userPrompt: 'Hi',
    onProgress: () => { calls++ },
    adapter: 'cli', _spawn: makeMultiChunkSpawn(),
  })
  assert.strictEqual(calls, 3, 'onProgress called once per emitted chunk (3 chunks)')
})

test('[cli] a throwing onProgress does NOT break the run', async () => {
  const result = await runAgent({
    userPrompt: 'Hi',
    onProgress: () => { throw new Error('callback boom') },
    adapter: 'cli', _spawn: makeOkSpawn('survived'),
  })
  assert.strictEqual(result.text, 'survived', 'run completes despite throwing onProgress')
})

// ── sdk: effort ──────────────────────────────────────────────────────────────
test('[sdk] effort maps to options.effort (first-class)', async () => {
  const q = makeOkQuery('ok')
  const r = await runAgent({ adapter: 'sdk', userPrompt: 'Hi', effort: 'high', _query: q })
  assert.strictEqual(q.getCapturedParams().options.effort, 'high', 'options.effort set')
  assert.strictEqual(r.raw.effortApplied, true, 'raw.effortApplied true')
})

test('[sdk] no options.effort when effort unset; raw.effortApplied false', async () => {
  const q = makeOkQuery('ok')
  const r = await runAgent({ adapter: 'sdk', userPrompt: 'Hi', _query: q })
  assert.ok(!('effort' in q.getCapturedParams().options), 'options.effort absent')
  assert.strictEqual(r.raw.effortApplied, false, 'raw.effortApplied false')
})

// ── sdk: jsonSchema ──────────────────────────────────────────────────────────
test('[sdk] jsonSchema object maps to options.outputFormat={type:json_schema,schema}', async () => {
  const q = makeOkQuery('ok')
  const schema = { type: 'object', properties: { x: { type: 'string' } } }
  const r = await runAgent({ adapter: 'sdk', userPrompt: 'Hi', jsonSchema: schema, _query: q })
  assert.deepStrictEqual(q.getCapturedParams().options.outputFormat,
    { type: 'json_schema', schema },
    'outputFormat carries the schema object')
  assert.strictEqual(r.raw.jsonSchemaApplied, true, 'raw.jsonSchemaApplied true')
})

test('[sdk] jsonSchema JSON string is parsed into an object for outputFormat.schema', async () => {
  const q = makeOkQuery('ok')
  const schema = { type: 'object' }
  await runAgent({ adapter: 'sdk', userPrompt: 'Hi', jsonSchema: JSON.stringify(schema), _query: q })
  assert.deepStrictEqual(q.getCapturedParams().options.outputFormat.schema, schema,
    'string schema parsed into object')
})

test('[sdk] jsonSchema invalid JSON string throws descriptively', async () => {
  await assert.rejects(
    () => runAgent({ adapter: 'sdk', userPrompt: 'Hi', jsonSchema: '{not json', _query: makeOkQuery('ok') }),
    (e) => {
      assert.ok(e.message.includes('[sdk]['), `error carries [sdk][ prefix, got: ${e.message}`)
      assert.ok(/jsonSchema/i.test(e.message), `error mentions jsonSchema, got: ${e.message}`)
      return true
    }
  )
})

// ── sdk: addDirs ─────────────────────────────────────────────────────────────
test('[sdk] addDirs maps to options.additionalDirectories', async () => {
  const q = makeOkQuery('ok')
  await runAgent({ adapter: 'sdk', userPrompt: 'Hi', addDirs: [__roots.INTEL_ROOT, '/root/x'], _query: q })
  assert.deepStrictEqual(q.getCapturedParams().options.additionalDirectories,
    [__roots.INTEL_ROOT, '/root/x'], 'additionalDirectories carries the dir list')
})

// ── sdk: bare ────────────────────────────────────────────────────────────────
test('[sdk] bare maps to options.extraArgs={bare:null} + raw.bareApplied', async () => {
  const q = makeOkQuery('ok')
  const r = await runAgent({ adapter: 'sdk', userPrompt: 'Hi', bare: true, _query: q })
  assert.deepStrictEqual(q.getCapturedParams().options.extraArgs, { bare: null },
    'extraArgs maps bare to a null-valued (bare-flag) entry')
  assert.strictEqual(r.raw.bareApplied, true, 'raw.bareApplied true')
})

test('[sdk] cacheOptimize default=true adds exclude-dynamic flag; bare not set; raw.bareApplied false', async () => {
  const q = makeOkQuery('ok')
  const r = await runAgent({ adapter: 'sdk', userPrompt: 'Hi', _query: q })
  // cacheOptimize=true (default) sets --exclude-dynamic-system-prompt-sections in extraArgs
  const extraArgs = q.getCapturedParams().options.extraArgs || {}
  assert.ok('exclude-dynamic-system-prompt-sections' in extraArgs,
    'cacheOptimize sets --exclude-dynamic-system-prompt-sections')
  assert.ok(!('bare' in extraArgs), 'bare not in extraArgs when bare unset')
  assert.strictEqual(r.raw.bareApplied, false, 'raw.bareApplied false')
})

// ── sdk: envExtras / omitApiKey ──────────────────────────────────────────────
test('[sdk] envExtras allowlisted key passes into query env', async () => {
  const q = makeOkQuery('ok')
  await runAgent({ adapter: 'sdk', userPrompt: 'Hi', envExtras: { AGENT_TASK_ID: 't6-sdk' }, _query: q })
  assert.strictEqual(q.getCapturedParams().options.env.AGENT_TASK_ID, 't6-sdk',
    'allowlisted extra forwarded to query env')
})

test('[sdk] envExtras disallowed key THROWS', async () => {
  await assert.rejects(
    () => runAgent({ adapter: 'sdk', userPrompt: 'Hi', envExtras: { GITHUB_TOKEN: 'x' }, _query: makeOkQuery('ok') }),
    (e) => {
      assert.ok(/allowlist|not allowlisted/i.test(e.message), `error mentions allowlist, got: ${e.message}`)
      assert.ok(e.message.includes('GITHUB_TOKEN'), `error names the rejected key, got: ${e.message}`)
      return true
    }
  )
})

test('[sdk] omitApiKey suppresses ANTHROPIC_API_KEY in query env', async () => {
  const origKey = process.env.ANTHROPIC_API_KEY
  const anthropicKey = require('../src/integrations/anthropic-key')
  anthropicKey.resetCache()
  process.env.ANTHROPIC_API_KEY = 'sk-ant-nope'
  try {
    const q = makeOkQuery('ok')
    await runAgent({ adapter: 'sdk', userPrompt: 'Hi', omitApiKey: true, _query: q })
    const env = q.getCapturedParams().options.env
    assert.ok(!('ANTHROPIC_API_KEY' in env), 'key suppressed when omitApiKey:true')
  } finally {
    if (origKey === undefined) delete process.env.ANTHROPIC_API_KEY
    else process.env.ANTHROPIC_API_KEY = origKey
    anthropicKey.resetCache()
  }
})

// ── sdk: onProgress ──────────────────────────────────────────────────────────
test('[sdk] onProgress fires once per stream message', async () => {
  let calls = 0
  // makeOkQuery yields 3 messages: init, assistant, result.
  await runAgent({
    adapter: 'sdk', userPrompt: 'Hi',
    onProgress: () => { calls++ },
    _query: makeOkQuery('ok'),
  })
  assert.strictEqual(calls, 3, 'onProgress called once per stream message (init+assistant+result)')
})

test('[sdk] a throwing onProgress does NOT break the run', async () => {
  const r = await runAgent({
    adapter: 'sdk', userPrompt: 'Hi',
    onProgress: () => { throw new Error('boom') },
    _query: makeOkQuery('survived sdk'),
  })
  assert.strictEqual(r.text, 'survived sdk', 'run completes despite throwing onProgress')
})

// ===========================================================================
// Rate-limit classification hardening (quota-manager.js:243 regex contract)
// sdk.js result-error path must preserve retry-classification text so that
// quota-manager.isRateLimitError() can detect rate limits arriving as result
// errors with empty errors[] (e.g. a 429 with no error detail text).
// ===========================================================================

const { isRateLimitError } = require('../src/integrations/quota-manager')

/** Result error stream with api_error_status set and empty errors[]. */
function makeRateLimitStatusQuery(status = 429) {
  return makeQueryFactory([
    { type: 'system', subtype: 'init', apiKeySource: 'oauth', model: 'claude-sonnet-4-6', tools: [] },
    {
      type: 'result',
      subtype: 'error_during_execution',
      is_error: true,
      errors: [],           // empty — the bug: without api_error_status nothing identifies the rate limit
      api_error_status: status,
      usage: { input_tokens: 1, output_tokens: 0 },
      modelUsage: {},
      total_cost_usd: 0,
    },
  ])
}

/** Result error stream with a limit-ish subtype and no other detail. */
function makeLimitSubtypeQuery(subtype = 'error_max_budget_usd') {
  return makeQueryFactory([
    { type: 'system', subtype: 'init', apiKeySource: 'oauth', model: 'claude-sonnet-4-6', tools: [] },
    {
      type: 'result',
      subtype,
      is_error: true,
      errors: [],
      usage: { input_tokens: 1, output_tokens: 0 },
      modelUsage: {},
      total_cost_usd: 0,
    },
  ])
}

test('[sdk] result error with api_error_status:429 + empty errors[] → thrown message contains "429" and isRateLimitError returns true', async () => {
  let thrownMsg = null
  await assert.rejects(
    () => runAgent({ adapter: 'sdk', userPrompt: 'Hi', _query: makeRateLimitStatusQuery(429) }),
    (e) => {
      thrownMsg = e.message
      return true
    }
  )
  assert.ok(thrownMsg !== null, 'error must have been thrown')
  assert.ok(
    thrownMsg.includes('429'),
    `thrown message must include "429" for quota-manager regex, got: ${thrownMsg}`)
  assert.ok(
    isRateLimitError(thrownMsg),
    `isRateLimitError must return true for message: ${thrownMsg}`)
})

test('[sdk] limit-ish subtype (error_max_budget_usd) with no other detail → isRateLimitError true', async () => {
  let thrownMsg = null
  await assert.rejects(
    () => runAgent({ adapter: 'sdk', userPrompt: 'Hi', _query: makeLimitSubtypeQuery('error_max_budget_usd') }),
    (e) => {
      thrownMsg = e.message
      return true
    }
  )
  assert.ok(thrownMsg !== null, 'error must have been thrown')
  assert.ok(
    isRateLimitError(thrownMsg),
    `isRateLimitError must return true for limit-ish subtype, got: ${thrownMsg}`)
})

test('[sdk] plain execution error (no status, non-limit subtype) → isRateLimitError false (no false retryable)', async () => {
  let thrownMsg = null
  await assert.rejects(
    () => runAgent({ adapter: 'sdk', userPrompt: 'Hi', _query: makeResultErrorQuery('error_during_execution') }),
    (e) => {
      thrownMsg = e.message
      return true
    }
  )
  assert.ok(thrownMsg !== null, 'error must have been thrown')
  assert.strictEqual(
    isRateLimitError(thrownMsg),
    false,
    `isRateLimitError must return false for a plain execution error, got: ${thrownMsg}`)
})
