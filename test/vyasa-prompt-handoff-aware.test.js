// test/vyasa-prompt-handoff-aware.test.js
//
// Sprint C.2 Task 8 (2026-05-10): VYASA report prompt scans
// /root/intel/handoffs/done/ for verdicts matching the current task and
// injects a CROSS-SQUAD CORROBORATION section listing each verdict grouped
// by source_finding_id. VYASA is told to cite handoff verdicts as
// ADDITIONAL evidence, not replacement for primary finding evidence.
//
// Closes the Sprint C.2 loop: ASHWATTHAMA fires handoff to KUBERA → KUBERA
// verdict in done/ → VYASA renders it under the source finding in the
// final report.
//
// Spec: docs/superpowers/specs/2026-05-10-sprint-c2-a2a-design.md
// Implementation: helper `buildCrossSquadCorroborationSection(taskId, {baseDir})`
// lives in agents/handoff-protocol.js (testable in isolation, no daemon spawn).

const assert = require('node:assert')
const { test } = require('node:test')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')

const SRC = fs.readFileSync(__dirname + '/../event-bus.js', 'utf-8')
const handoffProtocol = require('../agents/handoff-protocol')

function getVyasaBody() {
  const start = SRC.indexOf('function buildVyasaReportPrompt')
  assert.ok(start > 0, 'buildVyasaReportPrompt not found in event-bus.js')
  const next = SRC.indexOf('\nfunction ', start + 30)
  return SRC.slice(start, next > 0 ? next : start + 12000)
}

function makeTmpBase() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'handoff-vyasa-test-'))
  fs.mkdirSync(path.join(dir, 'inbox'), { recursive: true })
  fs.mkdirSync(path.join(dir, 'done'), { recursive: true })
  fs.mkdirSync(path.join(dir, 'failed'), { recursive: true })
  return dir
}

function writeDoneRecord(baseDir, record) {
  const filePath = path.join(baseDir, 'done', `${record.handoff_id}.json`)
  fs.writeFileSync(filePath, JSON.stringify(record, null, 2) + '\n')
  return filePath
}

test('handoff-protocol exports buildCrossSquadCorroborationSection helper', () => {
  assert.equal(typeof handoffProtocol.buildCrossSquadCorroborationSection, 'function',
    'helper must be exported so VYASA prompt builder can call it')
})

test('helper returns empty string when no matching handoffs exist (no false claims)', () => {
  const baseDir = makeTmpBase()
  try {
    const out = handoffProtocol.buildCrossSquadCorroborationSection('task-empty', { baseDir })
    assert.equal(out, '',
      'no matching done/ files → empty string (must NOT inject a fake CROSS-SQUAD section)')
  } finally {
    fs.rmSync(baseDir, { recursive: true, force: true })
  }
})

test('helper injects CROSS-SQUAD CORROBORATION section when matching handoffs exist', () => {
  const baseDir = makeTmpBase()
  try {
    writeDoneRecord(baseDir, {
      schema_version: '1',
      handoff_id: 'h-test-001',
      source_task_id: 'task-42',
      source_squad: 'pentest',
      source_agent: 'ASHWATTHAMA',
      source_finding_id: 'AS-007',
      target_squad: 'cloud-security',
      target_capability: 's3-bucket-audit',
      request: { question: 'Is bucket-x public?', evidence: {}, expected_artifacts: [] },
      created_at: '2026-05-10T05:00:00Z',
      status: 'completed',
      resolved_at: '2026-05-10T05:01:00Z',
      resolved_by_agent: 'KUBERA',
      verdict: 'CONFIRMED',
      verdict_reason: 'bucket policy allows s3:GetObject for Principal:*',
    })
    const out = handoffProtocol.buildCrossSquadCorroborationSection('task-42', { baseDir })
    assert.match(out, /CROSS-SQUAD CORROBORATION/i,
      'must include the section heading')
    assert.match(out, /AS-007/, 'must group verdict by source_finding_id')
    assert.match(out, /KUBERA/, 'must name the responding agent')
    assert.match(out, /CONFIRMED/, 'must include the verdict')
    assert.match(out, /bucket policy/, 'must include the verdict reason')
  } finally {
    fs.rmSync(baseDir, { recursive: true, force: true })
  }
})

test('helper filters by source_task_id — handoffs from other tasks are excluded', () => {
  const baseDir = makeTmpBase()
  try {
    writeDoneRecord(baseDir, {
      schema_version: '1',
      handoff_id: 'h-mine',
      source_task_id: 'task-mine',
      source_squad: 'pentest', source_agent: 'A', source_finding_id: 'F1',
      target_squad: 'cloud-security', target_capability: 'iam-audit',
      request: { question: 'q', evidence: {}, expected_artifacts: [] },
      created_at: '2026-05-10T05:00:00Z',
      status: 'completed', resolved_by_agent: 'MITRA',
      verdict: 'CONFIRMED', verdict_reason: 'role over-privileged',
    })
    writeDoneRecord(baseDir, {
      schema_version: '1',
      handoff_id: 'h-other',
      source_task_id: 'task-other',
      source_squad: 'pentest', source_agent: 'A', source_finding_id: 'F99',
      target_squad: 'cloud-security', target_capability: 'data-residency',
      request: { question: 'q', evidence: {}, expected_artifacts: [] },
      created_at: '2026-05-10T05:00:00Z',
      status: 'completed', resolved_by_agent: 'KUBERA',
      verdict: 'KILLED', verdict_reason: 'data stays in region',
    })
    const out = handoffProtocol.buildCrossSquadCorroborationSection('task-mine', { baseDir })
    assert.match(out, /F1/, 'task-mine finding must appear')
    assert.match(out, /MITRA/, 'task-mine resolver must appear')
    assert.doesNotMatch(out, /F99/, 'other-task finding must NOT appear')
    assert.doesNotMatch(out, /KILLED/, 'other-task verdict must NOT appear')
  } finally {
    fs.rmSync(baseDir, { recursive: true, force: true })
  }
})

test('helper groups multiple verdicts by source_finding_id', () => {
  const baseDir = makeTmpBase()
  try {
    // Two handoffs for the same finding F1
    writeDoneRecord(baseDir, {
      schema_version: '1', handoff_id: 'h-a', source_task_id: 't', source_squad: 'pentest',
      source_agent: 'A', source_finding_id: 'F1', target_squad: 'cloud-security',
      target_capability: 's3-bucket-audit',
      request: { question: 'q', evidence: {}, expected_artifacts: [] },
      created_at: 'x', status: 'completed', resolved_by_agent: 'AGNI',
      verdict: 'CONFIRMED', verdict_reason: 'public ACL',
    })
    writeDoneRecord(baseDir, {
      schema_version: '1', handoff_id: 'h-b', source_task_id: 't', source_squad: 'pentest',
      source_agent: 'A', source_finding_id: 'F1', target_squad: 'cloud-security',
      target_capability: 'iam-audit',
      request: { question: 'q', evidence: {}, expected_artifacts: [] },
      created_at: 'x', status: 'completed', resolved_by_agent: 'MITRA',
      verdict: 'CONFIRMED', verdict_reason: 'role allows write',
    })
    const out = handoffProtocol.buildCrossSquadCorroborationSection('t', { baseDir })
    // F1 should appear once as a header, with both AGNI and MITRA underneath.
    const f1Count = (out.match(/F1/g) || []).length
    assert.ok(f1Count >= 1, 'F1 must appear at least once as a group header')
    assert.match(out, /AGNI/, 'first verdict must appear')
    assert.match(out, /MITRA/, 'second verdict must appear')
  } finally {
    fs.rmSync(baseDir, { recursive: true, force: true })
  }
})

test('VYASA prompt body references handoffs/done OR cross-squad OR corroboration', () => {
  const body = getVyasaBody()
  assert.match(body, /handoffs\/done|cross-squad|CROSS-SQUAD|corroboration/i,
    'buildVyasaReportPrompt must read from /root/intel/handoffs/done/ or mention cross-squad corroboration')
})

test('VYASA instructions cite handoff verdicts as ADDITIONAL evidence (anti-sycophancy)', () => {
  const body = getVyasaBody()
  // VYASA must be told the handoff verdict is ADDITIONAL, not replacement.
  assert.match(body, /additional|supplement|alongside|in addition|cite.+(under|with).+(finding|evidence)/i,
    'VYASA must be told handoff verdicts are ADDITIONAL evidence, not replacement for primary finding evidence')
})

test('VYASA prompt invokes the helper with the actual taskId', () => {
  const body = getVyasaBody()
  // Implementation should call buildCrossSquadCorroborationSection(taskId).
  assert.match(body, /buildCrossSquadCorroborationSection\s*\(\s*taskId/,
    'buildVyasaReportPrompt must invoke buildCrossSquadCorroborationSection(taskId)')
})
