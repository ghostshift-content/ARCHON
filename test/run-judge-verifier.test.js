// test/run-judge-verifier.test.js
//
// Integration test for scripts/run-judge-verifier.js — the G1 MVP CLI runner.
// Spec: docs/superpowers/specs/2026-05-06-G1-judge-verifier-design.md §5 MVP

const assert = require('node:assert')
const { test } = require('node:test')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const { runJudge, readFindings, writeJudged, findValidatedFile } = require('../scripts/run-judge-verifier')

function mkTmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'judge-runner-'))
}

const ALL_PASS_RESPONSE = JSON.stringify({
  stage_a: { pass: true, reason: 'real production code' },
  stage_b: { pass: true, reason: 'unauth attacker' },
  stage_c: { pass: true, reason: 'reachable via HTTPS' },
  stage_d: { pass: true, reason: 'no upstream mitigation' },
  verdict: 'confirmed',
  first_failed_stage: null,
})

function buildResponseDowngraded(stage, reason = 'fail') {
  const base = {
    stage_a: { pass: true, reason: 'ok' },
    stage_b: { pass: true, reason: 'ok' },
    stage_c: { pass: true, reason: 'ok' },
    stage_d: { pass: true, reason: 'ok' },
  }
  base[`stage_${stage.toLowerCase()}`] = { pass: false, reason }
  base.verdict = 'downgraded'
  base.first_failed_stage = stage
  return JSON.stringify(base)
}

test('readFindings parses one JSON object per line', () => {
  const dir = mkTmp()
  const file = path.join(dir, 'V.jsonl')
  fs.writeFileSync(file, '{"id":"a","severity":"High"}\n{"id":"b","severity":"Low"}\n')
  const findings = readFindings(file)
  assert.strictEqual(findings.length, 2)
  assert.strictEqual(findings[0].id, 'a')
  assert.strictEqual(findings[1].severity, 'Low')
  fs.rmSync(dir, { recursive: true, force: true })
})

test('readFindings tolerates trailing whitespace and blank lines', () => {
  const dir = mkTmp()
  const file = path.join(dir, 'V.jsonl')
  fs.writeFileSync(file, '{"id":"a"}\n\n  \n{"id":"b"}\n  ')
  const findings = readFindings(file)
  assert.strictEqual(findings.length, 2)
  fs.rmSync(dir, { recursive: true, force: true })
})

test('writeJudged emits one JSON object per line + trailing newline', () => {
  const dir = mkTmp()
  const out = writeJudged([{ id: 'a' }, { id: 'b' }, { id: 'c' }], 'TX', dir)
  assert.strictEqual(path.basename(out), 'JUDGED-FINDINGS-TX.jsonl')
  const content = fs.readFileSync(out, 'utf-8')
  assert.ok(content.endsWith('\n'), 'must end with newline')
  const lines = content.trim().split('\n')
  assert.strictEqual(lines.length, 3)
  assert.strictEqual(JSON.parse(lines[0]).id, 'a')
  fs.rmSync(dir, { recursive: true, force: true })
})

test('runJudge happy path: 2 findings all confirmed → severity preserved', async () => {
  const dir = mkTmp()
  const validatedFile = path.join(dir, 'VALIDATED-FINDINGS-T1.jsonl')
  const findings = [
    { id: 'F1', severity: 'High', title: 'XSS', url: 'https://t', description: 'reflected' },
    { id: 'F2', severity: 'Critical', title: 'SQLi', url: 'https://t', description: 'auth-bypass' },
  ]
  fs.writeFileSync(validatedFile, findings.map(f => JSON.stringify(f)).join('\n') + '\n')

  const callLLM = async () => ALL_PASS_RESPONSE
  const result = await runJudge({ taskId: 'T1', file: validatedFile, callLLM })

  assert.ok(fs.existsSync(result.outFile), 'JUDGED-FINDINGS file written')
  assert.strictEqual(path.dirname(result.outFile), dir, 'output sits next to input')

  const lines = fs.readFileSync(result.outFile, 'utf-8').trim().split('\n')
  assert.strictEqual(lines.length, 2)

  const out0 = JSON.parse(lines[0])
  assert.strictEqual(out0.judge_verdict, 'confirmed')
  assert.strictEqual(out0.severity, 'High', 'severity preserved on confirm')
  assert.strictEqual(out0.severity_original, 'High')
  assert.deepStrictEqual(out0.judge_stages.a, { pass: true, reason: 'real production code' })

  assert.strictEqual(result.summary.total, 2)
  assert.strictEqual(result.summary.confirmed, 2)
  assert.strictEqual(result.summary.downgraded, 0)
  fs.rmSync(dir, { recursive: true, force: true })
})

test('runJudge: stage B failure caps High → Medium', async () => {
  const dir = mkTmp()
  const validatedFile = path.join(dir, 'VALIDATED-FINDINGS-T2.jsonl')
  const findings = [
    { id: 'F1', severity: 'High', title: 'requires already-root', url: 'https://t' },
  ]
  fs.writeFileSync(validatedFile, findings.map(f => JSON.stringify(f)).join('\n') + '\n')

  const callLLM = async () => buildResponseDowngraded('B', 'requires root')
  const result = await runJudge({ taskId: 'T2', file: validatedFile, callLLM })

  const out = JSON.parse(fs.readFileSync(result.outFile, 'utf-8').trim())
  assert.strictEqual(out.judge_verdict, 'downgraded')
  assert.strictEqual(out.severity, 'Medium', 'Stage B fail caps at Medium')
  assert.strictEqual(out.severity_original, 'High')
  assert.strictEqual(out.judge_first_failed_stage, 'B')
  assert.strictEqual(result.summary.downgraded, 1)
  assert.strictEqual(result.summary.downgraded_by_stage.B, 1)
  fs.rmSync(dir, { recursive: true, force: true })
})

test('runJudge: stage A failure crushes Critical → Info', async () => {
  const dir = mkTmp()
  const validatedFile = path.join(dir, 'VALIDATED-FINDINGS-T3.jsonl')
  fs.writeFileSync(validatedFile,
    JSON.stringify({ id: 'F1', severity: 'Critical', title: 'test fixture flagged' }) + '\n')

  const callLLM = async () => buildResponseDowngraded('A', 'test code, not production')
  const result = await runJudge({ taskId: 'T3', file: validatedFile, callLLM })
  const out = JSON.parse(fs.readFileSync(result.outFile, 'utf-8').trim())

  assert.strictEqual(out.severity, 'Info')
  assert.strictEqual(out.severity_original, 'Critical')
  assert.strictEqual(result.summary.downgraded_by_stage.A, 1)
  fs.rmSync(dir, { recursive: true, force: true })
})

test('runJudge: missing taskId throws clearly', async () => {
  await assert.rejects(
    () => runJudge({ taskId: 'NONEXISTENT-99999999', callLLM: async () => '' }),
    /No VALIDATED-FINDINGS/,
  )
})

test('runJudge: explicit --file overrides taskId path lookup', async () => {
  const dir = mkTmp()
  const validatedFile = path.join(dir, 'whatever-name.jsonl')
  fs.writeFileSync(validatedFile, JSON.stringify({ id: 'X', severity: 'Low', title: 't' }) + '\n')
  const result = await runJudge({ file: validatedFile, taskId: 'CUSTOM', callLLM: async () => ALL_PASS_RESPONSE })
  assert.ok(fs.existsSync(result.outFile))
  assert.strictEqual(path.basename(result.outFile), 'JUDGED-FINDINGS-CUSTOM.jsonl')
  fs.rmSync(dir, { recursive: true, force: true })
})

test('runJudge: LLM error on a finding yields indeterminate, others continue', async () => {
  const dir = mkTmp()
  const validatedFile = path.join(dir, 'VALIDATED-FINDINGS-T4.jsonl')
  fs.writeFileSync(validatedFile,
    JSON.stringify({ id: 'F1', severity: 'High' }) + '\n' +
    JSON.stringify({ id: 'F2', severity: 'High' }) + '\n')

  let callCount = 0
  const callLLM = async () => {
    callCount++
    if (callCount === 1) throw new Error('rate limit')
    return ALL_PASS_RESPONSE
  }
  const result = await runJudge({ taskId: 'T4', file: validatedFile, callLLM })

  assert.strictEqual(result.summary.total, 2)
  assert.strictEqual(result.summary.confirmed, 1, 'F2 confirmed')
  assert.strictEqual(result.summary.indeterminate, 1, 'F1 indeterminate (LLM error)')
  fs.rmSync(dir, { recursive: true, force: true })
})

test('findValidatedFile checks intel/ then intel/pentest/', () => {
  // Pure existence-check: not assertions about real files, just that the function
  // doesn't throw and returns null for nonsense IDs.
  const result = findValidatedFile('ZZZ-DOES-NOT-EXIST-9999999')
  assert.strictEqual(result, null)
})
