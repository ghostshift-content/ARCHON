
const __roots = require('../../paths') // portable roots (KURU_*_ROOT) — see paths.js
// /root/agents/tracer.js
//
// Langfuse-compatible trace emitter. Wraps LLM calls + agent spawns with structured
// timings + token/cost data, forwarded to either:
//   - self-hosted Langfuse (/root/langfuse/docker-compose.yml, LANGFUSE_PUBLIC_KEY env)
//   - /root/intel/trace-events.jsonl (fallback — always written)
//
// The JSONL fallback is the source of truth. Langfuse forwarding is best-effort —
// never blocks the LLM call. This way tracing never becomes a critical path dep.
//
// Usage:
//   const tracer = require('./tracer')
//   const span = tracer.span('grader.refineOne', { squad, taskId, expectation })
//   try { ... } finally { span.end({ cacheRead, cacheWrite, costUsd }) }
//
// Config: /root/intel/tracer-config.json — controls enabled, flush interval,
// http timeout, Langfuse URL. Rollback: set enabled=false.

const fs = require('fs')
const path = require('path')
const crypto = require('crypto')

const CONFIG_PATH = (__roots.INTEL_ROOT + '/tracer-config.json')
const LOCAL_JSONL = (__roots.INTEL_ROOT + '/trace-events.jsonl')

let _cfg = null
let _cfgMtime = 0
function loadConfig() {
  try {
    const st = fs.statSync(CONFIG_PATH)
    if (_cfg && st.mtimeMs === _cfgMtime) return _cfg
    _cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'))
    _cfgMtime = st.mtimeMs
    return _cfg
  } catch { return { enabled: false } }
}

function randId(prefix = 'span') {
  return `${prefix}_${Date.now().toString(36)}${crypto.randomBytes(4).toString('hex')}`
}

function appendLocal(event) {
  try { fs.appendFileSync(LOCAL_JSONL, JSON.stringify(event) + '\n') } catch {}
}

// Forward to Langfuse REST API. Spec: POST /api/public/ingestion
// Uses basic auth (public_key:secret_key). Fire-and-forget; failure is logged
// only to console (never blocks caller).
function forwardLangfuse(event, cfg) {
  if (!cfg.langfuse_url || !cfg.langfuse_public_key || !cfg.langfuse_secret_key) return
  const body = JSON.stringify({
    batch: [{
      id: event.id || randId('batch'),
      type: event.type === 'span' ? 'span-create' : 'event-create',
      timestamp: event.timestamp,
      body: event,
    }],
  })
  const auth = Buffer.from(`${cfg.langfuse_public_key}:${cfg.langfuse_secret_key}`).toString('base64')
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), cfg.http_timeout_ms || 2000)
  fetch(`${cfg.langfuse_url}/api/public/ingestion`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Basic ${auth}` },
    body, signal: controller.signal,
  }).catch(() => {}).finally(() => clearTimeout(timer))
}

function span(name, attrs = {}) {
  const cfg = loadConfig()
  const id = randId('span')
  const startTs = Date.now()
  const startIso = new Date(startTs).toISOString()

  const event = {
    id, type: 'span', name, timestamp: startIso,
    start_time: startIso,
    attributes: attrs,
  }

  return {
    id,
    end(endAttrs = {}) {
      if (!cfg.enabled) return
      const endTs = Date.now()
      const complete = {
        ...event,
        end_time: new Date(endTs).toISOString(),
        duration_ms: endTs - startTs,
        attributes: { ...attrs, ...endAttrs },
      }
      appendLocal(complete)
      if (cfg.forward_to_langfuse) {
        try { forwardLangfuse(complete, cfg) } catch {}
      }
    },
  }
}

// Singleton event — for fire-and-forget trace points that don't span time.
function event(name, attrs = {}) {
  const cfg = loadConfig()
  if (!cfg.enabled) return
  const e = { id: randId('event'), type: 'event', name, timestamp: new Date().toISOString(), attributes: attrs }
  appendLocal(e)
  if (cfg.forward_to_langfuse) { try { forwardLangfuse(e, cfg) } catch {} }
}

module.exports = { span, event, loadConfig, LOCAL_JSONL }
