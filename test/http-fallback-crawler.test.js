'use strict'

const assert = require('node:assert/strict')
const http = require('node:http')
const { after, before, test } = require('node:test')
const crawler = require('../agents/http-fallback-crawler')

let server
let origin

before(async () => {
  server = http.createServer((req, res) => {
    if (req.url === '/') {
      res.writeHead(200, { 'content-type': 'text/html' })
      return res.end('<a href="/openapi.json">API</a><a href="https://outside.test/no">outside</a><form method="post" action="/login"><input name="email"><input name="password"></form>')
    }
    if (req.url === '/openapi.json') {
      res.writeHead(200, { 'content-type': 'application/json' })
      return res.end(JSON.stringify({ openapi: '3.0.0', paths: { '/users/{id}': { get: {}, patch: {} } } }))
    }
    res.writeHead(404).end()
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  origin = `http://127.0.0.1:${server.address().port}`
})

after(async () => {
  await new Promise(resolve => server.close(resolve))
})

test('dependency-free crawler maps same-origin links, forms, and OpenAPI operations', async () => {
  const result = await crawler.crawl(origin, { maxPages: 10 })
  assert.ok(result.urls.includes(origin + '/'))
  assert.ok(result.urls.includes(origin + '/openapi.json'))
  assert.ok(!result.urls.some(url => url.includes('outside.test')))
  assert.ok(result.endpoints.some(row => row.method === 'POST' && row.path === '/login'))
  assert.ok(result.endpoints.some(row => row.method === 'GET' && row.path === '/users/{id}'))
  assert.ok(result.endpoints.some(row => row.method === 'PATCH' && row.path === '/users/{id}'))
})
