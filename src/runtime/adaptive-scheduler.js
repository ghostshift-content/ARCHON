'use strict'

const taskBoard = require('./task-board')
const sessions = require('./session-registry')
const journal = require('./mission-journal')
const decisions = require('./decision-log')
const planner = require('./adaptive-planner')
const memory = require('./pattern-memory')
const artifacts = require('./runtime-artifacts')
const team = require('./agent-team')

function _role(task) {
  if (task.phase === 'inventory') return 'ARCHON_INVENTORY'
  if (task.phase === 'explore') return 'ARCHON_EXPLORE'
  if (task.phase === 'runtime_validate') return 'ARCHON_RESEARCHER'
  if (task.phase === 'verify') return 'ARCHON_VERIFIER'
  if (task.phase === 'triage') return 'TRIAGER'
  if (task.phase === 'audit') return 'AUDITOR'
  if (task.phase === 'judge') return 'ARBITER'
  if (task.phase === 'report') return 'SCRIBE'
  return 'ARCHON_RESEARCHER'
}
function _sessionId(task, attempt) { return `${_role(task).toLowerCase()}-${task.id}-${attempt}` }
function _terminalStatus(result, task) {
  if (!result) return 'failed'
  if (task && task.phase === 'report' && result.report_generated !== true) return 'failed'
  if (result.status && taskBoard.STATUSES.includes(result.status)) return result.status
  if (result.error) return 'failed'
  if (Array.isArray(result.candidates) && result.candidates.length) return 'candidate_found'
  return result.no_issue === false ? 'completed' : 'no_issue'
}
function _wait(ms) {
  return new Promise(resolve => setTimeout(resolve, Math.max(1, Number(ms) || 1)))
}
async function _waves(items, concurrency, fn) {
  const out = []
  for (let i = 0; i < items.length; i += Math.max(1, concurrency)) {
    out.push(...await Promise.all(items.slice(i, i + Math.max(1, concurrency)).map(fn)))
  }
  return out
}

function createScheduler(opts = {}) {
  const taskId = opts.taskId
  const dir = opts.dir
  const executeTask = opts.executeTask
  if (!taskId || typeof executeTask !== 'function') throw new Error('adaptive scheduler requires taskId and executeTask')
  const maxChildren = Math.max(0, Math.min(2, Number(opts.maxExploreChildren) || 2))
  const maxRetries = Math.max(0, Math.min(5, Number(opts.maxRetries) || 2))
  const concurrency = Math.max(1, Number(opts.activeConcurrency) || 1)
  const cancelled = opts.isCancelled || (() => false)
  const scopeValidate = opts.scopeValidate || (() => true)
  const quotaState = opts.quotaState || (() => 'healthy')
  const quotaWaitMs = Math.max(1, Number(opts.quotaWaitMs) || 2_000)
  const childCount = new Map()

  async function runOne(task) {
    if (cancelled()) return taskBoard.setStatus(taskId, task.id, 'cancelled', { error: 'mission cancelled' }, dir)
    if (!scopeValidate(task)) return taskBoard.setStatus(taskId, task.id, 'blocked', { error: 'scope validation failed' }, dir)
    let quotaWaitRecorded = false
    while (quotaState() === 'cooling' && !['triage', 'verify'].includes(task.phase)) {
      if (cancelled()) return taskBoard.setStatus(taskId, task.id, 'cancelled', { error: 'mission cancelled while waiting for quota' }, dir)
      if (!quotaWaitRecorded) {
        taskBoard.setStatus(taskId, task.id, 'needs_followup', { error: 'quota cooling; waiting for automatic resume' }, dir)
        journal.append(taskId, 'QUOTA_SIGNAL', {
          state: 'cooling', task_id: task.id, deferred: true,
        }, { dir, idempotencyKey: `quota-wait:${task.id}:${Number(task.attempt) || 0}` })
        quotaWaitRecorded = true
      }
      await _wait(quotaWaitMs)
    }
    const sessionId = _sessionId(task, (Number(task.attempt) || 0) + 1)
    const agent = _role(task)
    if (!taskBoard.claim(taskId, task.id, agent, sessionId, dir, { leaseMs: opts.leaseMs })) return null
    taskBoard.setStatus(taskId, task.id, 'running', { claimed_by: agent, session_id: sessionId }, dir)
    sessions.start(taskId, {
      session_id: sessionId, role: agent, current_task_id: task.id,
      workstream_id: task.workstream_id, model: opts.model || null,
      context_size: (task.context_refs || []).length, budget: task.budget || null,
      child_count: childCount.get(task.id) || 0,
    }, dir)
    journal.append(taskId, 'SESSION_STATUS', { session_id: sessionId, role: agent, status: 'running', task_id: task.id }, { dir })
    journal.append(taskId, 'PHASE_STATUS', { phase: task.phase, status: 'running' }, {
      dir,
      idempotencyKey: `phase-running:${task.phase}`,
    })
    decisions.record({
      taskId, agent, session_id: sessionId, decision: 'claim-task', reason: task.reason,
      evidence_used: task.evidence_refs || [], task_created: task.id, result: 'running',
    }, dir)

    let timer = setInterval(() => {
      taskBoard.renewLease(taskId, task.id, agent, sessionId, dir, { leaseMs: opts.leaseMs })
      sessions.heartbeat(taskId, sessionId, {}, dir)
    }, Math.max(1_000, Math.floor((Number(opts.leaseMs) || taskBoard.DEFAULT_LEASE_MS) / 3)))
    if (timer.unref) timer.unref()
    let result
    try {
      result = await executeTask(task, {
        taskId, sessionId, role: agent,
        heartbeat(patch) {
          taskBoard.renewLease(taskId, task.id, agent, sessionId, dir, { leaseMs: opts.leaseMs })
          sessions.heartbeat(taskId, sessionId, patch || {}, dir)
        },
      })
    } catch (error) {
      result = { error: error.message }
    } finally {
      clearInterval(timer)
    }

    if (result && result.rate_limited) {
      const canRetry = Number(task.attempt) < maxRetries
      const status = canRetry ? 'needs_followup' : 'blocked'
      const reason = canRetry
        ? 'rate limited; deferred for automatic retry'
        : 'rate-limit retry budget exhausted; explicit coverage gap'
      taskBoard.setStatus(taskId, task.id, status, {
        error: reason,
        result: canRetry ? 'deferred_rate_limit' : 'blocked_coverage_gap',
        lease_until: null,
      }, dir)
      sessions.finish(taskId, sessionId, 'blocked', {
        terminal_reason: canRetry ? 'rate_limit' : 'rate_limit_exhausted',
      }, dir)
      journal.append(taskId, 'QUOTA_SIGNAL', {
        state: quotaState(), task_id: task.id, rate_limited: true,
        retry_scheduled: canRetry,
      }, { dir })
      decisions.record({
        taskId, agent, session_id: sessionId,
        decision: canRetry ? 'defer-rate-limited-task' : 'record-rate-limit-coverage-gap',
        reason, evidence_used: task.evidence_refs || [], result: status,
        next_recommendation: canRetry ? 'retry after quota recovery' : 'operator may resume with a renewed quota budget',
      }, dir)
      return { ...result, status, coverage_gap: !canRetry }
    }

    const status = _terminalStatus(result, task)
    const evidenceRefs = [...new Set([...(task.evidence_refs || []), ...((result && result.evidence_refs) || [])])]
    taskBoard.setStatus(taskId, task.id, status, {
      result: result && result.summary || null,
      error: result && result.error || null,
      evidence_refs: evidenceRefs,
      lease_until: null,
      report_generated: result && result.report_generated === true,
      report_path: result && result.report_path || null,
      report_digest: result && result.report_digest || null,
    }, dir)
    sessions.finish(taskId, sessionId, status === 'failed' ? 'failed' : 'completed', {
      terminal_reason: result && result.error || status,
      evidence_count: evidenceRefs.length,
    }, dir)
    journal.append(taskId, 'TASK_RESULT', { task_id: task.id, status, evidence_refs: evidenceRefs }, { dir })
    if (result && Array.isArray(result.candidates) && result.candidates.length) {
      artifacts.appendCandidates(taskId, result.candidates, task.mode, dir)
    }
    if (result && Array.isArray(result.candidate_updates) && result.candidate_updates.length) {
      artifacts.updateCandidates(taskId, result.candidate_updates, task.mode, dir)
    }
    if (result && Array.isArray(result.votes) && result.votes.length) {
      artifacts.appendVotes(taskId, result.votes, dir)
    }
    if (result && typeof result === 'object') {
      artifacts.writePhaseResult(taskId, task.phase, {
        task_id: task.id,
        session_id: sessionId,
        status,
        result,
        recorded_at: new Date().toISOString(),
      }, dir)
    }
    decisions.record({
      taskId, agent, session_id: sessionId, decision: 'complete-task', reason: task.reason,
      evidence_used: evidenceRefs, result: status,
      next_recommendation: result && result.next_recommendation,
    }, dir)

    const discoveries = result && Array.isArray(result.followups) ? result.followups : []
    if (task.phase !== 'explore' && discoveries.length) {
      const used = childCount.get(task.id) || 0
      const allowed = discoveries.slice(0, Math.max(0, maxChildren - used))
      for (let index = 0; index < allowed.length; index++) {
        try {
          const child = planner.createExplorerTask(task, sessionId, allowed[index], used + index)
          const added = taskBoard.appendUnique(taskId, child, dir)
          if (added.appended) {
            journal.append(taskId, 'TASK_CREATED', { task_id: child.id, parent_id: task.id, reason: child.reason }, { dir })
            journal.append(taskId, 'REPLAN', {
              revision_reason: 'evidence-triggered follow-up',
              parent_task_id: task.id,
              task_id: child.id,
              evidence_refs: child.evidence_refs,
            }, { dir, idempotencyKey: `replan:${child.id}` })
            decisions.record({
              taskId, agent, session_id: sessionId, decision: 'create-evidence-followup',
              reason: child.reason, evidence_used: child.evidence_refs, task_created: child.id,
              confidence: allowed[index].confidence, result: 'queued',
            }, dir)
          }
        } catch {}
      }
      childCount.set(task.id, used + allowed.length)
    }
    if (task.skill_id && ['completed', 'candidate_found', 'no_issue', 'failed'].includes(status)) {
      memory.append({
        mode: task.mode, strategy: opts.strategy || 'adaptive', skill_family: task.skill_id,
        technology_family: result && result.technology_family || 'unknown',
        outcome: status === 'failed' ? 'failed' : status === 'no_issue' ? 'no_issue' : 'success',
        duration_bucket: result && result.duration_bucket || 'unknown',
        cost_bucket: result && result.cost_bucket || 'unknown',
      }, opts.memoryDir)
    }
    const phaseRows = taskBoard.load(taskId, dir).tasks.filter(row => row.phase === task.phase)
    if (phaseRows.length && phaseRows.every(row => taskBoard.isTerminal(row.status))) {
      journal.append(taskId, 'PHASE_STATUS', {
        phase: task.phase,
        status: phaseRows.some(row => ['failed', 'blocked', 'cancelled'].includes(row.status))
          ? 'completed_with_gaps'
          : 'completed',
      }, { dir, idempotencyKey: `phase-terminal:${task.phase}` })
    }
    return result
  }

  function _phaseTasks(tasks, phase) { return tasks.filter(task => task.phase === phase) }
  function _allTerminal(rows) { return rows.length > 0 && rows.every(row => taskBoard.isTerminal(row.status)) }
  function _seed(task) {
    const added = taskBoard.appendUnique(taskId, taskBoard.newTask(task), dir)
    if (added.appended) journal.append(taskId, 'TASK_CREATED', { task_id: task.id, phase: task.phase, reason: task.reason }, { dir })
    return added.appended
  }
  function seedDownstream() {
    const current = taskBoard.load(taskId, dir).tasks
    const research = current.filter(task => ['inventory', 'research', 'explore'].includes(task.phase))
    if (!_allTerminal(research)) return

    let triage = _phaseTasks(current, 'triage')
    if (!triage.length) {
      const candidates = artifacts.candidates(taskId, dir)
      const batches = team.batchCandidates(candidates, opts.triageBatchSize || 12)
      const rows = batches.length ? batches : [{ id: 'triage-empty', candidates: [] }]
      for (const batch of rows) _seed({
        id: `TRIAGE-${batch.id}`, taskId, mode: opts.mode || current[0]?.mode || 'static',
        phase: 'triage', status: 'queued', priority: 'high',
        skill_id: 'candidate-triage', candidate_ids: batch.candidates.map(row => row.id),
        context_refs: batch.candidates.map(row => `candidate:${row.id}`),
        idempotency_key: `${taskId}:triage:${batch.id}`,
        reason: batch.candidates.length ? 'validate and deduplicate a persistent candidate batch' : 'record clean no-findings triage outcome',
      })
      return
    }
    if (!_allTerminal(triage)) return

    const candidates = artifacts.candidates(taskId, dir).filter(row => row.accepted !== false && row.status !== 'DISPROVEN')
    if ((opts.mode || current[0]?.mode) === 'whitebox') {
      let runtime = _phaseTasks(current, 'runtime_validate')
      if (!runtime.length && candidates.length && opts.hasRuntimeTarget) {
        for (const batch of team.batchCandidates(candidates, opts.runtimeValidationBatchSize || 6)) {
          _seed({
            id: `RUNTIME-${batch.id}`, taskId, mode: 'whitebox',
            phase: 'runtime_validate', status: 'queued', priority: 'high',
            skill_id: 'source-guided-live-validation',
            candidate_ids: batch.candidates.map(row => row.id),
            context_refs: batch.candidates.flatMap(row => [`candidate:${row.id}`, ...(row.evidence_refs || [])]),
            dependencies: triage.map(row => row.id),
            idempotency_key: `${taskId}:runtime:${batch.id}`,
            reason: 'validate source candidates against the authorized live target using source context',
          })
        }
        return
      }
      runtime = _phaseTasks(taskBoard.load(taskId, dir).tasks, 'runtime_validate')
      if (runtime.length && !_allTerminal(runtime)) return
    }

    let verify = _phaseTasks(taskBoard.load(taskId, dir).tasks, 'verify')
    if (!verify.length && candidates.length) {
      const runtime = _phaseTasks(taskBoard.load(taskId, dir).tasks, 'runtime_validate')
      for (const batch of team.batchCandidates(candidates, opts.verifierBatchSize || 8)) {
        for (const lens of team.VERIFIER_LENSES) _seed({
          id: `VERIFY-${batch.id}-${lens}`, taskId, mode: opts.mode || current[0]?.mode || 'static',
          phase: 'verify', status: 'queued', priority: 'high',
          skill_id: `verify-${lens.toLowerCase()}`, lens, batch_id: batch.id,
          candidate_ids: batch.candidates.map(row => row.id),
          context_refs: batch.candidates.map(row => `candidate:${row.id}`),
          dependencies: runtime.length ? runtime.map(row => row.id) : triage.map(row => row.id),
          idempotency_key: `${taskId}:verify:${batch.id}:${lens}`,
          reason: `independently challenge candidates through the ${lens.toLowerCase()} lens`,
        })
      }
      return
    }
    verify = _phaseTasks(taskBoard.load(taskId, dir).tasks, 'verify')
    if (verify.length && !_allTerminal(verify)) return

    let audit = _phaseTasks(taskBoard.load(taskId, dir).tasks, 'audit')
    if (!audit.length) {
      let tally = { decisions: [], admitted: [], rejected: [], malformed_votes: [] }
      if (candidates.length) tally = team.tallyVerifierVotes(candidates, artifacts.allVotes(taskId, dir), opts.mode || current[0]?.mode)
      artifacts.writeDecisions(taskId, tally, dir)
      _seed({
        id: `AUDIT-${taskId}`, taskId, mode: opts.mode || current[0]?.mode || 'static',
        phase: 'audit', status: 'queued', priority: 'high', skill_id: 'evidence-audit',
        candidate_ids: tally.admitted.map(row => row.candidate_id),
        dependencies: verify.map(row => row.id),
        context_refs: [`artifact:${artifacts.file(taskId, 'verifier-decisions', dir, 'json')}`],
        idempotency_key: `${taskId}:audit`, reason: 'audit admitted candidates and evidence completeness',
      })
      return
    }
    if (!_allTerminal(audit)) return

    let judge = _phaseTasks(taskBoard.load(taskId, dir).tasks, 'judge')
    if (!judge.length) {
      const auditResults = artifacts.readPhaseResult(taskId, 'audit', dir) || []
      const latestAudit = [...(Array.isArray(auditResults) ? auditResults : [auditResults])].reverse()
        .find(row => row && row.status !== 'failed' && row.result)
      const approvedIds = latestAudit && Array.isArray(latestAudit.result.approved_ids)
        ? latestAudit.result.approved_ids
        : audit.flatMap(row => row.candidate_ids || [])
      _seed({
        id: `JUDGE-${taskId}`, taskId, mode: opts.mode || current[0]?.mode || 'static',
        phase: 'judge', status: 'queued', priority: 'high', skill_id: 'independent-judge',
        candidate_ids: [...new Set(approvedIds)],
        context_refs: [...new Set(approvedIds)].map(id => `candidate:${id}`),
        dependencies: audit.map(row => row.id), idempotency_key: `${taskId}:judge`,
        reason: 'independently decide report admission and final status',
      })
      return
    }
    if (!_allTerminal(judge)) return

    const report = _phaseTasks(taskBoard.load(taskId, dir).tasks, 'report')
    if (!report.length) {
      const judgeResults = artifacts.readPhaseResult(taskId, 'judge', dir) || []
      const latestJudge = [...(Array.isArray(judgeResults) ? judgeResults : [judgeResults])].reverse()
        .find(row => row && row.status !== 'failed' && row.result)
      const approvedIds = latestJudge && Array.isArray(latestJudge.result.approved_ids)
        ? latestJudge.result.approved_ids
        : judge.flatMap(row => row.candidate_ids || [])
      _seed({
        id: `REPORT-${taskId}`, taskId, mode: opts.mode || current[0]?.mode || 'static',
        phase: 'report', status: 'queued', priority: 'high', skill_id: 'report-writing',
        candidate_ids: [...new Set(approvedIds)],
        context_refs: [...new Set(approvedIds)].map(id => `candidate:${id}`),
        dependencies: judge.map(row => row.id), idempotency_key: `${taskId}:report`,
        reason: 'write the final report from judged findings and explicit coverage gaps',
      })
    }
  }

  async function run() {
    taskBoard.releaseExpired(taskId, dir)
    journal.append(taskId, 'MISSION_STATUS', { status: 'running' }, { dir, idempotencyKey: 'mission-running' })
    let idleRounds = 0
    while (!cancelled()) {
      seedDownstream()
      const board = taskBoard.load(taskId, dir)
      if (board.counts.complete) break
      const ready = board.tasks.filter(task =>
        ['queued', 'needs_followup'].includes(task.status) && taskBoard.dependenciesMet(task, board.tasks))
      if (!ready.length) {
        const released = taskBoard.releaseExpired(taskId, dir)
        if (!released && ++idleRounds >= 2) break
        continue
      }
      idleRounds = 0
      await _waves(ready, concurrency, runOne)
      seedDownstream()
    }
    const board = taskBoard.load(taskId, dir)
    const status = cancelled() ? 'cancelled' : board.counts.complete ? 'completed' : 'blocked'
    journal.append(taskId, 'MISSION_STATUS', { status }, { dir })
    return { status, board, sessions: sessions.load(taskId, dir), journal: journal.reduce(taskId, dir) }
  }

  return { run, runOne }
}

module.exports = { createScheduler }
