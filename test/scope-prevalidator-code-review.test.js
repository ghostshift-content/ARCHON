// test/scope-prevalidator-code-review.test.js
//
// Regression guard: Phase 0.0 scope pre-validation must find a code-review
// dispatch's source tree where it actually lives — dispatch.meta.sourceDir.
//
// The dashboard/UI and the code-review dispatcher carry the source path under
// dispatch.meta.sourceDir, but squad-policy/code-review.extractTarget used to
// read only dispatch.sourceDir/dispatch.target. So validateDispatch() returned
// BLOCKED ("no target extractable") for every white-box run that had a scope
// config — the source path was never evaluated against scope at all.

'use strict'
const __roots = require('../paths') // portable roots (KURU_*_ROOT) — see paths.js

const { test } = require('node:test')
const assert = require('node:assert/strict')

const policy = require((__roots.AGENTS_ROOT + '/agents/squad-policy/code-review'))
const { validateDispatch, PREDISPATCH_STATUS } = require((__roots.AGENTS_ROOT + '/agents/scope-prevalidator'))

const SRC = '/tmp/archon-cr-src'

test('extractTarget reads meta.sourceDir (where the UI/dispatcher put it)', () => {
  assert.equal(policy.extractTarget({ meta: { sourceDir: SRC } }), SRC)
})

test('extractTarget still reads a top-level sourceDir/target (back-compat)', () => {
  assert.equal(policy.extractTarget({ sourceDir: SRC }), SRC)
  assert.equal(policy.extractTarget({ target: SRC }), SRC)
})

test('extractTarget returns null when no source path anywhere', () => {
  assert.equal(policy.extractTarget({ meta: { preset: 'generic' } }), null)
  assert.equal(policy.extractTarget({}), null)
})

test('validateDispatch ALLOWS a meta.sourceDir dispatch whose path is in scope', () => {
  const res = validateDispatch(
    { taskId: 't1', meta: { sourceDir: SRC } },
    policy,
    { in_scope: [SRC] }
  )
  assert.equal(res.status, PREDISPATCH_STATUS.ALLOWED, res.reason)
})

test('validateDispatch BLOCKS a meta.sourceDir dispatch whose path is NOT in scope', () => {
  const res = validateDispatch(
    { taskId: 't2', meta: { sourceDir: SRC } },
    policy,
    { in_scope: ['/some/other/tree'] }
  )
  assert.equal(res.status, PREDISPATCH_STATUS.BLOCKED, res.reason)
})

test('validateDispatch still BLOCKS when no source path is extractable', () => {
  const res = validateDispatch(
    { taskId: 't3', meta: { preset: 'generic' } },
    policy,
    { in_scope: [SRC] }
  )
  assert.equal(res.status, PREDISPATCH_STATUS.BLOCKED, res.reason)
})
