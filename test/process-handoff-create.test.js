
const __roots = require('../paths') // portable roots (KURU_*_ROOT) — see paths.js
// test/process-handoff-create.test.js
//
// Sprint C.2 follow-up (2026-05-10): the handoff CLI's `--create` mode lets
// specialists drop a handoff JSON into the inbox without writing a markdown
// fallback. Live pentest 1778394458903 confirmed specialists tried
// `process-handoff.js --create` (referenced from event-bus.js A2A_HANDOFF_SECTION)
// and silently failed because the flag did not exist. These tests lock in
// the contract.
//
// Forms exercised:
//   --create '<json>'
//   --create-stdin   (JSON from stdin)
//   --create-file <path>
//   --base-dir <path> (override inbox root for testing)

const assert = require('node:assert')
const { test } = require('node:test')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const { spawnSync } = require('node:child_process')

const CLI = path.resolve(__dirname, '..', 'scripts', 'process-handoff.js')

function freshTmpBase() {
  const tmp = path.join(os.tmpdir(), `phc-create-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
  fs.mkdirSync(path.join(tmp, 'inbox'), { recursive: true })
  return tmp
}

function validHandoffJson() {
  return {
    source_task_id: 'CLI-T1',
    source_squad: 'pentest',
    source_agent: 'ASHWATTHAMA',
    source_finding_id: 'CLI-F1',
    target_squad: 'cloud-security',
    target_capability: 'data-residency',
    request: {
      question: 'Does this CDN route EU PII to us-east-1?',
      evidence: { cdn_url: 'https://example.invalid/x.js' },
      expected_artifacts: ['compliance_verdict'],
    },
  }
}

function runCli(args, { input } = {}) {
  return spawnSync('node', [CLI, ...args], {
    input: input == null ? undefined : input,
    encoding: 'utf-8',
  })
}

test('--create <valid-json> writes JSON to baseDir/inbox/ and prints handoff_id', () => {
  const tmpBase = freshTmpBase()
  try {
    const json = JSON.stringify(validHandoffJson())
    const r = runCli(['--create', json, '--base-dir', tmpBase])
    assert.strictEqual(r.status, 0, `exit=${r.status} stderr=${r.stderr}`)
    assert.match(r.stdout, /Handoff created: h-/, `stdout=${r.stdout}`)
    // Check at least one .json now lives in inbox/
    const inboxFiles = fs.readdirSync(path.join(tmpBase, 'inbox')).filter(f => f.endsWith('.json'))
    assert.strictEqual(inboxFiles.length, 1, `expected 1 inbox file, got ${inboxFiles.length}`)
    const written = JSON.parse(fs.readFileSync(path.join(tmpBase, 'inbox', inboxFiles[0]), 'utf-8'))
    assert.strictEqual(written.source_task_id, 'CLI-T1')
    assert.strictEqual(written.target_squad, 'cloud-security')
    assert.strictEqual(written.target_capability, 'data-residency')
    assert.strictEqual(written.request.question, 'Does this CDN route EU PII to us-east-1?')
    assert.strictEqual(written.status, 'pending')
    // stdout includes the inbox path
    assert.ok(r.stdout.includes(tmpBase) || r.stdout.includes(inboxFiles[0]),
      `stdout should mention the file path; got: ${r.stdout}`)
  } finally {
    fs.rmSync(tmpBase, { recursive: true, force: true })
  }
})

test('--create <invalid-json> exits 1 with parse error', () => {
  const tmpBase = freshTmpBase()
  try {
    const r = runCli(['--create', '{not-json', '--base-dir', tmpBase])
    assert.strictEqual(r.status, 1, `expected exit 1, got ${r.status}`)
    assert.match(r.stderr, /JSON|parse/i, `stderr should mention JSON parse error: ${r.stderr}`)
    // Inbox should be empty
    const inboxFiles = fs.readdirSync(path.join(tmpBase, 'inbox')).filter(f => f.endsWith('.json'))
    assert.strictEqual(inboxFiles.length, 0)
  } finally {
    fs.rmSync(tmpBase, { recursive: true, force: true })
  }
})

test('--create JSON missing required field exits 1 with field error', () => {
  const tmpBase = freshTmpBase()
  try {
    const incomplete = validHandoffJson()
    delete incomplete.target_capability
    const r = runCli(['--create', JSON.stringify(incomplete), '--base-dir', tmpBase])
    assert.strictEqual(r.status, 1, `expected exit 1, got ${r.status} stdout=${r.stdout}`)
    assert.match(r.stderr, /target.*capability|missing.*field/i,
      `stderr should mention missing field: ${r.stderr}`)
    const inboxFiles = fs.readdirSync(path.join(tmpBase, 'inbox')).filter(f => f.endsWith('.json'))
    assert.strictEqual(inboxFiles.length, 0)
  } finally {
    fs.rmSync(tmpBase, { recursive: true, force: true })
  }
})

test('--create-stdin reads JSON from stdin and creates handoff', () => {
  const tmpBase = freshTmpBase()
  try {
    const json = JSON.stringify(validHandoffJson())
    const r = runCli(['--create-stdin', '--base-dir', tmpBase], { input: json })
    assert.strictEqual(r.status, 0, `exit=${r.status} stderr=${r.stderr}`)
    assert.match(r.stdout, /Handoff created: h-/)
    const inboxFiles = fs.readdirSync(path.join(tmpBase, 'inbox')).filter(f => f.endsWith('.json'))
    assert.strictEqual(inboxFiles.length, 1)
  } finally {
    fs.rmSync(tmpBase, { recursive: true, force: true })
  }
})

test('--create-file <path> reads JSON from file and creates handoff', () => {
  const tmpBase = freshTmpBase()
  const jsonPath = path.join(tmpBase, 'handoff-input.json')
  try {
    fs.writeFileSync(jsonPath, JSON.stringify(validHandoffJson()))
    const r = runCli(['--create-file', jsonPath, '--base-dir', tmpBase])
    assert.strictEqual(r.status, 0, `exit=${r.status} stderr=${r.stderr}`)
    assert.match(r.stdout, /Handoff created: h-/)
    const inboxFiles = fs.readdirSync(path.join(tmpBase, 'inbox')).filter(f => f.endsWith('.json'))
    assert.strictEqual(inboxFiles.length, 1)
  } finally {
    fs.rmSync(tmpBase, { recursive: true, force: true })
  }
})

test('--create with --base-dir <path> never touches /root/intel/handoffs/inbox/', () => {
  // Prevent the test from polluting production. We assert that after the
  // CLI runs against a tmp baseDir, NO file with our marker shows up in the
  // production inbox.
  const tmpBase = freshTmpBase()
  const marker = `BASEDIR-ISOLATION-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  try {
    const payload = validHandoffJson()
    payload.source_task_id = marker
    const r = runCli(['--create', JSON.stringify(payload), '--base-dir', tmpBase])
    assert.strictEqual(r.status, 0, `exit=${r.status} stderr=${r.stderr}`)
    // Tmp inbox must contain the marker
    const tmpInbox = path.join(tmpBase, 'inbox')
    const found = fs.readdirSync(tmpInbox)
      .filter(f => f.endsWith('.json'))
      .some(f => fs.readFileSync(path.join(tmpInbox, f), 'utf-8').includes(marker))
    assert.ok(found, 'handoff with marker should land in tmp inbox')
    // Production inbox must NOT contain our marker
    const prodInbox = (__roots.INTEL_ROOT + '/handoffs/inbox')
    if (fs.existsSync(prodInbox)) {
      const prodHas = fs.readdirSync(prodInbox)
        .filter(f => f.endsWith('.json'))
        .some(f => {
          try { return fs.readFileSync(path.join(prodInbox, f), 'utf-8').includes(marker) }
          catch { return false }
        })
      assert.strictEqual(prodHas, false, 'production inbox should NOT contain marker')
    }
  } finally {
    fs.rmSync(tmpBase, { recursive: true, force: true })
  }
})

test('--create-file with non-existent path exits 1', () => {
  const tmpBase = freshTmpBase()
  try {
    const missing = path.join(tmpBase, 'does-not-exist.json')
    const r = runCli(['--create-file', missing, '--base-dir', tmpBase])
    assert.strictEqual(r.status, 1, `expected exit 1, got ${r.status}`)
    assert.match(r.stderr, /not found|ENOENT|read|file/i,
      `stderr should mention file error: ${r.stderr}`)
  } finally {
    fs.rmSync(tmpBase, { recursive: true, force: true })
  }
})
