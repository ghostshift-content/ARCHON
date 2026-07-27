'use strict'

const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const agentPaths = require('../../paths')
const { withFileLock } = require('./file-lock')

const KINDS = new Set(['source_snippet', 'http_request', 'http_response', 'screenshot', 'tool_output', 'log', 'diff'])

function root(taskId, dir) {
  return path.join(dir || agentPaths.INTEL_ROOT, 'runtime-evidence', String(taskId))
}
function indexPath(taskId, dir) { return path.join(root(taskId, dir), 'index.jsonl') }
function load(taskId, dir) {
  try {
    return fs.readFileSync(indexPath(taskId, dir), 'utf8').split('\n').filter(Boolean)
      .map(line => { try { return JSON.parse(line) } catch { return null } }).filter(Boolean)
  } catch { return [] }
}
function _safeContent(value, cap) {
  const text = typeof value === 'string' ? value : JSON.stringify(value == null ? '' : value)
  return text.slice(0, Math.max(256, Number(cap) || 4096))
}
function capture(taskId, items, opts = {}) {
  const lock = `${indexPath(taskId, opts.dir)}.lock`
  return withFileLock(lock, () => {
    const existing = new Map(load(taskId, opts.dir).map(row => [row.evidence_id, row]))
    const labels = new Map()
    const stored = []
    fs.mkdirSync(root(taskId, opts.dir), { recursive: true })
    for (const item of items || []) {
      if (!item || !KINDS.has(item.kind) || !item.source) continue
      const content = _safeContent(item.content, opts.maxBytes)
      const digest = crypto.createHash('sha256')
        .update(JSON.stringify({ kind: item.kind, source: item.source, content }))
        .digest('hex')
      const evidenceId = `EVID-${digest.slice(0, 20)}`
      labels.set(String(item.label || evidenceId), evidenceId)
      if (existing.has(evidenceId)) {
        stored.push(existing.get(evidenceId))
        continue
      }
      const record = {
        evidence_id: evidenceId,
        task_id: String(taskId),
        kind: item.kind,
        source: String(item.source),
        sha256: digest,
        bytes: Buffer.byteLength(content),
        captured_at: new Date().toISOString(),
      }
      const destination = path.join(root(taskId, opts.dir), `${evidenceId}.json`)
      const temp = `${destination}.${process.pid}.${Date.now()}.tmp`
      fs.writeFileSync(temp, JSON.stringify({ ...record, content }, null, 2), { mode: 0o600 })
      fs.renameSync(temp, destination)
      fs.appendFileSync(indexPath(taskId, opts.dir), JSON.stringify(record) + '\n', { mode: 0o600 })
      existing.set(evidenceId, record)
      stored.push(record)
    }
    return { labels, stored }
  })
}
function resolveRefs(refs, labels, taskId, dir) {
  const known = new Set(load(taskId, dir).map(row => row.evidence_id))
  return [...new Set((refs || []).map(ref => labels.get(String(ref)) || String(ref)).filter(ref => known.has(ref)))]
}
function materialize(taskId, refs, dir) {
  const wanted = new Set(refs || [])
  const rows = []
  for (const id of wanted) {
    if (!/^EVID-[a-f0-9]+$/i.test(String(id))) continue
    try {
      const value = JSON.parse(fs.readFileSync(path.join(root(taskId, dir), `${id}.json`), 'utf8'))
      if (value && value.evidence_id === id) rows.push(value)
    } catch {}
  }
  return rows
}

module.exports = { KINDS, root, indexPath, load, capture, resolveRefs, materialize }
