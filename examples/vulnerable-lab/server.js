'use strict'

const http = require('node:http')
const config = require('./config')
const { Router } = require('./lib/router')
const auth = require('./routes/auth')
const content = require('./routes/content')
const integrations = require('./routes/integrations')
const orders = require('./routes/orders')
const system = require('./routes/system')
const users = require('./routes/users')
const { json } = require('./lib/http')

if (!['127.0.0.1', 'localhost', '::1'].includes(config.host)) {
  throw new Error('The intentionally vulnerable lab may only bind to loopback')
}

function createApp() {
  const router = new Router()
  for (const module of [system, auth, users, orders, content, integrations]) module.register(router)

  return http.createServer(async (req, res) => {
    res.setHeader('x-powered-by', 'MerchantSupport/1.4.2')
    try {
      const handled = await router.dispatch(req, res, {
        origin: `http://${config.host}:${config.port}`,
      })
      if (!handled && !res.writableEnded) json(res, 404, { error: 'route not found' })
    } catch (error) {
      json(res, 500, { error: error.message, stack: error.stack })
    }
  })
}

if (require.main === module) {
  createApp().listen(config.port, config.host, () => {
    console.log(`ARCHON vulnerable lab listening on http://${config.host}:${config.port}`)
  })
}

module.exports = { createApp }
