
const __roots = require('../paths') // portable roots (KURU_*_ROOT) — see paths.js
const test = require('node:test')
const assert = require('node:assert')

test('GATE-86: kripa-validated-builder imports url-extractor', () => {
  const fs = require('node:fs')
  const src = fs.readFileSync((__roots.AGENTS_ROOT + '/agents/kripa-validated-builder.js'), 'utf8')
  assert.match(src, /require\(['"]\.\/url-extractor['"]\)/,
    'kripa-validated-builder must import url-extractor for canonical url emission')
})

test('GATE-86: kripa-validated-builder references extractFirstUrl on details or notes', () => {
  const fs = require('node:fs')
  const src = fs.readFileSync((__roots.AGENTS_ROOT + '/agents/kripa-validated-builder.js'), 'utf8')
  assert.match(src, /extractFirstUrl\([^)]*(details|notes)/,
    'kripa-validated-builder must call extractFirstUrl on details or notes')
})

test('GATE-86: url-extractor module exists and exports extractFirstUrl', () => {
  const { extractFirstUrl } = require('../agents/url-extractor')
  assert.strictEqual(typeof extractFirstUrl, 'function')
  assert.strictEqual(
    extractFirstUrl('test https://example.com/x'),
    'https://example.com/x'
  )
})
