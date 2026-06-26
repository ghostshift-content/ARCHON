// test/js-bundle-analyzer-ast.test.js
//
// AST-based endpoint extraction. Cases the existing regex misses:
//   1. Endpoints in TEMPLATE LITERALS  (`/api/users/${id}` → /api/users/...)
//   2. Endpoints split across CONCATENATION  ('/api/' + 'v1/printLog')
//   3. Endpoints as OBJECT PROPERTY VALUES nested inside config objects
// Regex extraction is kept; AST extraction UNIONS its results with regex.

const assert = require('node:assert')
const { test } = require('node:test')
const ast = require('../agents/js-bundle-analyzer-ast')

test('extracts plain string literal endpoints', () => {
  const code = `const url = "/api/v1/users";`
  const endpoints = ast.extractEndpointsFromAst(code)
  assert.ok(endpoints.includes('/api/v1/users'),
    `expected /api/v1/users, got ${JSON.stringify(endpoints)}`)
})

test('extracts template literal endpoints (regex misses these)', () => {
  const code = "const url = `/api/users/${userId}`;"
  const endpoints = ast.extractEndpointsFromAst(code)
  // Template literal — should yield the static prefix as an endpoint
  assert.ok(endpoints.some(e => e.startsWith('/api/users')),
    `expected /api/users prefix, got ${JSON.stringify(endpoints)}`)
})

test('extracts concatenated endpoints (regex splits these)', () => {
  const code = `const path = '/api/' + 'v1/printLog';`
  const endpoints = ast.extractEndpointsFromAst(code)
  // Either the concat result OR both parts must include the path
  assert.ok(
    endpoints.includes('/api/v1/printLog') ||
    endpoints.some(e => /\/api\/?$/.test(e)) ||
    endpoints.some(e => /printLog/.test(e)),
    `expected concatenated path detection, got ${JSON.stringify(endpoints)}`,
  )
})

test('extracts endpoints from nested object property values', () => {
  const code = `
    const routes = {
      auth: { login: '/api/auth/login', logout: '/api/auth/logout' },
      user: { profile: '/api/user/profile' }
    };
  `
  const endpoints = ast.extractEndpointsFromAst(code)
  assert.ok(endpoints.includes('/api/auth/login'),
    `expected /api/auth/login in ${JSON.stringify(endpoints)}`)
  assert.ok(endpoints.includes('/api/user/profile'),
    `expected /api/user/profile in ${JSON.stringify(endpoints)}`)
})

test('returns empty on un-parseable JS without throwing', () => {
  const code = `this is not { valid javascript $@#`
  const endpoints = ast.extractEndpointsFromAst(code)
  assert.ok(Array.isArray(endpoints))
  assert.strictEqual(endpoints.length, 0)
})

test('ignores non-API strings (avoids noise like CSS, log text)', () => {
  const code = `
    const css = "/* this is a css comment */";
    const msg = "User logged in successfully";
    const apiPath = "/api/v1/data";
  `
  const endpoints = ast.extractEndpointsFromAst(code)
  assert.ok(endpoints.includes('/api/v1/data'))
  assert.ok(!endpoints.some(e => /css comment|logged in/.test(e)),
    `should not include log/css text, got ${JSON.stringify(endpoints)}`)
})

test('caps result length to avoid runaway extraction', () => {
  // Build a fake bundle with 500 distinct path strings
  let code = ''
  for (let i = 0; i < 500; i++) {
    code += `const p${i} = '/api/route${i}';\n`
  }
  const endpoints = ast.extractEndpointsFromAst(code)
  assert.ok(endpoints.length <= 200, `expected ≤200 results, got ${endpoints.length}`)
})
