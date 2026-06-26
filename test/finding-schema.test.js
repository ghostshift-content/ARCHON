
const __roots = require('../paths') // portable roots (KURU_*_ROOT) — see paths.js
// test/finding-schema.test.js
//
// Sprint A.2 (2026-05-09): canonical FindingSchema normalizer at specialist→pipeline boundary.
//
// Production audit on /root/intel/pentest/VALIDATED-FINDINGS.jsonl found:
//   - severity in 3 case variants ("High", "high", "medium") — case-sensitive comparisons silently miss half
//   - 42/48 findings missing `title` (DHARMA family uses `id` only; DURYODHANA family has both)
//   - 22 distinct key signatures (every agent stamps own `{agent}_ts`)
//   - Two schema families: DHARMA-style (id, original_agent, validation_status) and
//     DURYODHANA-style (findingId, type, agent, evidence as object)
//
// This module normalizes finding records to a canonical shape before they hit
// the judge, browser-verifier, or VYASA. Belt-and-suspenders: the judge prompt's
// extractEvidence already JSON-stringifies object evidence; normalization makes
// downstream comparisons (severity case, id presence) reliable too.

const assert = require('node:assert')
const { test } = require('node:test')

const { normalizeFinding, readFindingsFile } = require('../agents/finding-schema')

// ── normalizeFinding ──

test('normalizeFinding: severity case is coerced to title case', () => {
  assert.strictEqual(normalizeFinding({ severity: 'high' }).severity, 'High')
  assert.strictEqual(normalizeFinding({ severity: 'MEDIUM' }).severity, 'Medium')
  assert.strictEqual(normalizeFinding({ severity: 'critical' }).severity, 'Critical')
  assert.strictEqual(normalizeFinding({ severity: 'Info' }).severity, 'Info')
  assert.strictEqual(normalizeFinding({ severity: 'low' }).severity, 'Low')
})

test('normalizeFinding: severity defaults to Medium if missing or unrecognized', () => {
  assert.strictEqual(normalizeFinding({}).severity, 'Medium')
  assert.strictEqual(normalizeFinding({ severity: '' }).severity, 'Medium')
  assert.strictEqual(normalizeFinding({ severity: null }).severity, 'Medium')
  assert.strictEqual(normalizeFinding({ severity: 'urgent' }).severity, 'Medium', 'unrecognized labels default to Medium')
})

test('normalizeFinding: findingId is mapped to id when id missing (DURYODHANA family)', () => {
  const f = normalizeFinding({ findingId: 'X-123', type: 'csrf', severity: 'High' })
  assert.strictEqual(f.id, 'X-123', 'findingId should populate id when id is missing')
  assert.strictEqual(f.findingId, 'X-123', 'findingId is preserved (no destructive renaming)')
})

test('normalizeFinding: existing id wins over findingId when both present', () => {
  const f = normalizeFinding({ id: 'OG-001', findingId: 'X-123', severity: 'High' })
  assert.strictEqual(f.id, 'OG-001')
  assert.strictEqual(f.findingId, 'X-123')
})

test('normalizeFinding: title is synthesized from id when missing', () => {
  const f = normalizeFinding({ id: 'KARNA-SQLI-001', severity: 'High' })
  assert.ok(f.title, 'title must be populated')
  assert.match(f.title, /KARNA-SQLI-001/, 'title should reference the id when no original title')
})

test('normalizeFinding: title falls back to type when both id and title missing', () => {
  const f = normalizeFinding({ type: 'reflected_xss', severity: 'High' })
  assert.ok(f.title, 'title must be populated')
  assert.match(f.title, /xss/i, 'title should reference the type when id missing')
})

test('normalizeFinding: original title is preserved when present', () => {
  const f = normalizeFinding({ id: 'X', title: 'CSRF on /login endpoint', severity: 'High' })
  assert.strictEqual(f.title, 'CSRF on /login endpoint')
})

test('normalizeFinding: title falls back to "Untitled" with last-resort message', () => {
  const f = normalizeFinding({ severity: 'Low' })
  assert.ok(f.title, 'title must always be populated')
  assert.match(f.title, /untitled/i, 'last-resort title should mention "untitled"')
})

test('normalizeFinding: does not mutate the input record', () => {
  const input = { severity: 'high', id: 'X' }
  const normalized = normalizeFinding(input)
  assert.strictEqual(input.severity, 'high', 'input must not be mutated')
  assert.strictEqual(normalized.severity, 'High', 'output is normalized')
  assert.notStrictEqual(input, normalized, 'output is a fresh object')
})

test('normalizeFinding: object-shaped evidence is preserved (judge handles stringification)', () => {
  const obj = { command: 'curl evil.com', response: '200 OK' }
  const f = normalizeFinding({ severity: 'High', evidence: obj })
  assert.deepStrictEqual(f.evidence, obj, 'evidence object preserved (judge stringifies at prompt build)')
})

test('normalizeFinding: handles null/undefined input gracefully', () => {
  const f = normalizeFinding(null)
  assert.ok(f, 'should return a record (not crash)')
  assert.strictEqual(f.severity, 'Medium')
  assert.ok(f.title)
})

// ── readFindingsFile ──

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

test('readFindingsFile: reads JSONL, parses, and normalizes each line', () => {
  const tmpFile = path.join(os.tmpdir(), `finding-schema-${Date.now()}.jsonl`)
  fs.writeFileSync(tmpFile,
    JSON.stringify({ severity: 'high', findingId: 'A-1' }) + '\n' +
    JSON.stringify({ severity: 'Medium', id: 'B-2', title: 'preexisting' }) + '\n' +
    JSON.stringify({ severity: 'CRITICAL', id: 'C-3' }) + '\n'
  )
  try {
    const findings = readFindingsFile(tmpFile)
    assert.strictEqual(findings.length, 3)
    assert.strictEqual(findings[0].severity, 'High')
    assert.strictEqual(findings[0].id, 'A-1', 'findingId mapped to id')
    assert.strictEqual(findings[1].severity, 'Medium')
    assert.strictEqual(findings[1].title, 'preexisting')
    assert.strictEqual(findings[2].severity, 'Critical')
  } finally {
    fs.unlinkSync(tmpFile)
  }
})

test('readFindingsFile: returns empty array for missing file', () => {
  const findings = readFindingsFile('/nonexistent/path.jsonl')
  assert.deepStrictEqual(findings, [])
})

test('readFindingsFile: skips malformed JSON lines without crashing', () => {
  const tmpFile = path.join(os.tmpdir(), `finding-schema-malformed-${Date.now()}.jsonl`)
  fs.writeFileSync(tmpFile,
    JSON.stringify({ severity: 'High', id: 'A-1' }) + '\n' +
    'not valid json\n' +
    JSON.stringify({ severity: 'Low', id: 'B-2' }) + '\n'
  )
  try {
    const findings = readFindingsFile(tmpFile)
    assert.strictEqual(findings.length, 2, 'malformed line skipped, valid lines kept')
  } finally {
    fs.unlinkSync(tmpFile)
  }
})

test('readFindingsFile: handles real production file shape', () => {
  // If real production file exists, verify it parses without crashing.
  // Won't fail in CI (no production file there) — only in dev.
  const realFile = (__roots.INTEL_ROOT + '/pentest/VALIDATED-FINDINGS.jsonl')
  if (!fs.existsSync(realFile)) return
  const findings = readFindingsFile(realFile)
  assert.ok(Array.isArray(findings))
  // All severities should be canonical
  for (const f of findings) {
    assert.match(f.severity, /^(Critical|High|Medium|Low|Info)$/,
      `severity must be canonical (got "${f.severity}" on ${f.id || f.findingId})`)
    assert.ok(f.title, `every finding must have a title (id=${f.id})`)
    assert.ok(f.id, `every finding must have an id (after findingId fallback)`)
  }
})

// ── validateFinding (Task 4 — enforcement gap closure) ──

test('validateFinding: returns {valid:true, finding, warnings:[]} for complete record', () => {
  const fs = require('../agents/finding-schema')
  const result = fs.validateFinding({
    id: 'F-001',
    title: 'CSRF',
    severity: 'Medium',
    validation_status: 'confirmed',
    original_agent: 'NAKUL',
    taskId: '1234567890',
  })
  assert.strictEqual(result.valid, true)
  assert.deepStrictEqual(result.warnings, [])
  assert.strictEqual(result.finding.id, 'F-001')
})

test('validateFinding: auto-repairs missing severity → Medium + warning', () => {
  const fs = require('../agents/finding-schema')
  const result = fs.validateFinding({
    id: 'F-002', title: 'X', validation_status: 'confirmed',
    original_agent: 'NAKUL', taskId: '123',
  })
  assert.strictEqual(result.valid, true)
  assert.strictEqual(result.finding.severity, 'Medium')
  assert.ok(result.warnings.some(w => /severity/i.test(w)))
})

test('validateFinding: auto-synthesizes missing id', () => {
  const fs = require('../agents/finding-schema')
  const result = fs.validateFinding({
    title: 'X', severity: 'Low', validation_status: 'confirmed',
    original_agent: 'NAKUL', taskId: '123',
  })
  assert.strictEqual(result.valid, true)
  assert.match(result.finding.id, /^F-AUTO-/)
  assert.ok(result.warnings.some(w => /id/i.test(w)))
})

test('validateFinding: auto-synthesizes missing title from id', () => {
  const fs = require('../agents/finding-schema')
  const result = fs.validateFinding({
    id: 'F-003', severity: 'Low', validation_status: 'confirmed',
    original_agent: 'NAKUL', taskId: '123',
  })
  assert.strictEqual(result.finding.title, 'F-003')
})

test('validateFinding: rejects non-object input', () => {
  const fs = require('../agents/finding-schema')
  assert.strictEqual(fs.validateFinding(null).valid, false)
  assert.strictEqual(fs.validateFinding(undefined).valid, false)
  assert.strictEqual(fs.validateFinding('a string').valid, false)
  assert.strictEqual(fs.validateFinding(42).valid, false)
  assert.strictEqual(fs.validateFinding([]).valid, false)
})

test('validateFinding: handles missing optional fields gracefully', () => {
  const fs = require('../agents/finding-schema')
  const result = fs.validateFinding({
    id: 'F-004', title: 'Y', severity: 'High',
    validation_status: 'confirmed', original_agent: 'NAKUL', taskId: '123',
    // no notes, details, url — all optional
  })
  assert.strictEqual(result.valid, true)
})
