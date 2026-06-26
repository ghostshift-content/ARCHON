// test/chain-verifier-semantic-match.test.js

const assert = require('node:assert')
const { test } = require('node:test')
const cv = require('../src/pipeline/chain-verifier')

test('match_mode=strict (default) — schema accepted, not rejected', () => {
  const r = cv.verifyChain({
    id: 't', name: 't', severity: 'Low',
    steps: [{
      step_id: 1, description: 'x',
      curl: 'curl http://127.0.0.1:1/nonexistent',
      expected_result: 'EXACT-STRING-NOT-IN-RESPONSE',
      match_mode: 'strict',
    }],
  }, { dryRun: true })
  assert.notStrictEqual(r.stepResults[0].status, 'rejected')
})

test('match_mode=semantic accepts keyword set match', () => {
  const r = cv.semanticMatch('HTTP/2 200 OK\nContent-Type: text/plain\n\nadmin: true', {
    keywords: ['admin', 'root', 'unauthorized'],
    status_code_range: [200, 299],
    actual_status_code: 200,
  })
  assert.strictEqual(r.matched, true)
  assert.ok(r.matched_keywords.includes('admin'))
})

test('semantic match fails when no keyword present', () => {
  const r = cv.semanticMatch('HTTP/2 404 Not Found', {
    keywords: ['admin', 'root'],
    status_code_range: [200, 299],
    actual_status_code: 404,
  })
  assert.strictEqual(r.matched, false)
  assert.match(r.reason, /status_code|keyword/)
})

test('semantic match status-code-range honored (201 within 200-299)', () => {
  const r = cv.semanticMatch('HTTP/2 201 Created\n\ncreated', {
    keywords: ['created', 'success'],
    status_code_range: [200, 299],
    actual_status_code: 201,
  })
  assert.strictEqual(r.matched, true)
})
