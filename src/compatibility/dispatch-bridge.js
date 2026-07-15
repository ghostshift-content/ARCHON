'use strict'
// M8–M10 / M13: the compatibility bridge the CURRENT dispatchers call to emit the new architecture artifacts
// DURING a real run — the live task board, decision log, session plan, and coverage. Every function is
// try/caught internally and gated by a flag, so it is PURE ADDITIVE TELEMETRY: it can never change control flow
// or break a scan. This is the safe "engine uses the task board" (emit form of M8–M10). Turn off with
// ARCHON_TASK_BOARD=0.

const fs = require('fs')
const path = require('path')
const agentPaths = require('../../paths')
const taskBoard = require('../runtime/task-board')
const decisionLog = require('../runtime/decision-log')
const mission = require('../runtime/mission-workspace')
const bridge = require('./task-board-bridge')

function enabled() { return process.env.ARCHON_TASK_BOARD !== '0' }
function _try(fn) { try { if (enabled()) fn() } catch { /* telemetry must never break a scan */ } }

// session plan → var/intel/session-plan-<taskId>.json + create the mission workspace (R2)
function onSessionPlan(taskId, plan) {
  _try(() => {
    fs.writeFileSync(path.join(agentPaths.INTEL_ROOT, `session-plan-${taskId}.json`), JSON.stringify({ taskId, ...plan }, null, 2))
    mission.ensureMission(taskId, { mode: plan.mode || 'static', featureCount: plan.features_total, plan })
    mission.mirror(taskId)
  })
}

// one feature's mapping outcome → a MAP task on the board + a decision-log line + a per-feature workstream (R2)
function onFeatureMapped(taskId, feature, status, owner, mode) {
  _try(() => {
    const s = bridge.MAP_STATUS[status] || 'completed'
    taskBoard.append(taskId, taskBoard.newTask({ id: `MAP-${feature}`, taskId, mode: mode || 'static', phase: 'mapping', feature, status: s, claimed_by: owner || null, finished_at: new Date().toISOString() }))
    decisionLog.record({ taskId, agent: owner || 'CURATOR', decision: `mapped feature ${feature}`, result: s })
    mission.ensureWorkstream(taskId, feature, {})
    mission.appendNote(taskId, feature, `mapping ${s}`)
  })
}

// one feature's review outcome → a REV task + decision-log line + workstream note (R2)
function onFeatureReviewed(taskId, feature, status, agent, classes, mode) {
  _try(() => {
    const s = bridge.REV_STATUS[status] || 'no_issue'
    taskBoard.append(taskId, taskBoard.newTask({ id: `REV-${feature}`, taskId, mode: mode || 'static', phase: 'review', feature, status: s, claimed_by: agent || null, vulnerability_class: Array.isArray(classes) ? classes.join(',') : (classes || null), finished_at: new Date().toISOString() }))
    decisionLog.record({ taskId, agent: agent || 'CURATOR', decision: `reviewed feature ${feature}`, result: s })
    mission.ensureWorkstream(taskId, feature, { classes })
    mission.appendNote(taskId, feature, `review ${s}${agent ? ` by ${agent}` : ''}`)
  })
}

// coverage snapshot (from the ledger) → var/intel/coverage-<taskId>.json + refresh the mission mirror (R2)
function onCoverage(taskId) {
  _try(() => {
    fs.writeFileSync(path.join(agentPaths.INTEL_ROOT, `coverage-${taskId}.json`), JSON.stringify(bridge.deriveCoverage(taskId), null, 2))
    mission.mirror(taskId)
  })
}

module.exports = { enabled, onSessionPlan, onFeatureMapped, onFeatureReviewed, onCoverage }
