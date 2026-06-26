#!/usr/bin/env node
// Unit tests for the dispatch-config priority in extractTargetUrl().
//
// Bug context (2026-05-09 round-8 motorola.com):
//   Title: "Pentest round-8 — full Sprint A+B+C+polish+gates validation on motorola.com"
//   Config: { target: "https://support.motorola.com", target_url: "https://support.motorola.com" }
//   Pre-fix: bare 'motorola.com' won from title, EKLAVYA crawled wrong URL.
//   Post-fix: config.target_url MUST win over title-extracted bare domain.
//
// Priority order locked in here:
//   1. dispatch.config.target_url
//   2. dispatch.config.target
//   3. Title/description/goal scheme URL
//   4. Title/description/goal bare-domain fallback
//
// Run: node test/extract-target-priority.test.js
const fs = require('fs')
const path = require('path')
const assert = require('assert')
const { extractTargetUrl } = require('../src/utils/url-extractor')

let failures = 0
let passed = 0
function test(name, fn) {
  try {
    fn()
    console.log(`  ✓ ${name}`)
    passed++
  } catch (e) {
    console.log(`  ✗ ${name}`)
    console.log(`    ${e.message}`)
    failures++
  }
}

console.log('extract-target-priority tests:')

test('config.target_url wins over title bare domain (round-8 motorola.com regression)', () => {
  const out = extractTargetUrl({
    taskTitle: 'Pentest round-8 — full Sprint A+B+C+polish+gates validation on motorola.com',
    config: { target: 'https://support.motorola.com', target_url: 'https://support.motorola.com' },
  })
  assert.strictEqual(out, 'https://support.motorola.com')
})

test('config.target_url present + title has bare domain → uses config.target_url', () => {
  const out = extractTargetUrl({
    taskTitle: 'audit example.com please',
    config: { target_url: 'https://app.example.com/api' },
  })
  assert.strictEqual(out, 'https://app.example.com/api')
})

test('config.target present (no target_url) + title has URL → uses config.target', () => {
  const out = extractTargetUrl({
    taskTitle: 'scan https://other.example.com',
    config: { target: 'https://canonical.example.com' },
  })
  assert.strictEqual(out, 'https://canonical.example.com')
})

test('config.target_url null but config.target set → uses config.target', () => {
  const out = extractTargetUrl({
    taskTitle: 'test',
    config: { target_url: null, target: 'https://example.com' },
  })
  assert.strictEqual(out, 'https://example.com')
})

test('config.target_url empty string falls through to config.target', () => {
  const out = extractTargetUrl({
    taskTitle: 'test',
    config: { target_url: '', target: 'https://example.com' },
  })
  assert.strictEqual(out, 'https://example.com')
})

test('no config → falls back to title-extracted URL (backwards compat)', () => {
  const out = extractTargetUrl({
    taskTitle: 'Pentest of https://legacy.example.com/path',
  })
  assert.strictEqual(out, 'https://legacy.example.com/path')
})

test('empty config → falls back to title-extracted URL', () => {
  const out = extractTargetUrl({
    taskTitle: 'Pentest of https://legacy.example.com',
    config: {},
  })
  assert.strictEqual(out, 'https://legacy.example.com')
})

test('no config + bare domain in title → https:// prefixed fallback (backwards compat)', () => {
  const out = extractTargetUrl({
    taskTitle: 'Pentest of example.com',
  })
  assert.strictEqual(out, 'https://example.com')
})

test('null/empty everywhere → returns null (existing behavior preserved)', () => {
  assert.strictEqual(extractTargetUrl({}), null)
  assert.strictEqual(extractTargetUrl({ config: {} }), null)
  assert.strictEqual(extractTargetUrl({ config: { target: '', target_url: '' } }), null)
  assert.strictEqual(extractTargetUrl(null), null)
})

test('config.target_url with whitespace is trimmed/used as-is', () => {
  const out = extractTargetUrl({
    taskTitle: 'motorola.com',
    config: { target_url: 'https://support.motorola.com' },
  })
  assert.strictEqual(out, 'https://support.motorola.com')
})

test('config.target_url ignores goal text — config wins', () => {
  const out = extractTargetUrl({
    taskTitle: 'audit',
    goal: 'See https://decoy.example.com for context',
    config: { target_url: 'https://real.example.com' },
  })
  assert.strictEqual(out, 'https://real.example.com')
})

test('config.target accepts bare domain too — gets https:// prefix', () => {
  // Allows shorthand: config: { target: "example.com" }
  const out = extractTargetUrl({
    taskTitle: 'whatever',
    config: { target: 'example.com' },
  })
  assert.strictEqual(out, 'https://example.com')
})

// ─── Module-level grep: event-bus.js must pass dispatch.config ───
test('event-bus.js call sites pass config to extractTargetUrl', () => {
  const src = fs.readFileSync(path.resolve(__dirname, '..', 'event-bus.js'), 'utf-8')
  const calls = src.match(/extractTargetUrl\([^)]*\)/g) || []
  assert.ok(calls.length >= 3, `expected ≥3 extractTargetUrl call sites, found ${calls.length}`)
  for (const c of calls) {
    assert.ok(
      /config\s*:\s*dispatch\.config/.test(c) || /dispatch\.config/.test(c),
      `call site missing dispatch.config: ${c}`
    )
  }
})

console.log(`\n${passed} passed, ${failures} failed`)
process.exit(failures > 0 ? 1 : 0)
