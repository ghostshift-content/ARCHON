#!/usr/bin/env node

const __roots = require('../paths') // portable roots (KURU_*_ROOT) — see paths.js
// Empirical verification: replay Phase 3.5 filter on historical HR task to confirm
// fixed filter + merge would fire the constructor pipeline.
// Exits 0 if Phase 3.5 would fire (>100 chars of confirmed entries), 1 otherwise.

const fs = require('fs')
const path = require('path')

const TASK_ID = process.argv[2] || '1776660416495'
const TASK_LOG = `${__roots.INTEL_ROOT}/task-logs/${TASK_ID}.jsonl`
const GLOBAL_LOG = (__roots.INTEL_ROOT + '/ACTIVITY-LOG.jsonl')
const PHASE35_CUTOFF = process.argv[3] || '2026-04-20T05:40:06.443Z'

// Simulate readTaskActivity with merge
const byKey = new Map()
const add = (e) => {
  if (!e) return
  const k = `${e.ts||''}|${e.agent||''}|${String(e.action||'').slice(0,100)}`
  if (!byKey.has(k)) byKey.set(k, e)
}

if (fs.existsSync(TASK_LOG)) {
  for (const line of fs.readFileSync(TASK_LOG, 'utf-8').split('\n')) {
    if (line) try { add(JSON.parse(line)) } catch {}
  }
}
if (fs.existsSync(GLOBAL_LOG)) {
  for (const line of fs.readFileSync(GLOBAL_LOG, 'utf-8').split('\n')) {
    if (!line || !line.includes(TASK_ID)) continue
    try {
      const e = JSON.parse(line)
      if (String(e.taskId||'') === TASK_ID) add(e)
    } catch {}
  }
}
const merged = Array.from(byKey.values()).sort((a,b) => String(a.ts||'').localeCompare(String(b.ts||'')))

// New filter: check action AND details (the Phase 3.5 fix)
// +5s delay after Phase 3 would shift cutoff by 5s, capturing post-KRIPA flushes
const cutoffWithDelay = new Date(new Date(PHASE35_CUTOFF).getTime() + 5000).toISOString()
const prePhase = merged.filter(e => e.ts <= cutoffWithDelay)
const confirmed = prePhase.filter(e => {
  const a = String(e.action||'').toUpperCase()
  const d = String(e.details||'').toUpperCase()
  return a.includes('CONFIRMED') || a.includes('SUSPECTED') || d.includes('CONFIRMED') || d.includes('SUSPECTED')
})
const text = confirmed.map(e => `[${e.agent}] ${(e.action||'').slice(0,150)} | ${(e.details||'').slice(0,300)}`).join('\n')

console.log(`Task: ${TASK_ID}`)
console.log(`Phase 3.5 cutoff (with +5s delay): ${cutoffWithDelay}`)
console.log(`Merged entries: ${merged.length}`)
console.log(`Pre-Phase3.5 entries: ${prePhase.length}`)
console.log(`Confirmed matches: ${confirmed.length}`)
console.log(`Filter text length: ${text.length} chars (threshold >100)`)
console.log(`Would fire Phase 3.5: ${text.length > 100 ? 'YES ✅' : 'NO ❌'}`)
process.exit(text.length > 100 ? 0 : 1)
