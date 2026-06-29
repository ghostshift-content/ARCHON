// agents/active-poc-runner.js
//
// Active-PoC runner: orchestrates squad-agnostic probes against CONFIRMED
// findings under a permission grant. Gates: env flag, permission validity,
// per-target scope, per-finding cap, per-task cap. Writes a JSONL audit
// log per task (one line per probe attempt) so all probing is replayable
// and reviewable post-hoc.
//
// Defender abort: any probe returning `aborted_on_defender: true` ends
// further probing on that finding (proxy for 429/CAPTCHA/CF block).

'use strict'
const __roots = require('../paths') // portable roots (KURU_*_ROOT) — see paths.js


const fs = require('node:fs')
const path = require('node:path')
const policy = require('./active-poc-policy')

const DEFAULT_AUDIT_DIR = (__roots.INTEL_ROOT + '/active-poc-audit')

function _hostnameOf(urlOrHost) {
  if (!urlOrHost) return ''
  try { return new URL(urlOrHost).hostname } catch {}
  return urlOrHost
}

function _loadDefaultProbeRegistry() {
  const libBase = path.join(__dirname, 'active-poc-library')
  const registry = {}
  if (!fs.existsSync(libBase)) return registry
  for (const squad of fs.readdirSync(libBase)) {
    const squadDir = path.join(libBase, squad)
    if (!fs.statSync(squadDir).isDirectory()) continue
    for (const f of fs.readdirSync(squadDir)) {
      if (!f.endsWith('.js')) continue
      try {
        const mod = require(path.join(squadDir, f))
        if (mod && mod.targets_capability && typeof mod.run === 'function') {
          registry[mod.targets_capability] = mod
        }
      } catch { /* skip broken probe */ }
    }
  }
  return registry
}

async function runActivePocsForTask({
  taskId, permission, findings,
  probeRegistry = null, auditDir = DEFAULT_AUDIT_DIR,
}) {
  if (!policy.envIsEnabled()) {
    return { skipped: true, skip_reason: 'env ARCHON_ACTIVE_POC not enabled',
      probes_run: 0, skipped_reasons: [], audit_path: null }
  }
  if (!permission) {
    return { skipped: true, skip_reason: 'no permission', probes_run: 0,
      skipped_reasons: [], audit_path: null }
  }
  probeRegistry = probeRegistry || _loadDefaultProbeRegistry()
  fs.mkdirSync(auditDir, { recursive: true })
  const auditPath = path.join(auditDir, `${taskId}.jsonl`)

  const capState = policy.newCapState(permission)
  const allowedCaps = new Set(permission.capabilities)
  const probes_run = []
  const skipped_reasons = []

  for (const f of findings) {
    if (f.validation_status !== 'CONFIRMED') continue
    for (const [cap, probe] of Object.entries(probeRegistry)) {
      if (!allowedCaps.has(cap)) continue
      const host = _hostnameOf(f.url || f.affected_url || '')
      if (!host || !policy.targetInScope(host, permission)) {
        skipped_reasons.push({ finding_id: f.id, probe: cap,
          reason: `target out-of-scope (${host})` })
        continue
      }
      if (!policy.canProbe(capState, f.id)) {
        skipped_reasons.push({ finding_id: f.id, probe: cap, reason: 'cap-reached' })
        continue
      }
      const startedAt = new Date().toISOString()
      let result
      try { result = await probe.run(f, {}) }
      catch (e) { result = { error: e.message || String(e) } }
      policy.recordProbe(capState, f.id)
      const auditEntry = {
        ts: startedAt, task_id: taskId, finding_id: f.id,
        probe: cap, squad: probe.squad, result,
      }
      fs.appendFileSync(auditPath, JSON.stringify(auditEntry) + '\n')
      probes_run.push(auditEntry)
      if (result && result.aborted_on_defender) break
    }
  }
  return {
    skipped: false,
    probes_run: probes_run.length,
    skipped_reasons,
    audit_path: auditPath,
    defender_aborts: probes_run.filter(p => p.result && p.result.aborted_on_defender).length,
  }
}

module.exports = { runActivePocsForTask, _loadDefaultProbeRegistry }
