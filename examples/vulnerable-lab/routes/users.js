'use strict'

const { users, publicUser } = require('../data/store')
const { requireUser } = require('../middleware/auth')
const { body, json } = require('../lib/http')

function register(router) {
  router.add('GET', '/api/users/:id', async (req, res, ctx) => {
    if (!requireUser(req, res, json)) return
    // Intentional IDOR: no ownership or administrator check.
    const user = users.find(row => row.id === Number(ctx.params.id))
    return user ? json(res, 200, publicUser(user)) : json(res, 404, { error: 'not found' })
  })

  router.add('PATCH', '/api/users/:id', async (req, res, ctx) => {
    if (!requireUser(req, res, json)) return
    const user = users.find(row => row.id === Number(ctx.params.id))
    if (!user) return json(res, 404, { error: 'not found' })
    // Intentional mass assignment plus IDOR.
    Object.assign(user, await body(req))
    return json(res, 200, publicUser(user))
  })
}

module.exports = { register }
