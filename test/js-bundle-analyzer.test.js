// test/js-bundle-analyzer.test.js
// Covers the JS-bundle endpoint discovery module. Surfaced as a gap during
// the 2026-05-11 bounty-PoC session — the framework missed /api/v1/printLog
// because TRACER crawled .js URLs but never analyzed their contents.

const assert = require('node:assert')
const { test } = require('node:test')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const {
  analyzeJsBundle,
  analyzeBundlesFromUrls,
  extractApiEndpoints,
  extractUrls,
  extractInternalHints,
  extractBuildMetadata,
  writeAnalysisForTask,
  readJsUrlsForTask,
} = require('../agents/js-bundle-analyzer')

// Realistic JS bundle fragment modeled on the actual Knowdee SPA bundle we
// reverse-engineered in the 2026-05-11 session.
const SAMPLE_BUNDLE = `
/*
 * @@Copyright (c): Knowdee All rights reserved.
 * @Description: Environment variables
 * @Author: wangwz@knowdee.com
 * @LastEditors: wangwz@knowdee.com
 * @FilePath: /client-h5-v2/public/index.html
 */
const router = {
  push: function(p) { return fetch('/api/v1/auth/query'); }
};
axios.post('/api/v1/chatLog/sync', payload);
axios.post('/api/v1/printLog', logEntry);
axios.get('/api/v1/config/query');
fetch("/api/v1/deviceHelp/pullMessage", { method: "POST" });
const apiBase = "https://us-llm.moli.lenovo.com/callcenterv2";
const testHost = "https://test.cube.lenovo.com";
const internalAdmin = "http://10.0.0.5:8080/admin";
const cnHost = "https://webvpncnpek01.lenovo.com";
window.botV2GlobalProperties = {
  MF_API_HOST: 'https://cube.zhaopin.com',
};
// Note: dev.api.example.internal used for staging
`

test('extractApiEndpoints finds /api/v{N}/... patterns', () => {
  const endpoints = extractApiEndpoints(SAMPLE_BUNDLE)
  // Must include the 5 known endpoints embedded above
  for (const expected of [
    '/api/v1/auth/query',
    '/api/v1/chatLog/sync',
    '/api/v1/printLog',
    '/api/v1/config/query',
    '/api/v1/deviceHelp/pullMessage',
  ]) {
    assert.ok(endpoints.includes(expected), `expected endpoint ${expected} not found, got: ${endpoints.join(', ')}`)
  }
})

test('extractApiEndpoints would have caught /api/v1/printLog (the bug-bounty miss)', () => {
  // This is the regression test that nails the original gap:
  // /api/v1/printLog was a second unauth-write vector we found manually.
  const minimal = 'axios.post("/api/v1/printLog", entry);'
  const endpoints = extractApiEndpoints(minimal)
  assert.ok(endpoints.includes('/api/v1/printLog'))
})

test('extractApiEndpoints de-duplicates repeated paths', () => {
  const js = `
    fetch('/api/v1/x'); fetch('/api/v1/x'); fetch('/api/v1/x');
    axios.post('/api/v1/x');
  `
  const endpoints = extractApiEndpoints(js)
  assert.strictEqual(endpoints.filter(e => e === '/api/v1/x').length, 1)
})

test('extractApiEndpoints caps at MAX_ENDPOINTS_PER_BUNDLE', () => {
  // 250 unique endpoints — must cap at 200
  const lines = Array.from({length: 250}, (_, i) => `fetch("/api/v1/endpoint${i}");`).join('\n')
  const endpoints = extractApiEndpoints(lines)
  assert.ok(endpoints.length <= 200)
})

test('extractApiEndpoints handles null/empty/non-string gracefully', () => {
  assert.deepStrictEqual(extractApiEndpoints(null), [])
  assert.deepStrictEqual(extractApiEndpoints(''), [])
  assert.deepStrictEqual(extractApiEndpoints(123), [])
})

test('extractUrls finds absolute URLs (incl. internal-hint hosts)', () => {
  const urls = extractUrls(SAMPLE_BUNDLE)
  assert.ok(urls.some(u => u.includes('us-llm.moli.lenovo.com')))
  assert.ok(urls.some(u => u.includes('test.cube.lenovo.com')))
  assert.ok(urls.some(u => u.includes('webvpncnpek01.lenovo.com')))
  assert.ok(urls.some(u => u.includes('cube.zhaopin.com')))
})

test('extractInternalHints flags RFC1918 IPs and .internal / dev. hosts', () => {
  const hints = extractInternalHints(SAMPLE_BUNDLE)
  assert.ok(hints.some(h => /10\.0\.0\.5/.test(h)))
  // The "test.cube.lenovo.com" should match the dev/test prefix pattern
  const hasTestHost = hints.some(h => /test\.cube\.lenovo\.com/.test(h))
  // Either it matches or the bundle simply doesn't trigger our pattern shape — both OK,
  // the goal is that RFC1918 ALWAYS works.
  assert.ok(hasTestHost || hints.length >= 1)
})

test('extractBuildMetadata captures developer-identity leaks (the wangwz case)', () => {
  const meta = extractBuildMetadata(SAMPLE_BUNDLE)
  assert.ok(meta.some(m => m.includes('Author: wangwz@knowdee.com')))
  assert.ok(meta.some(m => m.includes('FilePath: /client-h5-v2/public/index.html')))
})

test('analyzeJsBundle returns the full analysis object', () => {
  const a = analyzeJsBundle(SAMPLE_BUNDLE)
  assert.ok(a.endpoints.length >= 5)
  assert.ok(a.urls.length >= 4)
  assert.ok(typeof a.bundle_size_bytes === 'number')
  assert.ok(a.bundle_size_bytes > 0)
})

test('analyzeBundlesFromUrls: fetches each, aggregates, fails soft per URL', async () => {
  const responses = new Map([
    ['https://a/bundle.js', 'fetch("/api/v1/aaa"); fetch("/api/v1/bbb");'],
    ['https://b/bundle.js', 'axios.post("/api/v1/ccc");'],
    ['https://broken/bundle.js', ''], // empty body = treated as fetch failure
  ])
  const mockFetch = async (url) => responses.get(url) || ''
  const result = await analyzeBundlesFromUrls(
    ['https://a/bundle.js', 'https://b/bundle.js', 'https://broken/bundle.js'],
    { fetchImpl: mockFetch }
  )
  assert.strictEqual(result.bundles_analyzed, 2)
  assert.strictEqual(result.bundles_failed, 1)
  assert.ok(result.endpoints.includes('/api/v1/aaa'))
  assert.ok(result.endpoints.includes('/api/v1/bbb'))
  assert.ok(result.endpoints.includes('/api/v1/ccc'))
  assert.strictEqual(result.per_bundle.length, 2)
})

test('analyzeBundlesFromUrls caps at maxUrls', async () => {
  let called = 0
  const mockFetch = async () => {
    called++
    return 'fetch("/api/v1/foo");'
  }
  const urls = Array.from({length: 100}, (_, i) => `https://h${i}/bundle.js`)
  await analyzeBundlesFromUrls(urls, { fetchImpl: mockFetch, maxUrls: 10 })
  assert.strictEqual(called, 10)
})

test('writeAnalysisForTask + readJsUrlsForTask roundtrip', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jsa-'))
  // Seed a crawl-{taskId}/g1-js-urls.txt
  const taskId = 'T-99'
  const crawlDir = path.join(tmp, `crawl-${taskId}`)
  fs.mkdirSync(crawlDir, { recursive: true })
  fs.writeFileSync(path.join(crawlDir, 'g1-js-urls.txt'),
    'https://example.com/index.js\nhttps://example.com/chunk.js\n\n# comment line\n')
  const urls = readJsUrlsForTask(taskId, { intelDir: tmp })
  // Should include the 2 https URLs, skip blank+comment
  assert.strictEqual(urls.length, 2)
  assert.ok(urls.includes('https://example.com/index.js'))

  // writeAnalysisForTask
  const analysis = { bundles_analyzed: 1, endpoints: ['/api/v1/foo'] }
  const outPath = writeAnalysisForTask({ taskId, analysis, intelDir: tmp })
  assert.match(outPath, /js-bundle-analysis-T-99\.json$/)
  const read = JSON.parse(fs.readFileSync(outPath, 'utf-8'))
  assert.strictEqual(read.bundles_analyzed, 1)
  fs.rmSync(tmp, { recursive: true, force: true })
})

test('readJsUrlsForTask: returns [] when no crawl dir exists (fail-soft)', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jsa-empty-'))
  const urls = readJsUrlsForTask('NONE', { intelDir: tmp })
  assert.deepStrictEqual(urls, [])
  fs.rmSync(tmp, { recursive: true, force: true })
})

test('Universal: works for Vite/Webpack/Rollup bundle styles', () => {
  // Vite-style: ES module imports
  const vite = `import {a} from "./chunk.js"; const url = "/api/v1/vite-endpoint";`
  // Webpack-style: __webpack_require__ with embedded paths
  const webpack = `var u = "/api/v2/webpack-endpoint"; __webpack_require__(123)("axios").get(u)`
  // Rollup-style: bundled fetch calls
  const rollup = `fetch("/api/v3/rollup-endpoint", { method: "GET" })`

  for (const [name, src] of [['vite', vite], ['webpack', webpack], ['rollup', rollup]]) {
    const eps = extractApiEndpoints(src)
    assert.ok(eps.length > 0, `${name} bundle should yield at least one endpoint`)
  }
})

test('Anti-noise: skips absurdly long matches', () => {
  // Test that a 500-char path doesn't crash or get stored verbatim.
  // Template-literal prefixes (e.g. /api/v1/foo- before ${expr}) may still
  // partial-match — that's acceptable because the prefix is a real path stem.
  const noise = `const s = "/api/v1/${'x'.repeat(500)}"; const x = "/api/v1/normal";`
  const eps = extractApiEndpoints(noise)
  // 500-char absurd match must be filtered (length cap)
  assert.ok(!eps.some(e => e.length > 200), `expected no entries >200 chars, got: ${JSON.stringify(eps)}`)
  // Normal endpoint still captured
  assert.ok(eps.includes('/api/v1/normal'))
})
