'use strict'

// Append-only mission journal. It is the recovery authority for runtime-v2;
// snapshots are projections and can always be rebuilt from this log.

const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const agentPaths = require('../../paths')
const { withFileLock } = require('./file-lock')

function journalPath(taskId, dir) {
  return path.join(dir || agentPaths.INTEL_ROOT, `mission-events-${taskId}.jsonl`)
}

function _read(taskId, dir) {
  try {
    return fs.readFileSync(journalPath(taskId, dir), 'utf8').split('\n').filter(Boolean)
      .map(line => { try { return JSON.parse(line) } catch { return null } }).filter(Boolean)
  } catch { return [] }
}

function _withLock(taskId, dir, fn) {
  const lock = `${journalPath(taskId, dir)}.lock`
  return withFileLock(lock, fn)
}

function append(taskId, type, payload = {}, opts = {}) {
  return _withLock(taskId, opts.dir, () => {
    const prior = _read(taskId, opts.dir)
    if (opts.idempotencyKey) {
      const duplicate = prior.find(row => row.idempotency_key === opts.idempotencyKey)
      if (duplicate) return duplicate
    }
    const record = {
      event_id: crypto.randomUUID(),
      seq: prior.reduce((max, row) => Math.max(max, Number(row.seq) || 0), 0) + 1,
      ts: new Date().toISOString(),
      task_id: taskId,
      type,
      idempotency_key: opts.idempotencyKey || null,
      payload,
    }
    const file = journalPath(taskId, opts.dir)
    fs.appendFileSync(file, JSON.stringify(record) + '\n')
    return record
  })
}

function load(taskId, dir) { return _read(taskId, dir).sort((a, b) => a.seq - b.seq) }

function reduce(taskId, dir) {
  const state = {
    task_id: taskId,
    status: 'created',
    runtime_generation: 'legacy',
    events: 0,
    last_event_at: null,
    phases: {},
    agents: {},
    replans: 0,
    completion_gate: null,
  }
  for (const event of load(taskId, dir)) {
    state.events++
    state.last_event_at = event.ts
    const p = event.payload || {}
    if (event.type === 'MISSION_PINNED') state.runtime_generation = p.runtime_generation || state.runtime_generation
    if (event.type === 'MISSION_STATUS') state.status = p.status || state.status
    if (event.type === 'PHASE_STATUS' && p.phase) state.phases[p.phase] = p.status
    if (event.type === 'SESSION_STATUS' && p.session_id) state.agents[p.session_id] = p
    if (event.type === 'REPLAN') state.replans++
    if (event.type === 'COMPLETION_GATE') state.completion_gate = p
  }
  return state
}

module.exports = { journalPath, append, load, reduce }
