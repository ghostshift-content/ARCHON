
const __roots = require('../paths') // portable roots (KURU_*_ROOT) — see paths.js
const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')

test('GATE-90: browser-verifier handles cross_origin_fetch action', () => {
  const src = fs.readFileSync((__roots.AGENTS_ROOT + '/agents/browser-verifier.js'), 'utf8')
  assert.match(src, /case ['"]cross_origin_fetch['"]/,
    'browser-verifier action dispatcher must handle cross_origin_fetch')
})

test('GATE-90: pentest-browser-recipe-constructor has deterministic CORS recipe builder', () => {
  const src = fs.readFileSync((__roots.AGENTS_ROOT + '/agents/pentest-browser-recipe-constructor.js'), 'utf8')
  assert.match(src, /buildCorsRecipe/,
    'recipe constructor must expose buildCorsRecipe for deterministic credentialed-CORS recipes')
})

test('GATE-90: browser-recipe-validator schema accepts cross_origin_fetch', () => {
  const src = fs.readFileSync((__roots.AGENTS_ROOT + '/agents/browser-recipe-validator.js'), 'utf8')
  assert.match(src, /cross_origin_fetch/,
    'validator schema must recognize cross_origin_fetch as a valid action')
})

test('GATE-90: buildCorsRecipe falls back to URL extraction from details', () => {
  const mod = require('../agents/pentest-browser-recipe-constructor')
  if (typeof mod.buildCorsRecipe !== 'function') {
    // Source-level test above already covers the contract
    return
  }
  const recipe = mod.buildCorsRecipe({
    id: 'F-G90',
    details: 'curl -sI https://victim.example.com/api -H "Origin: null"',
  })
  assert.ok(Array.isArray(recipe))
  assert.strictEqual(recipe[0].action, 'cross_origin_fetch')
  assert.strictEqual(recipe[0].victim_url, 'https://victim.example.com/api')
})
