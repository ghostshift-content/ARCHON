// test/rule-based-handoff-generator.test.js
//
// Covers the rule-based deterministic post-SENTRY handoff generator. The
// module exists because empirical data across rounds 7/8c/9 showed 0 organic
// specialist handoffs even with prompt + worked example. These tests lock in
// the behaviors that close the gap: severity gating, rule matching,
// anti-sycophancy stripping, per-target dedup within a finding, and idempotent
// integration with handoff-protocol.createHandoff.

const assert = require('node:assert')
const { test } = require('node:test')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const {
  generateHandoffsForTask,
  buildHandoffArgs,
  matchedRulesFor,
  isEligibleFinding,
  pickEvidence,
  findingText,
  RULES,
  STRIPPED_FIELDS,
  ELIGIBLE_SEVERITIES,
} = require('../agents/rule-based-handoff-generator')

const protocol = require('../agents/handoff-protocol')

function mkTmpBase() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'handoff-rules-'))
}

test('ELIGIBLE_SEVERITIES is exactly {critical, high}', () => {
  assert.deepStrictEqual(
    [...ELIGIBLE_SEVERITIES].sort(),
    ['critical', 'high']
  )
})

test('isEligibleFinding accepts mixed case High/CRITICAL, rejects Medium/Low/Info', () => {
  assert.strictEqual(isEligibleFinding({ severity: 'High' }), true)
  assert.strictEqual(isEligibleFinding({ severity: 'CRITICAL' }), true)
  assert.strictEqual(isEligibleFinding({ severity: 'critical' }), true)
  assert.strictEqual(isEligibleFinding({ severity: 'Medium' }), false)
  assert.strictEqual(isEligibleFinding({ severity: 'Low' }), false)
  assert.strictEqual(isEligibleFinding({ severity: 'Info' }), false)
  assert.strictEqual(isEligibleFinding({}), false)
  assert.strictEqual(isEligibleFinding(null), false)
})

test('pickEvidence copies raw fields only — no analyst commentary', () => {
  const finding = {
    url: 'https://example.com/x',
    affected_url: 'https://example.com/x',
    reproduction_method: 'GET /x',
    reproduction_result: '200 OK',
    cvss_vector: 'CVSS:3.1/AV:N',
    evidence_completeness: 'full',
    // Should be stripped:
    rationale: 'I think this is bad',
    my_analysis: 'classic pattern',
    severity_claim: 'high',
    severity: 'high',
    analyst_note: 'see the code',
    notes: 'follow up',
    false_positive_check: 'maybe a FP',
    conclusion: 'critical',
    recommendation: 'patch it',
    threat_model: { privilege: 'admin' },
  }
  const e = pickEvidence(finding)
  assert.strictEqual(e.url, 'https://example.com/x')
  assert.strictEqual(e.reproduction_method, 'GET /x')
  assert.strictEqual(e.cvss_vector, 'CVSS:3.1/AV:N')
  for (const k of STRIPPED_FIELDS) {
    assert.strictEqual(e[k], undefined, `STRIPPED_FIELDS leak: ${k}`)
  }
})

test('findingText concatenates evidence fields lowercase, excludes analyst fields', () => {
  const f = {
    title: 'Open Redirect On Login',
    url: 'https://example.COM/Login',
    notes: 'TOP SECRET ANALYST NOTE — should not appear',
  }
  const text = findingText(f)
  assert.match(text, /open redirect on login/)
  assert.match(text, /example\.com\/login/)
  assert.doesNotMatch(text, /top secret analyst note/i)
})

test('cloud-provider-touched rule matches S3, Azure, GCP, CloudFront URLs', () => {
  const f1 = { severity: 'high', url: 'https://bucket.s3.amazonaws.com/key' }
  const f2 = { severity: 'high', reproduction_method: 'curl https://blob.core.windows.net/x' }
  const f3 = { severity: 'high', details: 'leaked GCP key for *.googleapis.com' }
  const f4 = { severity: 'high', url: 'https://d12345.cloudfront.net/asset' }
  for (const f of [f1, f2, f3, f4]) {
    const rules = matchedRulesFor(f)
    assert.ok(
      rules.some(r => r.id === 'cloud-provider-touched'),
      `expected cloud-provider-touched match for ${JSON.stringify(f)}`
    )
  }
})

test('supply-chain rule fires on third-party / dependency / takeover signals (incl. round-9 zhaopin codification)', () => {
  const cases = [
    { severity: 'high', details: 'supply chain risk via npm package outdated' },
    { severity: 'high', url: 'https://cdn.jsdelivr.net/foo.js' },
    { severity: 'critical', details: 'subdomain takeover on cube.zhaopin.com exfiltrates JS context' },
    { severity: 'high', reproduction_method: 'GET /third-party/integration' },
  ]
  for (const f of cases) {
    const rules = matchedRulesFor(f)
    assert.ok(
      rules.some(r => r.id === 'supply-chain'),
      `expected supply-chain match for ${JSON.stringify(f)}`
    )
  }
})

test('network-attribution rule fires on RFC1918 internal IPs and DNS rebinding', () => {
  const cases = [
    { severity: 'high', reproduction_method: 'SSRF to internal 10.0.0.5' },
    { severity: 'critical', details: 'response leaks 192.168.10.42' },
    { severity: 'high', details: 'DNS rebinding to attacker-controlled host' },
    { severity: 'high', url: 'https://api.internal/v1/' },
  ]
  for (const f of cases) {
    const rules = matchedRulesFor(f)
    assert.ok(
      rules.some(r => r.id === 'network-attribution'),
      `expected network-attribution match for ${JSON.stringify(f)}`
    )
  }
})

test('framework-cve rule fires on CVE-XXXX-N patterns + known framework hints', () => {
  const cases = [
    { severity: 'high', details: 'VTEX IO version 1.2.3 vulnerable to CVE-2024-1234' },
    { severity: 'high', details: 'outdated framework detected: Spring Boot 2.x' },
    { severity: 'critical', reproduction_method: 'GET /wp-includes/version.php' },
  ]
  for (const f of cases) {
    const rules = matchedRulesFor(f)
    assert.ok(
      rules.some(r => r.id === 'framework-cve'),
      `expected framework-cve match for ${JSON.stringify(f)}`
    )
  }
})

test('Medium/Low/Info findings never match any rule (severity gate)', () => {
  const mediumWithCloud = {
    severity: 'Medium',
    url: 'https://bucket.s3.amazonaws.com/x',
  }
  // matchedRulesFor itself doesn't check severity (rules match on text), but
  // the public generateHandoffsForTask path skips ineligible severity FIRST.
  // Verify the integrated path enforces this:
  let createCalled = false
  const result = generateHandoffsForTask({
    findings: [mediumWithCloud],
    sourceTaskId: 't-x',
    sourceSquad: 'pentest',
    sourceAgent: 'VIPER',
    createHandoff: () => { createCalled = true; return { handoff_id: 'h-fake' } },
  })
  assert.strictEqual(createCalled, false, 'createHandoff should not fire for Medium')
  assert.strictEqual(result.created.length, 0)
  assert.strictEqual(result.skipped.length, 1)
  assert.strictEqual(result.skipped[0].reason, 'severity-not-eligible')
})

test('per-target dedup: one finding matching two rules to the same squad only fires one', () => {
  // Engineered finding that hits TWO cloud-security rules
  // (cloud-provider-touched + supply-chain — both target cloud-security).
  const finding = {
    severity: 'high',
    id: 'F-1',
    url: 'https://cdn.jsdelivr.net/lib.js', // supply-chain
    details: 's3 bucket controls dependency hosting', // cloud-provider-touched
  }
  const rules = matchedRulesFor(finding)
  const targets = rules.map(r => `${r.target_squad}|${r.target_capability}`)
  // Different capabilities are OK — that's two distinct handoffs.
  // Identical squad+capability must dedup.
  const uniqueTargets = new Set(targets)
  assert.strictEqual(
    targets.length, uniqueTargets.size,
    `dedup failed: ${JSON.stringify(targets)}`
  )
})

test('buildHandoffArgs synthesizes well-formed createHandoff args', () => {
  const finding = {
    id: 'F-42',
    severity: 'high',
    url: 'https://bucket.s3.amazonaws.com/k',
    affected_url: 'https://bucket.s3.amazonaws.com/k',
    reproduction_method: 'GET /k',
    reproduction_result: '200 with sensitive data',
    rationale: 'BANNED-ANALYST',
    notes: 'BANNED-NOTES',
    original_agent: 'TRACER',
  }
  const rule = RULES.find(r => r.id === 'cloud-provider-touched')
  const args = buildHandoffArgs({
    finding, rule,
    sourceTaskId: 'task-99',
    sourceSquad: 'pentest',
    sourceAgent: 'TRACER',
  })
  assert.strictEqual(args.sourceTaskId, 'task-99')
  assert.strictEqual(args.sourceSquad, 'pentest')
  assert.strictEqual(args.sourceAgent, 'TRACER')
  assert.strictEqual(args.sourceFindingId, 'F-42')
  assert.strictEqual(args.targetSquad, 'cloud-security')
  assert.strictEqual(args.targetCapability, 'cloud-misconfig')
  assert.ok(args.request.question.length > 30, 'question must be substantive')
  // Question must NOT contain analyst commentary
  assert.doesNotMatch(args.request.question, /banned-analyst|banned-notes/i)
  // Evidence must NOT contain stripped fields
  for (const k of STRIPPED_FIELDS) {
    assert.strictEqual(args.request.evidence[k], undefined)
  }
  // Evidence must contain raw fields
  assert.strictEqual(args.request.evidence.url, 'https://bucket.s3.amazonaws.com/k')
  assert.strictEqual(args.request.evidence.reproduction_method, 'GET /k')
  // expected_artifacts is a non-empty array
  assert.ok(Array.isArray(args.request.expected_artifacts))
  assert.ok(args.request.expected_artifacts.length > 0)
})

test('integrated: high finding flows through createHandoff and lands as canonical JSON in inbox/', () => {
  const baseDir = mkTmpBase()
  const findings = [
    {
      id: 'F-INT-1',
      severity: 'High',
      original_agent: 'RELAY',
      url: 'https://bucket.s3.amazonaws.com/secret-data',
      reproduction_method: 'curl https://bucket.s3.amazonaws.com/secret-data',
      reproduction_result: '200 OK with PII payload',
    },
  ]
  const wrappedCreate = (args) => protocol.createHandoff(args, { baseDir })
  const result = generateHandoffsForTask({
    findings,
    sourceTaskId: 'integration-1',
    sourceSquad: 'pentest',
    sourceAgent: 'RELAY',
    createHandoff: wrappedCreate,
  })
  assert.strictEqual(result.created.length, 1)
  assert.strictEqual(result.errors.length, 0)
  assert.strictEqual(result.created[0].target_squad, 'cloud-security')

  // Verify the actual JSON on disk matches the canonical schema and
  // is anti-sycophancy clean.
  const inboxFiles = fs.readdirSync(path.join(baseDir, 'inbox'))
  assert.strictEqual(inboxFiles.length, 1)
  const rec = JSON.parse(fs.readFileSync(path.join(baseDir, 'inbox', inboxFiles[0]), 'utf-8'))
  assert.strictEqual(rec.schema_version, '1')
  assert.strictEqual(rec.source_task_id, 'integration-1')
  assert.strictEqual(rec.source_squad, 'pentest')
  assert.strictEqual(rec.source_finding_id, 'F-INT-1')
  assert.strictEqual(rec.target_squad, 'cloud-security')
  assert.strictEqual(rec.status, 'pending')
  // Evidence on disk has no banned keys
  for (const k of STRIPPED_FIELDS) {
    assert.strictEqual(rec.request.evidence[k], undefined,
      `STRIPPED_FIELDS leaked to disk: ${k}`)
  }

  // Cleanup
  fs.rmSync(baseDir, { recursive: true, force: true })
})

test('idempotence: calling generateHandoffsForTask twice with same finding hits MAX_HANDOFFS_PER_FINDING cap', () => {
  const baseDir = mkTmpBase()
  const finding = {
    id: 'F-IDEM-1',
    severity: 'High',
    original_agent: 'VIPER',
    url: 'https://bucket.s3.amazonaws.com/x',
    reproduction_method: 'GET /x',
    details: 'supply chain via cdn.jsdelivr.net and 10.0.0.5 internal',
  }
  const wrappedCreate = (args) => protocol.createHandoff(args, { baseDir })

  // First run — should create up to MAX_HANDOFFS_PER_FINDING (3)
  const r1 = generateHandoffsForTask({
    findings: [finding],
    sourceTaskId: 'idem-1',
    sourceSquad: 'pentest',
    sourceAgent: 'VIPER',
    createHandoff: wrappedCreate,
  })
  assert.ok(r1.created.length <= protocol.MAX_HANDOFFS_PER_FINDING)
  assert.ok(r1.created.length > 0)

  // Second run — should hit the per-finding cap and surface errors
  const r2 = generateHandoffsForTask({
    findings: [finding],
    sourceTaskId: 'idem-1',
    sourceSquad: 'pentest',
    sourceAgent: 'VIPER',
    createHandoff: wrappedCreate,
  })
  // No new handoffs accepted (the protocol's MAX_HANDOFFS_PER_FINDING fires)
  assert.strictEqual(r2.created.length, 0,
    `second run created ${r2.created.length} — idempotence broken`)
  assert.ok(r2.errors.length > 0, 'cap rejection should surface in errors')

  fs.rmSync(baseDir, { recursive: true, force: true })
})

test('createHandoff that throws non-cap errors lands in errors[] without breaking the loop', () => {
  let calls = 0
  const flakyCreate = () => {
    calls++
    if (calls === 1) throw new Error('disk full')
    return { handoff_id: 'h-ok' }
  }
  const findings = [
    { id: 'F-A', severity: 'High', url: 'https://bucket.s3.amazonaws.com/x' },
    { id: 'F-B', severity: 'High', url: 'https://cdn.jsdelivr.net/y.js' },
  ]
  const r = generateHandoffsForTask({
    findings,
    sourceTaskId: 't-flaky',
    sourceSquad: 'pentest',
    sourceAgent: 'TEST',
    createHandoff: flakyCreate,
  })
  assert.strictEqual(r.errors.length, 1)
  assert.match(r.errors[0].error, /disk full/)
  assert.strictEqual(r.created.length, 1)
  assert.strictEqual(r.created[0].finding_id, 'F-B')
})

test('module exports RULES with non-empty rule set + every rule has the required shape', () => {
  assert.ok(Array.isArray(RULES) && RULES.length >= 3, 'need at least 3 rules')
  for (const r of RULES) {
    assert.ok(r.id, `rule missing id: ${JSON.stringify(r)}`)
    assert.ok(typeof r.match === 'function', `rule ${r.id} match must be fn`)
    assert.ok(r.target_squad, `rule ${r.id} target_squad`)
    assert.ok(r.target_capability, `rule ${r.id} target_capability`)
    assert.ok(typeof r.question === 'function', `rule ${r.id} question must be fn`)
    assert.ok(Array.isArray(r.expected_artifacts), `rule ${r.id} expected_artifacts must be array`)
  }
})

test('framework-cve rule catches outdated library + dependency-confusion hints', () => {
  const cases = [
    { severity: 'high', details: 'Spring Boot 2.5.0 actuator endpoint disclosed' },
    { severity: 'critical', details: 'npm package react-scripts@2.0.0 with known CVE' },
    { severity: 'high', details: 'composer.json reveals laravel ^6.0' },
  ]
  for (const f of cases) {
    const rules = matchedRulesFor(f)
    assert.ok(rules.some(r => r.id === 'framework-cve'),
      `expected framework-cve match for ${JSON.stringify(f)}`)
  }
})

test('supply-chain rule catches CDN-hosted JS + transitive deps', () => {
  const cases = [
    { severity: 'high', url: 'https://cdn.jsdelivr.net/npm/lodash@4.17.20' },
    { severity: 'critical', details: 'transitive dependency through subdomain takeover' },
    { severity: 'high', details: 'unpkg.com hosting unverified third-party JS' },
  ]
  for (const f of cases) {
    const rules = matchedRulesFor(f)
    assert.ok(rules.some(r => r.id === 'supply-chain'),
      `expected supply-chain for ${JSON.stringify(f)}`)
  }
})

test('data-residency rule catches cross-border + region-suffix hosts', () => {
  const cases = [
    { severity: 'high', url: 'https://eu-west-1.s3.amazonaws.com/bucket' },
    { severity: 'critical', details: 'data stored in cn-north-1 region without consent' },
    { severity: 'high', details: 'Costa Rica datacenter handling EU customer requests' },
  ]
  for (const f of cases) {
    const rules = matchedRulesFor(f)
    assert.ok(rules.some(r => r.id === 'data-residency'),
      `expected data-residency for ${JSON.stringify(f)}`)
  }
})

test('network-attribution rule catches private subnet leakage + reverse-DNS hints', () => {
  const cases = [
    { severity: 'high', details: 'SSRF response leaks Host: internal-app.corp.local' },
    { severity: 'critical', details: 'error stack reveals 172.20.5.42' },
    { severity: 'high', details: '.lan TLD reachable from external' },
  ]
  for (const f of cases) {
    const rules = matchedRulesFor(f)
    assert.ok(rules.some(r => r.id === 'network-attribution'),
      `expected network-attribution for ${JSON.stringify(f)}`)
  }
})
