'use strict'

const taskBoard = require('./task-board')

const REQUIRED_PHASES = Object.freeze(['inventory', 'research', 'triage', 'verify', 'audit', 'judge', 'report'])

function evaluate(input = {}) {
  const tasks = input.tasks || []
  const open = tasks.filter(task => !taskBoard.isTerminal(task.status))
  const failed = tasks.filter(task => ['failed', 'blocked', 'cancelled'].includes(task.status))
  const phases = new Set(tasks.filter(task => taskBoard.isTerminal(task.status)).map(task => task.phase))
  const required = (input.requiredPhases || REQUIRED_PHASES).filter(phase => input.applicablePhases ? input.applicablePhases.includes(phase) : true)
  const missingPhases = required.filter(phase => !phases.has(phase))
  const incompleteVerifierPanels = (input.verifierDecisions || []).filter(row => !row.complete)
  const followupsOpen = open.filter(task => task.parent_id || task.phase === 'explore')
  const reportTasks = tasks.filter(task => task.phase === 'report')
  const reportGenerated = reportTasks.length > 0 && reportTasks.every(task => task.report_generated === true)
  const finalReportGenerated = reportGenerated && reportTasks.every(task =>
    !input.finalReportRequired || /(?:^|[/\\])FINAL-REPORT-/.test(String(task.report_path || '')))
  const reportEligible = open.length === 0 && missingPhases.length === 0 &&
    incompleteVerifierPanels.length === 0 && input.triageDrained !== false &&
    input.auditComplete !== false && input.judgeComplete !== false && finalReportGenerated
  return {
    complete: reportEligible,
    completion_status: reportEligible ? (failed.length ? 'COMPLETE_WITH_GAPS' : 'COMPLETE') : 'REPORT_BLOCKED',
    report_eligible: reportEligible,
    open_task_ids: open.map(task => task.id),
    failed_task_ids: failed.map(task => task.id),
    missing_phases: missingPhases,
    incomplete_verifier_candidates: incompleteVerifierPanels.map(row => row.candidate_id),
    open_followup_ids: followupsOpen.map(task => task.id),
    report_generated: reportGenerated,
    final_report_generated: finalReportGenerated,
    reason: reportEligible
      ? (failed.length ? 'all work terminal; explicit coverage gaps retained' : 'all completion gates passed')
      : (reportGenerated && !finalReportGenerated ? 'preliminary report produced; final runtime validation is incomplete' : 'open work or validation gates remain'),
  }
}

module.exports = { REQUIRED_PHASES, evaluate }
