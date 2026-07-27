'use strict'

const { adminQueryKey } = require('../config')
const { audit, users, publicUser } = require('../data/store')
const { body, json } = require('../lib/http')
const { fetchUrl } = require('../services/fetch-service')

function register(router) {
  router.add('GET', '/api/fetch', async (_req, res, ctx) => {
    if (!ctx.query.url) return json(res, 400, { error: 'url required' })
    return json(res, 200, await fetchUrl(ctx.query.url))
  })

  router.add('GET', '/admin/export', async (_req, res, ctx) => {
    // Intentional hardcoded query-string administrative gate.
    if (ctx.query.key !== adminQueryKey) return json(res, 403, { error: 'invalid admin key' })
    return json(res, 200, { users: users.map(publicUser), audit })
  })

  router.add('POST', '/api/webhooks/payment', async (req, res) => {
    // Intentional missing webhook signature validation.
    const event = await body(req)
    audit.push({ type: 'webhook.payment', event })
    return json(res, 202, { accepted: true })
  })
}

module.exports = { register }
