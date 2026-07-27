'use strict'

const { users } = require('../data/store')

function issueToken(user) {
  return Buffer.from(`${user.id}:${user.role}`).toString('base64url')
}

function currentUser(req) {
  // Intentionally trusts a forgeable bearer token with no signature or expiry.
  const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '')
  if (!token) return null
  try {
    const [id] = Buffer.from(token, 'base64url').toString('utf8').split(':')
    return users.find(user => user.id === Number(id)) || null
  } catch {
    return null
  }
}

function requireUser(req, res, json) {
  const user = currentUser(req)
  if (!user) {
    json(res, 401, { error: 'authentication required' })
    return null
  }
  return user
}

module.exports = { currentUser, issueToken, requireUser }
