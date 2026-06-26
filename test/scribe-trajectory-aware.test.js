
const __roots = require('../paths') // portable roots (KURU_*_ROOT) — see paths.js
// test/scribe-trajectory-aware.test.js
//
// FIX 2 (2026-05-09): SCRIBE reads trajectory observer signals.
//
// Sprint C.1 (trajectory observer) logs which specialists ran on-track vs
// off-track per task. SCRIBE did NOT see this signal. This fix injects a
// "SPECIALIST QUALITY SIGNALS" section into the SCRIBE report prompt so the
// report writer can mention specialist quality and treat off-track findings
// as LESS RELIABLE (not blanket-dismissed).
//
// We test:
//   (a) static — buildscribeReportPrompt body references the trajectory section
//   (b) dynamic — given a tmp trajectory log with on-track + off-track entries
//       for the current taskId, the rendered prompt names the off-track agents
//   (c) anti-sycophancy — instruction is "less reliable", not "ignore"
//
// Implementation must read /root/intel/trajectory/observations.jsonl (the
// canonical path from agents/trajectory-observer.js).

const assert = require('node:assert')
const { test } = require('node:test')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')

const SRC_PATH = path.resolve(__dirname, '..', 'event-bus.js')
const SRC = fs.readFileSync(SRC_PATH, 'utf-8')

// ── Static / module-level grep tests ───────────────────────────────────────

test('event-bus.js requires trajectory-observer.readTrajectoryLog', () => {
  // Either at module-load via require or inside the function via require().
  assert.match(SRC, /readTrajectoryLog|trajectory-observer/,
    'must reference readTrajectoryLog or the trajectory-observer module')
})

test('buildscribeReportPrompt body mentions SPECIALIST QUALITY SIGNALS section', () => {
  const fnStart = SRC.indexOf('function buildscribeReportPrompt')
  assert.ok(fnStart > 0, 'buildscribeReportPrompt missing')
  const fnSlice = SRC.slice(fnStart, fnStart + 14000)
  assert.match(fnSlice, /SPECIALIST QUALITY SIGNALS|trajectory observer|trajectory-observer/i,
    'function body must inject the trajectory signals section')
})

test('SCRIBE prompt instructs that off-track findings are LESS RELIABLE (not dismissed)', () => {
  const fnStart = SRC.indexOf('function buildscribeReportPrompt')
  const fnSlice = SRC.slice(fnStart, fnStart + 14000)
  // Anti-sycophancy: don't tell SCRIBE to ignore the finding entirely
  assert.match(fnSlice, /less reliable|cross-reference|cross.reference|treat.+(less|with caution)/i,
    'must instruct SCRIBE to treat off-track evidence as LESS RELIABLE, not dismissed')
})

test('SCRIBE prompt mentions cross-referencing with judge-verifier or chain-verifier', () => {
  const fnStart = SRC.indexOf('function buildscribeReportPrompt')
  const fnSlice = SRC.slice(fnStart, fnStart + 14000)
  assert.match(fnSlice, /judge.?verifier|chain.?verifier|JUDGED-FINDINGS|chain.?result/i,
    'must tell SCRIBE to cross-reference off-track findings with verifiers')
})

// ── Dynamic tests via extracted function ───────────────────────────────────
//
// We extract buildscribeReportPrompt from event-bus.js into a temp module
// (the same pattern used in publication-blocking-gate.test.js) so we can
// invoke it with controlled inputs (a fresh tmp trajectory log) and inspect
// the rendered prompt.

function buildHelperModule() {
  function extractFn(src, name) {
    const idx = src.indexOf(`function ${name}`)
    if (idx < 0) throw new Error(`fn ${name} not found`)
    let depth = 0, started = false, end = idx
    for (let i = idx; i < src.length; i++) {
      const c = src[i]
      if (c === '{') { depth++; started = true }
      else if (c === '}') { depth--; if (started && depth === 0) { end = i + 1; break } }
    }
    return src.slice(idx, end)
  }

  const fnscribe = extractFn(SRC, 'buildscribeReportPrompt')

  // Stubs needed inside buildscribeReportPrompt:
  //   - scrubBaselineFromGoal
  //   - getSquadFinalReportPath
  //   - require('./agents/handoff-protocol')  → buildCrossSquadCorroborationSection
  //   - require('./agents/trajectory-observer')  → readTrajectoryLog (real)
  //   - MUST_GATES (constant)
  //
  // For the trajectory section to render real values, we let the real
  // trajectory-observer module load (it has no side-effects on require).
  // Replace './agents/...' relative requires with absolute paths so the temp
  // module can resolve them no matter where it lives on disk.
  const fixedFnscribe = fnscribe
    .replace(/require\(['"]\.\/agents\/handoff-protocol['"]\)/g, "require('/root/agents/agents/handoff-protocol')")
    .replace(/require\(['"]\.\/agents\/trajectory-observer['"]\)/g, "require('/root/agents/agents/trajectory-observer')")

  const moduleCode = `
const fs = require('node:fs')
const path = require('node:path')
const agentPaths = require('${__roots.AGENTS_ROOT}/paths') // Phase-1 resolver — prompt builders reference it
function scrubBaselineFromGoal(g) { return g || '' }
function getSquadFinalReportPath(_squad) { return '${__roots.INTEL_ROOT}/pentest/FINAL-REPORT.md' }
const MUST_GATES = ''
${fixedFnscribe}
module.exports = { buildscribeReportPrompt }
`
  const tmpPath = path.join(os.tmpdir(), `_scribe-trajectory-helper-${process.pid}.js`)
  fs.writeFileSync(tmpPath, moduleCode)
  return tmpPath
}

let helperPath
let buildPrompt

test('setup: extract helper module', () => {
  helperPath = buildHelperModule()
  buildPrompt = require(helperPath).buildscribeReportPrompt
})

// Use the canonical log path that trajectory-observer writes to.
const TRAJECTORY_LOG = (__roots.INTEL_ROOT + '/trajectory/observations.jsonl')
const SCHEMA_VERSION = '1'

function backupLog() {
  if (fs.existsSync(TRAJECTORY_LOG)) {
    const bak = TRAJECTORY_LOG + '.bak.' + process.pid
    fs.copyFileSync(TRAJECTORY_LOG, bak)
    return bak
  }
  return null
}
function restoreLog(bak) {
  if (bak && fs.existsSync(bak)) {
    fs.copyFileSync(bak, TRAJECTORY_LOG)
    fs.unlinkSync(bak)
  } else {
    try { fs.unlinkSync(TRAJECTORY_LOG) } catch {}
  }
}

test('dynamic: 5 on-track + 2 off-track for taskId → prompt names off-track agents', () => {
  const taskId = `traj-test-${Date.now()}`
  const bak = backupLog()
  try {
    fs.mkdirSync(path.dirname(TRAJECTORY_LOG), { recursive: true })
    const lines = []
    // 5 on-track for this task
    for (const a of ['VIPER', 'DRILL', 'RELAY', 'SENTRY', 'GATEWAY']) {
      lines.push(JSON.stringify({
        schema_version: SCHEMA_VERSION, task_id: taskId, agent: a,
        verdict: 'on-track', first_failed_dim: null, reason: 'ok'
      }))
    }
    // 2 off-track for this task
    lines.push(JSON.stringify({
      schema_version: SCHEMA_VERSION, task_id: taskId, agent: 'RANGER',
      verdict: 'off-track', first_failed_dim: 'goal-alignment', reason: 'wrong target'
    }))
    lines.push(JSON.stringify({
      schema_version: SCHEMA_VERSION, task_id: taskId, agent: 'LEDGER',
      verdict: 'off-track', first_failed_dim: 'evidence-quality', reason: 'no probes'
    }))
    // 1 unrelated task — must be ignored
    lines.push(JSON.stringify({
      schema_version: SCHEMA_VERSION, task_id: 'other-task', agent: 'SCOUT',
      verdict: 'off-track', first_failed_dim: 'coherence', reason: 'noise'
    }))
    // overwrite to give us a clean controlled view
    fs.writeFileSync(TRAJECTORY_LOG, lines.join('\n') + '\n')

    const prompt = buildPrompt('test', taskId, 'proj1', 'pentest', 'https://example.com', 'goal', [], '')

    // Section heading present
    assert.match(prompt, /SPECIALIST QUALITY SIGNALS/, 'must include section heading')
    // Off-track agents named
    assert.match(prompt, /RANGER/, 'must name off-track agent RANGER')
    assert.match(prompt, /LEDGER/, 'must name off-track agent LEDGER')
    // first_failed_dim surfaced
    assert.match(prompt, /goal-alignment/, 'must surface first_failed_dim for off-track entries')
    assert.match(prompt, /evidence-quality/, 'must surface first_failed_dim for second off-track entry')
    // Counts mentioned (5 of 7 on-track in some form)
    assert.match(prompt, /5[\s\S]{0,40}(on-track|of\s*7)|7\s*specialists|on-track/i,
      'must mention specialist counts')
    // Unrelated task agent NOT named in this section
    // (we look at the SPECIALIST QUALITY SIGNALS slice only)
    const sectionStart = prompt.indexOf('SPECIALIST QUALITY SIGNALS')
    const sectionEnd = prompt.indexOf('##', sectionStart + 30)
    const sectionSlice = prompt.slice(sectionStart, sectionEnd > 0 ? sectionEnd : sectionStart + 1500)
    assert.ok(!sectionSlice.includes('SCOUT'),
      'unrelated task agent must NOT appear in the trajectory section')
  } finally {
    restoreLog(bak)
  }
})

test('dynamic: empty trajectory log → section absent OR shows "no observations"', () => {
  const taskId = `traj-empty-${Date.now()}`
  const bak = backupLog()
  try {
    // Wipe / write empty
    fs.mkdirSync(path.dirname(TRAJECTORY_LOG), { recursive: true })
    fs.writeFileSync(TRAJECTORY_LOG, '')

    const prompt = buildPrompt('test', taskId, 'proj1', 'pentest', 'https://example.com', 'goal', [], '')

    // Either section absent or section text says "no observations"
    if (prompt.includes('SPECIALIST QUALITY SIGNALS')) {
      assert.match(prompt, /no observations|no trajectory|none recorded|0 specialists/i,
        'when log is empty, section must explicitly say no observations')
    }
    // Either way it must not crash and must render the prompt
    assert.ok(prompt.length > 1000, 'prompt must still render even with empty log')
  } finally {
    restoreLog(bak)
  }
})

test('cleanup: remove helper module', () => {
  try { fs.unlinkSync(helperPath) } catch {}
})
