'use strict'
// M5/§13 — UNIFIED decision log. This is a thin ADAPTER over the pre-existing src/pipeline/decision-log.js so
// there is exactly ONE decision trail on disk (decisions-<taskId>.jsonl) and one canonical 8-field schema. It
// keeps the ergonomic {taskId, agent, decision, …} record()/load() API the bridge + dashboard use, and maps it
// onto the pipeline appender. Fail-soft.

const pipeline = require('../pipeline/decision-log')
const agentPaths = require('../../paths')

function logPath(taskId, dir) { return `${dir || agentPaths.INTEL_ROOT}/decisions-${taskId}.jsonl` }

// record({ taskId, agent, decision, reason?, evidence_used?|evidence?, task_created?, confidence?, result?, next_recommendation? })
function record(entry, dir) {
  const e = entry || {}
  if (!e.taskId || !e.agent || !e.decision) return false
  const deps = dir ? { intelRoot: dir } : {}
  return !!pipeline.append(e.taskId, {
    agent: e.agent, decision: e.decision, reason: e.reason,
    evidence: e.evidence_used || e.evidence, task_created: e.task_created,
    confidence: e.confidence, result: e.result, next_recommendation: e.next_recommendation,
  }, deps)
}

function load(taskId, dir) { return pipeline.read(taskId, dir ? { intelRoot: dir } : {}) }

module.exports = { logPath, record, load, pipeline }
