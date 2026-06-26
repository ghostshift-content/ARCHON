// agents/handoff-end-to-end-monitor.js
//
// Per-task telemetry over /root/intel/handoffs/{inbox,done,failed}. Counts
// each handoff that names this task as source_task_id, broken down by
// inbox/done/failed and by target_squad. SCRIBE injects these stats into
// the report so "cross-squad handoffs fired N times" is provable, not
// claimed.

'use strict'
const __roots = require('../paths') // portable roots (KURU_*_ROOT) — see paths.js


const fs = require('node:fs')
const path = require('node:path')

const BASE_DIR = (__roots.INTEL_ROOT + '/handoffs')

function statsForTask(taskId, { baseDir = BASE_DIR } = {}) {
  const result = { inbox: 0, done: 0, failed: 0, total: 0, target_squads: {} }
  for (const sub of ['inbox', 'done', 'failed']) {
    const dir = path.join(baseDir, sub)
    if (!fs.existsSync(dir)) continue
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.json')) continue
      let rec
      try { rec = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf-8')) }
      catch { continue }
      if (String(rec.source_task_id) !== String(taskId)) continue
      result[sub] += 1
      result.total += 1
      const ts = rec.target_squad || 'unknown'
      result.target_squads[ts] = (result.target_squads[ts] || 0) + 1
    }
  }
  return result
}

module.exports = { statsForTask }
