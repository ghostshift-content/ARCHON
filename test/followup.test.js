'use strict'
// F11: follow-up classification — only NEW_FEATURE enters mapping; missing deps resolve or become coverage gaps.
const { test } = require('node:test'); const assert = require('node:assert/strict')
const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path')
const F = require('../src/runtime/followup')
test('classify + entersFeatureMapping', () => {
  assert.equal(F.classify({ name: 'user-notifications' }), 'NEW_FEATURE')
  assert.equal(F.classify({ name: 'ApplicationController' }), 'MISSING_DEPENDENCY')
  assert.equal(F.classify({ name: 'Order' }), 'MISSING_DEPENDENCY')
  assert.equal(F.classify({ reason: 'requires a live request/response to confirm' }), 'LIVE_VALIDATION_TASK')
  assert.equal(F.classify({ reason: 'could chain with the IDOR to escalate' }), 'ATTACK_CHAIN_LEAD')
  assert.ok(F.entersFeatureMapping('NEW_FEATURE'))
  assert.ok(!F.entersFeatureMapping('MISSING_DEPENDENCY') && !F.entersFeatureMapping('SOURCE_COVERAGE_GAP'))
})
test('resolveMissingDependency: found in repo vs truly absent (fail-soft)', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'fu-'))
  fs.writeFileSync(path.join(d, 'app.rb'), 'class Order; end')
  assert.equal(F.resolveMissingDependency('Order', d), 'resolved')
  assert.equal(F.resolveMissingDependency('NonExistentThing', d), 'coverage_gap')
  fs.rmSync(d, { recursive: true, force: true })
})
