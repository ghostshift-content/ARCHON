'use strict'
// Profiler (SPEC §3).
const { test } = require('node:test'); const assert = require('node:assert/strict')
const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path')
const P = require('../src/runtime/profiler')
test('usable_context = model − reserves (Opus 1M ⇒ ~520k)', () => {
  const u = P.usableContext({ model_context: 1_000_000 })
  assert.ok(u > 400_000 && u < 700_000)
  assert.equal(P.estimateTokens(4000), 1000)
})
test('source walk counts code files, skips vendor', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'prof-'))
  fs.mkdirSync(path.join(d, 'app')); fs.writeFileSync(path.join(d, 'app', 'a.rb'), 'class A; end')
  fs.writeFileSync(path.join(d, 'app', 'b.js'), 'const x=1')
  fs.mkdirSync(path.join(d, 'node_modules')); fs.writeFileSync(path.join(d, 'node_modules', 'v.js'), 'x'.repeat(9999))
  const p = P.profileSource(d)
  assert.equal(p.files, 2, 'vendor skipped'); assert.ok(p.fits_in_one_session && p.min_sessions === 1)
  assert.ok(p.languages.includes('rb') && p.languages.includes('js'))
  fs.rmSync(d, { recursive: true, force: true })
})
