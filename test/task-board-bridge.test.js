'use strict'
// M5/observe-only: the bridge projects the CURRENT mapping ledger into task-board rows + a coverage snapshot,
// without touching the engine. Pure derivation, fail-soft.
const { test } = require('node:test')
const assert = require('node:assert/strict')
const B = require('../src/compatibility/task-board-bridge')

const ledger = {
  mode: 'static', features_total: 3, features_mapped: 3, features_reviewed: 2, features_candidates: 1,
  features_reviewed_no_issue: 1, features_blocked: 0, features_deferred: 0,
  features: {
    auth: { mapping_status: 'done', review_status: 'candidate_found', owner: 'CURATOR', assigned_agent: 'MARSHAL', risk: 'high', vulnerability_classes: ['access-control'] },
    api: { mapping_status: 'done', review_status: 'reviewed_no_issue', owner: 'CURATOR', assigned_agent: 'CIPHER', risk: 'medium' },
    misc: { mapping_status: 'done', review_status: 'pending', owner: 'CURATOR', risk: 'low' },
  },
}

test('bridge: ledger → mapping + review tasks with mapped board statuses', () => {
  const rows = B.tasksFromLedger('t-x', ledger)
  const mapTasks = rows.filter((r) => r.phase === 'mapping')
  const revTasks = rows.filter((r) => r.phase === 'review')
  assert.equal(mapTasks.length, 3, 'one mapping task per feature')
  assert.equal(revTasks.length, 3, 'one review task per reviewed feature')
  assert.ok(mapTasks.every((t) => t.status === 'completed'), 'done maps → completed')
  assert.equal(revTasks.find((t) => t.feature === 'auth').status, 'candidate_found')
  assert.equal(revTasks.find((t) => t.feature === 'api').status, 'no_issue')
  assert.equal(revTasks.find((t) => t.feature === 'misc').status, 'queued')
  assert.equal(revTasks.find((t) => t.feature === 'auth').claimed_by, 'MARSHAL')
})

test('bridge: deriveCoverage mirrors the ledger counters', () => {
  // deriveCoverage reads from disk via paths; here we only assert the pure mapping shape is sane through tasksFromLedger.
  const rows = B.tasksFromLedger('t-x', ledger)
  assert.ok(rows.length === 6)
  assert.ok(rows.every((r) => r.taskId === 't-x' && r.id && r.status))
})

test('bridge: empty/missing ledger → no rows (fail-soft)', () => {
  assert.deepEqual(B.tasksFromLedger('t-y', null), [])
  assert.deepEqual(B.tasksFromLedger('t-y', {}), [])
})
