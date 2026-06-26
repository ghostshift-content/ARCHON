
const __roots = require('../../paths') // portable roots (KURU_*_ROOT) — see paths.js
// /root/agents/task-log.js
//
// Per-task JSONL log module. Solves the O(N) scaling problem where 30+ call sites
// in event-bus.js grep the global /root/intel/ACTIVITY-LOG.jsonl (500MB+) to find
// entries for one task — at that size, readFileSync blocks the Node event loop for
// seconds, the supervisor thinks event-bus is dead, restarts it, and tasks run twice
// (architect review GAP-6, 2026-04-19).
//
// Design:
//   - Each task gets its own log at /root/intel/task-logs/{safeTaskId}.jsonl
//   - Append-only hot path (appendFileSync is atomic for lines < PIPE_BUF = 4096
//     bytes on linux, which covers normal activity entries)
//   - Full rewrites — if we ever need them — use the tmp+rename atomic pattern
//   - Task IDs are sanitized to [A-Za-z0-9_-]+ to block path traversal
//   - The first write mkdir's the task-logs directory (recursive, idempotent)
//
// Backwards compatibility:
//   - logActivity() in event-bus.js still writes every entry to the global
//     ACTIVITY-LOG.jsonl (UI activity page, grader fallback, supervisor). This
//     module is ADDITIVE — the fast path is layered on top.

const fs = require('fs')
const path = require('path')

const TASK_LOGS_DIR = (__roots.INTEL_ROOT + '/task-logs')

// Memoize mkdir so we don't fs.mkdirSync on every append.
let _mkdirDone = false

function _ensureDir() {
  if (_mkdirDone) return
  fs.mkdirSync(TASK_LOGS_DIR, { recursive: true })
  _mkdirDone = true
}

/**
 * Sanitize a task ID for use as a path segment.
 * Only allows [A-Za-z0-9_-]. Throws on empty/invalid input.
 */
function sanitizeTaskId(taskId) {
  if (taskId === null || taskId === undefined) {
    throw new Error('taskId is required')
  }
  const s = String(taskId).trim()
  if (!s) throw new Error('taskId cannot be empty')
  // Strip anything outside the safe set — this is a whitelist, not a blacklist.
  const safe = s.replace(/[^A-Za-z0-9_-]/g, '')
  if (!safe) throw new Error(`taskId '${taskId}' has no safe characters`)
  // Extra defense in depth — reject anything that could become . / .. / absolute path.
  if (safe === '.' || safe === '..') throw new Error(`taskId '${taskId}' is reserved`)
  return safe
}

/**
 * Return the absolute path for a task's log file. Pure — doesn't touch the FS.
 */
function taskLogPath(taskId) {
  const safe = sanitizeTaskId(taskId)
  return path.join(TASK_LOGS_DIR, `${safe}.jsonl`)
}

/**
 * Append one JSONL entry for a task. Atomic for small entries (< PIPE_BUF).
 * `entry` is stringified with JSON.stringify; a newline is added automatically.
 */
function appendToTaskLog(taskId, entry) {
  const p = taskLogPath(taskId)
  _ensureDir()
  const line = JSON.stringify(entry) + '\n'
  // appendFileSync with O_APPEND is atomic per-write under PIPE_BUF on linux.
  // Normal activity entries are small — far under 4096 bytes.
  fs.appendFileSync(p, line)
}

/**
 * Read a task's log and return parsed entries (array of objects).
 * Silent on missing file — returns [].
 * Corrupt / unparseable lines are skipped, not thrown.
 */
function readTaskLog(taskId) {
  const p = taskLogPath(taskId)
  if (!fs.existsSync(p)) return []
  const raw = fs.readFileSync(p, 'utf-8')
  if (!raw) return []
  const out = []
  for (const line of raw.split('\n')) {
    if (!line) continue
    try { out.push(JSON.parse(line)) } catch { /* skip bad line */ }
  }
  return out
}

/**
 * Does a task-log file exist for this taskId? Cheap check used by readTaskActivity's
 * fast path / slow path decision in event-bus.js.
 */
function taskLogExists(taskId) {
  try {
    return fs.existsSync(taskLogPath(taskId))
  } catch {
    return false
  }
}

module.exports = {
  TASK_LOGS_DIR,
  sanitizeTaskId,
  taskLogPath,
  appendToTaskLog,
  readTaskLog,
  taskLogExists,
}
