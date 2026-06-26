const test = require('node:test')
const assert = require('node:assert')
const sv = require('../agents/scope-validator')

const SCOPE = {
  in_scope: ['*.example.com'],
  out_of_scope: [],
  infra_dependencies: {}
}

test('GATE-87: scope-validator extracts URL from details when top-level missing', () => {
  const r = sv.validateFindingScope({
    id: 'F-X',
    details: 'curl -sI https://api.example.com/login'
  }, SCOPE)
  assert.strictEqual(r.status, 'in-scope',
    'scope-validator must fall back to details/notes URL extraction')
})

test('GATE-87: scope-validator fail-safe still fires when no URL anywhere', () => {
  const r = sv.validateFindingScope({
    id: 'F-Y',
    details: 'no url here',
    notes: ''
  }, SCOPE)
  assert.strictEqual(r.status, 'out-of-scope')
})
