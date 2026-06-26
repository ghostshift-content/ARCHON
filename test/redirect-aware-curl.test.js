const test = require('node:test')
const assert = require('node:assert')
const { isCorsAssertion, extractFinalResponse } = require('../agents/redirect-aware-curl')

test('isCorsAssertion: detects ACAO assertion in expected_result string', () => {
  assert.strictEqual(isCorsAssertion('access-control-allow-origin: https://evil.com'), true)
  assert.strictEqual(isCorsAssertion('Access-Control-Allow-Credentials: true'), true)
})

test('isCorsAssertion: detects via expected_keywords array', () => {
  assert.strictEqual(
    isCorsAssertion('', ['access-control-allow-origin', 'something_else']),
    true
  )
})

test('isCorsAssertion: false when no CORS keyword present', () => {
  assert.strictEqual(isCorsAssertion('HTTP/1.1 200 OK\nServer: nginx'), false)
  assert.strictEqual(isCorsAssertion('', ['x-frame-options']), false)
})

test('extractFinalResponse: returns last HTTP response block when multi-hop', () => {
  const raw = [
    'HTTP/1.1 301 Moved Permanently',
    'access-control-allow-origin: https://evil.com',
    'location: https://final.example.com/',
    '',
    'HTTP/1.1 200 OK',
    'content-type: text/html',
    '',
    '<html>final</html>',
    'HTTP/STATUS/200',
  ].join('\n')
  const final = extractFinalResponse(raw)
  assert.match(final, /200 OK/)
  assert.doesNotMatch(final, /access-control-allow-origin/i)
})

test('extractFinalResponse: returns full input when no redirects', () => {
  const raw = 'HTTP/1.1 200 OK\naccess-control-allow-origin: *\n\n<body>\nHTTP/STATUS/200'
  const final = extractFinalResponse(raw)
  assert.match(final, /200 OK/)
  assert.match(final, /access-control-allow-origin/i)
})

test('extractFinalResponse: handles HTTP/2 and HTTP/1.0 status lines', () => {
  const raw = 'HTTP/2 301\nlocation: /x\n\nHTTP/2 200\ncontent-length: 5\n\nhello\nHTTP/STATUS/200'
  const final = extractFinalResponse(raw)
  assert.match(final, /HTTP\/2 200/)
  assert.doesNotMatch(final, /301/)
})
