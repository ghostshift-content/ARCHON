
const __roots = require('../paths') // portable roots (KURU_*_ROOT) — see paths.js
// test/handoff-watcher.test.js
//
// Sprint C.2 Task 7 (2026-05-10): handoff watcher + dispatcher closure.
// TDD: failing first, then green.
const assert = require('node:assert')
const { test } = require('node:test')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')

const {
  loadCapabilityMap,
  processInboxOnce,
  buildClaudeDispatcher,
  buildHandoffDispatchPrompt,
  parseHandoffVerdict,
} = require('../agents/handoff-resolver')
const { createHandoff } = require('../agents/handoff-protocol')

// ─── buildHandoffDispatchPrompt ─────────────────────────────────────────────

test('buildHandoffDispatchPrompt: includes the source finding evidence + question', () => {
  const handoff = {
    handoff_id: 'h-test-1',
    source_squad: 'pentest',
    source_agent: 'ASHWATTHAMA',
    source_finding_id: 'F-42',
    target_squad: 'cloud-security',
    target_capability: 'data-residency',
    request: {
      question: 'Does this CDN endpoint route EU PII to a US region?',
      evidence: {
        cdn_url: 'https://cdn.example.com/script.js',
        response_headers: { 'x-aws-region': 'us-east-1' },
      },
      expected_artifacts: ['compliance_verdict'],
    },
  }
  const prompt = buildHandoffDispatchPrompt({
    agent: 'KUBERA', squad: 'cloud-security', capability: 'data-residency', handoff,
  })
  assert.match(prompt, /KUBERA/, 'prompt must address the target agent')
  assert.match(prompt, /data-residency/, 'prompt must reference the capability')
  assert.match(prompt, /Does this CDN endpoint route EU PII/,
    'prompt must include the question verbatim')
  assert.match(prompt, /cdn\.example\.com/,
    'prompt must include raw evidence (cdn_url)')
  assert.match(prompt, /us-east-1/, 'prompt must include raw evidence (region header)')
})

test('buildHandoffDispatchPrompt: anti-sycophancy — does NOT include source-agent notes or parent verdict', () => {
  // Even if the handoff record carried fields like source_notes, parent_verdict,
  // or any source-agent claim, the dispatched agent must NOT see them.
  const handoff = {
    handoff_id: 'h-test-2',
    source_squad: 'pentest',
    source_agent: 'ASHWATTHAMA',
    source_finding_id: 'F-100',
    target_squad: 'cloud-security',
    target_capability: 'data-residency',
    request: {
      question: 'Compliant?',
      evidence: { url: 'https://eu.example.com', region: 'us-east-1' },
    },
    // Hypothetical sycophancy bait — must not be reflected in the prompt
    source_notes: 'I think this is a critical GDPR violation',
    parent_verdict: 'CONFIRMED',
    source_severity_claim: 'Critical',
  }
  const prompt = buildHandoffDispatchPrompt({
    agent: 'KUBERA', squad: 'cloud-security', capability: 'data-residency', handoff,
  })
  assert.doesNotMatch(prompt, /I think this is a critical GDPR/i,
    'source_notes content must not leak into prompt')
  assert.doesNotMatch(prompt, /source_notes/i,
    'source_notes label must not leak')
  // The response-format SCHEMA may reference the verdict enum (CONFIRMED/REFUTED/
  // INDETERMINATE) — that's necessary so the agent knows what to output. What
  // must NOT leak is the parent's verdict TAGGED AS THE PARENT'S OPINION.
  assert.doesNotMatch(prompt, /parent_?verdict/i,
    'parent_verdict label must not leak')
  assert.doesNotMatch(prompt, /source[_ ]severity/i,
    'source severity label must not leak')
  // The source-claimed severity word "Critical" must not appear unlabeled.
  // (We can't ban "Critical" globally — but the source's "Critical" claim
  // shouldn't be quoted anywhere in the prompt.)
  assert.doesNotMatch(prompt, /\bCritical\b/,
    'source-claimed severity word must not appear in prompt')
  // And: explicit anti-pattern — must not pre-bias with phrasing like
  // "the source agent says..." or "another agent thinks..."
  assert.doesNotMatch(prompt, /source agent (?:thinks|says|claims|believes)/i,
    'must not pre-bias with source-agent claims')
})

// ─── parseHandoffVerdict ────────────────────────────────────────────────────

test('parseHandoffVerdict: empty input → INDETERMINATE with cost 0', () => {
  const v = parseHandoffVerdict('')
  assert.strictEqual(v.verdict, 'INDETERMINATE')
  assert.match(v.verdictReason, /parse failure/i)
  assert.strictEqual(v.costActualUsd, 0)
})

test('parseHandoffVerdict: malformed input → INDETERMINATE', () => {
  const v = parseHandoffVerdict('this is not json {{{ broken')
  assert.strictEqual(v.verdict, 'INDETERMINATE')
  assert.match(v.verdictReason, /parse failure/i)
})

test('parseHandoffVerdict: missing verdict field → INDETERMINATE', () => {
  const v = parseHandoffVerdict(JSON.stringify({ reason: 'no verdict here' }))
  assert.strictEqual(v.verdict, 'INDETERMINATE')
})

test('parseHandoffVerdict: valid JSON parses correctly', () => {
  const raw = JSON.stringify({
    verdict: 'CONFIRMED',
    reason: 'GDPR Art. 44 violated — EU data routed via us-east-1',
    evidence_added: { framework: 'GDPR', article: '44' },
  })
  const v = parseHandoffVerdict(raw)
  assert.strictEqual(v.verdict, 'CONFIRMED')
  assert.match(v.verdictReason, /GDPR/)
  assert.deepStrictEqual(v.evidenceAdded, { framework: 'GDPR', article: '44' })
})

test('parseHandoffVerdict: extracts JSON from markdown fence', () => {
  // LLMs frequently wrap JSON in ```json ... ``` — handle it gracefully.
  const raw = '```json\n{"verdict":"REFUTED","reason":"compliant"}\n```'
  const v = parseHandoffVerdict(raw)
  assert.strictEqual(v.verdict, 'REFUTED')
  assert.match(v.verdictReason, /compliant/)
})

// ─── processInboxOnce ───────────────────────────────────────────────────────

test('processInboxOnce: empty inbox returns zero counts', async () => {
  const tmpBase = path.join(os.tmpdir(), `inbox-empty-${Date.now()}`)
  fs.mkdirSync(path.join(tmpBase, 'inbox'), { recursive: true })
  try {
    const map = loadCapabilityMap((__roots.AGENTS_ROOT + '/squads'))
    const dispatchAgent = async () => ({ verdict: 'CONFIRMED', verdictReason: 'r' })
    const r = await processInboxOnce({ capabilityMap: map, dispatchAgent, baseDir: tmpBase })
    assert.strictEqual(r.processed, 0)
    assert.strictEqual(r.succeeded, 0)
    assert.strictEqual(r.failed, 0)
  } finally {
    fs.rmSync(tmpBase, { recursive: true, force: true })
  }
})

test('processInboxOnce: processes multiple handoffs in one call', async () => {
  const tmpBase = path.join(os.tmpdir(), `inbox-multi-${Date.now()}`)
  try {
    const a = createHandoff({
      sourceTaskId: 'T1', sourceSquad: 'pentest', sourceAgent: 'A',
      sourceFindingId: 'F1', targetSquad: 'cloud-security',
      targetCapability: 'data-residency',
      request: { question: 'q1', evidence: { x: 1 } },
    }, { baseDir: tmpBase })
    const b = createHandoff({
      sourceTaskId: 'T1', sourceSquad: 'pentest', sourceAgent: 'A',
      sourceFindingId: 'F2', targetSquad: 'cloud-security',
      targetCapability: 'data-residency',
      request: { question: 'q2', evidence: { y: 2 } },
    }, { baseDir: tmpBase })
    const c = createHandoff({
      sourceTaskId: 'T1', sourceSquad: 'pentest', sourceAgent: 'A',
      sourceFindingId: 'F3', targetSquad: 'cloud-security',
      targetCapability: 'no-such-cap', // will fail
      request: { question: 'q3', evidence: {} },
    }, { baseDir: tmpBase })

    const map = loadCapabilityMap((__roots.AGENTS_ROOT + '/squads'))
    const dispatchAgent = async () => ({
      verdict: 'CONFIRMED', verdictReason: 'ok', evidenceAdded: {}, costActualUsd: 0,
    })
    const r = await processInboxOnce({ capabilityMap: map, dispatchAgent, baseDir: tmpBase })
    assert.strictEqual(r.processed, 3, 'processed all 3')
    assert.strictEqual(r.succeeded, 2, '2 succeeded')
    assert.strictEqual(r.failed, 1, '1 failed (no capability)')
    // Verify file movement
    assert.ok(fs.existsSync(path.join(tmpBase, 'done', `${a.handoff_id}.json`)))
    assert.ok(fs.existsSync(path.join(tmpBase, 'done', `${b.handoff_id}.json`)))
    assert.ok(fs.existsSync(path.join(tmpBase, 'failed', `${c.handoff_id}.json`)))
  } finally {
    fs.rmSync(tmpBase, { recursive: true, force: true })
  }
})

test('processInboxOnce: ignores non-.json files in inbox', async () => {
  const tmpBase = path.join(os.tmpdir(), `inbox-junk-${Date.now()}`)
  try {
    const inboxDir = path.join(tmpBase, 'inbox')
    fs.mkdirSync(inboxDir, { recursive: true })
    // Drop a junk file
    fs.writeFileSync(path.join(inboxDir, 'junk.txt'), 'noise')
    fs.writeFileSync(path.join(inboxDir, '.partial.json.tmp'), '{}')
    const map = loadCapabilityMap((__roots.AGENTS_ROOT + '/squads'))
    const dispatchAgent = async () => ({ verdict: 'CONFIRMED', verdictReason: 'r' })
    const r = await processInboxOnce({ capabilityMap: map, dispatchAgent, baseDir: tmpBase })
    assert.strictEqual(r.processed, 0)
  } finally {
    fs.rmSync(tmpBase, { recursive: true, force: true })
  }
})

// ─── buildClaudeDispatcher ──────────────────────────────────────────────────

test('buildClaudeDispatcher: returns a dispatch closure that calls callLLM and parses verdict', async () => {
  let captured
  const callLLM = async (prompt, opts) => {
    captured = { prompt, opts }
    return JSON.stringify({ verdict: 'CONFIRMED', reason: 'GDPR violation' })
  }
  const dispatch = buildClaudeDispatcher({ callLLM, model: 'test-model' })
  const handoff = {
    handoff_id: 'h-1',
    source_squad: 'pentest', source_agent: 'A', source_finding_id: 'F1',
    target_squad: 'cloud-security', target_capability: 'data-residency',
    request: { question: 'q', evidence: { url: 'https://x' } },
  }
  const result = await dispatch({
    agent: 'KUBERA', squad: 'cloud-security', capability: 'data-residency', handoff,
  })
  assert.strictEqual(result.verdict, 'CONFIRMED')
  assert.match(result.verdictReason, /GDPR/)
  assert.strictEqual(captured.opts.model, 'test-model',
    'dispatcher must pass through the configured model')
  assert.match(captured.prompt, /KUBERA/,
    'dispatcher must invoke the prompt builder')
})

// ─── event-bus wiring (module-level grep) ───────────────────────────────────

test('event-bus.js wires the handoff watcher at startup with fail-soft polling', () => {
  const ebPath = path.resolve(__dirname, '..', 'event-bus.js')
  const src = fs.readFileSync(ebPath, 'utf-8')
  assert.match(src, /require\(['"]\.\/agents\/handoff-resolver['"]\)/,
    'event-bus.js must require ./agents/handoff-resolver')
  // setInterval-based polling, NOT fs.watch (per Task 7 spec — polling more reliable)
  assert.match(src, /processInboxOnce/,
    'event-bus.js must reference processInboxOnce')
  // 30s polling cadence
  assert.match(src, /Handoff inbox watcher/i,
    'event-bus.js must log a startup message for the handoff watcher')
})
