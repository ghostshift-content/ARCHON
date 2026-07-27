'use strict'

const fs = require('fs')
const path = require('path')
const agentPaths = require('../../paths')
const team = require('./agent-team')
const { withFileLock } = require('./file-lock')

function _file(taskId, kind, dir, ext = 'jsonl') {
  return path.join(dir || agentPaths.INTEL_ROOT, `runtime-${kind}-${taskId}.${ext}`)
}
function _readJsonl(file) {
  try {
    return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean)
      .map(line => { try { return JSON.parse(line) } catch { return null } }).filter(Boolean)
  } catch { return [] }
}
function _append(file, rows) {
  if (!rows.length) return
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.appendFileSync(file, rows.map(row => JSON.stringify(row)).join('\n') + '\n')
}
function appendCandidates(taskId, candidates, mode, dir) {
  const file = _file(taskId, 'candidates', dir)
  return withFileLock(`${file}.lock`, () => {
    const prior = team.dedupeCandidates(_readJsonl(file), mode)
    // Candidate IDs are runtime-owned. Model-provided IDs are only local to one
    // response and may collide with another parallel session.
    const incoming = (candidates || []).map(({ id, ...row }) => row)
    const merged = team.dedupeCandidates([...prior, ...incoming], mode)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const temp = `${file}.${process.pid}.${Date.now()}.tmp`
    fs.writeFileSync(temp, merged.map(row => JSON.stringify(row)).join('\n') + (merged.length ? '\n' : ''))
    fs.renameSync(temp, file)
    return merged
  })
}
function candidates(taskId, dir) { return _readJsonl(_file(taskId, 'candidates', dir)) }
function updateCandidates(taskId, updates, mode, dir) {
  const file = _file(taskId, 'candidates', dir)
  return withFileLock(`${file}.lock`, () => {
    const current = _readJsonl(file)
    const byId = new Map(current.map(row => [row.id, row]))
    for (const update of updates || []) {
      if (!update || !update.id || !byId.has(update.id)) continue
      byId.set(update.id, { ...byId.get(update.id), ...update, id: update.id })
    }
    const merged = team.dedupeCandidates([...byId.values()], mode)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const temp = `${file}.${process.pid}.${Date.now()}.tmp`
    fs.writeFileSync(temp, merged.map(row => JSON.stringify(row)).join('\n') + (merged.length ? '\n' : ''))
    fs.renameSync(temp, file)
    return merged
  })
}
function appendVotes(taskId, votes, dir) {
  const file = _file(taskId, 'votes', dir)
  return withFileLock(`${file}.lock`, () => {
    _append(file, votes || [])
    return _readJsonl(file)
  })
}
function allVotes(taskId, dir) { return _readJsonl(_file(taskId, 'votes', dir)) }
function writeDecisions(taskId, value, dir) {
  const file = _file(taskId, 'verifier-decisions', dir, 'json')
  return withFileLock(`${file}.lock`, () => {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const temp = `${file}.${process.pid}.${Date.now()}.tmp`
    fs.writeFileSync(temp, JSON.stringify(value, null, 2))
    fs.renameSync(temp, file)
    return file
  })
}
function decisions(taskId, dir) {
  try { return JSON.parse(fs.readFileSync(_file(taskId, 'verifier-decisions', dir, 'json'), 'utf8')) } catch { return null }
}
function writePhaseResult(taskId, phase, value, dir) {
  const file = _file(taskId, `phase-${phase}`, dir, 'json')
  return withFileLock(`${file}.lock`, () => {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    let prior = null
    try { prior = JSON.parse(fs.readFileSync(file, 'utf8')) } catch {}
    const rows = prior == null ? [] : (Array.isArray(prior) ? prior : [prior])
    const temp = `${file}.${process.pid}.${Date.now()}.tmp`
    fs.writeFileSync(temp, JSON.stringify([...rows, value], null, 2))
    fs.renameSync(temp, file)
    return file
  })
}
function readPhaseResult(taskId, phase, dir) {
  try { return JSON.parse(fs.readFileSync(_file(taskId, `phase-${phase}`, dir, 'json'), 'utf8')) } catch { return null }
}

module.exports = {
  file: _file,
  appendCandidates,
  updateCandidates,
  candidates,
  appendVotes,
  allVotes,
  writeDecisions,
  decisions,
  writePhaseResult,
  readPhaseResult,
}
