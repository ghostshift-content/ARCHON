
const __roots = require('../paths') // portable roots (KURU_*_ROOT) — see paths.js
const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')

test('GATE-92: chain-verifier CHAIN_OUTPUT_SCHEMA mentions finding_ids', () => {
  const src = fs.readFileSync((__roots.AGENTS_ROOT + '/src/pipeline/chain-verifier.js'), 'utf8')
  assert.match(src, /finding_ids/,
    'CHAIN_OUTPUT_SCHEMA must include finding_ids field')
})

test('GATE-92: finding_ids is in the schema required list', () => {
  const src = fs.readFileSync((__roots.AGENTS_ROOT + '/src/pipeline/chain-verifier.js'), 'utf8')
  // Look for required array containing finding_ids — tolerant of formatting
  assert.match(src, /required:[^]*finding_ids/,
    'finding_ids must appear in a required array in CHAIN_OUTPUT_SCHEMA')
})

test('GATE-92: Constructor prompt teaches Opus to populate finding_ids', () => {
  const src = fs.readFileSync((__roots.AGENTS_ROOT + '/event-bus.js'), 'utf8')
  // Either the explicit instruction text or the field name in prompt context
  assert.match(src, /finding_ids[^]*confirmed finding|populate.*finding_ids|finding_ids.*confirmed/i,
    'event-bus.js Phase 3.5 Constructor prompt must instruct Opus to populate finding_ids')
})
