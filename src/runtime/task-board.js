'use strict'
// M5: the shared TASK BOARD — the source of operational truth. Append-only JSONL at
// var/intel/task-board-<taskId>.jsonl (one line per task-state write; readers reduce by id → latest state, so the
// UI can tail it live). Pure builders + fail-soft fs helpers (mirrors mapping-ledger's discipline). OBSERVE-ONLY:
// this is a library; a bridge mirrors current runs into it (M5), and later phases let the engine drive from it.
//
// Every task MUST end in a terminal state. A task is claimed by exactly one agent before work.

const fs = require('fs')
const path = require('path')
const agentPaths = require('../../paths')
const { withFileLock } = require('./file-lock')

const STATUSES = ['queued', 'claimed', 'running', 'completed', 'candidate_found', 'no_issue', 'needs_followup', 'blocked', 'failed', 'cancelled']
const TERMINAL = new Set(['completed', 'candidate_found', 'no_issue', 'blocked', 'failed', 'cancelled'])
const ACTIVE = new Set(['queued', 'claimed', 'running', 'needs_followup'])
const DEFAULT_LEASE_MS = 90_000

function boardPath(taskId, dir) { return path.join(dir || agentPaths.INTEL_ROOT, `task-board-${taskId}.jsonl`) }
function isTerminal(s) { return TERMINAL.has(s) }
function padId(n) { return `TASK-${String(n).padStart(4, '0')}` }
function _stamp() { try { return new Date().toISOString() } catch { return null } }
function _leaseUntil(ms, now = Date.now()) { return new Date(now + Math.max(1_000, Number(ms) || DEFAULT_LEASE_MS)).toISOString() }
function _expired(task, now = Date.now()) {
  const value = Date.parse(task && task.lease_until)
  return Number.isFinite(value) && value <= now
}

// canonical task record (unknown fields preserved)
function newTask(fields) {
  const f = fields || {}
  return {
    ...f,
    id: f.id, taskId: f.taskId, mode: f.mode || 'static', phase: f.phase || 'mapping',
    feature: f.feature ?? null, vulnerability_class: f.vulnerability_class ?? null, pattern_id: f.pattern_id ?? null,
    priority: f.priority || 'normal', status: f.status || 'queued', claimed_by: f.claimed_by ?? null,
    session_id: f.session_id ?? null, created_by: f.created_by || 'CURATOR', reason: f.reason ?? null,
    evidence_used: f.evidence_used || [], started_at: f.started_at ?? null, finished_at: f.finished_at ?? null,
    result: f.result ?? null, followups_created: f.followups_created || [], error: f.error ?? null,
    parent_id: f.parent_id ?? null, workstream_id: f.workstream_id ?? null,
    skill_id: f.skill_id ?? null, hypothesis_id: f.hypothesis_id ?? null,
    dependencies: Array.isArray(f.dependencies) ? f.dependencies : [],
    context_refs: Array.isArray(f.context_refs) ? f.context_refs : [],
    evidence_refs: Array.isArray(f.evidence_refs) ? f.evidence_refs : [],
    scope_ref: f.scope_ref ?? null, budget: f.budget || null,
    idempotency_key: f.idempotency_key ?? null, lease_until: f.lease_until ?? null,
    attempt: Number.isFinite(Number(f.attempt)) ? Number(f.attempt) : 0,
    created_at: f.created_at || _stamp(),
  }
}

// append one task-state line (fail-soft; append is atomic enough for a JSONL log)
function append(taskId, task, dir) {
  try { fs.mkdirSync(path.dirname(boardPath(taskId, dir)), { recursive: true }); fs.appendFileSync(boardPath(taskId, dir), JSON.stringify(task) + '\n'); return true } catch { return false }
}

// load → latest state per id + rollup counts (fail-soft: missing/garbled lines skipped)
function load(taskId, dir) {
  const byId = new Map()
  try {
    for (const line of fs.readFileSync(boardPath(taskId, dir), 'utf8').split('\n')) {
      const s = line.trim(); if (!s) continue
      let t; try { t = JSON.parse(s) } catch { continue }
      if (t && t.id) byId.set(t.id, t)
    }
  } catch { /* no board yet */ }
  const tasks = [...byId.values()]
  return { taskId, tasks, counts: recount(tasks) }
}

function recount(tasks) {
  const c = { total: tasks.length }
  for (const s of STATUSES) c[s] = 0
  for (const t of tasks) if (c[t.status] != null) c[t.status]++
  c.active = tasks.filter((t) => ACTIVE.has(t.status)).length
  c.terminal = tasks.filter((t) => TERMINAL.has(t.status)).length
  c.complete = tasks.length > 0 && c.terminal === tasks.length
  return c
}

function _withLock(taskId, dir, fn) {
  const file = `${boardPath(taskId, dir)}.lock`
  return withFileLock(file, fn)
}

function dependenciesMet(task, tasks) {
  const deps = Array.isArray(task && task.dependencies) ? task.dependencies : []
  if (!deps.length) return true
  const byId = new Map((tasks || []).map(row => [row.id, row]))
  return deps.every(id => byId.has(id) && isTerminal(byId.get(id).status))
}

// Cross-process compare-and-claim. Expired leases may be reclaimed; live leases
// and unmet dependencies cannot.
function claim(taskId, id, agent, sessionId, dir, opts = {}) {
  return _withLock(taskId, dir, () => {
    const { tasks } = load(taskId, dir)
    const t = tasks.find((x) => x.id === id)
    if (!t || isTerminal(t.status) || !dependenciesMet(t, tasks)) return false
    const expired = _expired(t, opts.now)
    if (t.claimed_by && !expired && t.claimed_by !== agent && ACTIVE.has(t.status)) return false
    if (['claimed', 'running'].includes(t.status) && !expired && t.claimed_by === agent && t.session_id !== (sessionId || t.session_id)) return false
    append(taskId, {
      ...t,
      status: 'claimed',
      claimed_by: agent,
      session_id: sessionId || t.session_id,
      started_at: t.started_at || _stamp(),
      lease_until: _leaseUntil(opts.leaseMs, opts.now),
      attempt: (Number(t.attempt) || 0) + 1,
    }, dir)
    return true
  })
}

function renewLease(taskId, id, agent, sessionId, dir, opts = {}) {
  return _withLock(taskId, dir, () => {
    const { tasks } = load(taskId, dir)
    const t = tasks.find(row => row.id === id)
    if (!t || isTerminal(t.status) || t.claimed_by !== agent || (sessionId && t.session_id !== sessionId)) return false
    append(taskId, { ...t, lease_until: _leaseUntil(opts.leaseMs, opts.now), heartbeat_at: _stamp() }, dir)
    return true
  })
}

function releaseExpired(taskId, dir, now = Date.now()) {
  let released = 0
  _withLock(taskId, dir, () => {
    const { tasks } = load(taskId, dir)
    for (const task of tasks) {
      if (!isTerminal(task.status) && ['claimed', 'running'].includes(task.status) && _expired(task, now)) {
        append(taskId, { ...task, status: 'queued', claimed_by: null, session_id: null, lease_until: null, error: 'lease expired; requeued' }, dir)
        released++
      }
    }
    return true
  })
  return released
}

function appendUnique(taskId, task, dir) {
  const rec = newTask(task)
  let result = { appended: false, task: null }
  _withLock(taskId, dir, () => {
    const { tasks } = load(taskId, dir)
    const duplicate = rec.idempotency_key && tasks.find(row => row.idempotency_key === rec.idempotency_key)
    if (duplicate) {
      result = { appended: false, task: duplicate }
      return true
    }
    const ok = append(taskId, rec, dir)
    result = { appended: ok, task: rec }
    return ok
  })
  return result
}

// set a task's status (+ optional patch: result, error, followups_created, finished_at…)
function setStatus(taskId, id, status, patch, dir) {
  let result = null
  _withLock(taskId, dir, () => {
    const { tasks } = load(taskId, dir)
    const t = tasks.find((x) => x.id === id) || newTask({ id, taskId })
    const rec = { ...t, status, ...(patch || {}) }
    if (TERMINAL.has(status) && !rec.finished_at) rec.finished_at = _stamp()
    if (append(taskId, rec, dir)) result = rec
    return Boolean(result)
  })
  return result
}

module.exports = {
  STATUSES, TERMINAL, ACTIVE, DEFAULT_LEASE_MS, boardPath, isTerminal, padId,
  newTask, append, appendUnique, load, recount, dependenciesMet, claim,
  renewLease, releaseExpired, setStatus,
}

// self-check
if (require.main === module) {
  const os = require('os'); const d = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-')); const assert = require('node:assert')
  append('t1', newTask({ id: padId(1), taskId: 't1', feature: 'auth', phase: 'mapping' }), d)
  assert.strictEqual(claim('t1', 'TASK-0001', 'MARSHAL', 's1', d), true)
  assert.strictEqual(claim('t1', 'TASK-0001', 'CIPHER', 's2', d), false) // no double-claim
  setStatus('t1', 'TASK-0001', 'candidate_found', { result: 'IDOR' }, d)
  const b = load('t1', d)
  assert.strictEqual(b.counts.candidate_found, 1); assert.strictEqual(b.counts.complete, true)
  fs.rmSync(d, { recursive: true, force: true })
  console.log('ok — task board: append/claim(no-double)/setStatus/load+counts, terminal gate')
}
