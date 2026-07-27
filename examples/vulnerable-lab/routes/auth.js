'use strict'

const { users, publicUser } = require('../data/store')
const { issueToken } = require('../middleware/auth')
const { body, json } = require('../lib/http')

function register(router) {
  router.add('POST', '/api/login', async (req, res) => {
    const input = await body(req)
    const user = users.find(row => row.email === input.email)
    if (!user) return json(res, 404, { error: 'account not found' })
    if (user.password !== input.password) return json(res, 401, { error: 'invalid password' })
    return json(res, 200, { token: issueToken(user), user: publicUser(user) })
  })
}

module.exports = { register }
