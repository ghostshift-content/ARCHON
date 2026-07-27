'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')
const controller = require('../src/runtime/runtime-controller')
const artifacts = require('../src/runtime/runtime-artifacts')
const taskBoard = require('../src/runtime/task-board')
const journal = require('../src/runtime/mission-journal')

function temp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'archon-adaptive-flow-'))
}

function finding(mode, overrides = {}) {
  return {
    title: 'Missing ownership check',
    class: 'access-control',
    severity: 'high',
    file: 'app/controllers/users.rb',
    line: 14,
    sink: 'update',
    endpoint: '/users/{id}',
    parameter: 'id',
    evidence_refs: ['EVID-source'],
    exploit_hypothesis: 'A user may update a record owned by another account.',
    mode,
    ...overrides,
  }
}

function successfulExecutor(mode, calls, opts = {}) {
  return async task => {
    calls.push({ phase: task.phase, id: task.id, candidate_ids: task.candidate_ids || [] })
    if (task.phase === 'inventory') return { no_issue: true, summary: 'inventory complete' }
    if (task.phase === 'research') {
      if (opts.noFindings) return { no_issue: true, summary: 'reviewed with no candidates' }
      return { candidates: [finding(mode, opts.finding)], evidence_refs: ['EVID-source'] }
    }
    if (task.phase === 'triage') {
      return { candidate_updates: task.candidate_ids.map(id => ({ id, accepted: true })) }
    }
    if (task.phase === 'runtime_validate') {
      return {
        candidate_updates: task.candidate_ids.map(id => ({
          id,
          runtime_evidence: true,
          status: 'RUNTIME_CONFIRMED',
          evidence_refs: ['EVID-request', 'EVID-response'],
        })),
      }
    }
    if (task.phase === 'verify') {
      return {
        votes: task.candidate_ids.map(candidate_id => ({
          candidate_id,
          lens: task.lens,
          verdict: 'TRUE_POSITIVE',
          evidence_refs: ['EVID-verifier'],
        })),
      }
    }
    if (task.phase === 'audit' || task.phase === 'judge') {
      return { approved_ids: task.candidate_ids, rejected: [] }
    }
    if (task.phase === 'report') {
      const preliminary = opts.preliminary === true
      return {
        report_generated: true,
        report_path: path.join(opts.dir, `${preliminary ? 'SOURCE-REVIEW-PRELIMINARY' : 'FINAL-REPORT'}-${opts.taskId}.md`),
        report_digest: 'a'.repeat(64),
      }
    }
    return { no_issue: true }
  }
}

test('static mission runs end to end, dedupes parallel observations, and source-confirms only after the verifier panel', async () => {
  const dir = temp()
  const taskId = 'static-e2e'
  const calls = []
  const result = await controller.run({
    taskId, intelRoot: dir, generation: 'active', mode: 'static',
    strategy: 'source', activeConcurrency: 2,
    applicableSkills: ['access-control', 'business-logic'],
    workstreams: [
      { id: 'users', files: ['app/controllers/users.rb'], skill_families: ['access-control'] },
      { id: 'shared-auth', files: ['app/controllers/users.rb'], skill_families: ['access-control'] },
    ],
  }, {
    executeTask: successfulExecutor('static', calls, { dir, taskId }),
    scopeValidate: () => true,
    quotaState: () => 'healthy',
  })

  const phases = calls.map(row => row.phase)
  assert.deepStrictEqual([...new Set(phases)], ['inventory', 'research', 'triage', 'verify', 'audit', 'judge', 'report'])
  assert.equal(phases.filter(value => value === 'inventory').length, 1)
  assert.equal(phases.filter(value => value === 'research').length, 2)
  assert.equal(phases.filter(value => value === 'verify').length, 3)
  assert.equal(phases.includes('runtime_validate'), false)
  assert.ok(phases.indexOf('triage') > phases.lastIndexOf('research'))
  assert.ok(phases.indexOf('audit') > phases.lastIndexOf('verify'))

  const candidates = artifacts.candidates(taskId, dir)
  assert.equal(candidates.length, 1)
  assert.equal(candidates[0].observation_count, 2)
  assert.equal(artifacts.decisions(taskId, dir).decisions[0].validation_status, 'SOURCE_CONFIRMED')
  assert.equal(result.completionGate.completion_status, 'COMPLETE')
  assert.equal(result.completionGate.report_eligible, true)
  assert.equal(result.board.counts.complete, true)
  assert.ok(result.sessions.every(row => row.status === 'completed'))
  assert.ok(journal.load(taskId, dir).some(row => row.type === 'COMPLETION_GATE'))
  fs.rmSync(dir, { recursive: true, force: true })
})

test('direct focused black-box mission keeps the selected lenses and produces runtime-confirmed output', async () => {
  const dir = temp()
  const taskId = 'blackbox-e2e'
  const calls = []
  const result = await controller.run({
    taskId, intelRoot: dir, generation: 'active', mode: 'blackbox',
    strategy: 'direct', activeConcurrency: 1,
    applicableSkills: ['xss', 'access-control'],
    workstreams: [{
      id: 'application-app-example-test',
      domains: ['app.example.test'],
      endpoints: ['https://app.example.test'],
      skill_families: ['xss', 'access-control'],
    }],
  }, {
    executeTask: successfulExecutor('blackbox', calls, {
      dir, taskId,
      finding: {
        class: 'xss',
        file: null,
        line: null,
        sink: 'innerHTML',
        runtime_evidence: true,
        evidence_refs: ['EVID-request', 'EVID-response'],
      },
    }),
    scopeValidate: () => true,
    quotaState: () => 'healthy',
  })

  assert.equal(result.plan.strategy, 'direct')
  assert.deepStrictEqual(result.plan.team.assignments[0].skill_families.sort(), ['access-control', 'xss'])
  assert.equal(calls.some(row => row.phase === 'runtime_validate'), false)
  assert.equal(artifacts.decisions(taskId, dir).decisions[0].validation_status, 'RUNTIME_CONFIRMED')
  assert.equal(result.completionGate.report_eligible, true)
  fs.rmSync(dir, { recursive: true, force: true })
})

test('white-box without an authorized runtime target stays preliminary and needs live validation', async () => {
  const dir = temp()
  const taskId = 'whitebox-source-only'
  const calls = []
  const result = await controller.run({
    taskId, intelRoot: dir, generation: 'active', mode: 'whitebox',
    workstreams: [{ id: 'users', files: ['users.rb'], skill_families: ['access-control'] }],
  }, {
    executeTask: successfulExecutor('whitebox', calls, { dir, taskId, preliminary: true }),
  })

  assert.equal(calls.some(row => row.phase === 'runtime_validate'), false)
  assert.equal(artifacts.decisions(taskId, dir).decisions[0].validation_status, 'NEEDS_LIVE_VALIDATION')
  assert.equal(result.completionGate.report_eligible, false)
  assert.equal(result.completionGate.completion_status, 'REPORT_BLOCKED')
  assert.match(result.completionGate.reason, /preliminary report/)
  fs.rmSync(dir, { recursive: true, force: true })
})

test('clean static mission records an explicit no-findings path and still produces a valid report', async () => {
  const dir = temp()
  const taskId = 'static-clean'
  const calls = []
  const result = await controller.run({
    taskId, intelRoot: dir, generation: 'active', mode: 'static',
    workstreams: [{ id: 'health', files: ['health.rb'], skill_families: ['access-control'] }],
  }, {
    executeTask: successfulExecutor('static', calls, { dir, taskId, noFindings: true }),
  })

  assert.equal(artifacts.candidates(taskId, dir).length, 0)
  assert.equal(calls.some(row => row.phase === 'verify'), false)
  assert.deepStrictEqual([...new Set(calls.map(row => row.phase))], ['inventory', 'research', 'triage', 'audit', 'judge', 'report'])
  assert.equal(result.completionGate.report_eligible, true)
  assert.equal(result.completionGate.completion_status, 'COMPLETE')
  fs.rmSync(dir, { recursive: true, force: true })
})

test('quota cooling waits without executing or spinning, then automatically resumes the same task', async () => {
  const dir = temp()
  const taskId = 'quota-resume'
  const calls = []
  let quotaReads = 0
  const result = await controller.run({
    taskId, intelRoot: dir, generation: 'active', mode: 'static',
    quotaWaitMs: 2,
    workstreams: [{ id: 'one', files: ['one.rb'], skill_families: ['access-control'] }],
  }, {
    executeTask: successfulExecutor('static', calls, { dir, taskId, noFindings: true }),
    quotaState: () => (++quotaReads <= 2 ? 'cooling' : 'healthy'),
  })

  assert.ok(quotaReads >= 3)
  assert.equal(calls.filter(row => row.phase === 'inventory').length, 1)
  assert.equal(result.status, 'completed')
  const signals = journal.load(taskId, dir).filter(row => row.type === 'QUOTA_SIGNAL')
  assert.equal(signals.length, 1)
  assert.equal(signals[0].payload.deferred, true)
  fs.rmSync(dir, { recursive: true, force: true })
})

test('exhausted rate limits become an explicit coverage gap, never a false no-issue result', async () => {
  const dir = temp()
  const taskId = 'rate-limit-gap'
  const calls = []
  const executeTask = successfulExecutor('static', calls, { dir, taskId, noFindings: true })
  const result = await controller.run({
    taskId, intelRoot: dir, generation: 'active', mode: 'static',
    maxRetries: 1,
    workstreams: [{ id: 'limited', files: ['limited.rb'], skill_families: ['access-control'] }],
  }, {
    executeTask: async task => {
      if (task.phase === 'research') {
        calls.push({ phase: task.phase, id: task.id })
        return { rate_limited: true }
      }
      return executeTask(task)
    },
  })

  const research = result.board.tasks.find(row => row.phase === 'research')
  assert.equal(calls.filter(row => row.phase === 'research').length, 2)
  assert.equal(research.status, 'blocked')
  assert.equal(research.result, 'blocked_coverage_gap')
  assert.notEqual(research.status, 'no_issue')
  assert.equal(result.completionGate.completion_status, 'COMPLETE_WITH_GAPS')
  assert.equal(result.completionGate.report_eligible, true)
  fs.rmSync(dir, { recursive: true, force: true })
})

test('scope rejection fails closed before agent execution and prevents report eligibility', async () => {
  const dir = temp()
  let executions = 0
  const result = await controller.run({
    taskId: 'scope-block', intelRoot: dir, generation: 'active', mode: 'blackbox',
    workstreams: [{ id: 'app', endpoints: ['https://out.example.test'], skill_families: ['xss'] }],
  }, {
    scopeValidate: () => false,
    executeTask: async () => { executions++; return { no_issue: true } },
  })

  assert.equal(executions, 0)
  assert.ok(result.board.tasks.every(row => row.status === 'blocked'))
  assert.equal(result.completionGate.report_eligible, false)
  assert.equal(result.completionGate.completion_status, 'REPORT_BLOCKED')
  fs.rmSync(dir, { recursive: true, force: true })
})

test('mission cancellation stops before the next dependency wave and leaves an honest blocked report gate', async () => {
  const dir = temp()
  let cancelled = false
  const calls = []
  const result = await controller.run({
    taskId: 'cancel-flow', intelRoot: dir, generation: 'active', mode: 'static',
    workstreams: [{ id: 'one', files: ['one.rb'], skill_families: ['access-control'] }],
  }, {
    isCancelled: () => cancelled,
    executeTask: async task => {
      calls.push(task.phase)
      if (task.phase === 'inventory') cancelled = true
      return { no_issue: true }
    },
  })

  assert.deepStrictEqual(calls, ['inventory'])
  assert.equal(result.status, 'cancelled')
  assert.equal(result.completionGate.report_eligible, false)
  assert.ok(result.completionGate.open_task_ids.length > 0)
  fs.rmSync(dir, { recursive: true, force: true })
})

test('restart recovers an expired lease and resumes without duplicating the mission plan', async () => {
  const dir = temp()
  const taskId = 'resume-expired'
  const prepared = controller.prepare({
    taskId, intelRoot: dir, generation: 'active', mode: 'static',
    workstreams: [{ id: 'one', files: ['one.rb'], skill_families: ['access-control'] }],
  })
  const inventory = prepared.plan.tasks.find(row => row.phase === 'inventory')
  assert.equal(taskBoard.claim(taskId, inventory.id, 'ARCHON_INVENTORY', 'dead-session', dir, {
    now: Date.now() - 10_000,
    leaseMs: 1_000,
  }), true)

  const calls = []
  const result = await controller.run({
    taskId, intelRoot: dir, generation: 'active', mode: 'static',
    workstreams: [{ id: 'one', files: ['one.rb'], skill_families: ['access-control'] }],
  }, {
    executeTask: successfulExecutor('static', calls, { dir, taskId, noFindings: true }),
  })

  const resumedInventory = result.board.tasks.find(row => row.id === inventory.id)
  assert.equal(calls.filter(row => row.phase === 'inventory').length, 1)
  assert.equal(resumedInventory.attempt, 2)
  assert.equal(result.board.tasks.filter(row => row.id === inventory.id).length, 1)
  assert.equal(result.completionGate.report_eligible, true)
  fs.rmSync(dir, { recursive: true, force: true })
})

test('active generation cannot drive the built-in executor before parity approval', async () => {
  const dir = temp()
  const prior = process.env.ARCHON_RUNTIME_PARITY_APPROVED
  delete process.env.ARCHON_RUNTIME_PARITY_APPROVED
  try {
    const result = await controller.run({
      taskId: 'cutover-gated', intelRoot: dir, generation: 'active', mode: 'static',
      workstreams: [{ id: 'one', files: ['one.rb'], skill_families: ['access-control'] }],
    })
    assert.equal(result.status, 'cutover_gated')
    assert.equal(result.fallback_required, true)
    assert.equal(result.sessions, undefined)
    assert.equal(journal.reduce('cutover-gated', dir).status, 'cutover_gated')
  } finally {
    if (prior == null) delete process.env.ARCHON_RUNTIME_PARITY_APPROVED
    else process.env.ARCHON_RUNTIME_PARITY_APPROVED = prior
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('daemon adaptive ownership is checked before legacy routing and both success and failure return without fallback', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'event-bus.js'), 'utf8')
  const ownership = source.indexOf('if (adaptiveDispatch.shouldOwn(taskId))')
  const successReturn = source.indexOf('setTimeout(() => processQueue(), 1500)\n      return', ownership)
  const failure = source.indexOf('catch (adaptiveError)', ownership)
  const failureReturn = source.indexOf('setTimeout(() => processQueue(), 1500)\n    return', failure)
  const legacyCodeReview = source.indexOf("if (dispatchType === 'code-review')", ownership)
  const legacyPentest = source.indexOf('dispatchPentestParallel, getCostBudget', ownership)
  assert.ok(ownership > 0)
  assert.ok(successReturn > ownership && successReturn < legacyCodeReview)
  assert.ok(failure > successReturn && failureReturn > failure && failureReturn < legacyCodeReview)
  assert.ok(legacyCodeReview > ownership)
  assert.ok(legacyPentest > legacyCodeReview)
})
