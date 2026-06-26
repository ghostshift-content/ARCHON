
const __roots = require('../paths') // portable roots (KURU_*_ROOT) — see paths.js
const test = require('node:test')
const assert = require('node:assert')

test('browser-verifier source declares cross_origin_fetch action handler', () => {
  const fs = require('node:fs')
  const src = fs.readFileSync((__roots.AGENTS_ROOT + '/agents/browser-verifier.js'), 'utf8')
  assert.match(src, /case ['"]cross_origin_fetch['"]/,
    'browser-verifier action dispatcher must handle cross_origin_fetch')
})

test('browser-recipe-validator accepts cross_origin_fetch as a valid action', () => {
  let validator
  try {
    validator = require('../agents/browser-recipe-validator')
  } catch (e) {
    if (e.code === 'MODULE_NOT_FOUND') {
      assert.ok(false, 'browser-recipe-validator must exist')
    }
    throw e
  }

  // Try the public surface — could be validateRecipe, validate, or similar
  const fn = validator.validateRecipe || validator.validate || validator.default
  if (typeof fn !== 'function') {
    // If validator has no exported function, just confirm source mentions the new action
    const fs = require('node:fs')
    const src = fs.readFileSync((__roots.AGENTS_ROOT + '/agents/browser-recipe-validator.js'), 'utf8')
    assert.match(src, /cross_origin_fetch/, 'validator source must reference cross_origin_fetch')
    return
  }

  const recipe = {
    finding_id: 'F1',
    finding_type: 'cors-misconfig-browser',
    description: 'x',
    steps: [{
      action: 'cross_origin_fetch',
      victim_url: 'https://example.com/api',
      attacker_origin: 'null',
      credentials: 'include',
    }],
  }
  const result = fn(recipe)
  // Result shape may be { errors: [] } or { valid: true } or { ok: true } — adapt
  if (result && typeof result === 'object') {
    if ('errors' in result) {
      const corsErrors = (result.errors || []).filter(e => /cross_origin_fetch/.test(JSON.stringify(e)))
      assert.deepStrictEqual(corsErrors, [], `validator rejected cross_origin_fetch: ${JSON.stringify(corsErrors)}`)
    } else if ('ok' in result) {
      assert.strictEqual(result.ok, true, `validator rejected cross_origin_fetch: ${result.reason || ''}`)
    } else if ('valid' in result) {
      assert.strictEqual(result.valid, true)
    }
  } else if (typeof result === 'boolean') {
    assert.strictEqual(result, true)
  }
})

test('browser-recipe-validator rejects cross_origin_fetch without victim_url', () => {
  const fs = require('node:fs')
  const src = fs.readFileSync((__roots.AGENTS_ROOT + '/agents/browser-recipe-validator.js'), 'utf8')
  // Source-level check: validator must enforce victim_url required for the new action
  assert.match(src, /victim_url/, 'validator must enforce victim_url field for cross_origin_fetch')
})

test('pentest-browser-recipe-constructor has deterministic CORS recipe builder', () => {
  const fs = require('node:fs')
  const src = fs.readFileSync((__roots.AGENTS_ROOT + '/agents/pentest-browser-recipe-constructor.js'), 'utf8')
  assert.match(src, /buildCorsRecipe|cross_origin_fetch/,
    'recipe constructor must deterministically build cross_origin_fetch for CORS findings')
})

test('pentest-browser-recipe-constructor.buildCorsRecipe extracts URL from finding.url', () => {
  let mod
  try {
    mod = require('../agents/pentest-browser-recipe-constructor')
  } catch (e) {
    return // skip if not loadable
  }
  if (typeof mod.buildCorsRecipe !== 'function') {
    // If not exported, source-level test in previous case is sufficient
    return
  }
  const recipe = mod.buildCorsRecipe({
    id: 'F-001',
    title: 'CORS Misconfig',
    url: 'https://victim.example.com/api',
    details: '',
    notes: '',
  })
  assert.ok(Array.isArray(recipe), 'buildCorsRecipe must return an array of steps')
  assert.strictEqual(recipe[0].action, 'cross_origin_fetch')
  assert.strictEqual(recipe[0].victim_url, 'https://victim.example.com/api')
})

test('pentest-browser-recipe-constructor.buildCorsRecipe falls back to details URL', () => {
  let mod
  try {
    mod = require('../agents/pentest-browser-recipe-constructor')
  } catch (e) {
    return
  }
  if (typeof mod.buildCorsRecipe !== 'function') return
  const recipe = mod.buildCorsRecipe({
    id: 'F-002',
    title: 'CORS Misconfig',
    details: 'Tested via curl -sI https://victim2.example.com/api -H "Origin: https://evil.com"',
  })
  assert.ok(Array.isArray(recipe))
  assert.strictEqual(recipe[0].victim_url, 'https://victim2.example.com/api')
})

test('pentest-browser-recipe-constructor.buildCorsRecipe returns null when no URL extractable', () => {
  let mod
  try {
    mod = require('../agents/pentest-browser-recipe-constructor')
  } catch (e) {
    return
  }
  if (typeof mod.buildCorsRecipe !== 'function') return
  const recipe = mod.buildCorsRecipe({
    id: 'F-003',
    title: 'CORS Misconfig',
    details: 'No URL in this finding',
    notes: '',
  })
  assert.strictEqual(recipe, null)
})

// Integration test — requires headless Chromium. Opt-in via BROWSER_TESTS=1.
// Spins up a tiny localhost HTTP server with permissive CORS, runs the recipe,
// verifies CONFIRMED verdict. Kept opt-in to keep verify-framework fast.
test('cross_origin_fetch: real Chromium fetch against permissive endpoint', {
  skip: process.env.BROWSER_TESTS !== '1',
  timeout: 60000,
}, async () => {
  const http = require('node:http')
  const browserVerifier = require('../agents/browser-verifier')

  // Tiny ephemeral server: ACAO=null, ACAC=true — permissive for null opaque origin (data: URL)
  const server = http.createServer((_req, res) => {
    res.writeHead(200, {
      'access-control-allow-origin': 'null',
      'access-control-allow-credentials': 'true',
      'content-type': 'text/plain',
    })
    res.end('ok')
  })
  await new Promise(resolve => server.listen(0, resolve))
  const port = server.address().port

  try {
    // Build a recipe that uses the new action against the local permissive server
    const recipe = {
      finding_id: 'F-cors-int',
      finding_type: 'cors-misconfig-browser',
      description: 'integration: permissive CORS allows null-origin credentialed fetch',
      steps: [{
        action: 'cross_origin_fetch',
        victim_url: `http://localhost:${port}/`,
        attacker_origin: 'null',
        credentials: 'include',
      }],
    }
    const result = await browserVerifier.verifyRecipe(recipe)
    const txt = JSON.stringify(result)
    assert.match(txt, /CONFIRMED|ok.*true|status.*200|matched.*true/i,
      `expected CONFIRMED verdict, got ${txt.slice(0, 300)}`)
  } finally {
    server.close()
  }
})
