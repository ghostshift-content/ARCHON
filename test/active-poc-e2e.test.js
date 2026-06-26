// test/active-poc-e2e.test.js
//
// End-to-end validation of the active-poc dispatch path. Active-PoC
// requires THREE conditions to fire (defense-in-depth):
//   1. KURUKSHETRA_ACTIVE_POC=enabled env var
//   2. taskConfig.engagement_mode === 'active-poc'
//   3. Valid active_poc_permission token (id + issuer + unexpired
//      valid_until + scope_domains + capabilities + caps)
//
// This test exercises the runner against a mock probe registry — no
// real network traffic, no real targets — to prove that when all three
// gates are satisfied, probes do fire; and when any gate is missing,
// they don't.

const assert = require('node:assert')
const { test } = require('node:test')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const policy = require('../agents/active-poc-policy')
const runner = require('../agents/active-poc-runner')

function mkTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'apoc-e2e-'))
}

const VALID_PERMISSION = Object.freeze({
  permission_id: 'live-test-001',
  issued_by: 'jay',
  valid_until: '2099-12-31T00:00:00Z',
  scope_domains: ['*.example.com'],
  capabilities: ['vpn-no-lockout', 'pii-endpoint-snapshot'],
  max_total_probes: 10,
  max_per_finding: 3,
})

function buildMockRegistry(capturedRun) {
  return {
    'vpn-no-lockout': {
      name: 'vpn-no-lockout',
      squad: 'pentest',
      targets_capability: 'vpn-no-lockout',
      max_attempts: 5,
      async run(finding, ctx) {
        capturedRun.push({ capability: 'vpn-no-lockout', finding_id: finding.id })
        return { attempts: 5, no_lockout_proven: true, aborted_on_defender: false }
      },
    },
    'pii-endpoint-snapshot': {
      name: 'pii-endpoint-snapshot',
      squad: 'pentest',
      targets_capability: 'pii-endpoint-snapshot',
      max_attempts: 3,
      async run(finding, ctx) {
        capturedRun.push({ capability: 'pii-endpoint-snapshot', finding_id: finding.id })
        return { variants_tested: 3, pii_keys_observed: [], evidence: 'no pii returned' }
      },
    },
  }
}

test('end-to-end: env+permission+confirmed-finding → probe FIRES + audit written', async () => {
  process.env.KURUKSHETRA_ACTIVE_POC = 'enabled'
  const auditDir = mkTmpDir()
  const captured = []
  const findings = [{
    id: 'F-VPN-001',
    url: 'https://webvpn.example.com/+webvpn+/index.html',
    validation_status: 'CONFIRMED',
  }]

  const result = await runner.runActivePocsForTask({
    taskId: 'e2e-001',
    permission: VALID_PERMISSION,
    findings,
    probeRegistry: buildMockRegistry(captured),
    auditDir,
  })

  assert.strictEqual(result.skipped, false, 'should not skip — all gates passed')
  assert.ok(result.probes_run >= 1, `expected ≥1 probe run, got ${result.probes_run}`)
  assert.ok(captured.length >= 1, `expected probe captured, got ${captured.length}`)
  assert.ok(fs.existsSync(result.audit_path), 'audit JSONL should be written')

  const auditContent = fs.readFileSync(result.audit_path, 'utf-8')
  assert.ok(auditContent.length > 0, 'audit file should have content')
  assert.match(auditContent, /F-VPN-001/, 'audit should reference finding ID')

  delete process.env.KURUKSHETRA_ACTIVE_POC
  fs.rmSync(auditDir, { recursive: true, force: true })
})

test('env-gate: KURUKSHETRA_ACTIVE_POC unset → entire run silent', async () => {
  delete process.env.KURUKSHETRA_ACTIVE_POC
  const auditDir = mkTmpDir()
  const captured = []
  const findings = [{
    id: 'F-VPN-002',
    url: 'https://webvpn.example.com/+webvpn+/index.html',
    validation_status: 'CONFIRMED',
  }]

  const result = await runner.runActivePocsForTask({
    taskId: 'e2e-002',
    permission: VALID_PERMISSION,
    findings,
    probeRegistry: buildMockRegistry(captured),
    auditDir,
  })

  assert.strictEqual(result.skipped, true, 'env-gate must hold')
  assert.match(result.skip_reason, /env/i)
  assert.strictEqual(captured.length, 0, 'no probes should fire')

  fs.rmSync(auditDir, { recursive: true, force: true })
})

test('scope-gate: target out of scope → probe skipped, audit notes reason', async () => {
  process.env.KURUKSHETRA_ACTIVE_POC = 'enabled'
  const auditDir = mkTmpDir()
  const captured = []
  const findings = [{
    id: 'F-OUTSCOPE',
    url: 'https://different-host.com/vpn',
    validation_status: 'CONFIRMED',
  }]

  const result = await runner.runActivePocsForTask({
    taskId: 'e2e-003',
    permission: VALID_PERMISSION, // scope is *.example.com only
    findings,
    probeRegistry: buildMockRegistry(captured),
    auditDir,
  })

  assert.strictEqual(captured.length, 0, 'out-of-scope probe must not fire')
  assert.ok(result.skipped_reasons.some(s => /scope/i.test(s.reason)),
    `expected scope-skip reason, got ${JSON.stringify(result.skipped_reasons)}`)

  delete process.env.KURUKSHETRA_ACTIVE_POC
  fs.rmSync(auditDir, { recursive: true, force: true })
})

test('permission-validity: expired permission → validatePermission rejects', () => {
  const expired = {
    engagement_mode: 'active-poc',
    active_poc_permission: {
      permission_id: 'x', issued_by: 'x',
      valid_until: '2020-01-01T00:00:00Z',
      scope_domains: ['*.example.com'],
      capabilities: ['vpn-no-lockout'],
      max_total_probes: 1, max_per_finding: 1,
    },
  }
  const r = policy.validatePermission(expired)
  assert.strictEqual(r.ok, false)
  assert.match(r.reason, /expired/i)
})

test('non-confirmed finding skipped (validation_status check)', async () => {
  process.env.KURUKSHETRA_ACTIVE_POC = 'enabled'
  const auditDir = mkTmpDir()
  const captured = []
  const findings = [{
    id: 'F-SUSP',
    url: 'https://webvpn.example.com/+webvpn+/index.html',
    validation_status: 'SUSPECTED', // NOT CONFIRMED
  }]

  await runner.runActivePocsForTask({
    taskId: 'e2e-005',
    permission: VALID_PERMISSION,
    findings,
    probeRegistry: buildMockRegistry(captured),
    auditDir,
  })

  assert.strictEqual(captured.length, 0,
    'SUSPECTED findings must not trigger probes — only CONFIRMED')

  delete process.env.KURUKSHETRA_ACTIVE_POC
  fs.rmSync(auditDir, { recursive: true, force: true })
})
