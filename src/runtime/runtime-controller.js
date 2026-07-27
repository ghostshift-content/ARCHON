'use strict'

const fs = require('fs')
const path = require('path')
const agentPaths = require('../../paths')
const generations = require('./runtime-generation')
const adapters = require('./mode-adapter')
const planner = require('./adaptive-planner')
const taskBoard = require('./task-board')
const journal = require('./mission-journal')
const scheduler = require('./adaptive-scheduler')
const sessions = require('./session-registry')
const artifacts = require('./runtime-artifacts')
const completionGate = require('./completion-gate')
const agenticExecutor = require('./agentic-executor')
const { hostAllowed } = require('./tool-scope-gate')
const decisionLog = require('./decision-log')

function _root(taskId, generation, intelRoot) {
  const base = intelRoot || agentPaths.INTEL_ROOT
  return generation === 'shadow' ? path.join(base, 'shadow', String(taskId)) : base
}
function _artifact(taskId, root) { return path.join(root, `adaptive-plan-${taskId}.json`) }
function _atomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`
  fs.writeFileSync(temp, JSON.stringify(value, null, 2))
  fs.renameSync(temp, file)
}

function prepare(input = {}) {
  if (!input.taskId) throw new Error('runtime controller requires taskId')
  const pinned = generations.pin(input.taskId, {
    dir: input.intelRoot,
    generation: input.generation,
    canaryPercent: input.canaryPercent,
  })
  if (pinned.runtime_generation === 'legacy') return { generation: 'legacy', drives_execution: false, plan: null }
  const adapter = adapters.get(input.mode)
  if (!adapter) throw new Error(`unsupported runtime mode: ${input.mode}`)
  const root = _root(input.taskId, pinned.runtime_generation, input.intelRoot)
  const plan = planner.buildMissionPlan({
    taskId: input.taskId,
    mode: input.mode,
    strategy: input.strategy,
    workstreams: input.workstreams || [],
    candidates: input.candidates || [],
    applicableSkills: input.applicableSkills || [],
    personas: input.personas,
    activeConcurrency: input.activeConcurrency,
    maxExploreChildren: input.maxExploreChildren,
    verifierBatchSize: input.verifierBatchSize,
    workstreamBudget: input.workstreamBudget,
  })
  const artifact = {
    task_id: input.taskId,
    runtime_generation: pinned.runtime_generation,
    drives_execution: ['canary', 'active'].includes(pinned.runtime_generation),
    adapter: {
      mode: adapter.mode,
      workstream_unit: adapter.workstreamUnit,
      evidence_required: adapter.evidenceRequired,
    },
    ...plan,
  }
  _atomic(_artifact(input.taskId, root), artifact)
  for (const task of plan.tasks) taskBoard.appendUnique(input.taskId, task, root)
  journal.append(input.taskId, 'PLAN_CREATED', {
    runtime_generation: pinned.runtime_generation,
    mode: input.mode,
    strategy: plan.strategy,
    task_count: plan.tasks.length,
  }, { dir: root, idempotencyKey: `plan:${plan.replan_revision}` })
  journal.append(input.taskId, 'MISSION_PINNED', {
    runtime_generation: pinned.runtime_generation,
  }, { dir: root, idempotencyKey: 'mission-generation' })
  return { generation: pinned.runtime_generation, drives_execution: artifact.drives_execution, root, plan: artifact }
}

async function run(input = {}, deps = {}) {
  const prepared = prepare(input)
  if (!prepared.drives_execution) return { ...prepared, status: prepared.generation === 'shadow' ? 'shadowed' : 'legacy' }
  const explicitlyInjected = typeof deps.executeTask === 'function'
  const cutoverApproved = process.env.ARCHON_RUNTIME_PARITY_APPROVED === '1' || input.parityApproved === true
  if (!explicitlyInjected && !cutoverApproved) {
    journal.append(input.taskId, 'MISSION_STATUS', {
      status: 'cutover_gated',
      reason: 'runtime parity approval is not enabled',
    }, { dir: prepared.root, idempotencyKey: 'cutover-gated' })
    return { ...prepared, status: 'cutover_gated', fallback_required: true }
  }
  const executeTask = deps.executeTask || agenticExecutor.createExecutor({
    taskId: input.taskId,
    runtimeRoot: prepared.root,
    mode: input.mode,
    strategy: prepared.plan.strategy,
    goal: input.goal,
    target: input.target,
    scope: input.scope,
    sourceRoots: input.sourceRoots,
    model: input.model,
    timeoutMs: input.timeoutMs,
    omitApiKey: input.omitApiKey,
    runAgent: deps.runAgent,
    runtimeProofComplete() {
      const rows = taskBoard.load(input.taskId, prepared.root).tasks
      const runtime = rows.filter(row => row.phase === 'runtime_validate')
      return runtime.length > 0 && runtime.every(row =>
        taskBoard.isTerminal(row.status) && !['failed', 'blocked', 'cancelled'].includes(row.status))
    },
  })
  const hasRuntimeTarget = Boolean(input.target && input.scope && hostAllowed(input.target, input.scope))
  const engine = scheduler.createScheduler({
    taskId: input.taskId,
    dir: prepared.root,
    executeTask,
    activeConcurrency: prepared.plan.active_concurrency,
    maxExploreChildren: prepared.plan.max_explore_children_per_parent,
    maxRetries: input.maxRetries,
    leaseMs: input.leaseMs,
    model: input.model,
    mode: input.mode,
    strategy: prepared.plan.strategy,
    memoryDir: input.intelRoot,
    isCancelled: deps.isCancelled,
    scopeValidate: deps.scopeValidate,
    quotaState: deps.quotaState,
    quotaWaitMs: input.quotaWaitMs,
    hasRuntimeTarget,
    runtimeValidationBatchSize: input.runtimeValidationBatchSize,
  })
  const result = await engine.run()
  const candidates = artifacts.candidates(input.taskId, prepared.root)
  const verifier = artifacts.decisions(input.taskId, prepared.root) || { decisions: [] }
  const applicablePhases = candidates.length
    ? [
        'inventory', 'research', 'triage',
        ...(input.mode === 'whitebox' && hasRuntimeTarget ? ['runtime_validate'] : []),
        'verify', 'audit', 'judge', 'report',
      ]
    : ['inventory', 'research', 'triage', 'audit', 'judge', 'report']
  const completion = completionGate.evaluate({
    tasks: result.board.tasks,
    applicablePhases,
    verifierDecisions: verifier.decisions || [],
    triageDrained: result.board.tasks.filter(row => row.phase === 'triage').every(row => taskBoard.isTerminal(row.status)),
    auditComplete: result.board.tasks.filter(row => row.phase === 'audit').every(row => taskBoard.isTerminal(row.status)),
    judgeComplete: result.board.tasks.filter(row => row.phase === 'judge').every(row => taskBoard.isTerminal(row.status)),
    finalReportRequired: input.mode === 'whitebox',
  })
  journal.append(input.taskId, 'COMPLETION_GATE', completion, { dir: prepared.root })
  return { ...prepared, ...result, completionGate: completion }
}

function inspect(taskId, intelRoot) {
  const pinned = generations.read(taskId, intelRoot)
  const root = _root(taskId, pinned.runtime_generation, intelRoot)
  let plan = null
  try { plan = JSON.parse(fs.readFileSync(_artifact(taskId, root), 'utf8')) } catch {}
  return {
    generation: pinned.runtime_generation,
    plan,
    board: taskBoard.load(taskId, root),
    journal: journal.reduce(taskId, root),
    sessions: sessions.load(taskId, root),
    decisions: decisionLog.load(taskId, root),
    root,
  }
}

module.exports = { prepare, run, inspect }
