'use strict'
// F5: never silently drop a candidate — repair common LLM-JSON errors, quarantine the rest. F2: coverage.
const { test } = require('node:test'); const assert = require('node:assert/strict')
const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path')
const cr = require('../src/dispatch/code-review-dispatcher')

test('F5: parseCandidateLine repairs lone backslashes (\\A \\z \\d) that broke the path-traversal candidate', () => {
  const bad = '{"feature":"upload","vuln_class":"path-traversal","code_block":"filename =~ /\\A\\.\\./","file":"u.rb"}'
  assert.throws(() => JSON.parse(bad), 'raw is invalid JSON')
  const p = cr.parseCandidateLine(bad)
  assert.ok(p.ok && p.repaired, 'repaired instead of dropped')
  assert.equal(p.c.vuln_class, 'path-traversal')
})
test('F5: valid JSON parses without repair; truly-broken is quarantined (ok:false), never silent', () => {
  const p = cr.parseCandidateLine('{"feature":"x","vuln_class":"xss"}')
  assert.ok(p.ok && !p.repaired)
  const q = cr.parseCandidateLine('{ this is : not json at all ][')
  assert.equal(q.ok, false); assert.equal(q.raw, '{ this is : not json at all ][')
})
test('F5: emitCandidatesFromFile emits repaired + quarantines unrepairable (no silent drop)', () => {
  const INTEL = require('../paths').INTEL_ROOT
  const f = path.join(os.tmpdir(), `cand-${Date.now()}.jsonl`)
  fs.writeFileSync(f, [
    '{"feature":"a","vuln_class":"sqli","file":"a.rb","status":"SOURCE_CONFIRMED"}',
    '{"feature":"b","vuln_class":"path-traversal","code_block":"/\\A/","file":"b.rb","status":"SOURCE_CONFIRMED"}',
    '{ totally broken',
  ].join('\n'))
  let emitted = 0
  const n = cr.emitCandidatesFromFile(f, 'holistic', { slug: 'ws1' }, 'MARSHAL', 't-f5', (tid, rec) => emitted++, () => {}, '/src', 'static')
  assert.equal(n, 2, 'both valid+repaired emitted (the path-traversal survived)')
  assert.equal(emitted, 2)
  const rej = path.join(INTEL, 'rejected-candidates-t-f5.jsonl')
  assert.ok(fs.existsSync(rej) && fs.readFileSync(rej, 'utf8').includes('totally broken'), 'the unrepairable line was quarantined, not dropped')
  fs.rmSync(f, { force: true }); fs.rmSync(rej, { force: true })
})
