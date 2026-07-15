'use strict'
// M2: agent registry maps existing agent names → clean roles/specialties/modes, descriptively (observe-only).
const { test } = require('node:test')
const assert = require('node:assert/strict')
const R = require('../src/agents/registry')

test('existing agent names remain valid and map to clean roles', () => {
  assert.equal(R.roleOf('CURATOR'), 'mission_lead')
  assert.equal(R.roleOf('curator'), 'mission_lead') // case-insensitive
  assert.equal(R.roleOf('MARSHAL'), 'specialist')
  assert.equal(R.roleOf('QUILL'), 'freehand_reviewer')
  assert.equal(R.roleOf('TRIAGER'), 'triage')
  assert.equal(R.roleOf('AUDITOR'), 'auditor')
  assert.equal(R.roleOf('ARBITER'), 'judge')
  assert.equal(R.roleOf('SCRIBE'), 'reporter')
})

test('specialties + class lookup', () => {
  assert.ok(R.specialtiesOf('CIPHER').includes('xss'))
  assert.ok(R.specialtiesOf('MARSHAL').includes('access-control'))
  assert.ok(R.agentsForClass('xss').includes('CIPHER'))
  assert.ok(R.agentsForClass('access-control').includes('MARSHAL'))
})

test('role grouping + full roster', () => {
  assert.ok(R.byRole('specialist').length >= 5)
  assert.ok(R.byRole('mission_lead').includes('CURATOR'))
  assert.ok(R.byRole('mission_lead').includes('ATLAS'))
  assert.ok(R.all().length >= 20, 'the whole ARCHON roster is registered')
})

test('unknown agent is fail-soft (null / empty), never throws', () => {
  assert.equal(R.get('does-not-exist'), null)
  assert.equal(R.roleOf('does-not-exist'), null)
  assert.deepEqual(R.specialtiesOf('does-not-exist'), [])
})
