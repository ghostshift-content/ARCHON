const test = require('node:test')
const assert = require('node:assert')
const { filterChainsAgainstValidatedFindings } = require('../agents/scribe-chain-orphan-guard')

test('chain with all backed finding_ids passes', () => {
  const chains = [{ id: 'CHAIN-001', finding_ids: ['F-001', 'F-002'], severity: 'High' }]
  const validated = [{ id: 'F-001' }, { id: 'F-002' }]
  const r = filterChainsAgainstValidatedFindings(chains, validated)
  assert.strictEqual(r.kept.length, 1)
  assert.strictEqual(r.dropped.length, 0)
})

test('chain with 0 backed finding_ids is dropped', () => {
  const chains = [{ id: 'CHAIN-002', finding_ids: ['F-X', 'F-Y'], severity: 'Critical' }]
  const validated = [{ id: 'F-001' }]
  const r = filterChainsAgainstValidatedFindings(chains, validated)
  assert.strictEqual(r.kept.length, 0)
  assert.strictEqual(r.dropped.length, 1)
  assert.strictEqual(r.dropped[0].id, 'CHAIN-002')
  assert.match(r.dropped[0].reason, /no validated findings back this chain/i)
})

test('chain with partial backing — drop by default (require all)', () => {
  const chains = [{ id: 'CHAIN-003', finding_ids: ['F-001', 'F-MISSING'], severity: 'High' }]
  const validated = [{ id: 'F-001' }]
  const r = filterChainsAgainstValidatedFindings(chains, validated)
  assert.strictEqual(r.kept.length, 0)
  assert.strictEqual(r.dropped.length, 1)
  assert.match(r.dropped[0].reason, /F-MISSING/)
})

test('chain with empty finding_ids array is dropped', () => {
  const chains = [{ id: 'CHAIN-004', finding_ids: [], severity: 'Medium' }]
  const r = filterChainsAgainstValidatedFindings(chains, [{ id: 'F-001' }])
  assert.strictEqual(r.kept.length, 0)
  assert.match(r.dropped[0].reason, /finding_ids is empty/i)
})

test('chain with missing finding_ids field is dropped (defensive)', () => {
  const chains = [{ id: 'CHAIN-005', severity: 'Critical' }]
  const r = filterChainsAgainstValidatedFindings(chains, [{ id: 'F-001' }])
  assert.strictEqual(r.kept.length, 0)
  assert.match(r.dropped[0].reason, /finding_ids missing/i)
})

test('no chains → no kept, no dropped', () => {
  const r = filterChainsAgainstValidatedFindings([], [{ id: 'F-001' }])
  assert.deepStrictEqual(r.kept, [])
  assert.deepStrictEqual(r.dropped, [])
})

test('input is null/undefined → empty result', () => {
  assert.deepStrictEqual(filterChainsAgainstValidatedFindings(null, []), { kept: [], dropped: [] })
  assert.deepStrictEqual(filterChainsAgainstValidatedFindings([], null), { kept: [], dropped: [] })
})

test('chains with non-object members are skipped silently', () => {
  const chains = [
    null,
    { id: 'CHAIN-OK', finding_ids: ['F-A'] },
    'not an object',
    42,
  ]
  const r = filterChainsAgainstValidatedFindings(chains, [{ id: 'F-A' }])
  assert.strictEqual(r.kept.length, 1)
  assert.strictEqual(r.kept[0].id, 'CHAIN-OK')
  assert.strictEqual(r.dropped.length, 0)
})

// ── Sprint B Task B3.5: alternative chain shape extraction ──
// Constructor may emit chain.finding_ids, OR chain.steps[].finding_id,
// OR chain.stepResults[].finding_id (projected after Phase 3.6 execution),
// OR chain.finding_id (singular). Guard must normalize across all shapes.

test('extracts finding_ids from steps[].finding_id when finding_ids missing', () => {
  const chain = {
    id: 'CHAIN-X',
    steps: [{ finding_id: 'F-001' }, { finding_id: 'F-002' }],
  }
  const r = filterChainsAgainstValidatedFindings([chain], [{ id: 'F-001' }, { id: 'F-002' }])
  assert.strictEqual(r.kept.length, 1)
  assert.strictEqual(r.dropped.length, 0)
})

test('extracts finding_ids from stepResults[].finding_id when steps missing', () => {
  const chain = {
    id: 'CHAIN-Y',
    stepResults: [{ finding_id: 'F-001' }, { finding_id: 'F-003' }],
  }
  const r = filterChainsAgainstValidatedFindings([chain], [{ id: 'F-001' }, { id: 'F-003' }])
  assert.strictEqual(r.kept.length, 1)
})

test('extracts finding_id (singular) when no array forms present', () => {
  const chain = { id: 'CHAIN-Z', finding_id: 'F-X' }
  const r = filterChainsAgainstValidatedFindings([chain], [{ id: 'F-X' }])
  assert.strictEqual(r.kept.length, 1)
})

test('extracts nothing when no shape present — drops', () => {
  const chain = { id: 'CHAIN-NONE', severity: 'High' }
  const r = filterChainsAgainstValidatedFindings([chain], [{ id: 'F-001' }])
  assert.strictEqual(r.dropped.length, 1)
  assert.match(r.dropped[0].reason, /no finding ids extractable|finding_ids missing/i)
})

test('explicit finding_ids takes precedence over steps[].finding_id', () => {
  const chain = {
    id: 'CHAIN-PRIO',
    finding_ids: ['F-A'],
    steps: [{ finding_id: 'F-B' }],
  }
  // explicit says F-A — must be checked against validated (only F-A here)
  const r = filterChainsAgainstValidatedFindings([chain], [{ id: 'F-A' }])
  assert.strictEqual(r.kept.length, 1)
  // explicit says F-A — validated only has F-B → drop
  const r2 = filterChainsAgainstValidatedFindings([chain], [{ id: 'F-B' }])
  assert.strictEqual(r2.dropped.length, 1)
})
