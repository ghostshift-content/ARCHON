'use strict'
// M3: the pattern registry layers drop-in packs over the legacy catalog, IDENTICAL when empty, fail-soft on
// bad packs, and supports append / override / new-class. Uses an env-injected temp root so the repo stays clean.
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path')

function withRoot(fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'patroot-'))
  fs.mkdirSync(path.join(root, 'builtin'), { recursive: true })
  fs.mkdirSync(path.join(root, 'custom', 'user-created'), { recursive: true })
  const prev = process.env.ARCHON_PATTERNS_ROOT
  process.env.ARCHON_PATTERNS_ROOT = root
  delete require.cache[require.resolve('../src/patterns/registry')]
  const R = require('../src/patterns/registry')
  try { return fn(R, root) } finally {
    if (prev === undefined) delete process.env.ARCHON_PATTERNS_ROOT; else process.env.ARCHON_PATTERNS_ROOT = prev
    delete require.cache[require.resolve('../src/patterns/registry')]
    fs.rmSync(root, { recursive: true, force: true })
  }
}
const legacy = require('../src/intel/pattern-catalog')

test('M3 invariant: no packs ⇒ identical to the legacy catalog', () => {
  withRoot((R) => {
    assert.deepEqual(R.patternIds('xss'), legacy.patternIds('xss'), 'xss ids unchanged')
    assert.deepEqual(R.patternIds('access-control'), legacy.patternIds('access-control'))
    assert.ok(R.classes().includes('xss') && R.classes().includes('sqli'))
  })
})

test('M3 append: a custom xss pack ADDS to the built-in ids', () => {
  withRoot((R, root) => {
    fs.writeFileSync(path.join(root, 'custom', 'user-created', 'x.json'), JSON.stringify({
      class: 'xss', mode: 'append', patterns: [{ id: 'xss.custom.dom-clobbering', name: 'DOM clobbering', category: 'xss' }] }))
    const ids = R.patternIds('xss')
    assert.ok(ids.includes('xss.custom.dom-clobbering'), 'custom id present')
    assert.ok(ids.length > legacy.patternIds('xss').length, 'added on top of legacy')
  })
})

test('M3 override: a pack REPLACES the class built-in set', () => {
  withRoot((R, root) => {
    fs.writeFileSync(path.join(root, 'custom', 'only.json'), JSON.stringify({
      class: 'xss', mode: 'override', patterns: [{ id: 'ONLY-1', name: 'only', category: 'xss' }] }))
    assert.deepEqual(R.patternIds('xss'), ['ONLY-1'], 'legacy ids replaced')
    assert.deepEqual(R.patternIds('sqli'), legacy.patternIds('sqli'), 'other classes untouched')
  })
})

test('M3 fail-soft: a malformed pack is skipped, others still load, scan not broken', () => {
  withRoot((R, root) => {
    fs.writeFileSync(path.join(root, 'custom', 'bad.json'), '{ this is not json')
    fs.writeFileSync(path.join(root, 'custom', 'good.json'), JSON.stringify({ class: 'xss', patterns: [{ id: 'GOOD-1', name: 'g', category: 'xss' }] }))
    const ids = R.patternIds('xss')
    assert.ok(ids.includes('GOOD-1'), 'the valid pack loaded despite the broken one')
  })
})

test('M3 new class: a pack with an unknown class makes that class available', () => {
  withRoot((R, root) => {
    fs.mkdirSync(path.join(root, 'builtin', 'llm-prompt-injection'), { recursive: true })
    fs.writeFileSync(path.join(root, 'builtin', 'llm-prompt-injection', 'p.json'), JSON.stringify({
      class: 'llm-prompt-injection', patterns: [{ id: 'llm.pi.1', name: 'sys prompt leak', category: 'llm-prompt-injection' }] }))
    assert.ok(R.classes().includes('llm-prompt-injection'))
    assert.deepEqual(R.patternIds('llm-prompt-injection'), ['llm.pi.1'])
  })
})
