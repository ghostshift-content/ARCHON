#!/usr/bin/env node
// Unit tests for the Operational Supervisor (src/ops/supervisor.js).
// Synthetic daemon state → asserts invariant detection + the zombie-cancel auto-heal + snapshot shape.
const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { runHealthPass } = require('../src/ops/supervisor')

let passed = 0, failed = 0
const ok = (label, cond, extra = '') => cond ? (console.log(`  ✓ ${label}`), passed++) : (console.log(`  ✗ ${label}${extra ? ' — ' + extra : ''}`), failed++)

console.log('Operational Supervisor:')

function fixture() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sup-test-'))
  fs.mkdirSync(path.join(tmp, 'streams'))
  return tmp
}
const now = Date.now()

// 1. healthy state → ok=true, no fixes
{
  const tmp = fixture()
  fs.writeFileSync(path.join(tmp, 'tasks.json'), JSON.stringify([{ id: 't-1-aa', status: 'done' }]))
  fs.writeFileSync(path.join(tmp, 'dispatch-queue.json'), JSON.stringify([]))
  fs.writeFileSync(path.join(tmp, 'task-heartbeats.json'), JSON.stringify({}))
  const snap = runHealthPass({ intel: tmp, now, execSync: () => '' })
  ok('healthy state → ok=true', snap.ok === true, JSON.stringify(snap.checks.filter(c => !c.ok)))
  ok('writes health.json', fs.existsSync(path.join(tmp, 'health.json')))
}

// 2. zombie cancelled task (live agent stream) → auto re-cancel
{
  const tmp = fixture()
  fs.writeFileSync(path.join(tmp, 'tasks.json'), JSON.stringify([{ id: 't-9-ab', status: 'cancelled' }]))
  fs.writeFileSync(path.join(tmp, 'dispatch-queue.json'), JSON.stringify([]))
  fs.writeFileSync(path.join(tmp, 'task-heartbeats.json'), JSON.stringify({}))
  fs.writeFileSync(path.join(tmp, 'streams', 'scout-t-9-ab.stream'), 'x') // fresh = zombie agent
  const cancelled = []
  const snap = runHealthPass({ intel: tmp, now, execSync: () => '', writeCancelSignal: id => cancelled.push(id) })
  ok('zombie re-cancelled', cancelled.length === 1 && cancelled[0] === 't-9-ab', JSON.stringify(cancelled))
  ok('cancel_integrity marked auto-fixed', snap.checks.find(c => c.name === 'cancel_integrity').autoFixed === true)
  ok('snapshot.tasks.zombie = 1', snap.tasks.zombie === 1)
}

// 3. stuck 'processing' queue entry (no live agent) → flagged not-ok
{
  const tmp = fixture()
  fs.writeFileSync(path.join(tmp, 'tasks.json'), JSON.stringify([{ id: 't-3-cc', status: 'in-progress', startedAt: new Date(now).toISOString() }]))
  fs.writeFileSync(path.join(tmp, 'dispatch-queue.json'), JSON.stringify([{ id: 'd1', taskId: 't-3-cc', status: 'processing', processedAt: new Date(now - 20 * 60000).toISOString() }]))
  fs.writeFileSync(path.join(tmp, 'task-heartbeats.json'), JSON.stringify({ 't-3-cc': new Date(now).toISOString() }))
  const snap = runHealthPass({ intel: tmp, now, execSync: () => '' })
  ok('queue_integrity flags stuck processing', snap.checks.find(c => c.name === 'queue_integrity').ok === false)
  ok('snapshot.queue.stuckProcessing = 1', snap.queue.stuckProcessing === 1)
}

// 4. dispatch without a task → dispatch_integrity not-ok
{
  const tmp = fixture()
  fs.writeFileSync(path.join(tmp, 'tasks.json'), JSON.stringify([]))
  fs.writeFileSync(path.join(tmp, 'dispatch-queue.json'), JSON.stringify([{ id: 'd1', taskId: 't-ghost', status: 'pending' }]))
  fs.writeFileSync(path.join(tmp, 'task-heartbeats.json'), JSON.stringify({}))
  const snap = runHealthPass({ intel: tmp, now, execSync: () => '' })
  ok('dispatch_integrity flags orphan dispatch', snap.checks.find(c => c.name === 'dispatch_integrity').ok === false)
}

// 5. escalation rate-limit: same anomaly twice → spawnDiagnostic called ONCE
{
  const tmp = fixture()
  fs.writeFileSync(path.join(tmp, 'tasks.json'), JSON.stringify([]))
  fs.writeFileSync(path.join(tmp, 'dispatch-queue.json'), JSON.stringify([{ id: 'd1', taskId: 't-ghost', status: 'pending' }]))
  fs.writeFileSync(path.join(tmp, 'task-heartbeats.json'), JSON.stringify({}))
  const st = {}
  let calls = 0
  const ctx = { intel: tmp, now, execSync: () => '', escalateState: st, escalateAfterMs: 0, spawnDiagnostic: () => calls++ }
  runHealthPass(ctx)
  runHealthPass({ ...ctx, now: now + 1000 })
  ok('SENTINEL escalation rate-limited (1 of 2 passes)', calls === 1, `calls=${calls}`)
}

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)
