'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')

const journal = require('../src/runtime/mission-journal')
const generations = require('../src/runtime/runtime-generation')
const board = require('../src/runtime/task-board')
const memory = require('../src/runtime/pattern-memory')
const completion = require('../src/runtime/completion-gate')
const parity = require('../src/runtime/parity-gate')
const controller = require('../src/runtime/runtime-controller')
const runtimeArtifacts = require('../src/runtime/runtime-artifacts')

function temp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'archon-adaptive-')) }

test('mission journal is append-only, idempotent, ordered, and replayable', () => {
  const dir = temp()
  const a = journal.append('m1', 'MISSION_PINNED', { runtime_generation: 'shadow' }, { dir, idempotencyKey: 'pin' })
  const b = journal.append('m1', 'MISSION_PINNED', { runtime_generation: 'active' }, { dir, idempotencyKey: 'pin' })
  journal.append('m1', 'MISSION_STATUS', { status: 'running' }, { dir })
  assert.equal(a.event_id, b.event_id)
  assert.deepEqual(journal.load('m1', dir).map(row => row.seq), [1, 2])
  assert.equal(journal.reduce('m1', dir).runtime_generation, 'shadow')
  assert.equal(journal.reduce('m1', dir).status, 'running')
  fs.rmSync(dir, { recursive: true, force: true })
})

test('runtime generation is immutable for a mission', () => {
  const dir = temp()
  const first = generations.pin('m2', { dir, generation: 'shadow' })
  const second = generations.pin('m2', { dir, generation: 'active' })
  assert.equal(first.runtime_generation, 'shadow')
  assert.equal(second.runtime_generation, 'shadow')
  fs.rmSync(dir, { recursive: true, force: true })
})

test('task board enforces dependencies, leases, idempotency, and expired recovery', () => {
  const dir = temp()
  board.appendUnique('m3', board.newTask({ id: 'A', taskId: 'm3', idempotency_key: 'a' }), dir)
  board.appendUnique('m3', board.newTask({ id: 'B', taskId: 'm3', idempotency_key: 'b', dependencies: ['A'] }), dir)
  assert.equal(board.appendUnique('m3', board.newTask({ id: 'A2', taskId: 'm3', idempotency_key: 'a' }), dir).appended, false)
  assert.equal(board.claim('m3', 'B', 'WORKER', 's-b', dir), false)
  assert.equal(board.claim('m3', 'A', 'WORKER', 's-a', dir, { leaseMs: 1_000, now: 1_000 }), true)
  assert.equal(board.claim('m3', 'A', 'OTHER', 's-x', dir, { now: 1_100 }), false)
  assert.equal(board.releaseExpired('m3', dir, 2_001), 1)
  assert.equal(board.claim('m3', 'A', 'OTHER', 's-x', dir), true)
  board.setStatus('m3', 'A', 'completed', {}, dir)
  assert.equal(board.claim('m3', 'B', 'WORKER', 's-b', dir), true)
  fs.rmSync(dir, { recursive: true, force: true })
})

test('strategy memory rejects engagement data and retains sanitized outcomes only', () => {
  const dir = temp()
  const row = memory.append({
    mode: 'static', skill_family: 'access-control', outcome: 'success',
    target: 'private.example', source_file: '/repo/app.js', request: 'GET /secret',
    strategy: 'adaptive', success_rate: 1,
  }, dir)
  assert.ok(row)
  assert.equal(row.target, undefined)
  assert.equal(row.source_file, undefined)
  assert.equal(row.request, undefined)
  assert.deepEqual(memory.rank('static', ['xss', 'access-control'], dir)[0], 'access-control')
  fs.rmSync(dir, { recursive: true, force: true })
})

test('completion and parity gates fail closed', () => {
  const gate = completion.evaluate({
    tasks: [{ id: 'a', phase: 'research', status: 'completed' }],
    requiredPhases: ['research', 'judge'],
    verifierDecisions: [],
  })
  assert.equal(gate.report_eligible, false)
  assert.deepEqual(gate.missing_phases, ['judge'])
  assert.equal(parity.compare(
    { task_keys: ['a'], candidate_keys: ['c'], coverage_complete: true, report_eligible: true },
    { task_keys: ['a'], candidate_keys: [], coverage_complete: true, report_eligible: true },
  ).pass, false)
})

test('oversized source workstreams are explicit blocked coverage gaps and are never executed', () => {
  const plan = require('../src/runtime/adaptive-planner').buildMissionPlan({
    taskId: 'oversized-plan',
    mode: 'static',
    workstreams: [{
      id: 'oversized',
      files: ['generated/huge.js'],
      oversized: true,
      skill_families: ['access-control'],
    }],
    applicableSkills: ['access-control'],
  })
  const research = plan.tasks.find(row => row.phase === 'research')
  assert.strictEqual(research.status, 'blocked')
  assert.strictEqual(research.result, 'blocked_coverage_gap')
  assert.match(research.error, /usable model context/)
})

test('active controller runs dependency waves and bounded evidence-triggered explorers', async () => {
  const dir = temp()
  const seen = []
  const result = await controller.run({
    taskId: 'm4',
    intelRoot: dir,
    generation: 'active',
    mode: 'static',
    strategy: 'adaptive',
    activeConcurrency: 2,
    maxExploreChildren: 1,
    workstreams: [
      { id: 'auth', features: ['login'], files: ['auth.js'], skill_families: ['access-control'] },
      { id: 'billing', features: ['refund'], files: ['billing.js'], skill_families: ['business-logic'] },
    ],
  }, {
    scopeValidate: () => true,
    quotaState: () => 'healthy',
    executeTask: async task => {
      seen.push(task.phase)
      if (task.phase === 'inventory') return { no_issue: true, summary: 'inventory complete' }
      if (task.phase === 'research') return {
        candidates: [{ id: `c-${task.id}`, mode: 'static', class: 'access-control', file: `${task.workstream_id}.js`, line: 1, sink: task.workstream_id }],
        evidence_refs: [`ev-${task.id}`],
        followups: [
          { objective: 'verify discovered authorization edge', evidence_refs: [`ev-${task.id}`] },
          { objective: 'must be capped', evidence_refs: [`ev2-${task.id}`] },
        ],
      }
      if (task.phase === 'verify') return {
        votes: task.candidate_ids.map(candidate_id => ({
          candidate_id, lens: task.lens, verdict: 'TRUE_POSITIVE', evidence_refs: [`proof-${candidate_id}`],
        })),
      }
      if (task.phase === 'report') return {
        report_generated: true, report_path: '/tmp/report.md', report_digest: 'test-digest',
      }
      return { no_issue: true }
    },
  })
  assert.equal(result.status, 'completed')
  assert.equal(seen.filter(phase => phase === 'inventory').length, 1)
  assert.equal(seen.filter(phase => phase === 'research').length, 2)
  assert.equal(seen.filter(phase => phase === 'explore').length, 2)
  assert.equal(seen.filter(phase => phase === 'verify').length, 3)
  assert.equal(result.board.counts.complete, true)
  assert.equal(result.completionGate.report_eligible, true)
  assert.ok(result.sessions.every(row => ['completed', 'failed'].includes(row.status)))
  assert.equal(runtimeArtifacts.decisions('m4', dir).admitted.length, 2)
  fs.rmSync(dir, { recursive: true, force: true })
})

test('white-box links source candidates to runtime validation before verifier and final report', async () => {
  const dir = temp()
  const seen = []
  const result = await controller.run({
    taskId: 'm-whitebox',
    intelRoot: dir,
    generation: 'active',
    mode: 'whitebox',
    target: 'https://app.example.test',
    scope: { in_scope: ['app.example.test'] },
    workstreams: [{ id: 'auth', features: ['profile'], files: ['profile.rb'], skill_families: ['access-control'] }],
  }, {
    executeTask: async task => {
      seen.push(task.phase)
      if (task.phase === 'research') return {
        candidates: [{
          id: 'CAND-WB',
          mode: 'whitebox',
          title: 'Candidate',
          class: 'access-control',
          severity: 'high',
          file: 'profile.rb',
          line: 1,
          sink: 'update',
          evidence_refs: ['source-proof'],
          exploit_hypothesis: 'Cross-account update may be possible.',
        }],
      }
      if (task.phase === 'triage') return {
        candidate_updates: task.candidate_ids.map(id => ({ id, accepted: true })),
      }
      if (task.phase === 'runtime_validate') return {
        candidate_updates: task.candidate_ids.map(id => ({
          id,
          runtime_evidence: true,
          status: 'RUNTIME_CONFIRMED',
          evidence_refs: ['request-proof', 'response-proof'],
        })),
      }
      if (task.phase === 'verify') return {
        votes: task.candidate_ids.map(candidate_id => ({
          candidate_id, lens: task.lens, verdict: 'TRUE_POSITIVE', evidence_refs: ['runtime-proof'],
        })),
      }
      if (task.phase === 'audit' || task.phase === 'judge') return {
        approved_ids: task.candidate_ids,
        rejected: [],
      }
      if (task.phase === 'report') return {
        report_generated: true,
        report_path: '/tmp/FINAL-REPORT-m-whitebox.md',
        report_digest: 'digest',
      }
      return { no_issue: true }
    },
  })
  assert.ok(seen.indexOf('runtime_validate') > seen.indexOf('triage'))
  assert.ok(seen.indexOf('verify') > seen.indexOf('runtime_validate'))
  assert.equal(runtimeArtifacts.decisions('m-whitebox', dir).decisions[0].validation_status, 'RUNTIME_CONFIRMED')
  assert.equal(result.completionGate.report_eligible, true)
  fs.rmSync(dir, { recursive: true, force: true })
})

test('shadow controller isolates artifacts and never drives execution', async () => {
  const dir = temp()
  let called = false
  const result = await controller.run({
    taskId: 'm5', intelRoot: dir, generation: 'shadow', mode: 'blackbox',
    workstreams: [{ id: 'app', endpoints: ['/'], skill_families: ['xss'] }],
  }, { executeTask: async () => { called = true } })
  assert.equal(result.status, 'shadowed')
  assert.equal(called, false)
  assert.ok(fs.existsSync(path.join(dir, 'shadow', 'm5', 'adaptive-plan-m5.json')))
  assert.equal(fs.existsSync(path.join(dir, 'task-board-m5.jsonl')), false)
  fs.rmSync(dir, { recursive: true, force: true })
})
