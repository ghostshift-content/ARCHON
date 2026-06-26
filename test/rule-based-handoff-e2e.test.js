// test/rule-based-handoff-e2e.test.js
//
// End-to-end validation that the rule-based-handoff-generator IS the
// architectural fix for the A2A prompt-to-action gap. Specialists are
// known not to organically emit handoff markers (round-7/8c/9 all 0/18).
// The generator post-processes their structured findings and emits
// markers programmatically — same pattern as the multi-agent code-review
// article ("Agents are just functions. Functions pass strictly typed
// objects to each other.").

const assert = require('node:assert')
const { test } = require('node:test')

const {
  generateHandoffsForTask,
  matchedRulesFor,
  isEligibleFinding,
} = require('../agents/rule-based-handoff-generator')

// Stub createHandoff that mimics handoff-protocol.createHandoff signature
// — captures emitted handoffs into an in-memory array for inspection.
function makeStubCreateHandoff() {
  const emitted = []
  const fn = (args) => {
    const rec = {
      handoff_id: `handoff-${args.sourceFindingId}-${args.targetCapability}`,
      source_task_id: args.sourceTaskId,
      source_squad: args.sourceSquad,
      source_finding_id: args.sourceFindingId,
      target_squad: args.targetSquad,
      target_capability: args.targetCapability,
      request: args.request,
    }
    emitted.push(rec)
    return rec
  }
  fn.emitted = emitted
  return fn
}

test('full chain: 0 specialist markers + 3 findings → ≥2 handoffs emitted', () => {
  const findings = [
    {
      id: 'F-1',
      severity: 'high',
      title: 'S3 bucket publicly readable',
      details: 'Bucket bucket.s3.amazonaws.com responds 200 to anonymous GET',
      url: 'https://test-bucket.s3.amazonaws.com/data.json',
      target: 'https://app.example.com',
      reproduction_method: 'curl -s https://test-bucket.s3.amazonaws.com/data.json',
    },
    {
      id: 'F-2',
      severity: 'critical',
      title: 'SSRF to internal corp.local',
      details: 'Webhook param accepts internal URL, response leaks 172.20.5.42 stack trace',
      url: 'https://app.example.com/webhook',
      target: 'https://app.example.com',
      reproduction_method: 'curl -X POST https://app.example.com/webhook -d url=http://internal-app.corp.local/',
    },
    {
      id: 'F-3',
      severity: 'high',
      title: 'Spring Boot 2.5.0 actuator endpoint exposed',
      details: 'Spring Boot 2.5.0 actuator endpoint /actuator/env reveals env vars',
      url: 'https://app.example.com/actuator/env',
      target: 'https://app.example.com',
      reproduction_method: 'curl https://app.example.com/actuator/env',
    },
  ]

  // Sanity: every finding is eligible (High/Critical) + matches ≥1 rule
  for (const f of findings) {
    assert.ok(isEligibleFinding(f), `${f.id} should be severity-eligible`)
    const rules = matchedRulesFor(f)
    assert.ok(rules.length > 0,
      `${f.id} should match at least one cross-squad rule, got ${JSON.stringify(rules.map(r => r.id))}`)
  }

  const createHandoff = makeStubCreateHandoff()
  const result = generateHandoffsForTask({
    findings,
    sourceTaskId: 'rbe2e-001',
    sourceSquad: 'pentest',
    sourceAgent: 'TEST',
    createHandoff,
  })

  // Each finding matched ≥1 rule, so ≥3 handoffs expected (could be more
  // if a single finding matches multiple distinct target squads/capabilities)
  assert.ok(result.created.length >= 3,
    `expected ≥3 handoffs, got ${result.created.length}: ${JSON.stringify(result)}`)
  assert.strictEqual(result.errors.length, 0, `unexpected errors: ${JSON.stringify(result.errors)}`)

  // Verify each emitted handoff carries canonical fields + no analyst leakage
  for (const rec of createHandoff.emitted) {
    assert.ok(rec.handoff_id, 'missing handoff_id')
    assert.ok(rec.source_task_id, 'missing source_task_id')
    assert.ok(rec.target_squad, 'missing target_squad')
    assert.ok(rec.request && rec.request.question, 'missing request.question')
    const ev = rec.request.evidence || {}
    for (const banned of ['rationale', 'my_analysis', 'severity_claim', 'notes']) {
      assert.ok(!(banned in ev), `leaked banned analyst field "${banned}"`)
    }
  }
})

test('Info-severity findings are skipped (cross-squad budget reserved for confirmed High/Critical)', () => {
  const findings = [{
    id: 'F-INFO', severity: 'info', title: 'Minor disclosure',
    details: 'banner reveals nginx 1.18', url: 'https://x.com/',
  }]
  const createHandoff = makeStubCreateHandoff()
  const result = generateHandoffsForTask({
    findings, sourceTaskId: 't', sourceSquad: 'pentest', sourceAgent: 'T', createHandoff,
  })
  assert.strictEqual(result.created.length, 0)
  assert.ok(result.skipped.some(s => s.reason === 'severity-not-eligible'))
})

test('idempotency: same findings + same task → stable handoff IDs', () => {
  const findings = [{
    id: 'F-IDEM', severity: 'high',
    title: 'S3 bucket public',
    details: 'bucket on s3.amazonaws.com responds 200',
    url: 'https://bucket.s3.amazonaws.com/file',
    target: 'https://x.com',
  }]
  const c1 = makeStubCreateHandoff()
  const c2 = makeStubCreateHandoff()
  generateHandoffsForTask({
    findings, sourceTaskId: 'idem', sourceSquad: 'pentest', sourceAgent: 'T', createHandoff: c1,
  })
  generateHandoffsForTask({
    findings, sourceTaskId: 'idem', sourceSquad: 'pentest', sourceAgent: 'T', createHandoff: c2,
  })
  // Same input → same emitted count + same (deterministic-shape) targets
  assert.strictEqual(c1.emitted.length, c2.emitted.length, 'same input should produce same count')
  for (let i = 0; i < c1.emitted.length; i++) {
    assert.strictEqual(c1.emitted[i].target_squad, c2.emitted[i].target_squad)
    assert.strictEqual(c1.emitted[i].target_capability, c2.emitted[i].target_capability)
    assert.strictEqual(c1.emitted[i].source_finding_id, c2.emitted[i].source_finding_id)
  }
})
