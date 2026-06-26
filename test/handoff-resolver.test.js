
const __roots = require('../paths') // portable roots (KURU_*_ROOT) — see paths.js
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
  const map = loadCapabilityMap((__roots.AGENTS_ROOT + '/squads'))
  assert.ok(map['cloud-security'], 'cloud-security must be present')
  assert.ok(map['cloud-security']['data-residency'], 'data-residency capability indexed')
  const dataResAgents = map['cloud-security']['data-residency'].agents
  assert.ok(dataResAgents.includes('KUBERA'), 'KUBERA must own data-residency')
})

test('resolveTarget: returns the right agent', () => {
  const map = loadCapabilityMap((__roots.AGENTS_ROOT + '/squads'))
  const result = resolveTarget(map, 'cloud-security', 'data-residency')
  assert.ok(result, 'must return a resolution')
  assert.strictEqual(result.squad, 'cloud-security')
  assert.strictEqual(result.capability, 'data-residency')
  assert.ok(result.agent === 'KUBERA' || result.agent === 'kubera')
})

test('resolveTarget: returns null for unknown squad', () => {
  const map = loadCapabilityMap((__roots.AGENTS_ROOT + '/squads'))
  assert.strictEqual(resolveTarget(map, 'made-up-squad', 'anything'), null)
})

test('resolveTarget: returns null for unknown capability', () => {
  const map = loadCapabilityMap((__roots.AGENTS_ROOT + '/squads'))
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
    const map = loadCapabilityMap((__roots.AGENTS_ROOT + '/squads'))
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
    const map = loadCapabilityMap((__roots.AGENTS_ROOT + '/squads'))
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
    const map = loadCapabilityMap((__roots.AGENTS_ROOT + '/squads'))
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
    const map = loadCapabilityMap((__roots.AGENTS_ROOT + '/squads'))
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
