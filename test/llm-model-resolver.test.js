
const __roots = require('../paths') // portable roots (KURU_*_ROOT) — see paths.js
// test/llm-model-resolver.test.js
//
// Tests for the centralized LLM model resolver.
// Replaces 4 hardcoded model strings (handoff-resolver, event-bus trajectory IIFE,
// run-judge-verifier, process-handoff) with a single config-driven helper.
//
// Spec: /root/agents/agents/llm-model-resolver.js

const assert = require('node:assert')
const { test } = require('node:test')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')

const resolver = require('../agents/llm-model-resolver')

// ── Test setup ──────────────────────────────────────────────────────────────
// We deliberately exercise the REAL /root/intel/model-config.json — not a mock.
// Reasons:
//   1. The whole point of the refactor is to honour edits to that file
//   2. Tests must catch a real change (e.g. someone bumps families.fast)
// We do snapshot-restore the file when we mutate it for the "missing config"
// branch, so live pentest reads aren't disturbed.

test('resolveLLMModel({family: "fast"}) returns the configured fast model', () => {
  resolver.resetCache()
  const got = resolver.resolveLLMModel({ family: 'fast' })
  const cfg = JSON.parse(fs.readFileSync((__roots.INTEL_ROOT + '/model-config.json'), 'utf-8'))
  assert.strictEqual(got, cfg.families.fast)
  assert.match(got, /^claude-/)
})

test('resolveLLMModel({family: "balanced"}) returns the configured balanced model', () => {
  resolver.resetCache()
  const got = resolver.resolveLLMModel({ family: 'balanced' })
  const cfg = JSON.parse(fs.readFileSync((__roots.INTEL_ROOT + '/model-config.json'), 'utf-8'))
  assert.strictEqual(got, cfg.families.balanced)
})

test('resolveLLMModel({family: "powerful"}) returns the configured powerful model', () => {
  resolver.resetCache()
  const got = resolver.resolveLLMModel({ family: 'powerful' })
  const cfg = JSON.parse(fs.readFileSync((__roots.INTEL_ROOT + '/model-config.json'), 'utf-8'))
  assert.strictEqual(got, cfg.families.powerful)
})

test('resolveLLMModel({override: "claude-foo"}) returns override regardless of family', () => {
  resolver.resetCache()
  const got = resolver.resolveLLMModel({ family: 'fast', override: 'claude-foo' })
  assert.strictEqual(got, 'claude-foo')
})

test('resolveLLMModel: empty/null override is ignored (falls through to family)', () => {
  resolver.resetCache()
  const cfg = JSON.parse(fs.readFileSync((__roots.INTEL_ROOT + '/model-config.json'), 'utf-8'))
  assert.strictEqual(
    resolver.resolveLLMModel({ family: 'balanced', override: '' }),
    cfg.families.balanced
  )
  assert.strictEqual(
    resolver.resolveLLMModel({ family: 'balanced', override: null }),
    cfg.families.balanced
  )
  assert.strictEqual(
    resolver.resolveLLMModel({ family: 'balanced', override: undefined }),
    cfg.families.balanced
  )
})

test('cache: 2 calls within 10s return same value without re-reading config', () => {
  resolver.resetCache()
  let reads = 0
  const origReadFile = fs.readFileSync
  fs.readFileSync = function patched(p, ...rest) {
    if (typeof p === 'string' && p.endsWith('model-config.json')) reads++
    return origReadFile.call(fs, p, ...rest)
  }
  try {
    const a = resolver.resolveLLMModel({ family: 'fast' })
    const b = resolver.resolveLLMModel({ family: 'fast' })
    assert.strictEqual(a, b)
    assert.strictEqual(reads, 1, `expected 1 config read, got ${reads}`)
  } finally {
    fs.readFileSync = origReadFile
  }
})

test('cache: resetCache() forces a fresh read', () => {
  resolver.resetCache()
  let reads = 0
  const origReadFile = fs.readFileSync
  fs.readFileSync = function patched(p, ...rest) {
    if (typeof p === 'string' && p.endsWith('model-config.json')) reads++
    return origReadFile.call(fs, p, ...rest)
  }
  try {
    resolver.resolveLLMModel({ family: 'fast' })
    resolver.resetCache()
    resolver.resolveLLMModel({ family: 'fast' })
    assert.strictEqual(reads, 2, `expected 2 config reads after reset, got ${reads}`)
  } finally {
    fs.readFileSync = origReadFile
  }
})

test('missing config → falls back to documented constant', () => {
  resolver.resetCache()
  // Point resolver at a guaranteed-missing file via override hook
  const got = resolver.resolveLLMModel({
    family: 'fast',
    _configPathForTest: '/tmp/definitely-does-not-exist-xyz-123.json',
  })
  // Must not throw, must return a claude-* string
  assert.match(got, /^claude-/, `expected claude-* fallback, got ${got}`)
  // Hardcoded fallback: fast = claude-haiku-4-5 per FALLBACK_FAMILIES
  assert.strictEqual(got, resolver.FALLBACK_FAMILIES.fast)
})

test('malformed config → falls back to documented constant', () => {
  resolver.resetCache()
  const tmpFile = path.join(os.tmpdir(), `resolver-malformed-${Date.now()}.json`)
  fs.writeFileSync(tmpFile, '{not valid json')
  try {
    const got = resolver.resolveLLMModel({
      family: 'balanced',
      _configPathForTest: tmpFile,
    })
    assert.strictEqual(got, resolver.FALLBACK_FAMILIES.balanced)
  } finally {
    try { fs.unlinkSync(tmpFile) } catch {}
  }
})

test('unknown family → falls back to balanced (documented graceful default)', () => {
  resolver.resetCache()
  const cfg = JSON.parse(fs.readFileSync((__roots.INTEL_ROOT + '/model-config.json'), 'utf-8'))
  // Per the contract: unknown family does NOT throw; it falls back to balanced.
  // This keeps the hot path safe — a typo in caller code shouldn't crash the pipeline.
  const got = resolver.resolveLLMModel({ family: 'gigantic' })
  assert.strictEqual(got, cfg.families.balanced)
})

test('no opts → defaults to balanced family', () => {
  resolver.resetCache()
  const cfg = JSON.parse(fs.readFileSync((__roots.INTEL_ROOT + '/model-config.json'), 'utf-8'))
  assert.strictEqual(resolver.resolveLLMModel(), cfg.families.balanced)
  assert.strictEqual(resolver.resolveLLMModel({}), cfg.families.balanced)
})

test('FALLBACK_FAMILIES contains all 3 documented families', () => {
  assert.ok(resolver.FALLBACK_FAMILIES.fast)
  assert.ok(resolver.FALLBACK_FAMILIES.balanced)
  assert.ok(resolver.FALLBACK_FAMILIES.powerful)
  assert.match(resolver.FALLBACK_FAMILIES.fast, /^claude-/)
  assert.match(resolver.FALLBACK_FAMILIES.balanced, /^claude-/)
  assert.match(resolver.FALLBACK_FAMILIES.powerful, /^claude-/)
})
