// test/active-poc-runner.test.js

const assert = require('node:assert')
const { test } = require('node:test')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const runner = require('../agents/active-poc-runner')

const FAKE_PERM = {
  permission_id: 'p', issued_by: 'jay',
  valid_until: '2099-01-01T00:00:00Z',
  scope_domains: ['*.example.com'],
  capabilities: ['vpn-no-lockout', 'pii-endpoint-snapshot'],
  max_total_probes: 10, max_per_finding: 5,
}

test('skips entire run when env flag not set', async () => {
  delete process.env.ARCHON_ACTIVE_POC
  const r = await runner.runActivePocsForTask({
    taskId: 't1', permission: FAKE_PERM, findings: [],
  })
  assert.strictEqual(r.skipped, true)
  assert.match(r.skip_reason, /env/)
})

test('matches finding to probe by capability+squad', async () => {
  process.env.ARCHON_ACTIVE_POC = 'enabled'
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'poc-run-'))
  const findings = [
    { id: 'F-1', url: 'https://webvpn.us.example.com/+webvpn+/index.html',
      validation_status: 'CONFIRMED' },
  ]
  const fakeProbeRegistry = {
    'vpn-no-lockout': {
      name: 'vpn-no-lockout', squad: 'pentest',
      targets_capability: 'vpn-no-lockout', max_attempts: 5,
      async run(finding, ctx) {
        return { attempts: [{ attempt: 1, status: 200, body_preview: 'a0=8' }],
          no_lockout_proven: true, aborted_on_defender: false }
      },
    },
  }
  const r = await runner.runActivePocsForTask({
    taskId: 't1', permission: FAKE_PERM, findings,
    probeRegistry: fakeProbeRegistry,
    auditDir: tmpDir,
  })
  assert.strictEqual(r.probes_run, 1)
  assert.ok(r.audit_path)
  assert.ok(fs.existsSync(r.audit_path))
  delete process.env.ARCHON_ACTIVE_POC
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

test('respects scope_domains filter', async () => {
  process.env.ARCHON_ACTIVE_POC = 'enabled'
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'poc-run-'))
  const findings = [
    { id: 'F-1', url: 'https://different-host.com/vpn',
      validation_status: 'CONFIRMED' },
  ]
  const fakeProbeRegistry = {
    'vpn-no-lockout': {
      name: 'vpn-no-lockout', squad: 'pentest',
      targets_capability: 'vpn-no-lockout', max_attempts: 5,
      async run() { return { ran: true } },
    },
  }
  const r = await runner.runActivePocsForTask({
    taskId: 't1', permission: FAKE_PERM, findings,
    probeRegistry: fakeProbeRegistry, auditDir: tmpDir,
  })
  assert.strictEqual(r.probes_run, 0)
  assert.ok(r.skipped_reasons.some(x => /scope/.test(x.reason)))
  delete process.env.ARCHON_ACTIVE_POC
  fs.rmSync(tmpDir, { recursive: true, force: true })
})
