'use strict'

const fs = require('fs')
const path = require('path')
const agentPaths = require('../../paths')

const TERMINAL = new Set(['completed', 'failed', 'cancelled', 'blocked'])
function sessionPath(taskId, dir) { return path.join(dir || agentPaths.INTEL_ROOT, `agent-sessions-${taskId}.jsonl`) }
function append(taskId, row, dir) {
  const record = { ts: new Date().toISOString(), task_id: taskId, ...row }
  const file = sessionPath(taskId, dir)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.appendFileSync(file, JSON.stringify(record) + '\n')
  return record
}
function load(taskId, dir) {
  const byId = new Map()
  try {
    for (const line of fs.readFileSync(sessionPath(taskId, dir), 'utf8').split('\n')) {
      let row; try { row = JSON.parse(line) } catch { continue }
      if (row && row.session_id) byId.set(row.session_id, row)
    }
  } catch {}
  return [...byId.values()]
}
function start(taskId, spec, dir) {
  return append(taskId, {
    ...spec, status: 'running', started_at: spec.started_at || new Date().toISOString(),
    heartbeat_at: new Date().toISOString(), child_count: Number(spec.child_count) || 0,
  }, dir)
}
function heartbeat(taskId, sessionId, patch = {}, dir) {
  const current = load(taskId, dir).find(row => row.session_id === sessionId)
  if (!current || TERMINAL.has(current.status)) return false
  append(taskId, { ...current, ...patch, session_id: sessionId, heartbeat_at: new Date().toISOString() }, dir)
  return true
}
function finish(taskId, sessionId, status, patch = {}, dir) {
  const current = load(taskId, dir).find(row => row.session_id === sessionId) || { session_id: sessionId }
  return append(taskId, { ...current, ...patch, session_id: sessionId, status, finished_at: new Date().toISOString() }, dir)
}

module.exports = { TERMINAL, sessionPath, append, load, start, heartbeat, finish }
