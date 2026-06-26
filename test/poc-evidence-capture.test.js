// test/poc-evidence-capture.test.js
// Covers the universal evidence-capture module. The bug-bounty PoC session
// surfaced that "evidence" was freeform LLM text — concrete data wasn't
// stored. This module captures real response artifacts deterministically.

const assert = require('node:assert')
const { test } = require('node:test')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const {
  captureUrl,
  captureForValidatedFindings,
  writeEvidenceFile,
  readCapturesForTask,
  extractUrlsFromFinding,
  sanitizeHeaders,
  truncateBody,
  MAX_BODY_BYTES,
} = require('../agents/poc-evidence-capture')

function mkTmpIntel() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'poc-evidence-'))
}

test('extractUrlsFromFinding pulls URLs from common finding shapes', () => {
  const f = {
    affected_url: 'https://example.com/api',
    url: 'https://example.com/api',  // dup, should de-dup
    reproduction_method: 'curl https://example.com/secret && curl https://other.example.com/x',
    details: 'See logs at https://logs.example.com',
  }
  const urls = extractUrlsFromFinding(f)
  assert.ok(urls.includes('https://example.com/api'))
  assert.ok(urls.includes('https://example.com/secret'))
  assert.ok(urls.includes('https://other.example.com/x'))
  assert.ok(urls.includes('https://logs.example.com'))
  // No duplicates
  assert.strictEqual(new Set(urls).size, urls.length)
})

test('extractUrlsFromFinding returns empty for findings with no URLs', () => {
  assert.deepStrictEqual(extractUrlsFromFinding({}), [])
  assert.deepStrictEqual(extractUrlsFromFinding(null), [])
  assert.deepStrictEqual(extractUrlsFromFinding({ title: 'No URL here' }), [])
})

test('extractUrlsFromFinding caps at 5 URLs total per finding', () => {
  const f = {
    details: Array.from({length: 20}, (_, i) => `https://example.com/p${i}`).join(' '),
  }
  const urls = extractUrlsFromFinding(f)
  assert.ok(urls.length <= 5)
})

test('sanitizeHeaders redacts cookies / auth / csrf tokens', () => {
  const out = sanitizeHeaders({
    'Content-Type': 'application/json',
    'set-cookie': 'session=secret-value',
    Authorization: 'Bearer abc.def.ghi',
    'X-CSRF-Token': 'csrf-secret',
    'X-Other': 'safe',
  })
  assert.strictEqual(out['Content-Type'], 'application/json')
  assert.strictEqual(out['set-cookie'], '[REDACTED]')
  assert.strictEqual(out['Authorization'], '[REDACTED]')
  assert.strictEqual(out['X-CSRF-Token'], '[REDACTED]')
  assert.strictEqual(out['X-Other'], 'safe')
})

test('truncateBody caps at MAX_BODY_BYTES and records original length', () => {
  const small = 'hello'
  const r1 = truncateBody(small)
  assert.strictEqual(r1.body, 'hello')
  assert.strictEqual(r1.truncated, false)
  assert.strictEqual(r1.original_length, 5)

  const huge = 'x'.repeat(MAX_BODY_BYTES + 100)
  const r2 = truncateBody(huge)
  assert.strictEqual(r2.body.length, MAX_BODY_BYTES)
  assert.strictEqual(r2.truncated, true)
  assert.strictEqual(r2.original_length, MAX_BODY_BYTES + 100)
})

test('captureUrl uses injectable fetchImpl + returns artifact shape', async () => {
  const mockFetch = async (url, opts) => ({
    status: 200,
    headers: { 'content-type': 'application/json' },
    body: '{"hello":"world"}',
    error: null,
  })
  const artifact = await captureUrl({
    url: 'https://example.com/x',
    fetchImpl: mockFetch,
  })
  assert.strictEqual(artifact.url, 'https://example.com/x')
  assert.strictEqual(artifact.response_status, 200)
  assert.strictEqual(artifact.response_body, '{"hello":"world"}')
  assert.strictEqual(artifact.response_body_truncated, false)
  assert.ok(typeof artifact.timing_ms === 'number')
  assert.ok(artifact.captured_at)
})

test('captureUrl surfaces fetch errors without throwing', async () => {
  const failingFetch = async () => ({ status: 0, headers: {}, body: '', error: 'ECONNREFUSED' })
  const artifact = await captureUrl({ url: 'http://localhost:1/dead', fetchImpl: failingFetch })
  assert.strictEqual(artifact.response_status, 0)
  assert.strictEqual(artifact.error, 'ECONNREFUSED')
})

test('writeEvidenceFile creates per-task directory + atomic write', () => {
  const tmp = mkTmpIntel()
  const artifact = { schema_version: '1', task_id: 'T-1', finding_id: 'F-1', captures: [] }
  const outPath = writeEvidenceFile({ taskId: 'T-1', findingId: 'F-1', artifact, intelDir: tmp })
  assert.match(outPath, /poc-evidence\/T-1\/F-1\.json$/)
  assert.ok(fs.existsSync(outPath))
  const read = JSON.parse(fs.readFileSync(outPath, 'utf-8'))
  assert.strictEqual(read.task_id, 'T-1')
  // No .tmp leftover
  assert.strictEqual(fs.existsSync(outPath + '.tmp'), false)
  fs.rmSync(tmp, { recursive: true, force: true })
})

test('writeEvidenceFile sanitizes finding_id path component', () => {
  const tmp = mkTmpIntel()
  const artifact = { task_id: 'T-1', finding_id: '../../etc/passwd', captures: [] }
  const outPath = writeEvidenceFile({ taskId: 'T-1', findingId: '../../etc/passwd', artifact, intelDir: tmp })
  // Should contain sanitized name, not traverse
  assert.ok(outPath.startsWith(path.join(tmp, 'poc-evidence', 'T-1')))
  assert.ok(!outPath.includes('etc/passwd'))
  fs.rmSync(tmp, { recursive: true, force: true })
})

test('captureForValidatedFindings: findings with URLs get artifacts written', async () => {
  const tmp = mkTmpIntel()
  const findings = [
    { id: 'F-1', severity: 'High', url: 'https://example.com/a', title: 'A' },
    { id: 'F-2', severity: 'Medium', affected_url: 'https://example.com/b', title: 'B' },
    { id: 'F-3', severity: 'Low', title: 'No URL — should skip' }, // no URL
  ]
  const mockFetch = async (url) => ({
    status: 200, headers: { ct: 'json' }, body: `body-for-${url}`, error: null,
  })
  const result = await captureForValidatedFindings({
    taskId: 'TEST-CAP',
    findings,
    fetchImpl: mockFetch,
    intelDir: tmp,
  })
  assert.strictEqual(result.captured.length, 2)
  assert.strictEqual(result.skipped.length, 1)
  assert.strictEqual(result.skipped[0].reason, 'no-url-in-finding')

  // Verify files on disk
  const dir = path.join(tmp, 'poc-evidence', 'TEST-CAP')
  const files = fs.readdirSync(dir)
  assert.strictEqual(files.length, 2)
  assert.ok(files.includes('F-1.json'))
  assert.ok(files.includes('F-2.json'))

  // Verify artifact content
  const f1 = JSON.parse(fs.readFileSync(path.join(dir, 'F-1.json'), 'utf-8'))
  assert.strictEqual(f1.finding_id, 'F-1')
  assert.strictEqual(f1.captures[0].response_body, 'body-for-https://example.com/a')

  fs.rmSync(tmp, { recursive: true, force: true })
})

test('captureForValidatedFindings: fail-soft on individual capture errors', async () => {
  const tmp = mkTmpIntel()
  const findings = [
    { id: 'F-OK', severity: 'High', url: 'https://ok.example.com' },
    { id: 'F-FAIL', severity: 'High', url: 'https://fail.example.com' },
  ]
  let call = 0
  const flakyFetch = async (url) => {
    call++
    if (url.includes('fail')) throw new Error('forced fail')
    return { status: 200, headers: {}, body: 'ok', error: null }
  }
  const result = await captureForValidatedFindings({
    taskId: 'TEST-FAIL',
    findings,
    fetchImpl: flakyFetch,
    intelDir: tmp,
  })
  assert.strictEqual(result.captured.length, 1)
  assert.strictEqual(result.captured[0].finding_id, 'F-OK')
  assert.strictEqual(result.errors.length, 1)
  assert.match(result.errors[0].error, /forced fail/)
  fs.rmSync(tmp, { recursive: true, force: true })
})

test('readCapturesForTask reads back previously written artifacts', () => {
  const tmp = mkTmpIntel()
  const dir = path.join(tmp, 'poc-evidence', 'TR-1')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'F-1.json'), JSON.stringify({
    finding_id: 'F-1', task_id: 'TR-1', captures: [{ response_body: 'test' }],
  }))
  fs.writeFileSync(path.join(dir, 'F-2.json'), JSON.stringify({
    finding_id: 'F-2', task_id: 'TR-1', captures: [],
  }))
  const map = readCapturesForTask('TR-1', { intelDir: tmp })
  assert.strictEqual(Object.keys(map).length, 2)
  assert.ok(map['F-1'])
  assert.ok(map['F-2'])
  assert.strictEqual(map['F-1'].captures[0].response_body, 'test')
  fs.rmSync(tmp, { recursive: true, force: true })
})

test('readCapturesForTask returns {} when no captures dir exists (fail-soft)', () => {
  const tmp = mkTmpIntel()
  const map = readCapturesForTask('NONE', { intelDir: tmp })
  assert.deepStrictEqual(map, {})
  fs.rmSync(tmp, { recursive: true, force: true })
})

test('Universal: works for cloud-security S3 URLs, network-pentest internal IPs', async () => {
  // Demonstrates squad-agnosticism: extractUrlsFromFinding handles any HTTP(S) URL.
  const cloudFinding = { id: 'CLOUD-1', severity: 'High',
    affected_url: 'https://my-bucket.s3.amazonaws.com/secret.json' }
  const netFinding = { id: 'NET-1', severity: 'High',
    url: 'http://10.0.0.5:8080/admin' }
  assert.deepStrictEqual(extractUrlsFromFinding(cloudFinding), ['https://my-bucket.s3.amazonaws.com/secret.json'])
  assert.deepStrictEqual(extractUrlsFromFinding(netFinding), ['http://10.0.0.5:8080/admin'])
})
