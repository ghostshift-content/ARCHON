
const __roots = require('../paths') // portable roots (KURU_*_ROOT) — see paths.js
const test = require('node:test')
const assert = require('node:assert')
const { filterChainsAgainstValidatedFindings } = require('../agents/scribe-chain-orphan-guard')

test('GATE-91: orphan chain dropped when no validated backing', () => {
  const r = filterChainsAgainstValidatedFindings(
    [{ id: 'CHAIN-X', finding_ids: ['F-A'], severity: 'Critical' }],
    [{ id: 'F-B' }]
  )
  assert.strictEqual(r.kept.length, 0)
  assert.strictEqual(r.dropped.length, 1)
})

test('GATE-91: backed chain kept', () => {
  const r = filterChainsAgainstValidatedFindings(
    [{ id: 'CHAIN-Y', finding_ids: ['F-A'] }],
    [{ id: 'F-A' }]
  )
  assert.strictEqual(r.kept.length, 1)
})

test('GATE-91: guard extracts finding_ids from steps[].finding_id fallback', () => {
  const r = filterChainsAgainstValidatedFindings(
    [{ id: 'CHAIN-S', steps: [{ finding_id: 'F-S' }] }],
    [{ id: 'F-S' }]
  )
  assert.strictEqual(r.kept.length, 1)
})

test('GATE-91: event-bus.js wires the guard', () => {
  const fs = require('node:fs')
  const src = fs.readFileSync((__roots.AGENTS_ROOT + '/event-bus.js'), 'utf8')
  assert.match(src, /filterChainsAgainstValidatedFindings|scribe-chain-orphan-guard/,
    'event-bus must call the chain-orphan guard before SCRIBE spawn')
})
