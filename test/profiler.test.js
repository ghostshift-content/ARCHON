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

// §9: security-relevant config/build files + extensionless manifests are profiled, not skipped.
test('§9: recognizes Gemfile/Dockerfile/requirements.txt/nginx.conf + a file manifest', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'prof9-'))
  fs.writeFileSync(path.join(d, 'Gemfile'), "gem 'rails'\n")
  fs.writeFileSync(path.join(d, 'Dockerfile'), 'FROM ruby:3\n')
  fs.writeFileSync(path.join(d, 'requirements.txt'), 'flask==1.0\n')
  fs.writeFileSync(path.join(d, 'nginx.conf'), 'server {}\n')
  fs.writeFileSync(path.join(d, 'app.rb'), 'class A; end\n')
  assert.ok(P.isSourceFile('Gemfile') && P.isSourceFile('Dockerfile') && P.isSourceFile('requirements.txt') && P.isSourceFile('nginx.conf'))
  const p = P.profileSource(d)
  assert.equal(p.files, 5, 'config + source files all counted')
  const manifest = P.listSourceFiles(d)
  assert.equal(manifest.length, 5)
  assert.ok(manifest.every(f => typeof f.path === 'string' && Number.isFinite(f.bytes)))
  fs.rmSync(d, { recursive: true, force: true })
})

// §3: model context resolution — unknown model defaults conservative (200k), not 1M.
test('§3: modelContext resolves per model; unknown defaults to a conservative 200k', () => {
  assert.equal(P.modelContext('claude-haiku-4-5'), 200_000)
  assert.equal(P.modelContext('claude-sonnet-4-6'), 1_000_000)
  assert.equal(P.modelContext('claude-opus-4-8[1m]'), 1_000_000)
  assert.equal(P.modelContext('some-unknown-model'), 200_000, 'unknown → conservative, never assume 1M')
  // a small model yields a small usable budget (floor 50k), never the 1M default
  assert.ok(P.usableContext({ model_context: P.modelContext('some-unknown-model') }) <= 200_000)
})
