
const __roots = require('../paths') // portable roots (KURU_*_ROOT) — see paths.js
// test/handoff-cost-caps.test.js
//
// Code-review fix (2026-05-10): handoff-protocol exported MAX_HANDOFFS_PER_FINDING
// and MAX_TASK_HANDOFF_BUDGET_USD as constants and the specialist prompt told
// agents the caps were "enforced by handoff-protocol" — but neither
// createHandoff() nor processHandoff() actually read them. A misbehaving
// specialist could fire 50 handoffs against one finding. These tests lock
// in the enforcement now wired in:
//   - createHandoff:  per-finding count cap (inbox + done + failed scope)
//   - processHandoff: per-task cumulative cost cap (sum of done/ entries)

const assert = require('node:assert')
const { test } = require('node:test')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')

const {
  createHandoff,
  MAX_HANDOFFS_PER_FINDING,
  MAX_TASK_HANDOFF_BUDGET_USD,
} = require('../agents/handoff-protocol')
const { processHandoff, loadCapabilityMap } = require('../agents/handoff-resolver')

function freshBaseDir(label) {
  const dir = path.join(os.tmpdir(), `handoff-caps-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`)
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

function baseArgs(overrides = {}) {
  return {
    sourceTaskId: 'T-CAP',
    sourceSquad: 'pentest',
    sourceAgent: 'FORGE',
    sourceFindingId: 'F-1',
    targetSquad: 'cloud-security',
    targetCapability: 'data-residency',
    request: { question: 'q?', evidence: { k: 'v' } },
    ...overrides,
  }
}

test('createHandoff: 3 handoffs for same finding succeed; 4th throws with MAX_HANDOFFS_PER_FINDING', () => {
  const tmpBase = freshBaseDir('count-cap')
  try {
    for (let i = 0; i < MAX_HANDOFFS_PER_FINDING; i++) {
      createHandoff(baseArgs({ sourceFindingId: 'F-A' }), { baseDir: tmpBase })
    }
    assert.throws(
      () => createHandoff(baseArgs({ sourceFindingId: 'F-A' }), { baseDir: tmpBase }),
      /MAX_HANDOFFS_PER_FINDING/,
      'must throw with MAX_HANDOFFS_PER_FINDING in message'
    )
  } finally {
    fs.rmSync(tmpBase, { recursive: true, force: true })
  }
})

test('createHandoff: per-finding scope — 3 handoffs for DIFFERENT findings on same task all succeed', () => {
  const tmpBase = freshBaseDir('per-finding-scope')
  try {
    // Each finding gets its own count, so even 9 handoffs (3 findings × 3) should be fine.
    for (const findingId of ['F-X', 'F-Y', 'F-Z']) {
      for (let i = 0; i < MAX_HANDOFFS_PER_FINDING; i++) {
        const r = createHandoff(baseArgs({ sourceFindingId: findingId }), { baseDir: tmpBase })
        assert.ok(r.handoff_id, `${findingId} #${i} should succeed`)
      }
    }
    // But a 4th on F-X should still fail (per-finding, not per-task)
    assert.throws(
      () => createHandoff(baseArgs({ sourceFindingId: 'F-X' }), { baseDir: tmpBase }),
      /MAX_HANDOFFS_PER_FINDING/
    )
  } finally {
    fs.rmSync(tmpBase, { recursive: true, force: true })
  }
})

test('createHandoff: cap counter walks all 3 dirs (inbox + done + failed)', () => {
  const tmpBase = freshBaseDir('walk-3-dirs')
  try {
    // First handoff lands in inbox/
    const r1 = createHandoff(baseArgs({ sourceFindingId: 'F-W' }), { baseDir: tmpBase })
    // Manually relocate the second to done/ and the third to failed/ — this
    // simulates the natural flow (inbox → done after dispatch, inbox → failed
    // on capability miss). The cap counter MUST see all three.
    const r2 = createHandoff(baseArgs({ sourceFindingId: 'F-W' }), { baseDir: tmpBase })
    const doneDir = path.join(tmpBase, 'done')
    fs.mkdirSync(doneDir, { recursive: true })
    fs.renameSync(r2.path, path.join(doneDir, path.basename(r2.path)))

    const r3 = createHandoff(baseArgs({ sourceFindingId: 'F-W' }), { baseDir: tmpBase })
    const failedDir = path.join(tmpBase, 'failed')
    fs.mkdirSync(failedDir, { recursive: true })
    fs.renameSync(r3.path, path.join(failedDir, path.basename(r3.path)))

    // Now there's 1 in inbox, 1 in done, 1 in failed → count == 3.
    // A 4th must throw, proving the counter looked at all three dirs.
    assert.throws(
      () => createHandoff(baseArgs({ sourceFindingId: 'F-W' }), { baseDir: tmpBase }),
      /MAX_HANDOFFS_PER_FINDING/,
      'counter must walk inbox/+done/+failed/'
    )
    // Sanity: r1 is still in inbox
    assert.ok(fs.existsSync(r1.path))
  } finally {
    fs.rmSync(tmpBase, { recursive: true, force: true })
  }
})

test('createHandoff: --force flag bypasses count cap and emits a warning', () => {
  const tmpBase = freshBaseDir('force-bypass')
  try {
    for (let i = 0; i < MAX_HANDOFFS_PER_FINDING; i++) {
      createHandoff(baseArgs({ sourceFindingId: 'F-F' }), { baseDir: tmpBase })
    }
    // Capture console.warn
    const warnings = []
    const origWarn = console.warn
    console.warn = (...args) => warnings.push(args.join(' '))
    try {
      const r = createHandoff(baseArgs({ sourceFindingId: 'F-F', force: true }), { baseDir: tmpBase })
      assert.ok(r.handoff_id, 'force=true must succeed past the cap')
      assert.ok(fs.existsSync(r.path))
    } finally {
      console.warn = origWarn
    }
    assert.ok(
      warnings.some(w => /MAX_HANDOFFS_PER_FINDING/.test(w) && /force/i.test(w)),
      `expected a warning mentioning MAX_HANDOFFS_PER_FINDING + force; got: ${JSON.stringify(warnings)}`
    )
  } finally {
    fs.rmSync(tmpBase, { recursive: true, force: true })
  }
})

test('createHandoff: count is per-(task, finding) — different sourceTaskId doesn\'t share the cap', () => {
  const tmpBase = freshBaseDir('per-task')
  try {
    for (let i = 0; i < MAX_HANDOFFS_PER_FINDING; i++) {
      createHandoff(baseArgs({ sourceTaskId: 'T-A', sourceFindingId: 'F-1' }), { baseDir: tmpBase })
    }
    // T-B with same finding id is a logically different task → fresh count.
    const r = createHandoff(baseArgs({ sourceTaskId: 'T-B', sourceFindingId: 'F-1' }), { baseDir: tmpBase })
    assert.ok(r.handoff_id, 'different task must not share finding-cap counter')
  } finally {
    fs.rmSync(tmpBase, { recursive: true, force: true })
  }
})

test('processHandoff: cumulative task cost ≥ MAX_TASK_HANDOFF_BUDGET_USD → next handoff marked failed, no dispatch', async () => {
  const tmpBase = freshBaseDir('budget-cap')
  try {
    // Pre-seed done/ with handoffs that already cost $2.00 cumulative
    // (1.10 + 0.95 = $2.05). Use task id T-OVER.
    const doneDir = path.join(tmpBase, 'done')
    fs.mkdirSync(doneDir, { recursive: true })
    const seed = (id, cost) => fs.writeFileSync(
      path.join(doneDir, `${id}.json`),
      JSON.stringify({
        handoff_id: id,
        source_task_id: 'T-OVER',
        source_finding_id: 'F-prev',
        target_squad: 'cloud-security',
        target_capability: 'data-residency',
        status: 'completed',
        cost_actual_usd: cost,
      }) + '\n'
    )
    seed('h-seed-1', 1.10)
    seed('h-seed-2', 0.95)

    // New handoff for the same task — capacity exceeded.
    const r = createHandoff(
      baseArgs({ sourceTaskId: 'T-OVER', sourceFindingId: 'F-NEW' }),
      { baseDir: tmpBase }
    )
    const map = loadCapabilityMap((__roots.AGENTS_ROOT + '/squads'))

    let dispatched = false
    const dispatchAgent = async () => {
      dispatched = true
      return { verdict: 'CONFIRMED', verdictReason: 'r', evidenceAdded: {}, costActualUsd: 0 }
    }
    const result = await processHandoff(r.path, map, { dispatchAgent, baseDir: tmpBase })

    assert.strictEqual(dispatched, false, 'must NOT call dispatchAgent when budget exceeded')
    assert.strictEqual(result.status, 'failed', 'result must report failed')

    const failedFile = path.join(tmpBase, 'failed', `${r.handoff_id}.json`)
    assert.ok(fs.existsSync(failedFile), 'handoff must be moved to failed/')
    const failedRec = JSON.parse(fs.readFileSync(failedFile, 'utf-8'))
    assert.match(failedRec.failure_reason, /budget exceeded/i, 'reason must say budget exceeded')
    assert.match(failedRec.failure_reason, /\$2\.00/, 'reason must mention the $2.00 cap')
    assert.match(failedRec.failure_reason, /\$2\.0\d/, 'reason must show actual sum')
  } finally {
    fs.rmSync(tmpBase, { recursive: true, force: true })
  }
})

test('processHandoff: under-budget tasks dispatch normally', async () => {
  const tmpBase = freshBaseDir('budget-ok')
  try {
    // Pre-seed: total $1.50 — under the $2.00 cap.
    const doneDir = path.join(tmpBase, 'done')
    fs.mkdirSync(doneDir, { recursive: true })
    fs.writeFileSync(
      path.join(doneDir, 'h-cheap.json'),
      JSON.stringify({
        handoff_id: 'h-cheap',
        source_task_id: 'T-OK',
        source_finding_id: 'F-prev',
        status: 'completed',
        cost_actual_usd: 1.50,
      }) + '\n'
    )
    const r = createHandoff(
      baseArgs({ sourceTaskId: 'T-OK', sourceFindingId: 'F-NEW' }),
      { baseDir: tmpBase }
    )
    const map = loadCapabilityMap((__roots.AGENTS_ROOT + '/squads'))
    let dispatched = false
    const dispatchAgent = async () => {
      dispatched = true
      return { verdict: 'CONFIRMED', verdictReason: 'ok', evidenceAdded: {}, costActualUsd: 0.10 }
    }
    const result = await processHandoff(r.path, map, { dispatchAgent, baseDir: tmpBase })
    assert.strictEqual(dispatched, true, 'under budget must still dispatch')
    assert.strictEqual(result.status, 'completed')
    assert.ok(MAX_TASK_HANDOFF_BUDGET_USD === 2.00, 'sanity: cap is $2.00')
  } finally {
    fs.rmSync(tmpBase, { recursive: true, force: true })
  }
})
