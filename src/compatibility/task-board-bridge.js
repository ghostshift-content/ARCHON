'use strict'
// M5/M8–M10 (OBSERVE-ONLY): derive the new architecture artifacts from the CURRENT engine's existing outputs —
// WITHOUT touching event-bus.js or the dispatchers. Reads the mapping ledger + source-runtime events + finding
// JSONL and projects them into a task board + coverage snapshot. This is the safe "observe" form of M8–M10: the
// UI sees a live task board while execution is unchanged. Fully fail-soft.

const fs = require('fs')
const path = require('path')
const agentPaths = require('../../paths')
const taskBoard = require('../runtime/task-board')

const INTEL = () => agentPaths.INTEL_ROOT
function _crDir(taskId) { return path.join(INTEL(), 'code-review', taskId) }
function _readJson(f) { try { return JSON.parse(fs.readFileSync(f, 'utf8')) } catch { return null } }
function _jsonlCount(f) { try { return fs.readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).length } catch { return 0 } }
function _readJsonl(f) { try { return fs.readFileSync(f, 'utf8').split('\n').map((l) => { try { return JSON.parse(l.trim()) } catch { return null } }).filter(Boolean) } catch { return [] } }

// mapping_status → board status
const MAP_STATUS = { done: 'completed', reviewed: 'completed', blocked: 'blocked', blocked_coverage_gap: 'blocked', failed: 'failed', in_progress: 'running', claimed: 'claimed', deferred_rate_limit: 'needs_followup', queued: 'queued' }
// review_status → board status
const REV_STATUS = { candidate_found: 'candidate_found', reviewed_no_issue: 'no_issue', failed: 'failed', in_progress: 'running', duplicate: 'completed', needs_more_context: 'needs_followup', pending: 'queued' }

// Project the mapping ledger (source of truth for source review) into task-board rows: one mapping task + one
// review task per feature. Returns an array of task objects (does NOT write).
function tasksFromLedger(taskId, ledger) {
  const rows = []
  const feats = (ledger && ledger.features) || {}
  let n = 0
  for (const slug of Object.keys(feats)) {
    const f = feats[slug]
    rows.push(taskBoard.newTask({
      id: `MAP-${String(++n).padStart(4, '0')}`, taskId, mode: (ledger.mode || 'static'), phase: 'mapping', feature: slug,
      priority: f.risk === 'high' ? 'high' : 'normal', status: MAP_STATUS[f.mapping_status || f.status] || 'queued',
      claimed_by: f.owner || null, created_by: 'CURATOR', reason: `map feature ${slug}`, finished_at: f.finished_at || null,
    }))
    if (f.review_status) rows.push(taskBoard.newTask({
      id: `REV-${String(n).padStart(4, '0')}`, taskId, mode: (ledger.mode || 'static'), phase: 'review', feature: slug,
      vulnerability_class: Array.isArray(f.vulnerability_classes) ? f.vulnerability_classes.join(',') : null,
      priority: f.risk === 'high' ? 'high' : 'normal', status: REV_STATUS[f.review_status] || 'queued',
      claimed_by: f.assigned_agent || null, created_by: 'CURATOR', reason: `review feature ${slug}`,
    }))
  }
  return rows
}

// Non-writing projection of the current ledger into task-board rows. Use this on READ paths (e.g. the dashboard)
// so we NEVER clobber a live board that dispatch-bridge is appending to during a run.
function boardRows(taskId) {
  const ledger = _readJson(path.join(_crDir(taskId), 'phase1-maps', 'mapping-ledger.json'))
  return ledger ? tasksFromLedger(taskId, ledger) : []
}

// Explicit rebuild of task-board-<taskId>.jsonl from the ledger (truncates + rewrites). ONLY call this when
// there is no live board (e.g. a completed/older run) — never on a routine dashboard read of a live run.
function deriveTaskBoard(taskId, dir) {
  const outDir = dir || INTEL()
  const rows = boardRows(taskId)
  try { fs.writeFileSync(taskBoard.boardPath(taskId, outDir), rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : '')) } catch {}
  return taskBoard.recount(rows)
}

// Coverage snapshot (feature + pattern) from the ledger + finding stream. Returns the object (does NOT write).
function deriveCoverage(taskId) {
  const ledger = _readJson(path.join(_crDir(taskId), 'phase1-maps', 'mapping-ledger.json')) || {}
  const cov = {
    taskId, mode: ledger.mode || 'static',
    features: {
      discovered: ledger.features_total || 0, mapped: ledger.features_mapped || 0, deep_mapped: ledger.features_deep_mapped || 0,
      reviewed: ledger.features_reviewed || 0, no_issue: ledger.features_reviewed_no_issue || 0,
      with_candidates: ledger.features_candidates || 0, blocked: ledger.features_blocked || 0, deferred: ledger.features_deferred || 0,
    },
    patterns: {},
    findings: {
      candidates: _jsonlCount(path.join(INTEL(), `live-findings-${taskId}.jsonl`)),
      validated: _jsonlCount(path.join(INTEL(), `VALIDATED-FINDINGS-${taskId}.jsonl`)),
      judged: _jsonlCount(path.join(INTEL(), `JUDGED-FINDINGS-${taskId}.jsonl`)),
      // §6: terminal candidate accounting from the candidate-ledger + triage quarantine — proves N candidates =
      // N terminal verdicts and exposes the confirmation-status + quarantine breakdown the UI needs.
      ...(() => {
        const ledgerRows = _readJsonl(path.join(INTEL(), `candidate-ledger-${taskId}.jsonl`))
        const by = (k, v) => ledgerRows.filter((r) => String(r[k] || '').toUpperCase() === v).length
        return {
          auditor_verdicts: ledgerRows.filter((r) => r.terminal_status && r.terminal_status !== 'AUDIT_QUARANTINED').length,
          triaged: ledgerRows.filter((r) => r.triaged).length,
          source_confirmed: by('terminal_status', 'SOURCE_CONFIRMED'),
          needs_live: by('terminal_status', 'NEEDS_LIVE_VALIDATION'),
          runtime_confirmed: by('terminal_status', 'RUNTIME_CONFIRMED'),
          disproven: by('terminal_status', 'DISPROVEN'),
          audit_quarantined: by('terminal_status', 'AUDIT_QUARANTINED'),
          triage_quarantined: _jsonlCount(path.join(INTEL(), `triage-quarantine-${taskId}.jsonl`)),
          candidate_ledger_total: ledgerRows.length,
        }
      })(),
    },
  }
  return cov
}

module.exports = { tasksFromLedger, boardRows, deriveTaskBoard, deriveCoverage, MAP_STATUS, REV_STATUS }
