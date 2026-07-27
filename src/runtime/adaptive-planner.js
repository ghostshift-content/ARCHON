'use strict'

const crypto = require('crypto')
const team = require('./agent-team')
const memory = require('./pattern-memory')

function _id(prefix, ...parts) {
  const hash = crypto.createHash('sha256').update(parts.map(String).join('|')).digest('hex').slice(0, 12)
  return `${prefix}-${hash}`
}

function expectedValue(skill = {}, graph = {}) {
  const likelihood = Number(skill.likelihood ?? 0.5)
  const impact = Number(skill.impact ?? 0.5)
  const cost = Math.max(0.05, Number(skill.cost ?? 0.5))
  const unlock = Number(skill.chain_potential ?? 0)
  const evidenceBoost = Array.isArray(skill.preconditions) && skill.preconditions.every(p => graph[p] === true) ? 0.25 : 0
  return ((likelihood + evidenceBoost) * impact * (1 + unlock)) / cost
}

function rankSkills(skills = [], graph = {}, mode, memoryDir) {
  const eligible = skills.filter(skill =>
    (!skill.modes || skill.modes.includes(mode)) &&
    (!skill.preconditions || skill.preconditions.every(key => graph[key] === true)))
  const learned = memory.rank(mode, eligible.map(skill => skill.id), memoryDir)
  const learnedRank = new Map(learned.map((id, index) => [id, index]))
  return eligible.sort((a, b) =>
    expectedValue(b, graph) - expectedValue(a, graph) ||
    (learnedRank.get(a.id) ?? 999) - (learnedRank.get(b.id) ?? 999) ||
    a.id.localeCompare(b.id))
}

function buildMissionPlan(input = {}) {
  const research = team.buildResearchPlan(input)
  const taskId = input.taskId
  const inventoryId = _id('INV', taskId, research.mode)
  const tasks = [{
    id: inventoryId,
    taskId,
    mode: research.mode,
    phase: 'inventory',
    priority: 'high',
    status: 'queued',
    skill_id: 'inventory',
    idempotency_key: `${taskId}:inventory`,
    reason: 'establish authoritative mission inventory and shared context',
    dependencies: [],
  }]
  for (const assignment of research.assignments) {
    const id = _id('RESEARCH', taskId, assignment.workstream_id)
    tasks.push({
      id, taskId, mode: research.mode, phase: 'research', status: 'queued',
      priority: assignment.oversized ? 'critical' : 'normal',
      workstream_id: assignment.workstream_id,
      skill_id: 'holistic-research',
      idempotency_key: `${taskId}:research:${assignment.workstream_id}`,
      dependencies: [inventoryId],
      context_refs: [
        ...(assignment.context.features || []).map(value => `feature:${value}`),
        ...(assignment.context.files || []).map(value => `file:${value}`),
        ...(assignment.context.endpoints || []).map(value => `endpoint:${value}`),
      ],
      budget: input.workstreamBudget || null,
      assignment,
      reason: 'holistically map and assess one coherent context slice',
      ...(assignment.oversized ? {
        status: 'blocked',
        error: 'workstream exceeds the usable model context and requires a smaller source slice',
        result: 'blocked_coverage_gap',
        finished_at: new Date().toISOString(),
      } : {}),
    })
  }
  return {
    version: 2,
    task_id: taskId,
    mode: research.mode,
    strategy: research.strategy,
    generated_at: new Date().toISOString(),
    replan_revision: Number(input.replanRevision) || 0,
    active_concurrency: Math.max(1, Number(input.activeConcurrency) || research.concurrency.researcher_leads || 1),
    max_explore_children_per_parent: research.concurrency.max_explore_children_per_parent,
    tasks,
    team: research,
  }
}

function createExplorerTask(parent, leadSessionId, discovery = {}, childIndex = 0) {
  if (!parent || parent.phase === 'explore') throw new Error('explorers cannot recursively spawn')
  const objective = String(discovery.objective || '').trim()
  if (!objective || !Array.isArray(discovery.evidence_refs) || !discovery.evidence_refs.length) {
    throw new Error('explorer requires a concrete objective and evidence_refs')
  }
  return {
    id: _id('EXPLORE', parent.taskId, parent.id, objective),
    taskId: parent.taskId,
    parent_id: parent.id,
    workstream_id: parent.workstream_id,
    mode: parent.mode,
    phase: 'explore',
    status: 'queued',
    priority: discovery.priority || 'high',
    skill_id: discovery.skill_id || 'evidence-followup',
    hypothesis_id: discovery.hypothesis_id || null,
    idempotency_key: `${parent.taskId}:explore:${parent.id}:${_id('K', objective)}`,
    dependencies: [],
    evidence_refs: discovery.evidence_refs,
    context_refs: discovery.context_refs || [],
    created_by: leadSessionId,
    child_index: childIndex,
    reason: objective,
  }
}

module.exports = { expectedValue, rankSkills, buildMissionPlan, createExplorerTask }
