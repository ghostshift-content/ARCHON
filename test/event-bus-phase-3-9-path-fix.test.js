// test/event-bus-phase-3-9-path-fix.test.js
//
// Round-6 fix (2026-05-09) was based on a flawed premise: it locked Phase 3.9
// to /root/intel/pentest/VALIDATED-FINDINGS.jsonl (a shared file) thinking
// KRIPA wrote there. KRIPA never did — that file was a fossil from an even
// earlier prompt design. Rounds 9 + 10 confirmed: shared file was stale
// across runs, Phase 3.9 judged old data, DHARMARAJ produced false verdicts.
//
// 2026-05-11 update (Sprint May-11): Phase 3.05 was added between KRIPA and
// Phase 3.4 that builds /root/intel/VALIDATED-FINDINGS-{taskId}.jsonl from
// KRIPA's ACTIVITY-LOG verdicts (deterministic post-processor, same pattern
// as rule-based-handoff-generator). Phase 3.9 now reads THAT per-task file.
// This test now validates the new contract.

const assert = require('node:assert')
const { test } = require('node:test')
const fs = require('node:fs')
const path = require('node:path')

const SRC = fs.readFileSync(path.resolve(__dirname, '..', 'event-bus.js'), 'utf-8')

function slicePhase39() {
  const start = SRC.indexOf('PHASE 3.9: Judge Verifier')
  assert.ok(start > 0, 'Phase 3.9 marker missing')
  return SRC.slice(start, start + 4000)
}

test('Phase 3.9 reads per-task /root/intel/VALIDATED-FINDINGS-{taskId}.jsonl (Sprint May-11)', () => {
  const slice = slicePhase39()
  assert.match(slice, /VALIDATED-FINDINGS-\$\{taskId\}\.jsonl/,
    'Phase 3.9 must read per-task /root/intel/VALIDATED-FINDINGS-${taskId}.jsonl built by Phase 3.05')
  // Must NOT read the fossil shared path
  assert.doesNotMatch(slice, /['"`]\/root\/intel\/pentest\/VALIDATED-FINDINGS\.jsonl['"`]/,
    'Phase 3.9 must NOT read fossil /root/intel/pentest/VALIDATED-FINDINGS.jsonl (no producer; stale-data bug)')
})

test('Phase 3.05 bridge wired: kripa-validated-builder runs after KRIPA', () => {
  // The bridge is what produces VALIDATED-FINDINGS-{taskId}.jsonl from
  // KRIPA's ACTIVITY-LOG entries. Without it Phase 3.9 would skip every run.
  assert.match(SRC, /require\(['"]\.\/agents\/kripa-validated-builder['"]\)/,
    'event-bus.js must require kripa-validated-builder')
  assert.match(SRC, /buildAndWriteForTask\s*\(\s*taskId\s*\)/,
    'event-bus.js must call buildAndWriteForTask(taskId) somewhere')
  // Phase 3.05 marker must exist between Phase 3 complete and Phase 3.4
  const phase3 = SRC.indexOf('✅ Phase 3 complete')
  const phase34 = SRC.indexOf('PHASE 3.4:')
  const phase305 = SRC.indexOf('PHASE 3.05:')
  assert.ok(phase3 > 0 && phase34 > 0 && phase305 > 0,
    'Phase 3, 3.05, 3.4 markers must all exist')
  assert.ok(phase3 < phase305 && phase305 < phase34,
    `Phase 3.05 must land between Phase 3 (line ${phase3}) and Phase 3.4 (line ${phase34}); got ${phase305}`)
})

test('Phase 3.9 passes outputDir=/root/intel so VYASA can find JUDGED-FINDINGS', () => {
  const slice = slicePhase39()
  // Look for outputDir option being passed to runJudge
  assert.match(slice, /outputDir\s*:\s*[`'"]?\/root\/intel[`'"]?|judgeOutputDir/,
    'Phase 3.9 must pass outputDir=/root/intel so JUDGED-FINDINGS-{taskId}.jsonl lands where VYASA reads')
})

test('runJudge accepts outputDir override (round-6)', () => {
  const runnerSrc = fs.readFileSync(path.resolve(__dirname, '..', 'scripts', 'run-judge-verifier.js'), 'utf-8')
  // The function signature should accept outputDir
  const fnMatch = runnerSrc.match(/async function runJudge\s*\(\s*\{([^}]+)\}/)
  assert.ok(fnMatch, 'runJudge function signature must destructure opts')
  assert.match(fnMatch[1], /outputDir/,
    'runJudge opts must include outputDir for caller override')
})
