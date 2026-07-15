'use strict'
// M11: quota governor — hit history → quota state (healthy/warm/constrained/cooling), pure + deterministic.
const { test } = require('node:test')
const assert = require('node:assert/strict')
const G = require('../src/runtime/quota-governor')

const NOW = 1_000_000_000_000

test('M11: no hits → healthy', () => {
  assert.equal(G.stateFrom([], NOW), 'healthy')
})

test('M11: one recent hit → warm; two within 30m → constrained', () => {
  assert.equal(G.stateFrom([{ ts: NOW - 60_000 }], NOW), 'warm')
  assert.equal(G.stateFrom([{ ts: NOW - 60_000 }, { ts: NOW - 30_000 }], NOW), 'constrained')
})

test('M11: hits older than 30m decay back toward healthy', () => {
  assert.equal(G.stateFrom([{ ts: NOW - 40 * 60_000 }], NOW), 'healthy')
})

test('M11: a long active cooldown → cooling (pause review + checkpoint)', () => {
  const s = G.stateFrom([{ ts: NOW - 1000, cooldownMs: 30 * 60_000 }], NOW, NOW + 30 * 60_000)
  assert.equal(s, 'cooling')
  assert.equal(G.shouldPauseReview('cooling'), true)
  assert.equal(G.shouldCheckpoint('cooling'), true)
  assert.equal(G.shouldPauseReview('warm'), false)
})

test('M11: shed order sheds freehand first', () => {
  assert.deepEqual(G.shedOrder(), ['freehand', 'low_priority_review', 'normal_review'])
})

test('M11: live governor tracks hits via injected clock', () => {
  let t = NOW; const gov = G.createGovernor(() => t)
  assert.equal(gov.state(), 'healthy')
  gov.reportHit(); assert.equal(gov.state(), 'warm')
  t += 1000; gov.reportHit(); assert.equal(gov.state(), 'constrained')
  assert.equal(gov.summary().pauseReview, false)
})
