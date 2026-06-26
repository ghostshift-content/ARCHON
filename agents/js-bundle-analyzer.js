// agents/js-bundle-analyzer.js
//
// 2026-05-12: Closes the endpoint-discovery blind spot surfaced during the
// 2026-05-11 bounty-PoC session. The framework's recon agents (TRACER +
// SCOUT) crawled webpages but did NOT reverse-engineer the SPA JS bundles
// they referenced — so /api/v1/printLog (a SECOND unauth-write endpoint on
// the same backend as the known chatLog/sync vuln) was missed entirely.
// We discovered it manually by grepping the 1.3MB index-C3_5rkBN.js bundle.
//
// This module makes that automatic. Pure regex extraction of API endpoints
// + URL constants + hardcoded hosts from any JS source string. Squad-
// agnostic: works on Vite/Webpack/Rollup/Parcel bundles or hand-rolled JS.
//
// Wired into Phase 1.6 (post-TRACER crawl, pre-Phase-2 dispatch) so every
// discovered .js URL gets analyzed and any new API paths get appended to
// pentest-endpoints-{taskId}.json for Phase 2 specialists to test.

'use strict'
const __roots = require('../paths') // portable roots (KURU_*_ROOT) — see paths.js


const fs = require('node:fs')
const path = require('node:path')

const INTEL_DIR = __roots.INTEL_ROOT
const DEFAULT_FETCH_TIMEOUT_MS = 15_000
const MAX_BUNDLE_BYTES = 5_000_000 // 5MB cap — most Vite/Webpack bundles fit comfortably
const MAX_ENDPOINTS_PER_BUNDLE = 200 // sanity cap to prevent prompt explosion

// API path regex — matches `/api/v{N}/...` and `/v{N}/...` patterns.
// Conservative: only matches if path starts with `/` and continues with
// /-delimited alphanumeric+_ segments. Tolerates colons (e.g. /:id) and
// hyphens but stops at quotes, whitespace, `)`, etc.
const API_PATH_RE = /\/(?:api\/v\d+|v\d+|api)(?:\/[a-zA-Z0-9_\-:.{}]+)+/g

// fetch/axios/$.ajax call URLs — extract the URL inside quotes.
// Conservative: only single/double-quoted strings, not template literals
// (those leak too many false positives from i18n strings).
const FETCH_CALL_RE = /(?:fetch|axios(?:\.(?:get|post|put|delete|patch|head))?)\s*\(\s*[`'"]([^`'"]+)[`'"]/g

// Hardcoded URLs (including subdomain leaks like test.cube.lenovo.com).
const URL_RE = /https?:\/\/[a-zA-Z0-9.-]+(?:\:[0-9]+)?(?:\/[^\s'"`<>)]*)?/g

// Internal hostname/IP patterns worth flagging (RFC1918, .local, .internal,
// test/dev/stage subdomains).
const INTERNAL_HINT_RE = /\b(?:10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(?:1[6-9]|2\d|3[01])\.\d+\.\d+|[a-z0-9-]+\.(?:local|internal|lan|corp))\b|\b(?:dev|test|stage|staging|qa|preprod|internal)[-.]\w+\.[a-z.]+/g

// Build artifact hints exposed in production bundles (these often leak
// developer identities and project names).
const BUILD_METADATA_RE = /(?:@(?:Author|LastEditors|FilePath|Copyright)|@@Copyright)\s*[:(].*$/gim

// Extract all API endpoint paths from a JS source buffer. Pure function.
// De-duplicated, sorted, capped at MAX_ENDPOINTS_PER_BUNDLE.
function extractApiEndpoints(jsContent) {
  if (!jsContent || typeof jsContent !== 'string') return []
  const seen = new Set()
  const out = []

  for (const m of jsContent.matchAll(API_PATH_RE)) {
    const path = m[0]
    if (path.length > 200) continue // skip absurd matches
    if (!seen.has(path)) {
      seen.add(path)
      out.push(path)
    }
  }
  // fetch/axios string-arg paths that aren't already captured by the API_PATH_RE
  for (const m of jsContent.matchAll(FETCH_CALL_RE)) {
    const url = m[1]
    if (!url || url.length > 300) continue
    // Normalize relative URLs by stripping protocol+host if present
    const candidate = url.startsWith('/') ? url : url.replace(/^https?:\/\/[^/]+/, '') || url
    if (candidate && candidate.startsWith('/') && !seen.has(candidate)) {
      seen.add(candidate)
      out.push(candidate)
    }
  }
  out.sort()
  return out.slice(0, MAX_ENDPOINTS_PER_BUNDLE)
}

// Extract all absolute URLs (for hardcoded host disclosure detection).
function extractUrls(jsContent) {
  if (!jsContent || typeof jsContent !== 'string') return []
  const seen = new Set()
  for (const m of jsContent.matchAll(URL_RE)) {
    const u = m[0]
    if (u.length > 500) continue
    seen.add(u)
  }
  return [...seen].sort()
}

// Extract internal-hostname / RFC1918 hints (often a finding by itself when
// disclosed in production bundles).
function extractInternalHints(jsContent) {
  if (!jsContent || typeof jsContent !== 'string') return []
  const seen = new Set()
  for (const m of jsContent.matchAll(INTERNAL_HINT_RE)) {
    seen.add(m[0])
  }
  return [...seen].sort()
}

// Extract build metadata leaks (developer identities, file paths, etc.)
// Truncates each hit at 200 chars to avoid bundle text bleeding.
function extractBuildMetadata(jsContent) {
  if (!jsContent || typeof jsContent !== 'string') return []
  const seen = new Set()
  for (const m of jsContent.matchAll(BUILD_METADATA_RE)) {
    const hit = m[0].slice(0, 200).trim()
    seen.add(hit)
  }
  return [...seen].sort()
}

// AST-based endpoint extraction (catches template literals, concatenated
// strings, deep object-property endpoints that regex misses). Lazily loaded
// to keep the require graph small if acorn parsing fails or isn't installed.
function _astExtractEndpoints(jsContent) {
  try {
    const astMod = require('./js-bundle-analyzer-ast')
    return astMod.extractEndpointsFromAst(jsContent) || []
  } catch {
    return []
  }
}

// One-pass analyzer that returns all findings for a bundle.
// 2026-05-14: endpoints[] is now the UNION of regex + AST extraction —
// strictly additive, dedupe via Set. The article's "structured handoff"
// idea applies here too: the more accurate the recon, the better Phase 2.
function analyzeJsBundle(jsContent) {
  const regexEndpoints = extractApiEndpoints(jsContent)
  const astEndpoints = _astExtractEndpoints(jsContent)
  const unionSet = new Set([...regexEndpoints, ...astEndpoints])
  const endpoints = [...unionSet].sort().slice(0, MAX_ENDPOINTS_PER_BUNDLE)
  return {
    endpoints,
    endpoints_regex_only: regexEndpoints.length,
    endpoints_ast_only: astEndpoints.filter(e => !regexEndpoints.includes(e)).length,
    urls: extractUrls(jsContent),
    internal_hints: extractInternalHints(jsContent),
    build_metadata: extractBuildMetadata(jsContent),
    bundle_size_bytes: jsContent ? jsContent.length : 0,
  }
}

// Default fetch driver — wraps node fetch with timeout + size cap.
// Returns the body string (capped at MAX_BUNDLE_BYTES) or '' on error.
async function defaultFetchImpl(url, { timeoutMs = DEFAULT_FETCH_TIMEOUT_MS } = {}) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: { 'User-Agent': 'archon-js-bundle-analyzer/1.0' },
      signal: controller.signal,
      redirect: 'follow',
    })
    if (!res.ok) return ''
    const text = await res.text()
    return text.slice(0, MAX_BUNDLE_BYTES)
  } catch {
    return ''
  } finally {
    clearTimeout(timer)
  }
}

// Fetch each JS URL and aggregate findings.
// Fail-soft per URL — one bad bundle never drops siblings.
async function analyzeBundlesFromUrls(jsUrls, {
  fetchImpl = defaultFetchImpl,
  timeoutMs = DEFAULT_FETCH_TIMEOUT_MS,
  maxUrls = 25, // cap to avoid burning hours on minified vendor chunks
} = {}) {
  if (!Array.isArray(jsUrls)) throw new Error('jsUrls must be an array')
  const aggregated = {
    bundles_analyzed: 0,
    bundles_failed: 0,
    endpoints: new Set(),
    urls: new Set(),
    internal_hints: new Set(),
    build_metadata: new Set(),
    per_bundle: [],
  }
  for (const url of jsUrls.slice(0, maxUrls)) {
    try {
      const content = await fetchImpl(url, { timeoutMs })
      if (!content) {
        aggregated.bundles_failed++
        continue
      }
      const analysis = analyzeJsBundle(content)
      aggregated.bundles_analyzed++
      aggregated.per_bundle.push({ url, ...analysis })
      analysis.endpoints.forEach(e => aggregated.endpoints.add(e))
      analysis.urls.forEach(u => aggregated.urls.add(u))
      analysis.internal_hints.forEach(h => aggregated.internal_hints.add(h))
      analysis.build_metadata.forEach(m => aggregated.build_metadata.add(m))
    } catch {
      aggregated.bundles_failed++
    }
  }
  return {
    bundles_analyzed: aggregated.bundles_analyzed,
    bundles_failed: aggregated.bundles_failed,
    endpoints: [...aggregated.endpoints].sort(),
    urls: [...aggregated.urls].sort(),
    internal_hints: [...aggregated.internal_hints].sort(),
    build_metadata: [...aggregated.build_metadata].sort(),
    per_bundle: aggregated.per_bundle,
  }
}

// Persist analysis result for a task.
function writeAnalysisForTask({ taskId, analysis, intelDir = INTEL_DIR }) {
  if (!taskId) throw new Error('writeAnalysisForTask: taskId required')
  const outPath = path.join(intelDir, `js-bundle-analysis-${taskId}.json`)
  const tmpPath = outPath + '.tmp'
  fs.writeFileSync(tmpPath, JSON.stringify(analysis, null, 2))
  fs.renameSync(tmpPath, outPath)
  return outPath
}

// Read JS URLs that TRACER's crawl wrote. The convention (since round-9):
//   /root/intel/crawl-{taskId}/g1-js-urls.txt — one URL per line
// Returns array of URLs, or empty if file missing.
function readJsUrlsForTask(taskId, { intelDir = INTEL_DIR } = {}) {
  const crawlDir = path.join(intelDir, `crawl-${taskId}`)
  const candidates = [
    path.join(crawlDir, 'g1-js-urls.txt'),
    path.join(crawlDir, 'js-urls.txt'),
  ]
  for (const f of candidates) {
    if (!fs.existsSync(f)) continue
    try {
      return fs.readFileSync(f, 'utf-8')
        .split('\n')
        .map(s => s.trim())
        .filter(u => u && /^https?:\/\//i.test(u))
    } catch { /* try next */ }
  }
  return []
}

module.exports = {
  analyzeJsBundle,
  analyzeBundlesFromUrls,
  extractApiEndpoints,
  extractUrls,
  extractInternalHints,
  extractBuildMetadata,
  writeAnalysisForTask,
  readJsUrlsForTask,
  defaultFetchImpl,
  MAX_BUNDLE_BYTES,
  MAX_ENDPOINTS_PER_BUNDLE,
}
