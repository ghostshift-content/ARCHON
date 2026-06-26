// agents/poc-evidence-capture.js
//
// 2026-05-12: Captures the ACTUAL response body for every CONFIRMED finding
// that carries a testable URL. Closes the "evidence is freeform LLM text, not
// concrete data" gap surfaced during the 2026-05-11 bounty-PoC session: when
// Bugcrowd triage asked for impact, the framework's stored evidence was a
// summary string — we had to manually re-`curl` the endpoints to capture
// actual JSON bodies. This module makes capture deterministic and
// framework-wide.
//
// Universal by design (works across every squad):
//   - pentest: HTTP/HTTPS URLs on web apps
//   - cloud-security: S3 / Azure Blob / GCS object URLs
//   - network-pentest: HTTP services on internal IPs (when reachable)
//   - code-review: deployed-app URLs
//   - stocks: API quote endpoints (rare but works)
//
// Stored under /root/intel/poc-evidence/{taskId}/{findingId}.json with
// {status, headers, body, timing_ms, redirect_chain, captured_at, error?}.
// VYASA's report builder reads these alongside ACTIVITY-LOG so reports cite
// concrete payloads instead of LLM paraphrases.
//
// Anti-sycophancy: captures and stores even when body looks empty / hostile
// (no LLM filter). The raw artifact is the truth; downstream reasoning is
// separate.

'use strict'
const __roots = require('../paths') // portable roots (KURU_*_ROOT) — see paths.js


const fs = require('node:fs')
const path = require('node:path')

const INTEL_DIR = __roots.INTEL_ROOT
const POC_EVIDENCE_DIR = path.join(INTEL_DIR, 'poc-evidence')
const DEFAULT_TIMEOUT_MS = 10_000
const MAX_BODY_BYTES = 200_000 // 200KB cap per response body — enough for evidence, prevents storage abuse
const REDACT_RESPONSE_HEADERS = Object.freeze(['set-cookie', 'authorization', 'x-csrf-token'])

// Extract candidate URL(s) from any finding shape we have seen across squads.
// Pure function — no I/O. Returns deduplicated absolute URLs in priority order.
function extractUrlsFromFinding(finding) {
  if (!finding || typeof finding !== 'object') return []
  const candidates = []
  for (const k of ['affected_url', 'url', 'target', 'endpoint', 'affected_endpoint', 'parent']) {
    if (typeof finding[k] === 'string' && /^https?:\/\//i.test(finding[k])) {
      candidates.push(finding[k].trim())
    }
  }
  // reproduction_method often contains "curl https://..." — extract the URL.
  if (typeof finding.reproduction_method === 'string') {
    const m = finding.reproduction_method.match(/https?:\/\/[^\s'"`<>)]+/g)
    if (m) for (const u of m) candidates.push(u.trim())
  }
  if (typeof finding.details === 'string') {
    const m = finding.details.match(/https?:\/\/[^\s'"`<>)]+/g)
    if (m) for (const u of m.slice(0, 3)) candidates.push(u.trim()) // cap to 3 from prose
  }
  // De-dup preserving order; cap to 5 per finding (storage budget).
  const seen = new Set()
  const out = []
  for (const u of candidates) {
    if (seen.has(u)) continue
    seen.add(u)
    out.push(u)
    if (out.length >= 5) break
  }
  return out
}

// Sanitize headers: drop secrets that would leak into evidence artifacts.
// Pure function. Returns a shallow copy with banned keys removed.
function sanitizeHeaders(headers) {
  const out = {}
  for (const [k, v] of Object.entries(headers || {})) {
    if (REDACT_RESPONSE_HEADERS.includes(String(k).toLowerCase())) {
      out[k] = '[REDACTED]'
    } else {
      out[k] = v
    }
  }
  return out
}

// Truncate body if oversized. Records original size so consumers can tell
// the body was truncated (vs naturally short).
function truncateBody(rawBody, maxBytes = MAX_BODY_BYTES) {
  if (typeof rawBody !== 'string') rawBody = String(rawBody || '')
  if (rawBody.length <= maxBytes) {
    return { body: rawBody, truncated: false, original_length: rawBody.length }
  }
  return {
    body: rawBody.slice(0, maxBytes),
    truncated: true,
    original_length: rawBody.length,
  }
}

// Real-fetch driver: thin wrapper over node's native fetch. Injected as
// `fetchImpl` for tests so we can mock without network.
async function defaultFetchImpl(url, opts) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs || DEFAULT_TIMEOUT_MS)
  try {
    const res = await fetch(url, {
      method: opts.method || 'GET',
      headers: opts.headers || {},
      body: opts.body,
      redirect: 'manual', // capture the redirect chain explicitly
      signal: controller.signal,
    })
    const body = await res.text()
    const headers = {}
    for (const [k, v] of res.headers.entries()) headers[k] = v
    return { status: res.status, headers, body, error: null }
  } catch (e) {
    return { status: 0, headers: {}, body: '', error: e.message || String(e) }
  } finally {
    clearTimeout(timer)
  }
}

// Capture a single URL. Returns the artifact object (does NOT write to disk).
// `fetchImpl` is injectable for tests.
async function captureUrl({
  url, method = 'GET', headers = {}, body = null, timeoutMs = DEFAULT_TIMEOUT_MS,
  fetchImpl = defaultFetchImpl,
}) {
  if (!url || typeof url !== 'string') throw new Error('captureUrl: url required')
  const t0 = Date.now()
  const res = await fetchImpl(url, { method, headers, body, timeoutMs })
  const timing_ms = Date.now() - t0
  const truncated = truncateBody(res.body)
  return {
    captured_at: new Date().toISOString(),
    url,
    method,
    request_headers: sanitizeHeaders(headers),
    request_body: body == null ? null : String(body).slice(0, 4000),
    response_status: res.status,
    response_headers: sanitizeHeaders(res.headers),
    response_body: truncated.body,
    response_body_truncated: truncated.truncated,
    response_body_original_length: truncated.original_length,
    timing_ms,
    error: res.error,
  }
}

// Atomic write to /root/intel/poc-evidence/{taskId}/{findingId}.json
function writeEvidenceFile({ taskId, findingId, artifact, intelDir = INTEL_DIR }) {
  if (!taskId || !findingId) throw new Error('writeEvidenceFile: taskId + findingId required')
  const dir = path.join(intelDir, 'poc-evidence', String(taskId))
  fs.mkdirSync(dir, { recursive: true })
  const safeId = String(findingId).replace(/[^a-zA-Z0-9._-]/g, '_')
  const outPath = path.join(dir, `${safeId}.json`)
  const tmpPath = outPath + '.tmp'
  fs.writeFileSync(tmpPath, JSON.stringify(artifact, null, 2))
  fs.renameSync(tmpPath, outPath)
  return outPath
}

// Top-level orchestrator: iterate findings, capture every URL, write to disk.
// Fail-soft per finding+URL — one bad capture never blocks siblings.
// Returns {captured, skipped, errors} for telemetry.
async function captureForValidatedFindings({
  taskId,
  findings,
  fetchImpl = defaultFetchImpl,
  intelDir = INTEL_DIR,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  perFindingCap = 3, // capture at most N URLs per finding to bound cost
}) {
  if (!taskId) throw new Error('captureForValidatedFindings: taskId required')
  if (!Array.isArray(findings)) throw new Error('findings must be an array')
  const result = { captured: [], skipped: [], errors: [] }
  for (const f of findings) {
    const urls = extractUrlsFromFinding(f).slice(0, perFindingCap)
    if (urls.length === 0) {
      result.skipped.push({ finding_id: f?.id, reason: 'no-url-in-finding' })
      continue
    }
    const findingArtifacts = []
    for (const url of urls) {
      try {
        const artifact = await captureUrl({ url, timeoutMs, fetchImpl })
        findingArtifacts.push(artifact)
      } catch (e) {
        result.errors.push({ finding_id: f?.id, url, error: e.message || String(e) })
      }
    }
    if (findingArtifacts.length === 0) continue
    try {
      const combined = {
        schema_version: '1',
        task_id: String(taskId),
        finding_id: f.id || f.findingId || 'unidentified',
        finding_severity: f.severity || 'unknown',
        finding_title: f.title || '',
        captures: findingArtifacts,
      }
      const outPath = writeEvidenceFile({
        taskId, findingId: combined.finding_id, artifact: combined, intelDir,
      })
      result.captured.push({ finding_id: combined.finding_id, path: outPath, capture_count: findingArtifacts.length })
    } catch (e) {
      result.errors.push({ finding_id: f?.id, error: 'write-failed: ' + (e.message || e) })
    }
  }
  return result
}

// Read previously captured evidence for a task. Used by VYASA report builder.
// Returns {findingId: artifact} map. Empty object if no captures yet.
function readCapturesForTask(taskId, { intelDir = INTEL_DIR } = {}) {
  const dir = path.join(intelDir, 'poc-evidence', String(taskId))
  if (!fs.existsSync(dir)) return {}
  const out = {}
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.json')) continue
    try {
      const parsed = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf-8'))
      out[parsed.finding_id || f.replace(/\.json$/, '')] = parsed
    } catch { /* skip malformed artifact */ }
  }
  return out
}

module.exports = {
  captureUrl,
  captureForValidatedFindings,
  writeEvidenceFile,
  readCapturesForTask,
  extractUrlsFromFinding,
  sanitizeHeaders,
  truncateBody,
  defaultFetchImpl,
  POC_EVIDENCE_DIR,
  MAX_BODY_BYTES,
}
