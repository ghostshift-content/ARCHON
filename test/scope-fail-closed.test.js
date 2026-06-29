// test/scope-fail-closed.test.js
//
// Phase 0.0 scope pre-validator must FAIL CLOSED: a missing scope config blocks
// the dispatch (a pentest tool must not fire at an undeclared target), unless the
// operator explicitly sets ARCHON_SCOPE_OVERRIDE=1.

const assert = require('node:assert')
const { test } = require('node:test')
const { PREDISPATCH_STATUS, validateDispatch } = require('../agents/scope-prevalidator')

const policy = {
  squad: 'pentest',
  extractTarget: (d) => d.target,
  matchesScope: (t, cfg) => (cfg.inScope || []).includes(t),
}
const dispatch = { taskId: 't1', target: 'app.example.com' }

test('missing scope config → BLOCKED (fail-closed)', () => {
  delete process.env.ARCHON_SCOPE_OVERRIDE
  const r = validateDispatch(dispatch, policy, null)
  assert.strictEqual(r.status, PREDISPATCH_STATUS.BLOCKED)
})

test('missing scope config + ARCHON_SCOPE_OVERRIDE=1 → WARNED (explicit opt-in)', () => {
  process.env.ARCHON_SCOPE_OVERRIDE = '1'
  try {
    const r = validateDispatch(dispatch, policy, null)
    assert.strictEqual(r.status, PREDISPATCH_STATUS.WARNED)
  } finally {
    delete process.env.ARCHON_SCOPE_OVERRIDE
  }
})

test('in-scope target → ALLOWED', () => {
  const r = validateDispatch(dispatch, policy, { inScope: ['app.example.com'] })
  assert.strictEqual(r.status, PREDISPATCH_STATUS.ALLOWED)
})

test('out-of-scope target → BLOCKED', () => {
  const r = validateDispatch(dispatch, policy, { inScope: ['other.example.com'] })
  assert.strictEqual(r.status, PREDISPATCH_STATUS.BLOCKED)
})

test('missing dispatch/policy → BLOCKED', () => {
  assert.strictEqual(validateDispatch(null, policy, {}).status, PREDISPATCH_STATUS.BLOCKED)
  assert.strictEqual(validateDispatch(dispatch, null, {}).status, PREDISPATCH_STATUS.BLOCKED)
})
