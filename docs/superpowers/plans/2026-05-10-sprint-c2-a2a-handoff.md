# Sprint C.2 — A2A Cross-Squad Handoff (MVP) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Pentest-squad specialists can request expert input from cloud-security squad via a file-based async handoff. The cloud-security agent runs against a structured task artifact and writes a verdict back. The verdict appears in the source task's final report. MVP scope: pentest → cloud-security ONE chain only.

**Architecture:** File-based async handoff (matches existing `telegram-outbox` / supervisor-inbox pattern, no new infra). Each squad declares capabilities in `capabilities.json`. Resolver watches `/root/intel/handoffs/inbox/`, routes by `target_squad + target_capability`, dispatches the target agent, writes back to `/root/intel/handoffs/done/`. Fail-soft (missing capability → `failed/`, never blocks pipeline).

**Tech Stack:** Node.js, bun test, existing `spawnAgent` infrastructure, file-system watching via `fs.watch` or polling.

**Locked decisions (Jay 2026-05-10):**
- Async (recommended) — pentest writes report with "handoff pending", cloud-security follows up
- Cost cap: max $0.50 per handoff, $2 per source task (configurable)
- Max 3 handoffs per finding
- Chain depth cap: 2 (cloud-security can request network-pentest, but no further)
- MVP: pentest → cloud-security ONE chain only. No cross-vendor crypto. No webhooks.

---

## File Structure

| File | Responsibility |
|------|---------------|
| `agents/handoff-protocol.js` (new) | Pure schema + helpers: `createHandoff`, `readHandoff`, `markCompleted`, `markFailed`, validation |
| `test/handoff-protocol.test.js` (new) | Unit tests for schema, helpers, idempotence |
| `agents/handoff-resolver.js` (new) | Watcher + router: read inbox, dispatch target agent, write result |
| `test/handoff-resolver.test.js` (new) | Unit tests for routing, fail-paths, dedup |
| `squads/pentest/capabilities.json` (new) | Pentest squad's capability declarations |
| `squads/cloud-security/capabilities.json` (new) | Cloud-security capabilities (data-residency = MVP target) |
| `event-bus.js` (modify) | Start handoff-resolver alongside other watchers; expose `createHandoff` to specialists |
| `verify-framework.js` (modify) | GATE-64: every active squad has capabilities.json. GATE-65: handoff-resolver wired |
| `agents/finding-schema.js` (modify) | Extend canonical Finding with `handoffs: []` array of handoff_ids |
| `/root/intel/handoffs/inbox/` (runtime) | Pending handoff JSONs |
| `/root/intel/handoffs/done/` (runtime) | Resolved handoff JSONs |
| `/root/intel/handoffs/failed/` (runtime) | Failed (no capability, cap exceeded, etc.) |

---

## Canonical Handoff Schema

```json
{
  "schema_version": "1",
  "handoff_id": "h-<timestamp>-<random4>",
  "source_task_id": "1778331136333",
  "source_squad": "pentest",
  "source_agent": "ASHWATTHAMA",
  "source_finding_id": "ASH-CONFIG-001",
  "target_squad": "cloud-security",
  "target_capability": "data-residency",
  "request": {
    "question": "string — what we're asking",
    "evidence": {},
    "expected_artifacts": ["string"]
  },
  "created_at": "2026-05-10T01:05:00.000Z",
  "status": "pending|completed|failed",
  "chain_depth": 0,
  "cost_budget_usd": 0.50,
  "parent_handoff_id": null
}
```

Resolved handoffs have these additional fields:

```json
{
  "resolved_at": "string ISO",
  "resolved_by_agent": "KUBERA",
  "verdict": "CONFIRMED|REFUTED|INDETERMINATE",
  "verdict_reason": "string",
  "evidence_added": {},
  "cost_actual_usd": 0.42
}
```

---

## Task 1: handoff-protocol.js — schema constants + paths

**Files:**
- Create: `/root/agents/agents/handoff-protocol.js`
- Test: `/root/agents/test/handoff-protocol.test.js`

- [ ] **Step 1: Write the failing test**

```javascript
// test/handoff-protocol.test.js
const assert = require('node:assert')
const { test } = require('node:test')
const {
  HANDOFF_SCHEMA_VERSION,
  HANDOFF_STATUSES,
  HANDOFFS_INBOX_DIR,
  HANDOFFS_DONE_DIR,
  HANDOFFS_FAILED_DIR,
  MAX_HANDOFFS_PER_FINDING,
  MAX_CHAIN_DEPTH,
  DEFAULT_HANDOFF_BUDGET_USD,
  MAX_TASK_HANDOFF_BUDGET_USD,
} = require('../agents/handoff-protocol')

test('HANDOFF_SCHEMA_VERSION is "1"', () => {
  assert.strictEqual(HANDOFF_SCHEMA_VERSION, '1')
})

test('HANDOFF_STATUSES has the three canonical values', () => {
  assert.deepStrictEqual(
    HANDOFF_STATUSES.slice().sort(),
    ['completed', 'failed', 'pending']
  )
})

test('Inbox/done/failed paths point at /root/intel/handoffs/<sub>/', () => {
  assert.strictEqual(HANDOFFS_INBOX_DIR, '/root/intel/handoffs/inbox')
  assert.strictEqual(HANDOFFS_DONE_DIR, '/root/intel/handoffs/done')
  assert.strictEqual(HANDOFFS_FAILED_DIR, '/root/intel/handoffs/failed')
})

test('Locked-decision constants match Jay 2026-05-10 design', () => {
  assert.strictEqual(MAX_HANDOFFS_PER_FINDING, 3)
  assert.strictEqual(MAX_CHAIN_DEPTH, 2)
  assert.strictEqual(DEFAULT_HANDOFF_BUDGET_USD, 0.50)
  assert.strictEqual(MAX_TASK_HANDOFF_BUDGET_USD, 2.00)
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test test/handoff-protocol.test.js`
Expected: FAIL with "Cannot find module '../agents/handoff-protocol'"

- [ ] **Step 3: Write minimal implementation**

```javascript
// agents/handoff-protocol.js
//
// Sprint C.2 (2026-05-10): A2A cross-squad handoff protocol.
// File-based async handoff: source squad drops a JSON in inbox/, resolver
// dispatches target agent, writes verdict to done/ (or failed/).
//
// Spec: docs/superpowers/specs/2026-05-10-sprint-c2-a2a-design.md
// Locked decisions: async, $0.50/$2 caps, 3 handoffs/finding, chain depth 2.

const HANDOFF_SCHEMA_VERSION = '1'
const HANDOFF_STATUSES = Object.freeze(['pending', 'completed', 'failed'])

const HANDOFFS_BASE_DIR = '/root/intel/handoffs'
const HANDOFFS_INBOX_DIR = '/root/intel/handoffs/inbox'
const HANDOFFS_DONE_DIR = '/root/intel/handoffs/done'
const HANDOFFS_FAILED_DIR = '/root/intel/handoffs/failed'

// Locked design decisions (Jay 2026-05-10):
const MAX_HANDOFFS_PER_FINDING = 3
const MAX_CHAIN_DEPTH = 2
const DEFAULT_HANDOFF_BUDGET_USD = 0.50
const MAX_TASK_HANDOFF_BUDGET_USD = 2.00

module.exports = {
  HANDOFF_SCHEMA_VERSION,
  HANDOFF_STATUSES,
  HANDOFFS_BASE_DIR,
  HANDOFFS_INBOX_DIR,
  HANDOFFS_DONE_DIR,
  HANDOFFS_FAILED_DIR,
  MAX_HANDOFFS_PER_FINDING,
  MAX_CHAIN_DEPTH,
  DEFAULT_HANDOFF_BUDGET_USD,
  MAX_TASK_HANDOFF_BUDGET_USD,
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test test/handoff-protocol.test.js`
Expected: PASS, 4 tests

- [ ] **Step 5: Commit**

```bash
git add agents/handoff-protocol.js test/handoff-protocol.test.js
git commit -m "feat(handoff-protocol): Sprint C.2 Task 1 — schema constants + paths

Schema version 1, 3 canonical statuses, three handoff dirs under
/root/intel/handoffs/, locked-decision constants (3/2/$0.50/\$2).
"
```

---

## Task 2: createHandoff — write a handoff JSON to inbox

**Files:**
- Modify: `/root/agents/agents/handoff-protocol.js`
- Modify: `/root/agents/test/handoff-protocol.test.js`

- [ ] **Step 1: Write failing tests**

Append to `test/handoff-protocol.test.js`:

```javascript
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const { createHandoff } = require('../agents/handoff-protocol')

test('createHandoff: writes a JSON file to inbox dir', () => {
  const tmpBase = path.join(os.tmpdir(), `handoff-test-${Date.now()}`)
  try {
    const result = createHandoff({
      sourceTaskId: 'T1',
      sourceSquad: 'pentest',
      sourceAgent: 'ASHWATTHAMA',
      sourceFindingId: 'ASH-001',
      targetSquad: 'cloud-security',
      targetCapability: 'data-residency',
      request: {
        question: 'Is this PII flow legal?',
        evidence: { api_host: 'cube.zhaopin.com' },
      },
    }, { baseDir: tmpBase })
    assert.ok(result.handoff_id, 'handoff_id must be set')
    assert.match(result.handoff_id, /^h-\d+-[a-z0-9]+$/)
    assert.ok(fs.existsSync(result.path), 'file must exist')
    const parsed = JSON.parse(fs.readFileSync(result.path, 'utf-8'))
    assert.strictEqual(parsed.schema_version, '1')
    assert.strictEqual(parsed.status, 'pending')
    assert.strictEqual(parsed.chain_depth, 0)
    assert.strictEqual(parsed.cost_budget_usd, 0.50)
    assert.strictEqual(parsed.source_squad, 'pentest')
    assert.strictEqual(parsed.target_capability, 'data-residency')
  } finally {
    fs.rmSync(tmpBase, { recursive: true, force: true })
  }
})

test('createHandoff: respects parent_handoff_id and chain_depth', () => {
  const tmpBase = path.join(os.tmpdir(), `handoff-chain-${Date.now()}`)
  try {
    const r = createHandoff({
      sourceTaskId: 'T1', sourceSquad: 'cloud-security', sourceAgent: 'KUBERA',
      sourceFindingId: 'F1', targetSquad: 'network-pentest',
      targetCapability: 'dns-attribution',
      request: { question: 'q', evidence: {} },
      parentHandoffId: 'h-abc-123',
      chainDepth: 1,
    }, { baseDir: tmpBase })
    const parsed = JSON.parse(fs.readFileSync(r.path, 'utf-8'))
    assert.strictEqual(parsed.parent_handoff_id, 'h-abc-123')
    assert.strictEqual(parsed.chain_depth, 1)
  } finally {
    fs.rmSync(tmpBase, { recursive: true, force: true })
  }
})

test('createHandoff: throws if chain_depth > MAX_CHAIN_DEPTH', () => {
  const tmpBase = path.join(os.tmpdir(), `handoff-depth-${Date.now()}`)
  try {
    assert.throws(
      () => createHandoff({
        sourceTaskId: 'T1', sourceSquad: 'pentest', sourceAgent: 'A',
        sourceFindingId: 'F1', targetSquad: 'cloud-security',
        targetCapability: 'x',
        request: { question: 'q', evidence: {} },
        chainDepth: 3,
      }, { baseDir: tmpBase }),
      /chain depth/i,
      'must reject chain_depth > MAX_CHAIN_DEPTH'
    )
  } finally {
    fs.rmSync(tmpBase, { recursive: true, force: true })
  }
})

test('createHandoff: creates parent dirs if missing', () => {
  const tmpBase = path.join(os.tmpdir(), `handoff-mkdir-${Date.now()}`)
  try {
    assert.ok(!fs.existsSync(tmpBase), 'parent must not exist')
    createHandoff({
      sourceTaskId: 'T1', sourceSquad: 'pentest', sourceAgent: 'A',
      sourceFindingId: 'F1', targetSquad: 'cloud-security',
      targetCapability: 'x',
      request: { question: 'q', evidence: {} },
    }, { baseDir: tmpBase })
    assert.ok(fs.existsSync(path.join(tmpBase, 'inbox')), 'inbox dir created')
  } finally {
    fs.rmSync(tmpBase, { recursive: true, force: true })
  }
})

test('createHandoff: required fields missing throws', () => {
  assert.throws(
    () => createHandoff({}, { baseDir: '/tmp' }),
    /missing required field/i
  )
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test test/handoff-protocol.test.js`
Expected: FAIL — `createHandoff is not a function`

- [ ] **Step 3: Write the implementation**

Add to `agents/handoff-protocol.js`:

```javascript
const fs = require('node:fs')
const path = require('node:path')

function generateHandoffId() {
  const ts = Date.now()
  const rand = Math.random().toString(36).slice(2, 6)
  return `h-${ts}-${rand}`
}

function createHandoff({
  sourceTaskId, sourceSquad, sourceAgent, sourceFindingId,
  targetSquad, targetCapability, request,
  parentHandoffId = null, chainDepth = 0,
  budgetUsd = DEFAULT_HANDOFF_BUDGET_USD,
}, { baseDir = HANDOFFS_BASE_DIR } = {}) {
  // Required-field validation
  const required = { sourceTaskId, sourceSquad, sourceAgent, sourceFindingId,
                     targetSquad, targetCapability, request }
  for (const [k, v] of Object.entries(required)) {
    if (v == null || v === '') throw new Error(`missing required field: ${k}`)
  }
  if (!request.question) throw new Error(`missing required field: request.question`)

  // Chain-depth guard
  if (chainDepth > MAX_CHAIN_DEPTH) {
    throw new Error(`chain depth ${chainDepth} exceeds MAX_CHAIN_DEPTH=${MAX_CHAIN_DEPTH}`)
  }

  const handoffId = generateHandoffId()
  const inboxDir = path.join(baseDir, 'inbox')
  fs.mkdirSync(inboxDir, { recursive: true })
  const filePath = path.join(inboxDir, `${handoffId}.json`)

  const record = {
    schema_version: HANDOFF_SCHEMA_VERSION,
    handoff_id: handoffId,
    source_task_id: String(sourceTaskId),
    source_squad: sourceSquad,
    source_agent: sourceAgent,
    source_finding_id: sourceFindingId,
    target_squad: targetSquad,
    target_capability: targetCapability,
    request: {
      question: String(request.question),
      evidence: request.evidence || {},
      expected_artifacts: request.expected_artifacts || [],
    },
    created_at: new Date().toISOString(),
    status: 'pending',
    chain_depth: chainDepth,
    cost_budget_usd: budgetUsd,
    parent_handoff_id: parentHandoffId,
  }

  fs.writeFileSync(filePath, JSON.stringify(record, null, 2) + '\n')
  return { handoff_id: handoffId, path: filePath, record }
}
```

Update `module.exports` to include `createHandoff`.

- [ ] **Step 4: Run tests**

Run: `bun test test/handoff-protocol.test.js`
Expected: PASS, 9 tests total

- [ ] **Step 5: Commit**

```bash
git add agents/handoff-protocol.js test/handoff-protocol.test.js
git commit -m "feat(handoff-protocol): Sprint C.2 Task 2 — createHandoff

Drop a structured handoff JSON into /root/intel/handoffs/inbox/. Validates
required fields, enforces chain-depth cap (2). Auto-mkdir parent dirs.
Generates unique handoff_id (h-<ts>-<rand>) for dedup + tracking.
"
```

---

## Task 3: readHandoff + markCompleted + markFailed — lifecycle helpers

**Files:**
- Modify: `/root/agents/agents/handoff-protocol.js`
- Modify: `/root/agents/test/handoff-protocol.test.js`

- [ ] **Step 1: Write failing tests**

Append to `test/handoff-protocol.test.js`:

```javascript
const { readHandoff, markCompleted, markFailed } = require('../agents/handoff-protocol')

test('readHandoff: parses JSON file from any handoff dir', () => {
  const tmpBase = path.join(os.tmpdir(), `handoff-read-${Date.now()}`)
  try {
    const r = createHandoff({
      sourceTaskId: 'T1', sourceSquad: 'pentest', sourceAgent: 'A',
      sourceFindingId: 'F1', targetSquad: 'cloud-security',
      targetCapability: 'x', request: { question: 'q', evidence: {} },
    }, { baseDir: tmpBase })
    const parsed = readHandoff(r.path)
    assert.strictEqual(parsed.handoff_id, r.handoff_id)
    assert.strictEqual(parsed.status, 'pending')
  } finally {
    fs.rmSync(tmpBase, { recursive: true, force: true })
  }
})

test('readHandoff: returns null for missing file', () => {
  assert.strictEqual(readHandoff('/nonexistent/path.json'), null)
})

test('markCompleted: moves file from inbox to done with verdict fields', () => {
  const tmpBase = path.join(os.tmpdir(), `handoff-mark-done-${Date.now()}`)
  try {
    const r = createHandoff({
      sourceTaskId: 'T1', sourceSquad: 'pentest', sourceAgent: 'A',
      sourceFindingId: 'F1', targetSquad: 'cloud-security',
      targetCapability: 'x', request: { question: 'q', evidence: {} },
    }, { baseDir: tmpBase })
    const result = markCompleted(r.path, {
      resolvedByAgent: 'KUBERA',
      verdict: 'CONFIRMED',
      verdictReason: 'GDPR Art. 44 violation',
      evidenceAdded: { framework: 'GDPR' },
      costActualUsd: 0.42,
    }, { baseDir: tmpBase })
    assert.ok(!fs.existsSync(r.path), 'inbox file must be moved')
    assert.ok(fs.existsSync(result.path), 'done file must exist')
    const parsed = JSON.parse(fs.readFileSync(result.path, 'utf-8'))
    assert.strictEqual(parsed.status, 'completed')
    assert.strictEqual(parsed.verdict, 'CONFIRMED')
    assert.strictEqual(parsed.cost_actual_usd, 0.42)
    assert.ok(parsed.resolved_at)
  } finally {
    fs.rmSync(tmpBase, { recursive: true, force: true })
  }
})

test('markFailed: moves to failed/ with reason', () => {
  const tmpBase = path.join(os.tmpdir(), `handoff-mark-fail-${Date.now()}`)
  try {
    const r = createHandoff({
      sourceTaskId: 'T1', sourceSquad: 'pentest', sourceAgent: 'A',
      sourceFindingId: 'F1', targetSquad: 'unknown-squad',
      targetCapability: 'x', request: { question: 'q', evidence: {} },
    }, { baseDir: tmpBase })
    const result = markFailed(r.path, 'no capability matching unknown-squad/x', { baseDir: tmpBase })
    assert.ok(!fs.existsSync(r.path), 'inbox file moved')
    assert.ok(fs.existsSync(result.path), 'failed file exists')
    const parsed = JSON.parse(fs.readFileSync(result.path, 'utf-8'))
    assert.strictEqual(parsed.status, 'failed')
    assert.match(parsed.failure_reason, /no capability/)
  } finally {
    fs.rmSync(tmpBase, { recursive: true, force: true })
  }
})

test('markCompleted: idempotent — second call is a no-op', () => {
  const tmpBase = path.join(os.tmpdir(), `handoff-idempotent-${Date.now()}`)
  try {
    const r = createHandoff({
      sourceTaskId: 'T1', sourceSquad: 'pentest', sourceAgent: 'A',
      sourceFindingId: 'F1', targetSquad: 'cloud-security',
      targetCapability: 'x', request: { question: 'q', evidence: {} },
    }, { baseDir: tmpBase })
    markCompleted(r.path, {
      resolvedByAgent: 'X', verdict: 'CONFIRMED', verdictReason: 'r',
    }, { baseDir: tmpBase })
    let threw = false
    try {
      markCompleted(r.path, {
        resolvedByAgent: 'X', verdict: 'REFUTED', verdictReason: 'r2',
      }, { baseDir: tmpBase })
    } catch { threw = true }
    assert.strictEqual(threw, false, 'second call must not throw')
  } finally {
    fs.rmSync(tmpBase, { recursive: true, force: true })
  }
})
```

- [ ] **Step 2: Run tests to verify they fail**

Expected: FAIL on functions not defined.

- [ ] **Step 3: Implementation**

Add to `agents/handoff-protocol.js`:

```javascript
function readHandoff(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'))
  } catch {
    return null
  }
}

function _moveTo(srcPath, destDir, baseDir) {
  fs.mkdirSync(destDir, { recursive: true })
  const destPath = path.join(destDir, path.basename(srcPath))
  fs.renameSync(srcPath, destPath)
  return destPath
}

function markCompleted(srcPath, {
  resolvedByAgent, verdict, verdictReason,
  evidenceAdded = {}, costActualUsd = 0,
}, { baseDir = HANDOFFS_BASE_DIR } = {}) {
  if (!fs.existsSync(srcPath)) {
    // Idempotent: file already moved (or never existed). No-op.
    return { path: null, alreadyResolved: true }
  }
  const record = readHandoff(srcPath)
  if (!record) throw new Error(`unparseable handoff at ${srcPath}`)
  Object.assign(record, {
    status: 'completed',
    resolved_at: new Date().toISOString(),
    resolved_by_agent: resolvedByAgent,
    verdict, verdict_reason: verdictReason,
    evidence_added: evidenceAdded,
    cost_actual_usd: costActualUsd,
  })
  fs.writeFileSync(srcPath, JSON.stringify(record, null, 2) + '\n')
  const doneDir = path.join(baseDir, 'done')
  const newPath = _moveTo(srcPath, doneDir, baseDir)
  return { path: newPath, record }
}

function markFailed(srcPath, reason, { baseDir = HANDOFFS_BASE_DIR } = {}) {
  if (!fs.existsSync(srcPath)) {
    return { path: null, alreadyResolved: true }
  }
  const record = readHandoff(srcPath)
  if (!record) throw new Error(`unparseable handoff at ${srcPath}`)
  Object.assign(record, {
    status: 'failed',
    resolved_at: new Date().toISOString(),
    failure_reason: String(reason),
  })
  fs.writeFileSync(srcPath, JSON.stringify(record, null, 2) + '\n')
  const failedDir = path.join(baseDir, 'failed')
  const newPath = _moveTo(srcPath, failedDir, baseDir)
  return { path: newPath, record }
}
```

Update `module.exports` to include `readHandoff`, `markCompleted`, `markFailed`.

- [ ] **Step 4: Run tests**

Expected: PASS, 14 tests total

- [ ] **Step 5: Commit**

```bash
git add agents/handoff-protocol.js test/handoff-protocol.test.js
git commit -m "feat(handoff-protocol): Sprint C.2 Task 3 — lifecycle helpers

readHandoff (null on missing file), markCompleted (move inbox→done with
verdict fields), markFailed (move inbox→failed with reason). All are
idempotent — second call on already-resolved handoff is a no-op so the
resolver can safely retry.
"
```

---

## Task 4: capabilities.json files for pentest + cloud-security

**Files:**
- Create: `/root/agents/squads/pentest/capabilities.json`
- Create: `/root/agents/squads/cloud-security/capabilities.json`

- [ ] **Step 1: Write the failing test**

Create `/root/agents/test/capabilities-files.test.js`:

```javascript
const assert = require('node:assert')
const { test } = require('node:test')
const fs = require('node:fs')

const REQUIRED_SQUADS = ['pentest', 'cloud-security']

for (const squad of REQUIRED_SQUADS) {
  test(`squads/${squad}/capabilities.json exists with valid shape`, () => {
    const filePath = `/root/agents/squads/${squad}/capabilities.json`
    assert.ok(fs.existsSync(filePath), `${filePath} must exist`)
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf-8'))
    assert.strictEqual(parsed.squad, squad)
    assert.strictEqual(parsed.version, '1')
    assert.ok(Array.isArray(parsed.capabilities))
    for (const cap of parsed.capabilities) {
      assert.ok(cap.id, 'capability must have id')
      assert.ok(Array.isArray(cap.agents) && cap.agents.length > 0,
        'capability must have ≥1 agent')
      assert.ok(cap.description, 'capability must have description')
    }
  })
}

test('cloud-security has data-residency capability (MVP requirement)', () => {
  const cs = JSON.parse(fs.readFileSync('/root/agents/squads/cloud-security/capabilities.json', 'utf-8'))
  const dataResidency = cs.capabilities.find(c => c.id === 'data-residency')
  assert.ok(dataResidency, 'cloud-security MUST declare data-residency capability')
  assert.ok(dataResidency.agents.includes('KUBERA') || dataResidency.agents.includes('kubera'),
    'KUBERA owns data-residency per spec')
})
```

- [ ] **Step 2: Run tests to verify they fail**

Expected: FAIL — files don't exist.

- [ ] **Step 3: Create the capabilities files**

Note: the directories `/root/agents/squads/pentest/` and `/root/agents/squads/cloud-security/` may not exist yet. Create them with `mkdir -p` if needed.

`squads/pentest/capabilities.json`:

```json
{
  "squad": "pentest",
  "version": "1",
  "capabilities": [
    {
      "id": "web-vulnerability-validation",
      "agents": ["NAKUL", "KARNA", "BHEEM"],
      "description": "XSS / SQLi / SSRF probe-and-confirm"
    },
    {
      "id": "supply-chain-risk",
      "agents": ["ASHWATTHAMA"],
      "description": "JS dependency / CDN / config-pointer integrity"
    }
  ]
}
```

`squads/cloud-security/capabilities.json`:

```json
{
  "squad": "cloud-security",
  "version": "1",
  "capabilities": [
    {
      "id": "data-residency",
      "agents": ["KUBERA"],
      "description": "Compliance verdict for cross-border PII flows (GDPR Art. 44, CCPA §1798.140(t), India DPDPA, etc.)"
    },
    {
      "id": "iam-audit",
      "agents": ["MITRA"],
      "description": "Cloud IAM policy review for over-privileged roles, exposed credentials"
    },
    {
      "id": "s3-bucket-audit",
      "agents": ["AGNI"],
      "description": "Public S3/GCS/Azure Blob exposure check"
    }
  ]
}
```

- [ ] **Step 4: Run tests**

Expected: PASS, 3 tests

- [ ] **Step 5: Commit**

```bash
git add squads/pentest/capabilities.json squads/cloud-security/capabilities.json test/capabilities-files.test.js
git commit -m "feat(squads): Sprint C.2 Task 4 — pentest + cloud-security capabilities.json

Each squad declares its handoff-receivable capabilities (id, agents,
description). Resolver routes by target_squad + target_capability.
MVP: cloud-security/data-residency (KUBERA-owned). Pentest is the source
squad in MVP — declared for symmetry + future-proofing.
"
```

---

## Task 5: handoff-resolver.js — capability lookup + dispatch

**Files:**
- Create: `/root/agents/agents/handoff-resolver.js`
- Test: `/root/agents/test/handoff-resolver.test.js`

- [ ] **Step 1: Write failing tests**

```javascript
// test/handoff-resolver.test.js
const assert = require('node:assert')
const { test } = require('node:test')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')

const {
  loadCapabilityMap, resolveTarget, processHandoff,
} = require('../agents/handoff-resolver')
const { createHandoff } = require('../agents/handoff-protocol')

test('loadCapabilityMap: reads all squads/<x>/capabilities.json', () => {
  const map = loadCapabilityMap('/root/agents/squads')
  assert.ok(map['cloud-security'], 'cloud-security must be present')
  assert.ok(map['cloud-security']['data-residency'], 'data-residency capability indexed')
  const dataResAgents = map['cloud-security']['data-residency'].agents
  assert.ok(dataResAgents.includes('KUBERA'), 'KUBERA must own data-residency')
})

test('resolveTarget: returns the right agent', () => {
  const map = loadCapabilityMap('/root/agents/squads')
  const result = resolveTarget(map, 'cloud-security', 'data-residency')
  assert.ok(result, 'must return a resolution')
  assert.strictEqual(result.squad, 'cloud-security')
  assert.strictEqual(result.capability, 'data-residency')
  assert.ok(result.agent === 'KUBERA' || result.agent === 'kubera')
})

test('resolveTarget: returns null for unknown squad', () => {
  const map = loadCapabilityMap('/root/agents/squads')
  assert.strictEqual(resolveTarget(map, 'made-up-squad', 'anything'), null)
})

test('resolveTarget: returns null for unknown capability', () => {
  const map = loadCapabilityMap('/root/agents/squads')
  assert.strictEqual(resolveTarget(map, 'cloud-security', 'made-up-cap'), null)
})

test('processHandoff: missing capability → markFailed, no dispatch', async () => {
  const tmpBase = path.join(os.tmpdir(), `resolver-fail-${Date.now()}`)
  try {
    const r = createHandoff({
      sourceTaskId: 'T1', sourceSquad: 'pentest', sourceAgent: 'A',
      sourceFindingId: 'F1', targetSquad: 'cloud-security',
      targetCapability: 'no-such-cap',
      request: { question: 'q', evidence: {} },
    }, { baseDir: tmpBase })
    const map = loadCapabilityMap('/root/agents/squads')
    let dispatched = false
    const dispatchAgent = async () => { dispatched = true; return null }
    const result = await processHandoff(r.path, map, { dispatchAgent, baseDir: tmpBase })
    assert.strictEqual(dispatched, false, 'must not dispatch when capability missing')
    assert.strictEqual(result.status, 'failed')
    assert.ok(fs.existsSync(path.join(tmpBase, 'failed', `${r.handoff_id}.json`)))
  } finally {
    fs.rmSync(tmpBase, { recursive: true, force: true })
  }
})

test('processHandoff: dispatch returns verdict → markCompleted', async () => {
  const tmpBase = path.join(os.tmpdir(), `resolver-success-${Date.now()}`)
  try {
    const r = createHandoff({
      sourceTaskId: 'T1', sourceSquad: 'pentest', sourceAgent: 'ASHWATTHAMA',
      sourceFindingId: 'F1', targetSquad: 'cloud-security',
      targetCapability: 'data-residency',
      request: { question: 'GDPR?', evidence: { x: 1 } },
    }, { baseDir: tmpBase })
    const map = loadCapabilityMap('/root/agents/squads')
    const dispatchAgent = async () => ({
      verdict: 'CONFIRMED',
      verdictReason: 'GDPR Art. 44 violation confirmed',
      evidenceAdded: { framework: 'GDPR' },
      costActualUsd: 0.18,
    })
    const result = await processHandoff(r.path, map, { dispatchAgent, baseDir: tmpBase })
    assert.strictEqual(result.status, 'completed')
    assert.ok(fs.existsSync(path.join(tmpBase, 'done', `${r.handoff_id}.json`)))
    const done = JSON.parse(fs.readFileSync(path.join(tmpBase, 'done', `${r.handoff_id}.json`), 'utf-8'))
    assert.strictEqual(done.verdict, 'CONFIRMED')
  } finally {
    fs.rmSync(tmpBase, { recursive: true, force: true })
  }
})

test('processHandoff: dispatch throws → markFailed with error', async () => {
  const tmpBase = path.join(os.tmpdir(), `resolver-throw-${Date.now()}`)
  try {
    const r = createHandoff({
      sourceTaskId: 'T1', sourceSquad: 'pentest', sourceAgent: 'A',
      sourceFindingId: 'F1', targetSquad: 'cloud-security',
      targetCapability: 'data-residency',
      request: { question: 'q', evidence: {} },
    }, { baseDir: tmpBase })
    const map = loadCapabilityMap('/root/agents/squads')
    const dispatchAgent = async () => { throw new Error('LLM rate limit') }
    const result = await processHandoff(r.path, map, { dispatchAgent, baseDir: tmpBase })
    assert.strictEqual(result.status, 'failed')
    const failed = JSON.parse(fs.readFileSync(path.join(tmpBase, 'failed', `${r.handoff_id}.json`), 'utf-8'))
    assert.match(failed.failure_reason, /rate limit/)
  } finally {
    fs.rmSync(tmpBase, { recursive: true, force: true })
  }
})

test('processHandoff: idempotent — re-processing already-completed file is a no-op', async () => {
  const tmpBase = path.join(os.tmpdir(), `resolver-idempotent-${Date.now()}`)
  try {
    const r = createHandoff({
      sourceTaskId: 'T1', sourceSquad: 'pentest', sourceAgent: 'A',
      sourceFindingId: 'F1', targetSquad: 'cloud-security',
      targetCapability: 'data-residency',
      request: { question: 'q', evidence: {} },
    }, { baseDir: tmpBase })
    const map = loadCapabilityMap('/root/agents/squads')
    let dispatchCount = 0
    const dispatchAgent = async () => {
      dispatchCount++
      return { verdict: 'CONFIRMED', verdictReason: 'r', evidenceAdded: {}, costActualUsd: 0 }
    }
    await processHandoff(r.path, map, { dispatchAgent, baseDir: tmpBase })
    // r.path no longer exists (moved to done/) — second call should no-op
    const second = await processHandoff(r.path, map, { dispatchAgent, baseDir: tmpBase })
    assert.strictEqual(dispatchCount, 1, 'dispatch must run only once')
    assert.ok(second.alreadyResolved || second.status === 'noop',
      'second call signals already-resolved')
  } finally {
    fs.rmSync(tmpBase, { recursive: true, force: true })
  }
})
```

- [ ] **Step 2: Run tests to verify they fail**

Expected: FAIL — handoff-resolver doesn't exist.

- [ ] **Step 3: Implementation**

```javascript
// agents/handoff-resolver.js
//
// Sprint C.2 Task 5 (2026-05-10): handoff resolver. Loads each squad's
// capabilities.json, routes incoming handoffs by target_squad +
// target_capability, dispatches the target agent, persists verdict.

const fs = require('node:fs')
const path = require('node:path')
const {
  HANDOFFS_BASE_DIR, readHandoff, markCompleted, markFailed,
} = require('./handoff-protocol')

const DEFAULT_SQUADS_DIR = '/root/agents/squads'

function loadCapabilityMap(squadsDir = DEFAULT_SQUADS_DIR) {
  const map = {}
  if (!fs.existsSync(squadsDir)) return map
  for (const squad of fs.readdirSync(squadsDir)) {
    const capFile = path.join(squadsDir, squad, 'capabilities.json')
    if (!fs.existsSync(capFile)) continue
    let parsed
    try {
      parsed = JSON.parse(fs.readFileSync(capFile, 'utf-8'))
    } catch {
      continue // skip malformed
    }
    map[parsed.squad || squad] = {}
    for (const cap of (parsed.capabilities || [])) {
      map[parsed.squad || squad][cap.id] = cap
    }
  }
  return map
}

function resolveTarget(capabilityMap, targetSquad, targetCapability) {
  const squadMap = capabilityMap[targetSquad]
  if (!squadMap) return null
  const cap = squadMap[targetCapability]
  if (!cap) return null
  return {
    squad: targetSquad,
    capability: targetCapability,
    agent: cap.agents[0], // primary agent for the capability
    cap,
  }
}

async function processHandoff(filePath, capabilityMap, {
  dispatchAgent, baseDir = HANDOFFS_BASE_DIR,
} = {}) {
  // Idempotence: file already moved (resolved or failed earlier)
  if (!fs.existsSync(filePath)) {
    return { status: 'noop', alreadyResolved: true }
  }
  const record = readHandoff(filePath)
  if (!record) {
    markFailed(filePath, 'unparseable handoff JSON', { baseDir })
    return { status: 'failed', reason: 'unparseable' }
  }
  // Route
  const target = resolveTarget(capabilityMap, record.target_squad, record.target_capability)
  if (!target) {
    markFailed(filePath, `no capability matching ${record.target_squad}/${record.target_capability}`, { baseDir })
    return { status: 'failed', reason: 'no-capability' }
  }
  // Dispatch
  let result
  try {
    result = await dispatchAgent({
      agent: target.agent,
      squad: target.squad,
      capability: target.capability,
      handoff: record,
    })
  } catch (e) {
    markFailed(filePath, `dispatch error: ${e.message}`, { baseDir })
    return { status: 'failed', reason: 'dispatch-error', error: e.message }
  }
  if (!result || !result.verdict) {
    markFailed(filePath, 'dispatch returned no verdict', { baseDir })
    return { status: 'failed', reason: 'no-verdict' }
  }
  markCompleted(filePath, {
    resolvedByAgent: target.agent,
    verdict: result.verdict,
    verdictReason: result.verdictReason || '',
    evidenceAdded: result.evidenceAdded || {},
    costActualUsd: result.costActualUsd || 0,
  }, { baseDir })
  return { status: 'completed' }
}

module.exports = {
  loadCapabilityMap,
  resolveTarget,
  processHandoff,
}
```

- [ ] **Step 4: Run tests**

Expected: PASS, 8 tests

- [ ] **Step 5: Commit**

```bash
git add agents/handoff-resolver.js test/handoff-resolver.test.js
git commit -m "feat(handoff-resolver): Sprint C.2 Task 5 — capability routing + dispatch

loadCapabilityMap: walk squads/<x>/capabilities.json, build squad → cap → agents map.
resolveTarget: lookup by target_squad + target_capability, returns null on miss.
processHandoff: route + dispatch + persist verdict. Fail-soft on unknown
capability, dispatch error, or missing verdict — handoff lands in failed/
with clear reason. Idempotent on already-moved files.

dispatchAgent injected as dependency (real impl in Task 6 wires it to
the cloud-security squad's agent runner; tests use a mock).
"
```

---

## Tasks 6-9 (preview only — full detail left for after Tasks 1-5 merge)

Tasks 6-9 are scoped but the implementer subagent should re-read this plan section + the spec doc before starting them, since their detail depends on what shape Tasks 1-5 produced.

**Task 6 — wire `createHandoff` into pentest specialist prompts:**
Add a "🔁 HANDOFF" section to ASHWATTHAMA's prompt template explaining when to request a handoff. Pentest specialists can opt-in to handoff via a structured emit (e.g., a stdout marker the dispatcher parses).

**Task 7 — wire `processHandoff` watcher into event-bus.js:**
At SANJAY startup, walk `/root/intel/handoffs/inbox/` and process each. Add a `fs.watch` (or polling fallback) to handle handoffs created during a run. Use the existing `spawnAgent` infrastructure for dispatch — the dispatchAgent closure is the integration glue.

**Task 8 — extend Finding schema + report integration:**
Modify `agents/finding-schema.js` so `normalizeFinding` accepts a `handoffs: []` array. Update VYASA prompt to inline handoff verdicts under each finding's evidence section. So a finding like ASH-CONFIG-001 in the published report will show:
> **Pentest verdict (ASHWATTHAMA):** Supply-chain misconfig
> **Cloud-security handoff verdict (KUBERA):** GDPR Art. 44 violation confirmed.

**Task 9 — GATE-64 + GATE-65:**
GATE-64: every active squad in `event-bus.js` has a `capabilities.json`.
GATE-65: SANJAY startup logs include `handoff-resolver started` (process the inbox).

**Task 10 — operational verification:**
Re-dispatch motorola task or a synthetic test. Verify a handoff fires from ASHWATTHAMA to KUBERA on ASH-CONFIG-001. Confirm verdict appears in the published report.

---

## Self-Review

**Spec coverage** (against `specs/2026-05-10-sprint-c2-a2a-design.md`):
- ✅ File-based protocol — Tasks 1-3 build the protocol module
- ✅ Capabilities map — Task 4 declares them, Task 5 loads + indexes
- ✅ Routing by squad+capability — Task 5
- ✅ Fail-soft on missing capability — Task 5 tests
- ✅ Locked decisions (3 handoffs / chain-2 / $0.50/$2) — Task 1 constants + Task 2 enforcement
- ⏸ Wiring into specialists' prompts — Task 6 (preview only in this plan)
- ⏸ Wiring into SANJAY at startup — Task 7
- ⏸ Report integration — Task 8

**Placeholder check:** Tasks 1-5 have full code in every step. Tasks 6-10 are preview-only by design (their detail depends on what Tasks 1-5 actually produce — locking them now risks plan-vs-impl drift). After Task 5 merges, expand Tasks 6-10 in a follow-on plan or in this same file.

**Type consistency:** Schema-version "1" everywhere. Handoff statuses enumerated and exported. Finding schema extension (Task 8) uses arrays of handoff_ids — matches `createHandoff`'s return shape.

**Risks:**
- Task 7 (watcher integration) is the riskiest: live daemon must process handoffs without blocking the main event loop. Plan to use the same IIFE / fail-soft pattern as Sprint C.1's trajectory observer.
- Task 6 (specialist prompt update) requires editing a per-agent prompt template — find which file holds ASHWATTHAMA's prompt before the subagent starts.

---

## Plan complete

Saved to `docs/superpowers/plans/2026-05-10-sprint-c2-a2a-handoff.md`.

**Recommendation:** Subagent-Driven for Tasks 1-5 (each task touches at most 2 files, clear TDD pattern). After Tasks 1-5 merge cleanly, write the detailed Tasks 6-10 in a follow-on plan informed by what shipped.
