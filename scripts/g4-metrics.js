
const __roots = require('../paths') // portable roots (KURU_*_ROOT) — see paths.js
// scripts/g4-metrics.js
//
// Per-dispatch metrics collector for G4 multi-model test.
//
// Reads VALIDATED-FINDINGS-${taskId}.jsonl + tasks.json, emits one JSON
// metrics record summarizing findings, cost, duration, profile.
//
// Output: /root/intel/g4-experiment/${taskId}-metrics.json
//
// Usage:
//   node scripts/g4-metrics.js <taskId>
//   node scripts/g4-metrics.js <taskId> --validated <path> --tasks <path>
//
// Spec: docs/superpowers/specs/2026-05-06-G4-multi-model-test-design.md
// Plan: docs/superpowers/plans/2026-05-06-G4-multi-model-test-plan.md (Task 3)

const fs = require('node:fs')
const path = require('node:path')

function readJsonl(p) {
  if (!p || !fs.existsSync(p)) return []
  return fs.readFileSync(p, 'utf-8')
    .split('\n')
    .filter(Boolean)
    .map(line => { try { return JSON.parse(line) } catch { return null } })
    .filter(Boolean)
}

function readJson(p) {
  if (!p || !fs.existsSync(p)) return null
  try { return JSON.parse(fs.readFileSync(p, 'utf-8')) } catch { return null }
}

/**
 * Build the per-dispatch metrics record.
 *
 * @param {object} args
 * @param {string} args.taskId - the dispatched task id
 * @param {string} args.validatedFile - path to VALIDATED-FINDINGS-<taskId>.jsonl
 * @param {string} args.tasksFile - path to tasks.json
 * @returns {object} metrics record
 */
function collectMetrics({ taskId, validatedFile, tasksFile }) {
  if (!taskId) throw new Error('taskId required')

  const findings = readJsonl(validatedFile)
  const tasks = readJson(tasksFile) || []
  const task = tasks.find(t => String(t.id) === String(taskId))
  if (!task) {
    throw new Error(`task ${taskId} not found in ${tasksFile}`)
  }

  const sev = { critical: 0, high: 0, medium: 0, low: 0, info: 0 }
  for (const f of findings) {
    const s = String(f.severity || '').toLowerCase()
    if (sev[s] !== undefined) sev[s]++
  }

  return {
    task_id: String(taskId),
    target: task.title || task.goal || '(unknown)',
    model_profile: task.model_profile || 'default',
    krishna_model: task.krishna_model || '(unknown)',
    captured_at: new Date().toISOString(),
    metrics: {
      findings_total: findings.length,
      findings_by_severity: sev,
      cost_usd: typeof task.cost_usd === 'number' ? task.cost_usd : 0,
      duration_seconds: typeof task.duration_seconds === 'number' ? task.duration_seconds : 0,
    },
  }
}

function main() {
  const args = process.argv.slice(2)
  const taskId = args[0]
  if (!taskId || taskId.startsWith('--')) {
    console.error('Usage: node scripts/g4-metrics.js <taskId> [--validated <path>] [--tasks <path>]')
    process.exit(1)
  }
  const validatedIdx = args.indexOf('--validated')
  const tasksIdx = args.indexOf('--tasks')
  const validatedFile = validatedIdx > -1 ? args[validatedIdx + 1] : `${__roots.INTEL_ROOT}/pentest/VALIDATED-FINDINGS-${taskId}.jsonl`
  const tasksFile = tasksIdx > -1 ? args[tasksIdx + 1] : (__roots.INTEL_ROOT + '/tasks.json')

  const m = collectMetrics({ taskId, validatedFile, tasksFile })

  const outDir = (__roots.INTEL_ROOT + '/g4-experiment')
  fs.mkdirSync(outDir, { recursive: true })
  const outFile = path.join(outDir, `${taskId}-metrics.json`)
  fs.writeFileSync(outFile, JSON.stringify(m, null, 2))
  console.log(`metrics written: ${outFile}`)
  console.log(JSON.stringify(m, null, 2))
}

if (require.main === module) main()

module.exports = { collectMetrics }
