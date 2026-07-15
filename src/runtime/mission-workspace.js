'use strict'
// R2: the MISSION WORKSPACE. A durable, human-readable folder per scan under var/intel/missions/<taskId>/ that
// mirrors the mission as one project understanding with per-feature workstreams. ADDITIVE + OBSERVE-ONLY: this
// is created/populated ALONGSIDE the current run (by dispatch-bridge). Agents do NOT yet execute from it, and it
// is NOT canonical — the existing JSONL artifacts stay authoritative. Every function is fail-soft.
//
//   var/intel/missions/<taskId>/
//     mission-context.md · mission-plan.json · session-plan.json · task-board.jsonl
//     decisions.jsonl · agent-messages.jsonl · coverage.json
//     workstreams/<feature>/{ context.md, evidence.jsonl, candidates.jsonl, notes.md }

const fs = require('fs')
const path = require('path')
const agentPaths = require('../../paths')

const _safe = (s) => String(s || 'unknown').toLowerCase().replace(/[^a-z0-9._-]+/g, '-').slice(0, 80) || 'unknown'
function missionDir(taskId, root) { return path.join(root || agentPaths.INTEL_ROOT, 'missions', String(taskId)) }
function workstreamDir(taskId, feature, root) { return path.join(missionDir(taskId, root), 'workstreams', _safe(feature)) }
function _w(file, str) { try { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, str); return true } catch { return false } }
function _wIfAbsent(file, str) { try { if (!fs.existsSync(file)) return _w(file, str); return true } catch { return false } }
function _append(file, str) { try { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.appendFileSync(file, str); return true } catch { return false } }
function _touch(file) { _wIfAbsent(file, '') }

// Create the mission workspace for a scan. Idempotent; writes mission-context.md (once) + mission-plan.json.
function ensureMission(taskId, meta = {}, root) {
  const dir = missionDir(taskId, root)
  try { fs.mkdirSync(path.join(dir, 'workstreams'), { recursive: true }) } catch { return false }
  const now = (() => { try { return new Date().toISOString() } catch { return '' } })()
  _wIfAbsent(path.join(dir, 'mission-context.md'),
    `# Mission ${taskId}\n\n- **Mode:** ${meta.mode || 'static'}\n- **Goal:** ${meta.goal || '(security review)'}\n- **Features:** ${meta.featureCount ?? '?'}\n- **Started:** ${now}\n\n` +
    `> One mission = one project understanding. Workstreams (per feature) hold scoped evidence + candidates.\n> Observe-only mirror of the live run — the existing JSONL artifacts remain authoritative.\n`)
  if (meta.plan) _w(path.join(dir, 'mission-plan.json'), JSON.stringify({ taskId, ...meta.plan }, null, 2))
  _touch(path.join(dir, 'agent-messages.jsonl'))
  return true
}

// Create a per-feature workstream (context.md + the three streams). Idempotent.
function ensureWorkstream(taskId, feature, meta = {}, root) {
  const dir = workstreamDir(taskId, feature, root)
  try { fs.mkdirSync(dir, { recursive: true }) } catch { return false }
  _wIfAbsent(path.join(dir, 'context.md'), `# Workstream: ${feature}\n\n- **Feature:** ${feature}\n- **Risk:** ${meta.risk || '?'}\n- **Classes:** ${(meta.classes && [].concat(meta.classes).join(', ')) || '?'}\n\nScoped context, evidence, and candidates for this feature.\n`)
  _touch(path.join(dir, 'evidence.jsonl'))
  _touch(path.join(dir, 'candidates.jsonl'))
  _wIfAbsent(path.join(dir, 'notes.md'), `# Notes — ${feature}\n`)
  return true
}

function appendCandidate(taskId, feature, rec, root) { return _append(path.join(workstreamDir(taskId, feature, root), 'candidates.jsonl'), JSON.stringify(rec) + '\n') }
function appendEvidence(taskId, feature, rec, root) { return _append(path.join(workstreamDir(taskId, feature, root), 'evidence.jsonl'), JSON.stringify(rec) + '\n') }
function appendNote(taskId, feature, line, root) { return _append(path.join(workstreamDir(taskId, feature, root), 'notes.md'), `- ${line}\n`) }
function appendAgentMessage(taskId, msg, root) {
  const rec = { ts: (() => { try { return new Date().toISOString() } catch { return '' } })(), ...msg }
  return _append(path.join(missionDir(taskId, root), 'agent-messages.jsonl'), JSON.stringify(rec) + '\n')
}

// Mirror the canonical live artifacts into the mission folder (copies; fail-soft, skips missing). Keeps the
// mission workspace a self-contained snapshot without becoming a second source of truth.
function mirror(taskId, root) {
  const dir = missionDir(taskId, root); const INTEL = root || agentPaths.INTEL_ROOT
  const pairs = [
    [`task-board-${taskId}.jsonl`, 'task-board.jsonl'],
    [`decisions-${taskId}.jsonl`, 'decisions.jsonl'],
    [`coverage-${taskId}.json`, 'coverage.json'],
    [`session-plan-${taskId}.json`, 'session-plan.json'],
  ]
  for (const [from, to] of pairs) { try { const src = path.join(INTEL, from); if (fs.existsSync(src)) { fs.mkdirSync(dir, { recursive: true }); fs.copyFileSync(src, path.join(dir, to)) } } catch {} }
  return true
}

module.exports = { missionDir, workstreamDir, ensureMission, ensureWorkstream, appendCandidate, appendEvidence, appendNote, appendAgentMessage, mirror }
