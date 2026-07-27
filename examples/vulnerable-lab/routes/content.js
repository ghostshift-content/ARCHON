'use strict'

const path = require('node:path')
const fs = require('node:fs')
const { comments } = require('../data/store')
const { currentUser } = require('../middleware/auth')
const { body, html, json } = require('../lib/http')
const { searchOrders } = require('../services/search-service')

const uploadRoot = path.join(__dirname, '..', 'uploads')

function register(router) {
  router.add('GET', '/api/search', async (_req, res, ctx) => {
    const result = searchOrders(ctx.query.q || '')
    return json(res, 200, result)
  })

  router.add('POST', '/api/comments', async (req, res) => {
    const user = currentUser(req)
    const input = await body(req)
    const comment = {
      id: comments.length + 1,
      userId: user ? user.id : null,
      body: String(input.body || ''),
      createdAt: new Date().toISOString(),
    }
    comments.push(comment)
    return json(res, 201, comment)
  })

  router.add('GET', '/comments', async (_req, res) => {
    // Intentional stored XSS: untrusted comment bodies are inserted without escaping.
    const rows = comments.map(comment => `<li data-id="${comment.id}">${comment.body}</li>`).join('')
    return html(res, 200, `<!doctype html><title>Comments</title><h1>Customer comments</h1><ul>${rows}</ul>`)
  })

  router.add('GET', '/api/files', async (_req, res, ctx) => {
    // Intentional path traversal: no basename or resolved-path containment check.
    const file = path.join(uploadRoot, ctx.query.name || 'welcome.txt')
    try {
      return json(res, 200, { name: ctx.query.name, content: fs.readFileSync(file, 'utf8') })
    } catch {
      return json(res, 404, { error: 'file not found' })
    }
  })
}

module.exports = { register }
