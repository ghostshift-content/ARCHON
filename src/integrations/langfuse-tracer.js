
const __roots = require('../../paths') // portable roots (KURU_*_ROOT) — see paths.js
// /root/agents/langfuse-tracer.js
//
// Minimum-viable Langfuse integration (2026-04-20). If Langfuse is running
// locally and /root/intel/langfuse.local has credentials, every task spawn
// + agent subprocess emits a trace. If the file is absent, this module is a
// no-op — no crash, no latency, no Node deps required.
//
// Events emitted:
//   - trace.start  (task opens a trace; trace_id = taskId)
//   - span.start   (per agent subprocess spawn)
//   - span.end     (with cost, cache hit rate, tokens, duration)
//   - trace.end    (task completes with verdict)
//
// Langfuse public API: POST {host}/api/public/ingestion
//   Auth: Basic base64(publicKey:secretKey)
//   Body: { batch: [{id, type, timestamp, body}], metadata: {...} }
//
// All writes are fire-and-forget (http POST with 2s timeout). Never blocks
// the main event loop. Buffered in memory, flushed every 5s or 50 events.

const fs = require('fs')
const http = require('http')
const https = require('https')
const { URL } = require('url')
const crypto = require('crypto')

const CONFIG_PATH = (__roots.INTEL_ROOT + '/langfuse.local')
let _cfg = null
let _cfgMtime = 0
function loadConfig() {
  try {
    const st = fs.statSync(CONFIG_PATH)
    if (_cfg && st.mtimeMs === _cfgMtime) return _cfg
    const raw = fs.readFileSync(CONFIG_PATH, 'utf-8')
    const cfg = JSON.parse(raw)
    if (!cfg.host || !cfg.publicKey || !cfg.secretKey) return null
    _cfg = cfg
    _cfgMtime = st.mtimeMs
    return _cfg
  } catch { return null }
}

function isEnabled() { return !!loadConfig() }

const _buffer = []
let _flushTimer = null

function _enqueue(event) {
  const cfg = loadConfig()
  if (!cfg) return
  _buffer.push(event)
  if (_buffer.length >= 50) {
    _flush()
  } else if (!_flushTimer) {
    _flushTimer = setTimeout(_flush, 5000)
  }
}

function _flush() {
  if (_flushTimer) { clearTimeout(_flushTimer); _flushTimer = null }
  if (_buffer.length === 0) return
  const cfg = loadConfig()
  if (!cfg) { _buffer.length = 0; return }
  const batch = _buffer.splice(0, _buffer.length)
  const body = JSON.stringify({ batch, metadata: { source: 'archon' } })
  try {
    const u = new URL(cfg.host + '/api/public/ingestion')
    const lib = u.protocol === 'https:' ? https : http
    const req = lib.request({
      method: 'POST',
      hostname: u.hostname,
      port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname,
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        'Authorization': 'Basic ' + Buffer.from(`${cfg.publicKey}:${cfg.secretKey}`).toString('base64'),
      },
      timeout: 2000,
    }, (res) => { res.on('data', () => {}); res.on('end', () => {}) })
    req.on('error', () => {})
    req.on('timeout', () => { try { req.destroy() } catch {} })
    req.write(body)
    req.end()
  } catch { /* swallow — fire-and-forget */ }
}

function _id() { return crypto.randomBytes(12).toString('hex') }

function traceStart(taskId, name, metadata = {}) {
  _enqueue({
    id: _id(),
    type: 'trace-create',
    timestamp: new Date().toISOString(),
    body: { id: String(taskId), name, metadata },
  })
}

function traceEnd(taskId, output = '', metadata = {}) {
  _enqueue({
    id: _id(),
    type: 'trace-create', // update via same endpoint
    timestamp: new Date().toISOString(),
    body: { id: String(taskId), output: String(output).slice(0, 10_000), metadata },
  })
  _flush() // force immediate publish on task end
}

function spanStart(taskId, agent, metadata = {}) {
  const spanId = `${String(taskId)}-${agent}-${Date.now()}`
  _enqueue({
    id: _id(),
    type: 'span-create',
    timestamp: new Date().toISOString(),
    body: {
      id: spanId,
      traceId: String(taskId),
      name: agent,
      startTime: new Date().toISOString(),
      metadata,
    },
  })
  return spanId
}

function spanEnd(spanId, taskId, agent, costData, duration, metadata = {}) {
  if (!spanId) return
  _enqueue({
    id: _id(),
    type: 'span-update',
    timestamp: new Date().toISOString(),
    body: {
      id: spanId,
      traceId: String(taskId),
      endTime: new Date().toISOString(),
      metadata: {
        ...metadata,
        cost_usd: costData?.totalCost,
        tokens: costData?.tokens,
        cache_hit_rate: costData?.cacheHitRate,
        duration_ms: duration,
      },
    },
  })
}

// Graceful shutdown flush.
process.on('beforeExit', _flush)
process.on('SIGTERM', _flush)
process.on('SIGINT', _flush)

module.exports = { isEnabled, traceStart, traceEnd, spanStart, spanEnd, _flush }
