# G4 Multi-Model Test — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the model-config layer + metrics collector + experiment runner so we can empirically test KRISHNA = Sonnet 4.6 vs Opus 4.7 across 3 controlled targets.

**Architecture:** New `agents/model-config.js` exposes per-agent model assignment via PROFILES. event-bus.js refactored to consult model-config instead of hardcoded model strings. New `scripts/g4-metrics.js` parses post-dispatch artifacts (VALIDATED-FINDINGS, tasks.json, etc.) into a single comparison-ready JSON record per dispatch. `scripts/g4-report.js` reads N records and renders side-by-side comparison.

**Tech Stack:** Node.js (kurukshetra runtime), bun for tests, plain Node assert via `test(name, fn)` helper, JSON files for artifact storage, ENV var `MODEL_PROFILE` for runtime profile selection.

**Spec source:** [/root/agents/docs/superpowers/specs/2026-05-06-G4-multi-model-test-design.md](../specs/2026-05-06-G4-multi-model-test-design.md)

---

## File Structure

| File | Purpose | Status |
|---|---|---|
| `agents/model-config.js` | PROFILES + getModel(agent, profile) — single source of truth for which model each agent uses | NEW |
| `test/model-config.test.js` | Unit tests for getModel + PROFILES schema | NEW |
| `agents/event-bus.js` | Modified: replace hardcoded model strings with `modelConfig.getModel(...)` | MODIFY (3-5 line edits) |
| `scripts/g4-metrics.js` | Per-dispatch metrics collector — reads task artifacts, emits JSON | NEW |
| `test/g4-metrics.test.js` | Unit tests for metrics collector with synthetic fixtures | NEW |
| `scripts/g4-report.js` | Comparison renderer — reads N metrics JSON files, prints decision table | NEW |
| `intel/g4-experiment/` | Output dir for per-dispatch metrics records | NEW DIR |
| `intel/g4-experiment/g4-decision.md` | Final write-up after experiment | NEW (Phase 2 output) |

---

## Task 1: Create agents/model-config.js with default profile

**Files:**
- Create: `/root/agents/agents/model-config.js`
- Test: `/root/agents/test/model-config.test.js`

- [ ] **Step 1: Write the failing test**

```javascript
// test/model-config.test.js
const assert = require('node:assert')
const { test } = require('node:test')
const modelConfig = require('../agents/model-config')

test('PROFILES.default exists with all 5 agents', () => {
  assert.ok(modelConfig.PROFILES.default, 'default profile present')
  for (const agent of ['KRISHNA', 'DHARMA', 'KRIPA', 'VYASA', 'GRADER']) {
    assert.ok(modelConfig.PROFILES.default[agent], `${agent} has model assigned in default`)
  }
})

test('getModel returns correct model for default profile', () => {
  assert.strictEqual(modelConfig.getModel('KRISHNA', 'default'), 'claude-opus-4-7')
  assert.strictEqual(modelConfig.getModel('KRIPA', 'default'), 'claude-haiku-4-5')
  assert.strictEqual(modelConfig.getModel('GRADER', 'default'), 'claude-haiku-4-5')
})

test('getModel falls back to default profile when name omitted', () => {
  assert.strictEqual(modelConfig.getModel('KRISHNA'), 'claude-opus-4-7')
})

test('getModel throws for unknown agent in profile', () => {
  assert.throws(() => modelConfig.getModel('UNKNOWN_AGENT'), /unknown agent/i)
})

test('getModel throws for unknown profile', () => {
  assert.throws(() => modelConfig.getModel('KRISHNA', 'nonexistent_profile'), /unknown profile/i)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /root/agents && bun test test/model-config.test.js`
Expected: FAIL with `Cannot find module '../agents/model-config'`

- [ ] **Step 3: Write minimal implementation**

```javascript
// agents/model-config.js
//
// Single source of truth for which model each agent uses.
// Set MODEL_PROFILE env var to swap profiles for experiments (e.g. G4).
//
// Adding a new profile: insert a new key in PROFILES with all 5 agents.
// Adding a new agent: add to every profile + memory entry of expected model class.

const PROFILES = Object.freeze({
  default: Object.freeze({
    KRISHNA: 'claude-opus-4-7',
    DHARMA: 'claude-opus-4-7',
    KRIPA: 'claude-haiku-4-5',
    VYASA: 'claude-opus-4-7',
    GRADER: 'claude-haiku-4-5',
  }),
  G4_test_sonnet: Object.freeze({
    KRISHNA: 'claude-sonnet-4-6',
    DHARMA: 'claude-opus-4-7',
    KRIPA: 'claude-haiku-4-5',
    VYASA: 'claude-opus-4-7',
    GRADER: 'claude-haiku-4-5',
  }),
})

function getModel(agent, profile = 'default') {
  if (!PROFILES[profile]) {
    throw new Error(`unknown profile: ${profile}`)
  }
  const model = PROFILES[profile][agent]
  if (!model) {
    throw new Error(`unknown agent: ${agent} in profile ${profile}`)
  }
  return model
}

module.exports = { PROFILES, getModel }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /root/agents && bun test test/model-config.test.js`
Expected: PASS, 5 tests passed.

- [ ] **Step 5: Commit**

```bash
cd /root/agents
git add agents/model-config.js test/model-config.test.js
git commit -m "feat(model-config): centralize per-agent model assignment with profile system

Single source of truth for which model each agent uses. PROFILES.default
preserves current production assignment (KRISHNA=Opus, DHARMA=Opus, KRIPA=Haiku,
VYASA=Opus, GRADER=Haiku). PROFILES.G4_test_sonnet swaps KRISHNA to Sonnet for
the multi-model experiment.

Tests: 5 passing (profile schema, default lookup, fallback, error cases).

Part of G4 spec: docs/superpowers/specs/2026-05-06-G4-multi-model-test-design.md

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Refactor event-bus.js to consult model-config

**Files:**
- Modify: `/root/agents/agents/event-bus.js` (3-5 hardcoded model strings → config-driven)
- Test: `/root/agents/test/event-bus-model-config-wiring.test.js` (NEW)

- [ ] **Step 1: Identify hardcoded model strings**

Run: `cd /root/agents && grep -nE "claude-(opus|sonnet|haiku)-[0-9]" agents/event-bus.js | head -20`
Expected: 3-7 matches showing hardcoded model names to replace.

- [ ] **Step 2: Write the failing wiring test**

```javascript
// test/event-bus-model-config-wiring.test.js
const assert = require('node:assert')
const { test } = require('node:test')
const fs = require('node:fs')
const path = require('node:path')

test('event-bus.js does NOT contain hardcoded model strings (uses model-config)', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'agents', 'event-bus.js'), 'utf-8')

  // Allow inside string literals that are model-config values themselves, comments, or test fixtures
  // The ban is on RUNTIME hardcoded model selection
  const hardcoded = src.match(/claude-(opus|sonnet|haiku)-[0-9]+(?:-[0-9]+)?/g) || []
  const allowedFiles = ['model-config.js']
  const allowedPatterns = [
    /\/\/.*claude-/,           // comments
    /'claude-(opus|sonnet|haiku)-[0-9]+'\s*\/\//,  // inline-commented
  ]

  // Filter out ones that are part of allowed contexts
  const lines = src.split('\n')
  const violations = []
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (!line.match(/claude-(opus|sonnet|haiku)-[0-9]/)) continue
    if (line.match(/^\s*\/\//)) continue   // comment-only line
    if (line.match(/^\s*\*/)) continue     // block comment
    if (line.includes('// allow')) continue // explicit allow marker
    violations.push({ line: i + 1, text: line.trim().slice(0, 100) })
  }

  if (violations.length > 0) {
    console.error('Hardcoded model strings found in event-bus.js:')
    violations.forEach(v => console.error(`  L${v.line}: ${v.text}`))
  }
  assert.strictEqual(violations.length, 0, `event-bus.js has ${violations.length} hardcoded model strings — should use modelConfig.getModel`)
})

test('event-bus.js requires model-config module', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'agents', 'event-bus.js'), 'utf-8')
  assert.match(src, /require\(['"](\.\/)?model-config['"]\)/, 'event-bus.js should require model-config')
})
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd /root/agents && bun test test/event-bus-model-config-wiring.test.js`
Expected: FAIL with violations list (showing the 3-7 hardcoded strings).

- [ ] **Step 4: Refactor event-bus.js**

For each hardcoded model string identified in Step 1:
- Add `const modelConfig = require('./agents/model-config')` near top of file (if not present)
- Replace `'claude-opus-4-7'` with `modelConfig.getModel('KRISHNA', process.env.MODEL_PROFILE)` (or appropriate agent name)
- Add inline comment `// resolved via model-config.js — set MODEL_PROFILE env to swap`

Specific replacements (verify line numbers via grep first):
- KRISHNA dispatch sites: → `modelConfig.getModel('KRISHNA', process.env.MODEL_PROFILE)`
- DHARMA validation sites: → `modelConfig.getModel('DHARMA', process.env.MODEL_PROFILE)`
- KRIPA verifier sites: → `modelConfig.getModel('KRIPA', process.env.MODEL_PROFILE)`
- VYASA reporter sites: → `modelConfig.getModel('VYASA', process.env.MODEL_PROFILE)`
- GRADER sites: → `modelConfig.getModel('GRADER', process.env.MODEL_PROFILE)`

- [ ] **Step 5: Run test to verify it passes**

Run: `cd /root/agents && bun test test/event-bus-model-config-wiring.test.js`
Expected: PASS, 2 tests passed (no hardcoded strings, requires model-config).

- [ ] **Step 6: Run full test suite to confirm no regression**

Run: `cd /root/agents && bun test test/`
Expected: 35+ files passing (1 known stale OK).

Run: `cd /root/agents && timeout 60 node verify-framework.js`
Expected: 54+ GATEs passed.

- [ ] **Step 7: Commit**

```bash
cd /root/agents
git add agents/event-bus.js test/event-bus-model-config-wiring.test.js
git commit -m "refactor(event-bus): consult model-config instead of hardcoded model strings

Replaces 3-7 hardcoded 'claude-{opus,sonnet,haiku}-X-Y' strings throughout
event-bus.js with modelConfig.getModel(agent, process.env.MODEL_PROFILE).
Behavior unchanged for default profile (env unset → defaults applied);
enables G4 experiment by setting MODEL_PROFILE=G4_test_sonnet.

New test: event-bus-model-config-wiring catches future hardcoded model
regressions.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Create scripts/g4-metrics.js metrics collector

**Files:**
- Create: `/root/agents/scripts/g4-metrics.js`
- Test: `/root/agents/test/g4-metrics.test.js`

- [ ] **Step 1: Write the failing test**

```javascript
// test/g4-metrics.test.js
const assert = require('node:assert')
const { test } = require('node:test')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const { collectMetrics } = require('../scripts/g4-metrics')

function makeFixtureDir(taskId, opts = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'g4-fixture-'))
  const validatedFile = path.join(dir, `VALIDATED-FINDINGS-${taskId}.jsonl`)
  const tasksFile = path.join(dir, 'tasks.json')

  // Synthetic findings
  const findings = opts.findings || [
    { id: '1', severity: 'Critical', title: 'SQL Injection' },
    { id: '2', severity: 'High', title: 'XSS' },
    { id: '3', severity: 'Medium', title: 'Missing CSP' },
  ]
  fs.writeFileSync(validatedFile, findings.map(f => JSON.stringify(f)).join('\n'))

  // Synthetic tasks.json
  const tasks = [{
    id: taskId,
    title: `Test target ${taskId}`,
    status: 'done',
    created: '2026-05-06',
    progress: 100,
    model_profile: opts.profile || 'default',
    krishna_model: opts.krishna || 'claude-opus-4-7',
    cost_usd: opts.cost || 142.30,
    duration_seconds: opts.duration || 4567,
  }]
  fs.writeFileSync(tasksFile, JSON.stringify(tasks))

  return { dir, validatedFile, tasksFile }
}

test('collectMetrics emits required keys', () => {
  const taskId = 'TEST-1'
  const { dir, validatedFile, tasksFile } = makeFixtureDir(taskId)
  const m = collectMetrics({ taskId, validatedFile, tasksFile })
  assert.strictEqual(m.task_id, taskId)
  assert.ok(m.metrics, 'has metrics object')
  assert.strictEqual(m.metrics.findings_total, 3)
  assert.strictEqual(m.metrics.findings_by_severity.critical, 1)
  assert.strictEqual(m.metrics.findings_by_severity.high, 1)
  assert.strictEqual(m.metrics.findings_by_severity.medium, 1)
  assert.strictEqual(m.metrics.cost_usd, 142.30)
  assert.strictEqual(m.metrics.duration_seconds, 4567)
})

test('collectMetrics handles empty VALIDATED-FINDINGS gracefully', () => {
  const taskId = 'TEST-2'
  const { validatedFile, tasksFile } = makeFixtureDir(taskId, { findings: [] })
  const m = collectMetrics({ taskId, validatedFile, tasksFile })
  assert.strictEqual(m.metrics.findings_total, 0)
  assert.strictEqual(m.metrics.findings_by_severity.critical, 0)
})

test('collectMetrics captures model profile for comparison', () => {
  const taskId = 'TEST-3'
  const { validatedFile, tasksFile } = makeFixtureDir(taskId, {
    profile: 'G4_test_sonnet',
    krishna: 'claude-sonnet-4-6',
    cost: 28.50,
  })
  const m = collectMetrics({ taskId, validatedFile, tasksFile })
  assert.strictEqual(m.model_profile, 'G4_test_sonnet')
  assert.strictEqual(m.krishna_model, 'claude-sonnet-4-6')
  assert.strictEqual(m.metrics.cost_usd, 28.50)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /root/agents && bun test test/g4-metrics.test.js`
Expected: FAIL with `Cannot find module '../scripts/g4-metrics'`

- [ ] **Step 3: Write minimal implementation**

```javascript
// scripts/g4-metrics.js
//
// Per-dispatch metrics collector for G4 multi-model test.
//
// Reads VALIDATED-FINDINGS-${taskId}.jsonl + tasks.json, emits one JSON
// metrics record summarizing findings, cost, duration, profile.
// Output written to /root/intel/g4-experiment/${taskId}-metrics.json.
//
// Usage: node scripts/g4-metrics.js <taskId>
//        node scripts/g4-metrics.js <taskId> --validated <path> --tasks <path>

const fs = require('node:fs')
const path = require('node:path')

function readJsonl(p) {
  if (!fs.existsSync(p)) return []
  return fs.readFileSync(p, 'utf-8')
    .split('\n')
    .filter(Boolean)
    .map(line => { try { return JSON.parse(line) } catch { return null } })
    .filter(Boolean)
}

function readJson(p) {
  if (!fs.existsSync(p)) return null
  try { return JSON.parse(fs.readFileSync(p, 'utf-8')) } catch { return null }
}

function collectMetrics({ taskId, validatedFile, tasksFile }) {
  if (!taskId) throw new Error('taskId required')

  const findings = readJsonl(validatedFile)
  const tasks = readJson(tasksFile) || []
  const task = tasks.find(t => String(t.id) === String(taskId))
  if (!task) {
    throw new Error(`task ${taskId} not found in ${tasksFile}`)
  }

  const sev = { critical: 0, high: 0, medium: 0, low: 0, info: 0 }
  for (const f of findings) {
    const s = String(f.severity || '').toLowerCase()
    if (sev[s] !== undefined) sev[s]++
  }

  return {
    task_id: String(taskId),
    target: task.title || task.goal || '(unknown)',
    model_profile: task.model_profile || 'default',
    krishna_model: task.krishna_model || '(unknown)',
    captured_at: new Date().toISOString(),
    metrics: {
      findings_total: findings.length,
      findings_by_severity: sev,
      cost_usd: task.cost_usd || 0,
      duration_seconds: task.duration_seconds || 0,
    },
  }
}

function main() {
  const args = process.argv.slice(2)
  const taskId = args[0]
  if (!taskId) {
    console.error('Usage: node scripts/g4-metrics.js <taskId> [--validated <path>] [--tasks <path>]')
    process.exit(1)
  }
  const validatedFile = args.includes('--validated')
    ? args[args.indexOf('--validated') + 1]
    : `/root/intel/pentest/VALIDATED-FINDINGS-${taskId}.jsonl`
  const tasksFile = args.includes('--tasks')
    ? args[args.indexOf('--tasks') + 1]
    : '/root/intel/tasks.json'

  const m = collectMetrics({ taskId, validatedFile, tasksFile })

  const outDir = '/root/intel/g4-experiment'
  fs.mkdirSync(outDir, { recursive: true })
  const outFile = path.join(outDir, `${taskId}-metrics.json`)
  fs.writeFileSync(outFile, JSON.stringify(m, null, 2))
  console.log(`metrics written: ${outFile}`)
}

if (require.main === module) main()

module.exports = { collectMetrics }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /root/agents && bun test test/g4-metrics.test.js`
Expected: PASS, 3 tests passed.

- [ ] **Step 5: Commit**

```bash
cd /root/agents
git add scripts/g4-metrics.js test/g4-metrics.test.js
git commit -m "feat(g4): per-dispatch metrics collector for multi-model experiment

Reads VALIDATED-FINDINGS-\${taskId}.jsonl + tasks.json, emits one JSON
metrics record per dispatch (task_id, target, model_profile, krishna_model,
findings_total/by_severity, cost_usd, duration_seconds).

Output: /root/intel/g4-experiment/\${taskId}-metrics.json
Usage: node scripts/g4-metrics.js <taskId>

3 unit tests: emits required keys, handles empty findings, captures
profile for cross-run comparison.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: Create scripts/g4-report.js comparison renderer

**Files:**
- Create: `/root/agents/scripts/g4-report.js`
- Test: `/root/agents/test/g4-report.test.js`

- [ ] **Step 1: Write the failing test**

```javascript
// test/g4-report.test.js
const assert = require('node:assert')
const { test } = require('node:test')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const { renderReport, applyDecisionCriteria } = require('../scripts/g4-report')

function makeMetric(taskId, profile, krishna, cost, findings, criticalCount = 1) {
  return {
    task_id: taskId,
    target: `Target ${taskId}`,
    model_profile: profile,
    krishna_model: krishna,
    captured_at: new Date().toISOString(),
    metrics: {
      findings_total: findings,
      findings_by_severity: { critical: criticalCount, high: 1, medium: 1, low: 0, info: 0 },
      cost_usd: cost,
      duration_seconds: 3000,
    }
  }
}

test('renderReport produces side-by-side comparison string', () => {
  const opus = makeMetric('T1', 'default', 'claude-opus-4-7', 142.30, 12)
  const sonnet = makeMetric('T1-sonnet', 'G4_test_sonnet', 'claude-sonnet-4-6', 28.50, 11)
  const out = renderReport([opus, sonnet])
  assert.match(out, /Opus/)
  assert.match(out, /Sonnet/)
  assert.match(out, /142\.30/)
  assert.match(out, /28\.50/)
})

test('applyDecisionCriteria: ALL THREE pass → ADOPT', () => {
  const opus = makeMetric('T1', 'default', 'claude-opus-4-7', 142.30, 12, 1)
  const sonnet = makeMetric('T1-sonnet', 'G4_test_sonnet', 'claude-sonnet-4-6', 28.50, 11, 1)
  const decision = applyDecisionCriteria([{ opus, sonnet }])
  assert.ok(decision.adopt, `should adopt, got: ${JSON.stringify(decision)}`)
})

test('applyDecisionCriteria: cost reduction <60% → REJECT', () => {
  const opus = makeMetric('T1', 'default', 'claude-opus-4-7', 142.30, 12)
  const sonnet = makeMetric('T1-sonnet', 'G4_test_sonnet', 'claude-sonnet-4-6', 100.00, 11) // only 30% cheaper
  const decision = applyDecisionCriteria([{ opus, sonnet }])
  assert.strictEqual(decision.adopt, false, `should reject (cost not 60%+ cheaper)`)
})

test('applyDecisionCriteria: new false-Critical → REJECT', () => {
  const opus = makeMetric('T1', 'default', 'claude-opus-4-7', 142.30, 12, 1)
  const sonnet = makeMetric('T1-sonnet', 'G4_test_sonnet', 'claude-sonnet-4-6', 28.50, 14, 3) // more Criticals!
  const decision = applyDecisionCriteria([{ opus, sonnet }])
  assert.strictEqual(decision.adopt, false, `should reject (Sonnet introduced 2 more Criticals)`)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /root/agents && bun test test/g4-report.test.js`
Expected: FAIL with `Cannot find module '../scripts/g4-report'`

- [ ] **Step 3: Write minimal implementation**

```javascript
// scripts/g4-report.js
//
// Read N metrics JSON files from /root/intel/g4-experiment/, compute decision.
// Decision criteria from spec §3.5:
//   1. F1 within 5% of Opus (placeholder: findings_total within 20% as proxy until ground-truth lookup added)
//   2. No new false-Critical findings (Sonnet's Critical count <= Opus's)
//   3. Cost reduction ≥60%

const fs = require('node:fs')
const path = require('node:path')

function pairBySource(metrics) {
  // Group by (target_id without profile suffix), pair Opus + Sonnet runs
  const byTarget = new Map()
  for (const m of metrics) {
    const targetKey = m.target
    if (!byTarget.has(targetKey)) byTarget.set(targetKey, {})
    if (m.model_profile === 'default' || m.krishna_model === 'claude-opus-4-7') {
      byTarget.get(targetKey).opus = m
    } else {
      byTarget.get(targetKey).sonnet = m
    }
  }
  return Array.from(byTarget.values()).filter(p => p.opus && p.sonnet)
}

function applyDecisionCriteria(pairs) {
  const evaluations = pairs.map(({ opus, sonnet }) => {
    const opusFindings = opus.metrics.findings_total
    const sonnetFindings = sonnet.metrics.findings_total
    const opusCritical = opus.metrics.findings_by_severity.critical
    const sonnetCritical = sonnet.metrics.findings_by_severity.critical
    const opusCost = opus.metrics.cost_usd
    const sonnetCost = sonnet.metrics.cost_usd

    // Criterion 1: findings within 20% (proxy for F1 within 5% pending ground-truth lookup)
    const findingsRatio = sonnetFindings / Math.max(opusFindings, 1)
    const criterion1 = findingsRatio >= 0.80 && findingsRatio <= 1.20

    // Criterion 2: No new false-Critical (Sonnet criticals <= Opus criticals)
    const criterion2 = sonnetCritical <= opusCritical

    // Criterion 3: cost reduction ≥60%
    const costSavings = (opusCost - sonnetCost) / Math.max(opusCost, 0.01)
    const criterion3 = costSavings >= 0.60

    return {
      target: opus.target,
      criterion1, criterion2, criterion3,
      findings_ratio: findingsRatio,
      cost_savings: costSavings,
      detail: `Opus: ${opusFindings} findings (${opusCritical} crit) $${opusCost.toFixed(2)} | Sonnet: ${sonnetFindings} findings (${sonnetCritical} crit) $${sonnetCost.toFixed(2)}`
    }
  })

  // Adopt if ALL targets pass ALL three criteria
  const adopt = evaluations.every(e => e.criterion1 && e.criterion2 && e.criterion3)

  return { adopt, evaluations }
}

function renderReport(metrics) {
  const pairs = pairBySource(metrics)
  const decision = applyDecisionCriteria(pairs)

  let out = '# G4 Multi-Model Experiment Results\n\n'
  out += `Run pairs: ${pairs.length}\n\n`

  for (const { opus, sonnet } of pairs) {
    out += `## ${opus.target}\n\n`
    out += '|  | Opus | Sonnet |\n|---|---|---|\n'
    out += `| Findings | ${opus.metrics.findings_total} | ${sonnet.metrics.findings_total} |\n`
    out += `| Critical | ${opus.metrics.findings_by_severity.critical} | ${sonnet.metrics.findings_by_severity.critical} |\n`
    out += `| Cost | $${opus.metrics.cost_usd.toFixed(2)} | $${sonnet.metrics.cost_usd.toFixed(2)} |\n`
    out += `| Duration | ${opus.metrics.duration_seconds}s | ${sonnet.metrics.duration_seconds}s |\n\n`
  }

  out += `\n## Decision\n\n**ADOPT Sonnet:** ${decision.adopt ? '🟢 YES' : '🔴 NO'}\n\n`
  out += '### Per-target evaluation\n\n'
  for (const e of decision.evaluations) {
    out += `- **${e.target}:** C1=${e.criterion1 ? '✅' : '❌'} C2=${e.criterion2 ? '✅' : '❌'} C3=${e.criterion3 ? '✅' : '❌'} (cost savings ${(e.cost_savings * 100).toFixed(1)}%, findings ratio ${e.findings_ratio.toFixed(2)})\n`
  }

  return out
}

function main() {
  const dir = '/root/intel/g4-experiment'
  if (!fs.existsSync(dir)) {
    console.error(`No experiment data at ${dir}`)
    process.exit(1)
  }
  const files = fs.readdirSync(dir).filter(f => f.endsWith('-metrics.json'))
  const metrics = files.map(f => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf-8')))

  const report = renderReport(metrics)
  const reportFile = path.join(dir, 'g4-decision.md')
  fs.writeFileSync(reportFile, report)
  console.log(report)
  console.log(`\nReport written: ${reportFile}`)
}

if (require.main === module) main()

module.exports = { renderReport, applyDecisionCriteria, pairBySource }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /root/agents && bun test test/g4-report.test.js`
Expected: PASS, 4 tests passed.

- [ ] **Step 5: Commit**

```bash
cd /root/agents
git add scripts/g4-report.js test/g4-report.test.js
git commit -m "feat(g4): comparison renderer + decision criteria evaluator

Reads N metrics JSON records from intel/g4-experiment/, pairs Opus runs with
Sonnet runs by target name, applies 3 decision criteria from spec:
  C1: findings_total ratio within 20% (proxy for F1 within 5%)
  C2: Sonnet critical count <= Opus critical count
  C3: cost reduction >=60%

Outputs side-by-side markdown table + ADOPT/REJECT decision.

4 unit tests: render, all-pass adopt, cost-fail reject, critical-regression reject.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: Wire MODEL_PROFILE into dispatch + tasks.json capture

**Files:**
- Modify: `/root/agents/agents/event-bus.js` (add task.model_profile + task.krishna_model + task.cost_usd capture)

- [ ] **Step 1: Identify task creation site in event-bus.js**

Run: `cd /root/agents && grep -n "tasks.json\|t.push.*new_task\|status.*in-progress.*progress" agents/event-bus.js | head -10`
Expected: line numbers where new task records are written.

- [ ] **Step 2: Add fields when task is created**

Locate the task-creation block (the existing `new_task = {...}` object construction) and ADD these fields:
- `model_profile: process.env.MODEL_PROFILE || 'default'`
- `krishna_model: modelConfig.getModel('KRISHNA', process.env.MODEL_PROFILE)`
- `cost_usd: 0  // updated when dispatch completes`
- `duration_seconds: 0  // updated when dispatch completes`

- [ ] **Step 3: Update task on completion**

Locate the task-completion block (where `status` becomes `done` or `completed`). Add cost + duration capture from any existing telemetry.

If no telemetry exists, leave cost_usd at 0 and document "TBD: cost capture requires API metering wire-up — manual entry for G4 experiment"

- [ ] **Step 4: Run regression test**

Run: `cd /root/agents && bun test test/`
Expected: 35+ files passing, no new failures.

- [ ] **Step 5: Commit**

```bash
cd /root/agents
git add agents/event-bus.js
git commit -m "feat(event-bus): record model_profile + krishna_model + cost on task creation

Adds 4 fields to tasks.json records on dispatch:
- model_profile: from MODEL_PROFILE env var, default 'default'
- krishna_model: resolved via modelConfig.getModel
- cost_usd: 0 placeholder (manual entry for G4 experiment until API metering)
- duration_seconds: 0 placeholder

Required for g4-metrics.js to attribute findings to a model profile.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: End-to-end smoke test (no live API)

**Files:**
- Create: `/root/agents/test/g4-end-to-end.test.js`

- [ ] **Step 1: Write integration test**

```javascript
// test/g4-end-to-end.test.js
const assert = require('node:assert')
const { test } = require('node:test')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const { collectMetrics } = require('../scripts/g4-metrics')
const { renderReport, applyDecisionCriteria } = require('../scripts/g4-report')

test('full G4 pipeline: 3 target pairs → renderReport → decision', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'g4-e2e-'))

  // Create synthetic 3-target × 2-model = 6 dispatches
  const tasks = []
  const validatedFiles = {}

  for (let i = 1; i <= 3; i++) {
    for (const profile of ['default', 'G4_test_sonnet']) {
      const taskId = `T${i}-${profile}`
      const krishna = profile === 'default' ? 'claude-opus-4-7' : 'claude-sonnet-4-6'
      const cost = profile === 'default' ? 140 : 30
      tasks.push({
        id: taskId,
        title: `Target ${i}`,
        status: 'done',
        model_profile: profile,
        krishna_model: krishna,
        cost_usd: cost,
        duration_seconds: 3000,
      })
      const findings = [
        { id: '1', severity: 'Critical' },
        { id: '2', severity: 'High' },
      ]
      const valFile = path.join(dir, `VALIDATED-${taskId}.jsonl`)
      fs.writeFileSync(valFile, findings.map(f => JSON.stringify(f)).join('\n'))
      validatedFiles[taskId] = valFile
    }
  }
  const tasksFile = path.join(dir, 'tasks.json')
  fs.writeFileSync(tasksFile, JSON.stringify(tasks))

  // Collect metrics for all 6
  const metrics = []
  for (const t of tasks) {
    metrics.push(collectMetrics({ taskId: t.id, validatedFile: validatedFiles[t.id], tasksFile }))
  }
  assert.strictEqual(metrics.length, 6)

  // Render report
  const report = renderReport(metrics)
  assert.match(report, /ADOPT/i)

  // Decision should be ADOPT (3 targets, all pass criteria)
  const decision = applyDecisionCriteria([
    { opus: metrics[0], sonnet: metrics[1] },
    { opus: metrics[2], sonnet: metrics[3] },
    { opus: metrics[4], sonnet: metrics[5] },
  ])
  assert.strictEqual(decision.adopt, true, `should ADOPT with synthetic favorable data`)
})
```

- [ ] **Step 2: Run test**

Run: `cd /root/agents && bun test test/g4-end-to-end.test.js`
Expected: PASS, 1 test passed.

- [ ] **Step 3: Run full test suite + verify-framework**

```bash
cd /root/agents && bun test test/ 2>&1 | tail -3
cd /root/agents && timeout 60 node verify-framework.js 2>&1 | tail -3
```
Expected: 35+ test files passing, 54+ GATEs passing.

- [ ] **Step 4: Commit + push all G4 build work**

```bash
cd /root/agents
git add test/g4-end-to-end.test.js
git commit -m "test(g4): end-to-end smoke for full pipeline

Tests 3-target × 2-model = 6 synthetic dispatches → 6 metrics records →
renderReport → decision = ADOPT. Catches integration bugs that unit tests miss.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
git push origin master
```

---

## Phase 2: Experiment execution (post-build, separate session)

After Tasks 1-6 ship, the experiment phase begins:

1. Pick 3 historical targets from tasks.json (one per squad)
2. For each, run dispatches:
   ```bash
   # Control (Opus, default profile)
   MODEL_PROFILE=default bash /root/scripts/dispatch-pentest.sh <target>

   # Treatment (Sonnet)
   MODEL_PROFILE=G4_test_sonnet bash /root/scripts/dispatch-pentest.sh <target>
   ```
3. After each pair: `node scripts/g4-metrics.js <taskId>` for both
4. After all 6: `node scripts/g4-report.js` → produces `intel/g4-experiment/g4-decision.md`
5. Memory write: `/root/.claude/projects/-root/memory/project_g4_multi_model_result.md`

This phase is operational, not coding — handle in next session.

## Phase 3: Decision rollout (if ADOPT)

If decision = ADOPT:
1. Update `model-config.js` defaults to use Sonnet for KRISHNA on routine targets
2. Add `is_critical_target` flag to dispatch payload — if true, force Opus profile
3. Document rollback: `MODEL_PROFILE=default` env override at any time
4. Commit + push as production change

If decision = REJECT:
1. Document why in memory + architecture vision
2. Remove G4_test_sonnet profile (clean up)
3. Move to G1 next

---

## Self-review checklist (run after writing the plan)

- [x] Every step has either code OR a command (no descriptive-only steps)
- [x] Files: section is exact paths, not vague references
- [x] Test code complete (not "write tests for the above")
- [x] Commit messages drafted, not placeholders
- [x] Tasks 1-6 are TDD-ordered (test first, impl after, commit last)
- [x] Phase 2 + Phase 3 acknowledged as out-of-scope-for-build but documented for continuity
- [x] Verify-loop continues to monitor — Tasks include explicit `bun test test/ + verify-framework` after each significant step
