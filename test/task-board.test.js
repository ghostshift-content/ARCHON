'use strict'
// M5: the shared task board — append/load/counts, single-claim, terminal gate.
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path')
const TB = require('../src/runtime/task-board')

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'tb-')) }

test('M5: append → load reduces to latest state per id + counts', () => {
  const d = tmp()
  TB.append('t1', TB.newTask({ id: 'TASK-0001', taskId: 't1', feature: 'auth', phase: 'mapping' }), d)
  TB.append('t1', TB.newTask({ id: 'TASK-0002', taskId: 't1', feature: 'api', phase: 'mapping' }), d)
  TB.setStatus('t1', 'TASK-0001', 'running', {}, d)
  const b = TB.load('t1', d)
  assert.equal(b.tasks.length, 2)
  assert.equal(b.tasks.find((t) => t.id === 'TASK-0001').status, 'running', 'latest state wins')
  assert.equal(b.counts.total, 2); assert.equal(b.counts.running, 1); assert.equal(b.counts.queued, 1)
  fs.rmSync(d, { recursive: true, force: true })
})

test('M5: a task is claimed by exactly one agent (no double-claim)', () => {
  const d = tmp()
  TB.append('t2', TB.newTask({ id: 'TASK-0001', taskId: 't2' }), d)
  assert.equal(TB.claim('t2', 'TASK-0001', 'MARSHAL', 's1', d), true)
  assert.equal(TB.claim('t2', 'TASK-0001', 'CIPHER', 's2', d), false, 'second agent cannot claim')
  assert.equal(TB.load('t2', d).tasks[0].claimed_by, 'MARSHAL')
  fs.rmSync(d, { recursive: true, force: true })
})

test('M5: terminal status stamps finished_at + completes the board', () => {
  const d = tmp()
  TB.append('t3', TB.newTask({ id: 'TASK-0001', taskId: 't3' }), d)
  const rec = TB.setStatus('t3', 'TASK-0001', 'candidate_found', { result: 'IDOR' }, d)
  assert.ok(rec.finished_at, 'finished_at stamped on terminal')
  assert.ok(TB.isTerminal('candidate_found') && !TB.isTerminal('running'))
  assert.equal(TB.load('t3', d).counts.complete, true)
  fs.rmSync(d, { recursive: true, force: true })
})

test('M5: garbled lines are skipped fail-soft', () => {
  const d = tmp()
  fs.writeFileSync(TB.boardPath('t4', d), '{bad json\n' + JSON.stringify(TB.newTask({ id: 'TASK-0009', taskId: 't4' })) + '\n')
  const b = TB.load('t4', d)
  assert.equal(b.tasks.length, 1); assert.equal(b.tasks[0].id, 'TASK-0009')
  fs.rmSync(d, { recursive: true, force: true })
})
