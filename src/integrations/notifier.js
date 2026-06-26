
const __roots = require('../../paths') // portable roots (KURU_*_ROOT) — see paths.js
// /root/agents/notifier.js
//
// Telegram alert emitter — drops structured messages into the outbox that
// telegram-relay PM2 service consumes. Config-driven; handles dedup so a task
// failure doesn't spam the user with 5 retries.
//
// Usage:
//   notifier.notify('task_failed', { taskId, squad, title, reason, cost })
//
// Config: /root/intel/notify-config.json — alert_on.* flags, thresholds,
// one-per-task rate limit. Rollback: set enabled=false.

const fs = require('fs')
const path = require('path')

const CONFIG_PATH = (__roots.INTEL_ROOT + '/notify-config.json')
const OUTBOX_DIR = (__roots.INTEL_ROOT + '/telegram-outbox')
const SEEN_DIR = (__roots.INTEL_ROOT + '/notify-seen') // per-task dedup markers

let _cfg = null
let _mtime = 0
function loadConfig() {
  try {
    const st = fs.statSync(CONFIG_PATH)
    if (_cfg && st.mtimeMs === _mtime) return _cfg
    _cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'))
    _mtime = st.mtimeMs
    return _cfg
  } catch { return { enabled: false } }
}

function hasSeen(taskId, eventKey) {
  if (!taskId) return false
  try {
    const marker = path.join(SEEN_DIR, `${String(taskId).replace(/[^\w.-]/g, '_')}.${eventKey}`)
    return fs.existsSync(marker)
  } catch { return false }
}

function markSeen(taskId, eventKey) {
  if (!taskId) return
  try {
    fs.mkdirSync(SEEN_DIR, { recursive: true })
    const marker = path.join(SEEN_DIR, `${String(taskId).replace(/[^\w.-]/g, '_')}.${eventKey}`)
    fs.writeFileSync(marker, String(Date.now()))
  } catch {}
}

// Queue a Telegram message via the outbox. telegram-relay (PM2) polls + sends.
function enqueue(chatId, text) {
  try {
    fs.mkdirSync(OUTBOX_DIR, { recursive: true })
    const fname = `notify-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`
    const tmp = path.join(OUTBOX_DIR, fname + '.tmp')
    const final = path.join(OUTBOX_DIR, fname)
    fs.writeFileSync(tmp, JSON.stringify({ chat_id: chatId, text }))
    fs.renameSync(tmp, final)
    return final
  } catch (e) {
    console.error('[notifier] enqueue failed:', e.message)
    return null
  }
}

// Core entry — event: 'task_failed' | 'task_cancelled' | 'low_grade' | 'budget_exceeded' | 'zero_findings'
function notify(event, payload = {}) {
  const cfg = loadConfig()
  if (!cfg.enabled) return { sent: false, reason: 'disabled' }
  if (!cfg.alert_on?.[event]) return { sent: false, reason: 'event-disabled' }
  if (!cfg.chat_id) return { sent: false, reason: 'no-chat-id' }

  const taskId = payload.taskId
  if (cfg.rate_limit?.one_per_task && hasSeen(taskId, event)) {
    return { sent: false, reason: 'already-notified' }
  }

  const text = formatMessage(event, payload, cfg)
  if (!text) return { sent: false, reason: 'no-message' }

  const queued = enqueue(cfg.chat_id, text)
  if (queued && taskId) markSeen(taskId, event)
  return { sent: !!queued, file: queued }
}

function formatMessage(event, p, cfg) {
  const squad = p.squad || 'unknown'
  const title = p.title || '(no title)'
  const short = s => String(s || '').slice(0, 160)
  const link = p.taskId ? `agent.n8nn8n.com/tasks/${p.taskId}/report` : ''

  switch (event) {
    case 'task_failed':
      return `🔴 Task FAILED — ${squad}\n${title}\nReason: ${short(p.reason)}\n${p.cost ? `Cost: $${Number(p.cost).toFixed(2)}\n` : ''}${link}`
    case 'task_cancelled':
      return `⚫ Task cancelled — ${squad}\n${title}\nReason: ${short(p.reason)}\n${link}`
    case 'low_grade': {
      const thr = cfg.alert_on?.low_grade_threshold ?? 50
      return `🟡 Low grade (${p.grade}% < ${thr}%) — ${squad}\n${title}\n${p.cost ? `Cost: $${Number(p.cost).toFixed(2)}\n` : ''}${link}`
    }
    case 'budget_exceeded':
      return `⚠️ Budget exceeded — ${squad}\n${title}\nSpent: $${Number(p.spent).toFixed(2)} (cap $${Number(p.cap).toFixed(2)})\n${link}`
    case 'zero_findings':
      return `⚪ Zero findings — ${squad}\n${title}\nNothing surfaced. Possibly: unreachable target, WAF blocking all probes, or agent misconfiguration.\n${link}`
    default:
      return null
  }
}

module.exports = { notify, loadConfig, formatMessage }
