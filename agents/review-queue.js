#!/usr/bin/env node
// review-queue.js — reader/resolver for the manual-review queue.
//
// GATE-124 wired the WRITER (Phase 3.075 escalates high-conviction/low-evidence findings
// to /root/intel/manual-review-queue.jsonl instead of silently archiving). But a write-only
// queue nobody reads just relocates the silent drop. This is the consumer: list pending
// escalations and resolve them (promote / dismiss) so the human-tap counterweight is real.
//
// Usage:
//   node agents/review-queue.js list [--all]        — pending (or all) escalated findings
//   node agents/review-queue.js count                — pending count (for dashboards/alerts)
//   node agents/review-queue.js resolve <findingId> <promote|dismiss> [note]
//
// resolve appends a resolution record (append-only audit trail) and is reflected by `list`.

'use strict'
const __roots = require('../paths') // portable roots (KURU_*_ROOT) — see paths.js

const fs = require('fs')
const path = require('path')

const QUEUE = process.env.REVIEW_QUEUE || (__roots.INTEL_ROOT + '/manual-review-queue.jsonl')

function _read(file) {
  if (!fs.existsSync(file)) return []
  return fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean)
    .map(l => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)
}

// Latest record per findingId wins (resolutions are appended after the escalation).
function _state(file = QUEUE) {
  const byId = new Map()
  for (const rec of _read(file)) {
    const id = rec.findingId || rec.id || rec.findingTitle || JSON.stringify(rec).slice(0, 40)
    byId.set(id, { ...(byId.get(id) || {}), ...rec, findingId: id })
  }
  return [...byId.values()]
}

function listPending({ all = false, file = QUEUE } = {}) {
  return _state(file).filter(r => all || (r.status || 'pending') === 'pending')
}

function resolve(findingId, decision, note = '', { file = QUEUE } = {}) {
  if (!findingId) throw new Error('resolve: findingId required')
  if (!['promote', 'dismiss'].includes(decision)) throw new Error("resolve: decision must be 'promote' or 'dismiss'")
  const rec = {
    ts: new Date().toISOString(),
    findingId,
    status: decision === 'promote' ? 'promoted' : 'dismissed',
    decision, note: note || null, resolvedBy: 'human-cli',
  }
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.appendFileSync(file, JSON.stringify(rec) + '\n', 'utf8')
  return rec
}

module.exports = { listPending, resolve, _state }

if (require.main === module) {
  const [cmd, ...rest] = process.argv.slice(2)
  if (cmd === 'count') {
    process.stdout.write(String(listPending().length) + '\n')
  } else if (cmd === 'list') {
    const all = rest.includes('--all')
    const rows = listPending({ all })
    if (!rows.length) { process.stdout.write(all ? 'queue empty\n' : 'no pending escalations ✓\n'); process.exit(0) }
    process.stdout.write(`\nMANUAL-REVIEW QUEUE — ${rows.length} ${all ? 'total' : 'pending'}\n`)
    for (const r of rows) {
      process.stdout.write(`  [${(r.status || 'pending').toUpperCase()}] ${r.findingId}\n`)
      process.stdout.write(`      ${r.findingTitle || '(no title)'} | squad=${r.squad || '?'} | task=${r.taskId || '?'}\n`)
      if (r.reason) process.stdout.write(`      reason: ${String(r.reason).slice(0, 160)}\n`)
    }
    process.stdout.write(`\nResolve: node agents/review-queue.js resolve <findingId> <promote|dismiss> [note]\n`)
  } else if (cmd === 'resolve') {
    const [findingId, decision, ...noteParts] = rest
    try {
      const rec = resolve(findingId, decision, noteParts.join(' '))
      process.stdout.write(`✓ ${findingId} → ${rec.status}\n`)
    } catch (e) { process.stderr.write(`✗ ${e.message}\n`); process.exit(1) }
  } else {
    process.stdout.write('usage: review-queue.js list [--all] | count | resolve <findingId> <promote|dismiss> [note]\n')
    process.exit(cmd ? 1 : 0)
  }
}
