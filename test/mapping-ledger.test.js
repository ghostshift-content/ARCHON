'use strict'
// S2: the mapping ledger — every feature tracked, terminal-status completion gate, additive reconciliation.
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path')
const L = require('../src/dispatch/mapping-ledger')

const batches = [
  { id: 'auth_identity-1', domain: 'auth_identity', risk: 'high', owner: 'marshal', features: [{ slug: 'login', name: 'Login', risk_hint: 'high' }, { slug: 'reset', name: 'Reset' }] },
  { id: 'search_browse-1', domain: 'search_browse', risk: 'normal', owner: 'cipher', features: [{ slug: 'search', name: 'Search' }] },
]

test('build: every feature tracked with owner/batch/risk, all queued', () => {
  const l = L.build('t1', batches)
  assert.equal(l.features_total, 3); assert.equal(l.features_done, 0); assert.equal(l.batches_total, 2)
  assert.equal(l.features.login.owner, 'marshal'); assert.equal(l.features.login.batch, 'auth_identity-1')
  assert.equal(l.features.login.risk, 'high'); assert.equal(l.features.reset.status, 'queued')
  assert.ok(!L.isComplete(l))
})

test('setFeature rolls up features_done + batches_done; completion gate needs ALL terminal', () => {
  let l = L.build('t1', batches)
  l = L.setFeature(l, 'login', { status: 'done', depth: 'fast' })
  l = L.setFeature(l, 'reset', { status: 'merged' })
  assert.equal(l.features_done, 2)
  assert.equal(l.batches_done, 1, 'auth batch done')
  assert.ok(!L.isComplete(l), 'search still queued')
  l = L.setFeature(l, 'search', { status: 'non_security' })
  assert.ok(L.isComplete(l), 'every feature terminal → complete')
})

test('addFeatures (reconciliation): adds new, never overwrites, reopens the gate', () => {
  let l = L.build('t1', batches)
  for (const s of ['login', 'reset', 'search']) l = L.setFeature(l, s, { status: 'done' })
  assert.ok(L.isComplete(l))
  l = L.addFeatures(l, [{ slug: 'login', name: 'DUP' }, { slug: 'oauth', name: 'OAuth', risk_hint: 'high' }], 'auth_identity-2')
  assert.equal(l.features.login.name, 'Login', 'existing not overwritten')
  assert.equal(l.features.oauth.status, 'queued')
  assert.ok(!L.isComplete(l), 'a new queued feature reopens completion')
})

test('S6 reconcileFollowups: new vs duplicate vs invalid (A3 — no-slug is surfaced, never dropped)', () => {
  const led = L.build('t', [{ id: 'b1', domain: 'auth_identity', owner: 'marshal', features: [{ slug: 'login', name: 'Login' }] }])
  const { newFeatures, duplicates, invalid } = L.reconcileFollowups([
    { slug: 'login', name: 'dup of existing' },
    { slug: 'oauth', name: 'OAuth' },
    { slug: 'oauth', name: 'OAuth again' }, // dedup within the list
    { name: 'no slug here' },               // invalid → surfaced (becomes a blocker downstream)
  ], led)
  assert.equal(newFeatures.length, 1); assert.equal(newFeatures[0].slug, 'oauth')
  assert.equal(duplicates.length, 1); assert.equal(duplicates[0].slug, 'login')
  assert.equal(invalid.length, 1)
})

test('S6 pending: non-terminal features feed the completion gate', () => {
  let led = L.build('t', [{ id: 'b1', domain: 'x', owner: 'a', features: [{ slug: 'a' }, { slug: 'b' }] }])
  led = L.setFeature(led, 'a', { status: 'done' })
  assert.equal(L.pending(led).length, 1)       // b still queued
  assert.equal(L.pending(led)[0].slug, 'b')
  led = L.setFeature(led, 'b', { status: 'blocked' }) // gate marks it a coverage gap
  assert.equal(L.pending(led).length, 0); assert.ok(L.isComplete(led))
})

test('S7 renderGateMd: counts, coverage gaps, ledger table', () => {
  let led = L.build('t', [{ id: 'b1', domain: 'auth_identity', risk: 'high', owner: 'marshal', features: [{ slug: 'login' }, { slug: 'reset' }] }])
  led = L.setFeature(led, 'login', { status: 'done', depth: 'deep_complete' })
  led = L.setFeature(led, 'reset', { status: 'blocked' })
  const md = L.renderGateMd(led)
  assert.match(md, /Phase 1 Completion Gate/)
  assert.match(md, /Coverage gaps \(blocked: 1\)/)
  assert.match(md, /login/); assert.match(md, /reset/)
  led = L.setFeature(led, 'reset', { status: 'done' })
  assert.match(L.renderGateMd(led), /No coverage gaps/)
})

test('blockers surfaced; save/load round-trip', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-'))
  let l = L.build('t1', batches)
  l = L.setFeature(l, 'login', { status: 'blocked' })
  assert.equal(L.blockers(l).length, 1)
  L.save(dir, l)
  const r = L.load(dir)
  assert.equal(r.features.login.status, 'blocked'); assert.equal(r.features_total, 3)
  assert.equal(L.load(path.join(dir, 'nope')), null) // missing → null (fail-soft)
})

test('rejects duplicate feature slugs across batches', () => {
  assert.throws(() => {
    L.build('task1', [
      {
        id: 'batch-a',
        features: [
          {
            slug: 'login'
          }
        ]
      },
      {
        id: 'batch-b',
        features: [
          {
            slug: 'login'
          }
        ]
      }
    ])
  }, /duplicate feature slug/)
})