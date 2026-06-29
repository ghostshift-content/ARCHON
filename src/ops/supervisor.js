'use strict'
// Operational Supervisor — one deterministic health pass over the daemon's OWN state.
//
// The daemon already has ~11 scattered self-monitors (processQueue, stuck-task watchdog, cancel,
// heartbeat, orphan-reaper…). This does NOT duplicate their fixes — it AGGREGATES every invariant
// into one snapshot (the missing health view), auto-heals only the GAP the others miss (a cancelled
// task whose agents are still alive → re-issue cancel), reports everything to var/intel/health.json,
// and escalates an unknown/recurring anomaly to a one-shot Opus SENTINEL diagnostic (rate-limited).
//
// Pure-ish: all daemon coupling is injected via ctx, so runHealthPass is unit-testable on temp files.

const fs = require('node:fs')
const path = require('node:path')

const STREAM_LIVE_MS = 120000   // an agent stream touched <120s ago = the agent is alive
const HEARTBEAT_STALE_MS = 150000 // in-progress task heartbeat older than this = suspect
const STUCK_PROCESSING_MS = 15 * 60 * 1000

function _readJSON(p, fb) { try { return JSON.parse(fs.readFileSync(p, 'utf8')) } catch { return fb } }

// taskId -> count of live agent streams (the daemon writes streams/<agent>-<taskId>.stream)
function _liveAgentTasks(intel, now) {
  const out = {}
  try {
    for (const f of fs.readdirSync(path.join(intel, 'streams'))) {
      const m = f.match(/-(t-\d+-[a-f0-9]+)\.stream$/)
      if (!m) continue
      let st; try { st = fs.statSync(path.join(intel, 'streams', f)) } catch { continue }
      if (now - st.mtimeMs < STREAM_LIVE_MS) out[m[1]] = (out[m[1]] || 0) + 1
    }
  } catch {}
  return out
}

// count orphaned scan tools (ppid==1) — same signal the reaper uses; for the snapshot only
function _orphanToolCount(execSyncFn) {
  try {
    const out = execSyncFn('ps -eo ppid=,args= 2>/dev/null', { timeout: 5000, maxBuffer: 4 * 1024 * 1024 }).toString()
    let n = 0
    for (const line of out.split('\n')) {
      const m = line.trim().match(/^(\d+)\s+(.*)$/)
      if (m && m[1] === '1' && /\b(nmap|ffuf|katana|nuclei|gobuster|sqlmap|wfuzz|nikto|gospider|feroxbuster)\b/i.test(m[2])) n++
    }
    return n
  } catch { return 0 }
}

// ctx: { intel, now?, execSync, writeCancelSignal(taskId), spawnDiagnostic(snapshot)?, escalateState }
// escalateState: persistent {} the caller keeps between passes (anomaly-signature → lastEscalatedMs)
function runHealthPass(ctx = {}) {
  const intel = ctx.intel
  const now = ctx.now || Date.now()
  const execSyncFn = ctx.execSync || require('node:child_process').execSync
  const tasks = _readJSON(path.join(intel, 'tasks.json'), []) || []
  const queue = _readJSON(path.join(intel, 'dispatch-queue.json'), []) || []
  const heartbeats = _readJSON(path.join(intel, 'task-heartbeats.json'), {}) || {}
  const live = _liveAgentTasks(intel, now)

  const checks = []
  const fixes = []
  const anomalies = []
  const add = (name, ok, detail, autoFixed = false) => checks.push({ name, ok, detail, autoFixed })

  // 1. CANCEL INTEGRITY (the gap we auto-heal): a cancelled task must have NO live agents.
  const cancelledIds = tasks.filter(t => t.status === 'cancelled').map(t => String(t.id))
  const zombies = cancelledIds.filter(id => (live[id] || 0) > 0)
  if (zombies.length && typeof ctx.writeCancelSignal === 'function') {
    for (const id of zombies) { try { ctx.writeCancelSignal(id); fixes.push(`re-cancel zombie ${id} (${live[id]} live agent)`) } catch {} }
  }
  add('cancel_integrity', zombies.length === 0, zombies.length ? `${zombies.length} cancelled task(s) still had live agents — re-cancelled` : 'no zombie cancelled tasks', zombies.length > 0)

  // 2. QUEUE INTEGRITY: dispatch entries stuck 'processing' with no live agent (existing recovery owns the FIX).
  const stuckProcessing = queue.filter(d => {
    if (d.status !== 'processing') return false
    const procMs = d.processedAt ? Date.parse(d.processedAt) : 0
    return procMs && (now - procMs) > STUCK_PROCESSING_MS && !(live[String(d.taskId)] > 0)
  })
  add('queue_integrity', stuckProcessing.length === 0, stuckProcessing.length ? `${stuckProcessing.length} stuck 'processing' entr(ies) >15min — processQueue recovery should reclaim` : 'no stuck queue entries')

  // 3. DISPATCH INTEGRITY: every active dispatch has a task (processQueue backfills it).
  const taskIds = new Set(tasks.map(t => String(t.id)))
  const orphanDispatch = queue.filter(d => (d.status === 'pending' || d.status === 'processing') && !taskIds.has(String(d.taskId)))
  add('dispatch_integrity', orphanDispatch.length === 0, orphanDispatch.length ? `${orphanDispatch.length} dispatch(es) without a task — backfill pending` : 'every dispatch has a task')

  // 4. HEARTBEAT INTEGRITY: in-progress task, stale heartbeat AND no live agent = suspect-dead (report; stuck-watchdog fails it).
  const inProgress = tasks.filter(t => t.status === 'in-progress')
  const deadish = inProgress.filter(t => {
    const hb = heartbeats[String(t.id)] ? Date.parse(heartbeats[String(t.id)]) : Date.parse(t.startedAt || t.createdAt || '') || 0
    return (now - hb) > HEARTBEAT_STALE_MS && !(live[String(t.id)] > 0)
  })
  add('heartbeat_integrity', deadish.length === 0, deadish.length ? `${deadish.length} in-progress task(s) look dead (stale heartbeat + no live agent)` : `${inProgress.length} in-progress, all alive`)

  // 5. ORPHAN TOOLS (reaper owns the FIX; surface the count).
  const orphans = _orphanToolCount(execSyncFn)
  add('orphan_tools', orphans === 0, orphans ? `${orphans} orphaned scan tool(s) — reaper will kill` : 'no orphaned tools')

  // anomalies = any check that's NOT ok and was NOT auto-fixed this pass (the others' fixes may lag)
  for (const c of checks) if (!c.ok && !c.autoFixed) anomalies.push(c)

  const snapshot = {
    ok: checks.every(c => c.ok),
    at: new Date(now).toISOString(),
    checks,
    queue: { pending: queue.filter(d => d.status === 'pending').length, processing: queue.filter(d => d.status === 'processing').length, stuckProcessing: stuckProcessing.length },
    tasks: { inProgress: inProgress.length, liveAgents: Object.keys(live).length, zombie: zombies.length, deadish: deadish.length },
    orphansReaped: orphans, // count seen this pass (reaper kills async)
    daemonUptimeS: ctx.daemonStartMs ? Math.round((now - ctx.daemonStartMs) / 1000) : null,
    recentFixes: fixes,
    anomalies: anomalies.map(a => ({ name: a.name, detail: a.detail })),
  }

  // 6. ESCALATE to Opus SENTINEL — ONLY if an anomaly PERSISTS past escalateAfterMs (i.e. the other
  // watchdogs failed to self-heal it; transient/known-recoverable states never trigger a diagnosis).
  // Then rate-limited to ≤1 per signature per 15min so it never loops/burns tokens.
  if (typeof ctx.spawnDiagnostic === 'function') {
    const st = ctx.escalateState || {}
    st._seen = st._seen || {}; st._esc = st._esc || {}
    const escalateAfterMs = ctx.escalateAfterMs != null ? ctx.escalateAfterMs : 5 * 60 * 1000
    const sig = anomalies.length ? anomalies.map(a => a.name).sort().join(',') : ''
    // forget signatures that resolved (no longer present)
    for (const k of Object.keys(st._seen)) if (k !== sig) delete st._seen[k]
    if (sig) {
      if (!st._seen[sig]) st._seen[sig] = now
      const persistedMs = now - st._seen[sig]
      if (persistedMs >= escalateAfterMs && (!st._esc[sig] || (now - st._esc[sig]) > 15 * 60 * 1000)) {
        st._esc[sig] = now
        try { ctx.spawnDiagnostic(snapshot) } catch {}
      }
    }
  }

  try { fs.writeFileSync(path.join(intel, 'health.json'), JSON.stringify(snapshot, null, 2)) } catch {}
  return snapshot
}

module.exports = { runHealthPass }

// self-check: synthetic state → asserts detection + the zombie auto-fix + snapshot shape
if (require.main === module) {
  const assert = require('node:assert')
  const os = require('node:os')
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sup-'))
  fs.mkdirSync(path.join(tmp, 'streams'))
  const now = Date.now()
  // a cancelled task WITH a fresh agent stream = zombie
  fs.writeFileSync(path.join(tmp, 'tasks.json'), JSON.stringify([
    { id: 't-1-aa', status: 'cancelled' },
    { id: 't-2-bb', status: 'in-progress', startedAt: new Date(now).toISOString() },
  ]))
  fs.writeFileSync(path.join(tmp, 'dispatch-queue.json'), JSON.stringify([
    // stuck 'processing' for an in-progress task with NO live agent stream
    { id: 'd1', taskId: 't-2-bb', status: 'processing', processedAt: new Date(now - 20 * 60000).toISOString() },
  ]))
  fs.writeFileSync(path.join(tmp, 'task-heartbeats.json'), JSON.stringify({ 't-2-bb': new Date(now).toISOString() }))
  fs.writeFileSync(path.join(tmp, 'streams', `scout-t-1-aa.stream`), 'x') // fresh = zombie agent
  const cancelled = []
  const snap = runHealthPass({ intel: tmp, now, execSync: () => '', writeCancelSignal: id => cancelled.push(id) })
  assert.deepStrictEqual(cancelled, ['t-1-aa'], `zombie should be re-cancelled, got ${cancelled}`)
  assert.strictEqual(snap.checks.find(c => c.name === 'cancel_integrity').autoFixed, true)
  assert.strictEqual(snap.checks.find(c => c.name === 'queue_integrity').ok, false, 'stuck processing should be flagged')
  assert.ok(fs.existsSync(path.join(tmp, 'health.json')), 'health.json written')
  assert.strictEqual(snap.tasks.zombie, 1)
  console.log('ok — supervisor detects zombie/stuck, auto-cancels zombie, writes health.json')
}
