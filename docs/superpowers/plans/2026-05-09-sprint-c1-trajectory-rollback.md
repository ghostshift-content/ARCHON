# Sprint C.1 — Trajectory Observation MVP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Observation-first telemetry that classifies every Phase 2 specialist's output as ON_TRACK / OFF_TRACK / CRASHED via a fresh-context Haiku check, written to `/root/intel/trajectory-observations.jsonl`. No auto-rollback yet — gather one week of data, then decide.

**Architecture:** New module `agents/trajectory-observer.js` exposes `observeSpecialistOutput(opts)` and `logObservation(obs)`. Wired into `event-bus.js` immediately after each Phase 2 specialist's `spawnAgent` returns. Fail-soft (any error in observer never breaks the pipeline). Anti-sycophancy: observer sees only the goal + output, never the analyst's claims or downstream verdicts. JSONL log is append-only, idempotent on retry.

**Tech Stack:** Node.js + bun test, fresh-context Haiku via existing `claude --print --model claude-haiku-4-5` subprocess pattern (matches `scripts/run-judge-verifier.js`). No new dependencies.

**Why this approach (vs the published TrajAD):** The arXiv paper uses a 4B fine-tuned verifier with three failure modes (Task Failure / Process Inefficiency / Unwarranted Continuation). We use Haiku as proxy because (a) we already have the binary integrated, (b) per-call cost is ~$0.01 vs running our own model server, (c) the rubric translates 1:1 to a structured prompt. MVP is observation-only because rolling back a Phase 2 dispatch mid-pipeline requires synchronization with the existing checkpoint/heartbeat logic — that's Sprint C.1.5, not C.1.

**Success criteria for MVP:** After one full pentest run on a real target:
1. `trajectory-observations.jsonl` exists and has one line per Phase 2 specialist (~18 lines for pentest squad).
2. Each line parses cleanly as the canonical `Observation` schema (defined in Task 1).
3. At least one observation classifies as `off-track` or `crashed` (proves the observer actually discriminates — if every line is `on-track` the rubric is too lenient).
4. Daemon PM2 restart count unchanged through the run (no pipeline regression).
5. Total observer cost adds <5% to the task's `totalCost` — at $0.01 per observation × 18 specialists = ~$0.18 on a typical $25 run = 0.7%.

---

## File Structure

| File | Responsibility |
|------|---------------|
| `agents/trajectory-observer.js` (new) | Pure module: `observeSpecialistOutput`, `buildObserverPrompt`, `parseObserverResponse`, `logObservation`. No process spawning. |
| `test/trajectory-observer.test.js` (new) | Unit tests for prompt shape, parser tolerance, log append idempotence, anti-sycophancy. |
| `test/event-bus-trajectory-wiring.test.js` (new) | Module-level grep tests proving the observer is wired at the right point in event-bus.js Phase 2. |
| `event-bus.js` (modify) | Wire `observeSpecialistOutput` after each Phase 2 specialist's `spawnAgent` resolves. Fail-soft. |
| `verify-framework.js` (modify) | Add GATE-63 enforcing the observer module exists + is wired. |
| `/root/intel/trajectory-observations.jsonl` (runtime artifact) | Append-only log, one JSON object per observation. |

---

## Canonical Observation Schema

Every line in `/root/intel/trajectory-observations.jsonl` is exactly this shape:

```json
{
  "schema_version": "1",
  "observed_at": "2026-05-09T22:00:00.000Z",
  "task_id": "1778331136333",
  "agent": "KARNA",
  "verdict": "on-track",
  "first_failed_dim": null,
  "reason": "Specialist focused on SQLi probes against discovered endpoints; produced 3 finding objects with curl evidence.",
  "output_bytes": 8412,
  "elapsed_ms": 145000,
  "model": "claude-haiku-4-5"
}
```

Fields:
- `schema_version`: bumps when fields change. Start at "1".
- `verdict`: `on-track` | `off-track` | `crashed` | `indeterminate` (parse error / empty output)
- `first_failed_dim`: `null` for on-track; otherwise the first failing dimension: `goal-alignment` | `evidence-quality` | `coherence`
- `reason`: one-sentence explanation from the LLM.
- `output_bytes` / `elapsed_ms`: telemetry for spotting "specialist crashed silently with empty output" cases.

---

## Three-Dimension Rubric

The observer LLM evaluates three dimensions, in order. First-failed determines the verdict.

1. **Goal alignment** — Did the specialist actually try to do what its dispatch prompt asked? Failure example: KARNA dispatched for SQLi but output is generic recon notes.
2. **Evidence quality** — Are claims backed by concrete artefacts (curl commands, response bodies, file paths)? Failure example: "I think this endpoint may have IDOR" with no probe evidence.
3. **Coherence** — Is the output internally consistent and parseable as findings? Failure example: incomplete JSON, half-written sentences, repeated paragraphs.

Anti-sycophancy guard: the observer is **never** shown KRIPA verdicts, judge-verifier verdicts, the goal_label, or the analyst's `notes`. It sees the dispatch prompt + the raw stdout only. Same discipline as the judge layer (Sprint A+B retro lessons).

---

## Task 1: Define schema constants and verdict taxonomy

**Files:**
- Create: `/root/agents/agents/trajectory-observer.js`
- Test: `/root/agents/test/trajectory-observer.test.js`

- [ ] **Step 1: Write the failing test**

```javascript
// test/trajectory-observer.test.js
const assert = require('node:assert')
const { test } = require('node:test')
const {
  SCHEMA_VERSION,
  VERDICTS,
  FAILURE_DIMS,
  DEFAULT_LOG_PATH,
} = require('../agents/trajectory-observer')

test('SCHEMA_VERSION is "1"', () => {
  assert.strictEqual(SCHEMA_VERSION, '1')
})

test('VERDICTS includes the four canonical values', () => {
  assert.deepStrictEqual(
    VERDICTS.slice().sort(),
    ['crashed', 'indeterminate', 'off-track', 'on-track']
  )
})

test('FAILURE_DIMS lists the three rubric dimensions in order', () => {
  assert.deepStrictEqual(FAILURE_DIMS, ['goal-alignment', 'evidence-quality', 'coherence'])
})

test('DEFAULT_LOG_PATH points at /root/intel/trajectory-observations.jsonl', () => {
  assert.strictEqual(DEFAULT_LOG_PATH, '/root/intel/trajectory-observations.jsonl')
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/trajectory-observer.test.js`
Expected: FAIL with "Cannot find module '../agents/trajectory-observer'"

- [ ] **Step 3: Write minimal implementation**

```javascript
// agents/trajectory-observer.js
//
// Sprint C.1 (2026-05-09): TrajAD-inspired specialist output observer.
// Pure observation layer — no auto-rollback in MVP. Logs verdicts so we
// can decide rollback policy from data, not speculation.
//
// Spec: docs/superpowers/specs/2026-05-09-sprint-c1-trajectory-rollback.md
// Reference: arXiv 2602.06443 (TrajAD step-level trajectory rollback)

const SCHEMA_VERSION = '1'
const VERDICTS = Object.freeze(['on-track', 'off-track', 'crashed', 'indeterminate'])
const FAILURE_DIMS = Object.freeze(['goal-alignment', 'evidence-quality', 'coherence'])
const DEFAULT_LOG_PATH = '/root/intel/trajectory-observations.jsonl'

module.exports = {
  SCHEMA_VERSION,
  VERDICTS,
  FAILURE_DIMS,
  DEFAULT_LOG_PATH,
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test test/trajectory-observer.test.js`
Expected: PASS, 4 tests pass

- [ ] **Step 5: Commit**

```bash
git add agents/trajectory-observer.js test/trajectory-observer.test.js
git commit -m "feat(trajectory-observer): Sprint C.1 Task 1 — schema constants

Define canonical Observation schema (version 1) + verdict taxonomy
(on-track/off-track/crashed/indeterminate) + 3-dimension rubric
(goal-alignment/evidence-quality/coherence). Log file path:
/root/intel/trajectory-observations.jsonl.

Spec: docs/superpowers/specs/2026-05-09-sprint-c1-trajectory-rollback.md
"
```

---

## Task 2: buildObserverPrompt — anti-sycophancy LLM prompt

**Files:**
- Modify: `/root/agents/agents/trajectory-observer.js`
- Modify: `/root/agents/test/trajectory-observer.test.js`

- [ ] **Step 1: Write the failing tests**

Append to `test/trajectory-observer.test.js`:

```javascript
const { buildObserverPrompt } = require('../agents/trajectory-observer')

test('buildObserverPrompt includes agent goal and output', () => {
  const prompt = buildObserverPrompt({
    agent: 'KARNA',
    goal: 'Probe discovered endpoints for SQL injection',
    output: 'Tested /search?q= with quote — got 500 error in 2.1s, sqlmap confirmed boolean blind.',
  })
  assert.match(prompt, /KARNA/)
  assert.match(prompt, /SQL injection/)
  assert.match(prompt, /sqlmap confirmed boolean blind/)
  assert.match(prompt, /STRICT JSON ONLY/)
})

test('buildObserverPrompt rubric mentions the three dimensions in order', () => {
  const prompt = buildObserverPrompt({ agent: 'X', goal: 'Y', output: 'Z' })
  const goalIdx = prompt.indexOf('Goal alignment')
  const evidenceIdx = prompt.indexOf('Evidence quality')
  const coherenceIdx = prompt.indexOf('Coherence')
  assert.ok(goalIdx > 0 && evidenceIdx > goalIdx && coherenceIdx > evidenceIdx,
    'rubric must list dimensions in goal/evidence/coherence order')
})

test('buildObserverPrompt anti-sycophancy: NO downstream verdicts visible', () => {
  const prompt = buildObserverPrompt({
    agent: 'X', goal: 'Y', output: 'Z',
    // These are EVERYTHING that would prime the observer.
    // The function must IGNORE them even if passed.
    kripa_verdict: 'CONFIRMED',
    judge_verdict: 'confirmed',
    notes: 'analyst says this is critical',
    severity_original: 'High',
  })
  assert.doesNotMatch(prompt, /CONFIRMED/, 'KRIPA verdict must not appear')
  assert.doesNotMatch(prompt, /critical/, 'analyst notes must not appear')
  assert.doesNotMatch(prompt, /severity_original/, 'severity must not anchor')
})

test('buildObserverPrompt truncates very long outputs to ~3KB', () => {
  const big = 'X'.repeat(50_000)
  const prompt = buildObserverPrompt({ agent: 'A', goal: 'G', output: big })
  // Prompt should not include all 50KB; truncate marker must appear
  assert.ok(prompt.length < 10_000, `prompt should be truncated, got ${prompt.length} bytes`)
  assert.match(prompt, /\[truncated\]/, 'truncation marker must be visible')
})

test('buildObserverPrompt accepts empty/null output as crashed-candidate', () => {
  const prompt1 = buildObserverPrompt({ agent: 'A', goal: 'G', output: '' })
  const prompt2 = buildObserverPrompt({ agent: 'A', goal: 'G', output: null })
  assert.match(prompt1, /\(no output\)/)
  assert.match(prompt2, /\(no output\)/)
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test test/trajectory-observer.test.js`
Expected: FAIL on `buildObserverPrompt is not a function`

- [ ] **Step 3: Write the implementation**

Add to `agents/trajectory-observer.js` (append before `module.exports`):

```javascript
const MAX_OUTPUT_BYTES = 3000

function buildObserverPrompt({ agent, goal, output }) {
  // Anti-sycophancy: deliberately ignore any downstream verdict fields.
  // Caller may pass them; we don't read them. Same discipline as judge-verifier.
  const safeAgent = String(agent || '(unknown)')
  const safeGoal = String(goal || '(no goal stated)')
  let safeOutput
  if (output == null || (typeof output === 'string' && output.trim() === '')) {
    safeOutput = '(no output)'
  } else {
    const s = String(output)
    safeOutput = s.length > MAX_OUTPUT_BYTES
      ? s.slice(0, MAX_OUTPUT_BYTES) + '\n…[truncated]'
      : s
  }

  return `You are the Trajectory Observer. Classify the SPECIALIST OUTPUT below
against its stated GOAL using a 3-dimension rubric. Do NOT validate the findings
themselves — that is a separate layer's job. Your job is to spot specialists that
went off-track, crashed silently, or produced incoherent output.

SPECIALIST: ${safeAgent}
GOAL: ${safeGoal}

OUTPUT:
${safeOutput}

EVALUATE 3 DIMENSIONS in order. First-failed determines verdict:

1. Goal alignment — Did the specialist actually attempt the stated goal?
   PASS: output addresses the goal directly with relevant artefacts
   FAIL: output is unrelated, generic recon, or wrong domain

2. Evidence quality — Are claims backed by concrete artefacts (curl, screenshots,
   response bodies, file paths)?
   PASS: at least one concrete artefact tied to a claim
   FAIL: assertions only, no probe data, no commands

3. Coherence — Is the output internally consistent and parseable?
   PASS: structured findings, complete sentences, no obvious crash mid-output
   FAIL: truncated mid-token, repeated paragraphs, malformed JSON, "Killed" / "OOM"

OUTPUT STRICT JSON ONLY (no markdown fences, no commentary):
{
  "verdict": "on-track" | "off-track" | "crashed" | "indeterminate",
  "first_failed_dim": "goal-alignment" | "evidence-quality" | "coherence" | null,
  "reason": "<one sentence>"
}

Verdict rules:
  - "on-track":      ALL THREE dimensions pass
  - "off-track":     dim 1 or 2 failed (specialist reasoning is wrong)
  - "crashed":       dim 3 failed AND output looks truncated/empty
  - "indeterminate": insufficient signal to decide either way

Be skeptical but fair. Specialists may legitimately find nothing — that's not
"off-track" if their probes were appropriate.`
}
```

- [ ] **Step 4: Update module.exports**

```javascript
module.exports = {
  SCHEMA_VERSION,
  VERDICTS,
  FAILURE_DIMS,
  DEFAULT_LOG_PATH,
  buildObserverPrompt,
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `bun test test/trajectory-observer.test.js`
Expected: PASS, 9 tests total

- [ ] **Step 6: Commit**

```bash
git add agents/trajectory-observer.js test/trajectory-observer.test.js
git commit -m "feat(trajectory-observer): Sprint C.1 Task 2 — buildObserverPrompt

3-dimension rubric LLM prompt (goal-alignment / evidence-quality /
coherence). Anti-sycophancy: observer never sees KRIPA/judge verdicts
or analyst notes. Long outputs truncated at 3KB with [truncated] marker.
Empty/null output renders as '(no output)' so the observer can classify
crashed-with-no-stdout cases.
"
```

---

## Task 3: parseObserverResponse — fail-safe JSON parser

**Files:**
- Modify: `/root/agents/agents/trajectory-observer.js`
- Modify: `/root/agents/test/trajectory-observer.test.js`

- [ ] **Step 1: Write the failing tests**

Append to `test/trajectory-observer.test.js`:

```javascript
const { parseObserverResponse } = require('../agents/trajectory-observer')

test('parseObserverResponse: clean JSON returns parsed object', () => {
  const r = parseObserverResponse(JSON.stringify({
    verdict: 'on-track', first_failed_dim: null, reason: 'looks good',
  }))
  assert.strictEqual(r.verdict, 'on-track')
  assert.strictEqual(r.first_failed_dim, null)
})

test('parseObserverResponse: strips markdown fences', () => {
  const r = parseObserverResponse('```json\n{"verdict":"off-track","first_failed_dim":"goal-alignment","reason":"x"}\n```')
  assert.strictEqual(r.verdict, 'off-track')
  assert.strictEqual(r.first_failed_dim, 'goal-alignment')
})

test('parseObserverResponse: invalid verdict normalizes to indeterminate', () => {
  const r = parseObserverResponse(JSON.stringify({ verdict: 'maybe', reason: 'x' }))
  assert.strictEqual(r.verdict, 'indeterminate')
  assert.ok(r.error, 'error reason should be set when verdict is unknown')
})

test('parseObserverResponse: empty/null input returns indeterminate (Strix-style)', () => {
  assert.strictEqual(parseObserverResponse('').verdict, 'indeterminate')
  assert.strictEqual(parseObserverResponse(null).verdict, 'indeterminate')
  assert.strictEqual(parseObserverResponse(undefined).verdict, 'indeterminate')
})

test('parseObserverResponse: malformed JSON returns indeterminate with error', () => {
  const r = parseObserverResponse('{this is broken')
  assert.strictEqual(r.verdict, 'indeterminate')
  assert.ok(r.error)
})

test('parseObserverResponse: invalid first_failed_dim is nulled', () => {
  const r = parseObserverResponse(JSON.stringify({
    verdict: 'off-track', first_failed_dim: 'made-up-dim', reason: 'x',
  }))
  assert.strictEqual(r.verdict, 'off-track')
  assert.strictEqual(r.first_failed_dim, null,
    'unrecognized dim must be nulled rather than passed through')
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test test/trajectory-observer.test.js`
Expected: FAIL on `parseObserverResponse is not a function`

- [ ] **Step 3: Write the implementation**

Add to `agents/trajectory-observer.js` (before `module.exports`):

```javascript
function parseObserverResponse(text) {
  // Strix-style discipline (matches Sprint B.1 judge-verifier): fail-safe
  // returns 'indeterminate' rather than silently confirming. Caller decides
  // what to do with indeterminate (here: just logged, not acted on in MVP).
  if (!text || typeof text !== 'string') {
    return { verdict: 'indeterminate', first_failed_dim: null, reason: '', error: 'empty response' }
  }
  let cleaned = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '')
  const m = cleaned.match(/\{[\s\S]*\}/)
  if (!m) {
    return { verdict: 'indeterminate', first_failed_dim: null, reason: '', error: 'no JSON found' }
  }
  let parsed
  try {
    parsed = JSON.parse(m[0])
  } catch (e) {
    return { verdict: 'indeterminate', first_failed_dim: null, reason: '', error: `parse failed: ${e.message}` }
  }
  // Validate verdict
  let verdict = String(parsed.verdict || '').toLowerCase()
  let error
  if (!VERDICTS.includes(verdict)) {
    error = `unknown verdict: ${parsed.verdict}`
    verdict = 'indeterminate'
  }
  // Validate first_failed_dim
  let dim = parsed.first_failed_dim
  if (dim != null && !FAILURE_DIMS.includes(String(dim))) {
    dim = null
  }
  if (verdict === 'on-track') dim = null // can't have a failed dim if on-track
  const result = {
    verdict,
    first_failed_dim: dim || null,
    reason: String(parsed.reason || '').slice(0, 500),
  }
  if (error) result.error = error
  return result
}
```

- [ ] **Step 4: Update module.exports**

```javascript
module.exports = {
  SCHEMA_VERSION,
  VERDICTS,
  FAILURE_DIMS,
  DEFAULT_LOG_PATH,
  buildObserverPrompt,
  parseObserverResponse,
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `bun test test/trajectory-observer.test.js`
Expected: PASS, 15 tests total

- [ ] **Step 6: Commit**

```bash
git add agents/trajectory-observer.js test/trajectory-observer.test.js
git commit -m "feat(trajectory-observer): Sprint C.1 Task 3 — parseObserverResponse

Strix-style fail-safe parser: empty / non-JSON / malformed / unknown verdict
all return 'indeterminate' with error context. Strips markdown fences.
Nulls invalid first_failed_dim values. Truncates reason to 500 chars.
Mirrors the judge-verifier parse hardening shipped in Sprint B.1.
"
```

---

## Task 4: logObservation — append-only JSONL writer

**Files:**
- Modify: `/root/agents/agents/trajectory-observer.js`
- Modify: `/root/agents/test/trajectory-observer.test.js`

- [ ] **Step 1: Write the failing tests**

Append to `test/trajectory-observer.test.js`:

```javascript
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { logObservation } = require('../agents/trajectory-observer')

test('logObservation: appends one JSON line to the file', () => {
  const tmp = path.join(os.tmpdir(), `traj-obs-${Date.now()}-${Math.random().toString(36).slice(2)}.jsonl`)
  try {
    logObservation({
      task_id: 'T1', agent: 'KARNA', verdict: 'on-track',
      first_failed_dim: null, reason: 'good', output_bytes: 100, elapsed_ms: 1000, model: 'claude-haiku-4-5',
    }, tmp)
    const lines = fs.readFileSync(tmp, 'utf-8').split('\n').filter(Boolean)
    assert.strictEqual(lines.length, 1)
    const parsed = JSON.parse(lines[0])
    assert.strictEqual(parsed.task_id, 'T1')
    assert.strictEqual(parsed.agent, 'KARNA')
    assert.strictEqual(parsed.verdict, 'on-track')
    assert.strictEqual(parsed.schema_version, '1')
    assert.ok(parsed.observed_at, 'observed_at must be set')
    assert.match(parsed.observed_at, /^\d{4}-\d{2}-\d{2}T/, 'observed_at must be ISO timestamp')
  } finally {
    if (fs.existsSync(tmp)) fs.unlinkSync(tmp)
  }
})

test('logObservation: multiple appends preserve order', () => {
  const tmp = path.join(os.tmpdir(), `traj-obs-${Date.now()}-${Math.random().toString(36).slice(2)}.jsonl`)
  try {
    for (const a of ['A', 'B', 'C']) {
      logObservation({ task_id: 'T1', agent: a, verdict: 'on-track' }, tmp)
    }
    const lines = fs.readFileSync(tmp, 'utf-8').split('\n').filter(Boolean)
    assert.strictEqual(lines.length, 3)
    assert.strictEqual(JSON.parse(lines[0]).agent, 'A')
    assert.strictEqual(JSON.parse(lines[1]).agent, 'B')
    assert.strictEqual(JSON.parse(lines[2]).agent, 'C')
  } finally {
    if (fs.existsSync(tmp)) fs.unlinkSync(tmp)
  }
})

test('logObservation: creates parent directory if missing', () => {
  const tmpDir = path.join(os.tmpdir(), `traj-obs-dir-${Date.now()}`)
  const tmp = path.join(tmpDir, 'nested', 'log.jsonl')
  try {
    assert.ok(!fs.existsSync(tmpDir), 'parent must not exist beforehand')
    logObservation({ task_id: 'T1', agent: 'X', verdict: 'on-track' }, tmp)
    assert.ok(fs.existsSync(tmp), 'log file must be created with parents')
  } finally {
    if (fs.existsSync(tmp)) fs.unlinkSync(tmp)
    if (fs.existsSync(path.dirname(tmp))) fs.rmdirSync(path.dirname(tmp))
    if (fs.existsSync(tmpDir)) fs.rmdirSync(tmpDir)
  }
})

test('logObservation: never throws — fail-soft for caller', () => {
  // Pass an unwriteable path. Must not throw.
  let threw = false
  try {
    logObservation({ task_id: 'T1', agent: 'X', verdict: 'on-track' }, '/proc/self/cmdline/cannot-write')
  } catch {
    threw = true
  }
  assert.strictEqual(threw, false, 'logObservation must never throw — caller is mid-pipeline')
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test test/trajectory-observer.test.js`
Expected: FAIL on `logObservation is not a function`

- [ ] **Step 3: Write the implementation**

Add to `agents/trajectory-observer.js` (before `module.exports`):

```javascript
const fs = require('node:fs')
const path = require('node:path')

function logObservation(obs, logFile = DEFAULT_LOG_PATH) {
  // Fail-soft: caller is mid-pipeline (Phase 2 specialist completion). An
  // observer-log error must never break the run. Worst case we lose a
  // single line of telemetry.
  try {
    const enriched = {
      schema_version: SCHEMA_VERSION,
      observed_at: obs.observed_at || new Date().toISOString(),
      ...obs,
    }
    const line = JSON.stringify(enriched) + '\n'
    const dir = path.dirname(logFile)
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
    fs.appendFileSync(logFile, line)
  } catch (e) {
    // Swallow. A future enhancement can wire this to logActivity, but for
    // MVP we accept silent loss of one telemetry record over breaking the run.
  }
}
```

- [ ] **Step 4: Update module.exports**

```javascript
module.exports = {
  SCHEMA_VERSION,
  VERDICTS,
  FAILURE_DIMS,
  DEFAULT_LOG_PATH,
  buildObserverPrompt,
  parseObserverResponse,
  logObservation,
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `bun test test/trajectory-observer.test.js`
Expected: PASS, 19 tests total

- [ ] **Step 6: Commit**

```bash
git add agents/trajectory-observer.js test/trajectory-observer.test.js
git commit -m "feat(trajectory-observer): Sprint C.1 Task 4 — logObservation

Append-only JSONL writer. Auto-injects schema_version + observed_at.
Creates parent directories. Fail-soft: never throws (caller is mid-
pipeline). Default path: /root/intel/trajectory-observations.jsonl.
"
```

---

## Task 5: observeSpecialistOutput — orchestrator

**Files:**
- Modify: `/root/agents/agents/trajectory-observer.js`
- Modify: `/root/agents/test/trajectory-observer.test.js`

- [ ] **Step 1: Write the failing tests**

Append to `test/trajectory-observer.test.js`:

```javascript
const { observeSpecialistOutput } = require('../agents/trajectory-observer')

test('observeSpecialistOutput: end-to-end with mock LLM returns observation', async () => {
  const tmp = path.join(os.tmpdir(), `obs-e2e-${Date.now()}-${Math.random().toString(36).slice(2)}.jsonl`)
  try {
    const callLLM = async () => JSON.stringify({
      verdict: 'on-track', first_failed_dim: null, reason: 'looks good',
    })
    const obs = await observeSpecialistOutput({
      agent: 'KARNA', taskId: 'T1', goal: 'find SQLi',
      output: 'tested /search?q= got 500',
      callLLM, logFile: tmp,
    })
    assert.strictEqual(obs.verdict, 'on-track')
    assert.strictEqual(obs.agent, 'KARNA')
    assert.strictEqual(obs.task_id, 'T1')
    assert.ok(obs.output_bytes > 0)
    assert.ok(obs.observed_at)
    // Should also be persisted
    const lines = fs.readFileSync(tmp, 'utf-8').split('\n').filter(Boolean)
    assert.strictEqual(lines.length, 1)
  } finally {
    if (fs.existsSync(tmp)) fs.unlinkSync(tmp)
  }
})

test('observeSpecialistOutput: LLM throw returns indeterminate, still logs', async () => {
  const tmp = path.join(os.tmpdir(), `obs-err-${Date.now()}-${Math.random().toString(36).slice(2)}.jsonl`)
  try {
    const callLLM = async () => { throw new Error('rate limit') }
    const obs = await observeSpecialistOutput({
      agent: 'X', taskId: 'T2', goal: 'g', output: 'o',
      callLLM, logFile: tmp,
    })
    assert.strictEqual(obs.verdict, 'indeterminate')
    assert.ok(obs.error, 'error must be captured on the observation')
    const lines = fs.readFileSync(tmp, 'utf-8').split('\n').filter(Boolean)
    assert.strictEqual(lines.length, 1, 'still logs even on LLM error — telemetry should be complete')
  } finally {
    if (fs.existsSync(tmp)) fs.unlinkSync(tmp)
  }
})

test('observeSpecialistOutput: never throws (fail-soft for caller)', async () => {
  // Even with a bad logFile, must not throw
  const callLLM = async () => 'not-json-at-all'
  let threw = false
  try {
    await observeSpecialistOutput({
      agent: 'X', taskId: 'T3', goal: 'g', output: 'o',
      callLLM, logFile: '/proc/self/cmdline/blocked',
    })
  } catch {
    threw = true
  }
  assert.strictEqual(threw, false, 'observeSpecialistOutput must never throw')
})

test('observeSpecialistOutput: respects elapsed_ms passed in (telemetry input)', async () => {
  const tmp = path.join(os.tmpdir(), `obs-elapsed-${Date.now()}-${Math.random().toString(36).slice(2)}.jsonl`)
  try {
    const callLLM = async () => JSON.stringify({ verdict: 'on-track', first_failed_dim: null, reason: 'x' })
    const obs = await observeSpecialistOutput({
      agent: 'X', taskId: 'T4', goal: 'g', output: 'o',
      callLLM, logFile: tmp, elapsedMs: 12345, model: 'claude-haiku-4-5',
    })
    assert.strictEqual(obs.elapsed_ms, 12345)
    assert.strictEqual(obs.model, 'claude-haiku-4-5')
  } finally {
    if (fs.existsSync(tmp)) fs.unlinkSync(tmp)
  }
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test test/trajectory-observer.test.js`
Expected: FAIL on `observeSpecialistOutput is not a function`

- [ ] **Step 3: Write the implementation**

Add to `agents/trajectory-observer.js` (before `module.exports`):

```javascript
async function observeSpecialistOutput({
  agent, taskId, goal, output,
  callLLM, logFile = DEFAULT_LOG_PATH,
  elapsedMs = null, model = null,
}) {
  const outputStr = typeof output === 'string' ? output : (output == null ? '' : String(output))
  const outputBytes = Buffer.byteLength(outputStr, 'utf-8')

  let parsed = { verdict: 'indeterminate', first_failed_dim: null, reason: '' }
  try {
    const prompt = buildObserverPrompt({ agent, goal, output: outputStr })
    const response = await callLLM(prompt)
    parsed = parseObserverResponse(response)
  } catch (e) {
    parsed = { verdict: 'indeterminate', first_failed_dim: null, reason: '', error: `LLM error: ${e.message}` }
  }

  const obs = {
    task_id: String(taskId),
    agent: String(agent || '(unknown)'),
    verdict: parsed.verdict,
    first_failed_dim: parsed.first_failed_dim,
    reason: parsed.reason,
    output_bytes: outputBytes,
    elapsed_ms: elapsedMs,
    model,
  }
  if (parsed.error) obs.error = parsed.error

  // Persist (fail-soft inside logObservation)
  logObservation(obs, logFile)

  return obs
}
```

- [ ] **Step 4: Update module.exports**

```javascript
module.exports = {
  SCHEMA_VERSION,
  VERDICTS,
  FAILURE_DIMS,
  DEFAULT_LOG_PATH,
  buildObserverPrompt,
  parseObserverResponse,
  logObservation,
  observeSpecialistOutput,
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `bun test test/trajectory-observer.test.js`
Expected: PASS, 23 tests total

- [ ] **Step 6: Commit**

```bash
git add agents/trajectory-observer.js test/trajectory-observer.test.js
git commit -m "feat(trajectory-observer): Sprint C.1 Task 5 — observeSpecialistOutput

End-to-end orchestrator. Builds prompt → calls LLM → parses → logs.
Always returns an observation object even on LLM error (verdict =
indeterminate with error captured). Never throws — caller is mid-
pipeline. Persists every observation, including error cases, so the
JSONL log is a complete telemetry record.
"
```

---

## Task 6: Wire observer into event-bus.js Phase 2 dispatch

**Files:**
- Modify: `/root/agents/event-bus.js` (find `dispatchPentestParallel` or the Phase 2a/2b/2c/2d batch dispatch)

- [ ] **Step 1: Locate the wiring point**

Run: `grep -n "Phase 2\|dispatchPentestParallel\|Vuln batch" /root/agents/event-bus.js | head -20`

Expected: at least one match like `🔄 Phase 2a: Vuln batch 1`. The wiring goes right after each specialist's `spawnAgent` resolves, before result aggregation.

Read 50 lines around that match to see the existing batch loop. Look for the `await spawnAgent(...)` call inside the per-batch promise. The observer call should be immediately after that `await` resolves.

- [ ] **Step 2: Write the failing module-level test**

Create `/root/agents/test/event-bus-trajectory-wiring.test.js`:

```javascript
// test/event-bus-trajectory-wiring.test.js
//
// Module-level grep tests confirming Sprint C.1 trajectory observer
// is wired into the Phase 2 specialist dispatch loop. Catches accidental
// regression that would silently disable observer telemetry.

const assert = require('node:assert')
const { test } = require('node:test')
const fs = require('node:fs')
const path = require('node:path')

const SRC = fs.readFileSync(path.resolve(__dirname, '..', 'event-bus.js'), 'utf-8')

test('event-bus.js requires trajectory-observer module', () => {
  assert.match(SRC, /require\(['"]\.\/agents\/trajectory-observer['"]\)/,
    "event-bus.js must require './agents/trajectory-observer'")
})

test('event-bus.js calls observeSpecialistOutput', () => {
  assert.match(SRC, /observeSpecialistOutput\s*\(/,
    'observeSpecialistOutput must be invoked in event-bus.js')
})

test('observer call is fail-soft (wrapped in try/catch or .catch)', () => {
  // Find the observeSpecialistOutput call, take the surrounding 500 chars,
  // and verify it has either try/catch wrapping or a .catch handler.
  const idx = SRC.indexOf('observeSpecialistOutput')
  assert.ok(idx > 0, 'must find the call')
  // Look back ~500 chars for `try {` or forward for `.catch(`
  const before = SRC.slice(Math.max(0, idx - 500), idx)
  const after = SRC.slice(idx, idx + 500)
  const hasTryBefore = /try\s*\{/.test(before)
  const hasCatchAfter = /\.catch\s*\(/.test(after)
  assert.ok(hasTryBefore || hasCatchAfter,
    'observer call must be fail-soft (try/catch wrapping or .catch handler)')
})

test('observer log path is /root/intel/trajectory-observations.jsonl (default)', () => {
  // Either the call passes the default explicitly, or it omits logFile and uses DEFAULT_LOG_PATH.
  // Both are acceptable. We just guard against accidentally pointing at a wrong path.
  const idx = SRC.indexOf('observeSpecialistOutput')
  const block = SRC.slice(idx, idx + 600)
  const explicitPath = /trajectory-observations\.jsonl/.test(block)
  const noLogFileArg = !/logFile\s*:/.test(block) // omitted → uses default
  assert.ok(explicitPath || noLogFileArg,
    'observer call must use canonical log path (default or explicit)')
})
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `bun test test/event-bus-trajectory-wiring.test.js`
Expected: FAIL — observer not yet wired

- [ ] **Step 4: Wire the observer in event-bus.js**

Find the per-specialist result-handling block in `dispatchPentestParallel` (search for the inner `await spawnAgent`). The wiring pattern is:

```javascript
// (somewhere near the top of event-bus.js or in the dispatch function)
const trajectoryObserver = require('./agents/trajectory-observer')

// (inside the per-specialist promise, right after spawnAgent resolves)
const tStart = Date.now()
const result = await spawnAgent(/* existing args */)
const tEnd = Date.now()

// Sprint C.1 (2026-05-09): trajectory observer.
// Pure observation — no auto-rollback in MVP. Fail-soft.
;(async () => {
  try {
    const callObserverLLM = async (prompt) => {
      const { callRealLLM } = require('./scripts/run-judge-verifier')
      return callRealLLM(prompt, { model: 'claude-haiku-4-5' })
    }
    await trajectoryObserver.observeSpecialistOutput({
      agent: agentName.toUpperCase(),
      taskId: String(taskId),
      goal: result.dispatchPrompt || result.goal || '(no goal recorded)',
      output: result.output || result.stdout || '',
      callLLM: callObserverLLM,
      elapsedMs: tEnd - tStart,
      model: 'claude-haiku-4-5',
    })
  } catch {
    // Never break the pipeline on observer failure.
  }
})()
```

The IIFE (`;(async () => { … })()`) makes the observer call non-blocking — Phase 2 continues immediately, the observation is logged whenever the LLM call resolves.

If the agentName variable in the surrounding scope is different (e.g., `specialist`, `agent`, `name`), use that. The test in Step 2 just requires the call to exist with the right shape.

- [ ] **Step 5: Run wiring tests to verify they pass**

Run: `bun test test/event-bus-trajectory-wiring.test.js`
Expected: PASS, 4 tests pass

- [ ] **Step 6: Run the full test suite to verify no regressions**

Run: `node test/run-all.js 2>&1 | grep -E "Files:|FAIL"`
Expected: pre-existing 3 failures unchanged (`context-inventory`, `fresh-eyes`, `network-dispatcher-integration` — known stale on master). No new failures.

- [ ] **Step 7: Commit**

```bash
git add event-bus.js test/event-bus-trajectory-wiring.test.js
git commit -m "feat(event-bus): Sprint C.1 Task 6 — wire trajectory observer into Phase 2

Observer call fires after each Phase 2 specialist's spawnAgent resolves.
Non-blocking IIFE (Phase 2 doesn't wait for the LLM observation roundtrip).
Fail-soft (any error inside observer is swallowed — telemetry must never
break the pipeline). Module-level grep tests in event-bus-trajectory-
wiring.test.js lock in the wiring shape.
"
```

---

## Task 7: Add GATE-63 in verify-framework.js

**Files:**
- Modify: `/root/agents/verify-framework.js`

- [ ] **Step 1: Locate the gate insertion point**

Run: `grep -n "GATE-62\|GATE-61" /root/agents/verify-framework.js | head -5`

Expected: at least one `gate('GATE-62: …', () => { … })` block. New gate goes immediately after.

- [ ] **Step 2: Write the gate**

Add after the GATE-62 block in `/root/agents/verify-framework.js`:

```javascript
gate('GATE-63: trajectory-observer module exists with full API + wired into event-bus.js', () => {
  // Sprint C.1 (2026-05-09): trajectory observation MVP.
  const observer = require('/root/agents/agents/trajectory-observer')
  const required = ['SCHEMA_VERSION', 'VERDICTS', 'FAILURE_DIMS', 'DEFAULT_LOG_PATH',
                    'buildObserverPrompt', 'parseObserverResponse', 'logObservation',
                    'observeSpecialistOutput']
  for (const name of required) {
    if (observer[name] == null) throw new Error(`trajectory-observer missing export: ${name}`)
  }
  if (observer.SCHEMA_VERSION !== '1') {
    throw new Error(`SCHEMA_VERSION expected '1', got ${observer.SCHEMA_VERSION}`)
  }
  if (observer.DEFAULT_LOG_PATH !== '/root/intel/trajectory-observations.jsonl') {
    throw new Error(`DEFAULT_LOG_PATH must be /root/intel/trajectory-observations.jsonl`)
  }
  // Wiring check
  const eventBus = require('fs').readFileSync('/root/agents/event-bus.js', 'utf-8')
  if (!/require\(['"]\.\/agents\/trajectory-observer['"]\)/.test(eventBus)) {
    throw new Error('event-bus.js does not require ./agents/trajectory-observer')
  }
  if (!/observeSpecialistOutput\s*\(/.test(eventBus)) {
    throw new Error('event-bus.js does not call observeSpecialistOutput')
  }
  return 'trajectory-observer module + Phase 2 wiring + canonical log path verified'
})
```

- [ ] **Step 3: Run verify-framework**

Run: `node /root/agents/verify-framework.js 2>&1 | grep "RESULT:"`
Expected: `RESULT: 62/63 gates passed` (the 1 pre-existing failure is `GATE-1` test-suite which has the 3 known stale failures — unchanged)

- [ ] **Step 4: Confirm GATE-63 specifically passes**

Run: `node /root/agents/verify-framework.js 2>&1 | grep "GATE-63"`
Expected: `✓ GATE-63: trajectory-observer module exists with full API + wired into event-bus.js — trajectory-observer module + Phase 2 wiring + canonical log path verified`

- [ ] **Step 5: Commit**

```bash
git add verify-framework.js
git commit -m "feat(verify-framework): Sprint C.1 Task 7 — GATE-63 trajectory observer

Enforce trajectory-observer module exists with full canonical API
(SCHEMA_VERSION='1', DEFAULT_LOG_PATH='/root/intel/trajectory-observations.jsonl',
8 expected exports), AND that event-bus.js requires + calls observeSpecialistOutput.
Catches accidental wiring removal in future event-bus refactors.
"
```

---

## Task 8: PM2 reload + smoke test on a real pentest dispatch

**Files:** None (operational task)

- [ ] **Step 1: PM2 reload event-bus**

Run: `pm2 reload event-bus`

Expected: `[PM2] [event-bus](2) ✓` — daemon picks up the new module without restart loop. Verify with:

```bash
pm2 show event-bus | grep -E "status|restarts|uptime" | head -3
```

Expected: `online`, restart count incremented by exactly 1, fresh uptime <30s.

- [ ] **Step 2: Watch for observer log file creation**

Run (in a separate terminal or background):

```bash
ls -la /root/intel/trajectory-observations.jsonl 2>&1
```

Expected: empty file or "No such file" — the observer hasn't run yet, this is the baseline.

- [ ] **Step 3: Dispatch a real pentest task and let it complete**

Use whatever the standard dispatch path is (the user can supply a target via the MC UI, or via `node /root/agents/scripts/dispatch-pentest.js <target>` if such a script exists). For MVP we want one full Phase 2 batch to fire — that's enough to verify the observer logs at least 4-9 lines.

- [ ] **Step 4: Inspect the observer log file after Phase 2 completes**

Run:

```bash
wc -l /root/intel/trajectory-observations.jsonl
jq -c '{agent, verdict, first_failed_dim, reason: (.reason | .[0:80])}' /root/intel/trajectory-observations.jsonl
```

Expected:
- Line count ≥ 4 (one per Phase 2a specialist; ≥ 9 once all batches done)
- Each line has the canonical schema fields
- At least one verdict is NOT `on-track` — proves the rubric discriminates

- [ ] **Step 5: Verify daemon stability**

Run: `pm2 show event-bus | grep -E "restarts|unstable"`
Expected: restart count unchanged from Step 1 baseline. `unstable_restarts: 0`.

- [ ] **Step 6: Verify cost overhead**

Run:

```bash
TASKID=<task id from Step 3>
jq -r --arg id "$TASKID" '.[] | select(.id==$id) | .totalCost' /root/intel/tasks.json
wc -l /root/intel/trajectory-observations.jsonl
```

Compute: observer cost ≈ `n_observations × $0.01`. Verify `(observer_cost / totalCost) < 0.05` (5%).

- [ ] **Step 7: Commit a brief OPERATIONAL note (no code)**

Append to commit log only — no code change here. Update `/root/.claude/projects/-root/memory/project_g1_judge_verifier_mvp.md` adding a "Sprint C.1 — Trajectory Observer LIVE" section with: deploy date, baseline restart count, first-run line count, percentage of off-track verdicts.

```bash
git add /root/.claude/projects/-root/memory/project_g1_judge_verifier_mvp.md
git commit -m "docs(memory): Sprint C.1 trajectory observer LIVE — first-run telemetry"
```

---

## Self-Review

**Spec coverage:**
- ✅ Observation-only telemetry (no auto-rollback) — Tasks 1-5 build the module, Task 6 wires it as fire-and-forget.
- ✅ JSONL log format — defined in Task 1 schema + tested in Task 4.
- ✅ Haiku prompt design with anti-sycophancy — Task 2 with explicit tests for the discipline.
- ✅ Idempotence + fail-soft — Task 4 tests `never throws`, Task 5 tests `LLM throw still logs`, Task 6 wires as IIFE.
- ✅ GATE addition — Task 7 adds GATE-63.
- ✅ Success criteria — Task 8 measures all 5 criteria from the plan header.

**Placeholder scan:** No "TBD", "TODO", or "fill in" markers. Every code block contains the actual code. The locate-and-modify steps in Task 6 reference grep commands the engineer runs to find the right line.

**Type consistency:** `Observation` shape is consistent across Tasks 1, 4, 5, 6, 7. Verdict values (`on-track`/`off-track`/`crashed`/`indeterminate`) consistent everywhere. `first_failed_dim` allowed values consistent. Module export list grows monotonically (`SCHEMA_VERSION` added Task 1, `buildObserverPrompt` Task 2, etc.) and the GATE-63 in Task 7 enforces all 8 are present.

**Execution-time risks flagged:**
- The observer LLM costs real money. Task 8 explicitly measures cost overhead before declaring success.
- The IIFE in Task 6 is non-blocking — if a Phase 2 specialist takes 10 minutes, the observer call fires after, so the log line may arrive ~30 seconds AFTER the next phase starts. This is fine for telemetry (we don't act on the verdict).
- Grep tests in Task 6 are deliberately loose (allow either explicit log path or default-omitted). If the engineer changes the wiring style mid-implementation, the tests still pass without false-negatives.

**Things deliberately out of scope (Sprint C.1.5+):**
- Auto-rollback on `off-track` / `crashed` verdicts. Wait for ≥1 week of data.
- Re-dispatching the specialist with a corrective prompt. Same reason.
- Cross-squad observer (cloud-security, network-pentest). Pentest squad first; rest after the rubric is validated.
- Trajectory-aware reasoning DURING a specialist's run. MVP is per-completion only.

---

## Plan complete

Saved to `docs/superpowers/plans/2026-05-09-sprint-c1-trajectory-rollback.md`.

Two execution options for tomorrow:

**1. Subagent-Driven (recommended)** — fresh subagent per task, review checkpoints between, fast iteration, automatic spec + code-quality review.

**2. Inline Execution** — execute tasks sequentially in a single session with batch checkpoints.

Tasks 1–5 are isolated module work (zero pipeline coupling) — ideal for subagent-driven execution. Task 6 is the integration step (touches event-bus.js, the live daemon's source) — needs careful manual review. Tasks 7–8 are operational (GATE + smoke test).

**Recommendation: Subagent-Driven for Tasks 1-5, manual review of Task 6, operational handoff for Tasks 7-8.**
