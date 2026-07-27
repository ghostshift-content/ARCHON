'use strict'

const { html, json } = require('../lib/http')

function register(router) {
  router.add('GET', '/', async (_req, res) => {
    return html(res, 200, `<!doctype html>
      <html><head><title>Merchant Support Portal</title></head>
      <body>
        <h1>Merchant Support Portal</h1>
        <nav>
          <a href="/comments">Customer comments</a>
          <a href="/api/health">Service health</a>
          <a href="/api/search?q=report">Order search</a>
          <a href="/api/files?name=welcome.txt">Downloads</a>
          <a href="/openapi.json">API documentation</a>
          <a href="/go?next=/comments">Continue</a>
        </nav>
        <form method="post" action="/api/login">
          <input name="email"><input name="password" type="password"><button>Sign in</button>
        </form>
        <form method="post" action="/api/comments">
          <textarea name="body"></textarea><button>Post comment</button>
        </form>
      </body></html>`)
  })

  router.add('GET', '/openapi.json', async (_req, res) => {
    return json(res, 200, {
      openapi: '3.0.0',
      info: { title: 'Merchant Support API', version: '1.4.2' },
      paths: {
        '/api/login': { post: {} },
        '/api/users/{id}': { get: {}, patch: {} },
        '/api/orders/{id}': { get: {} },
        '/api/orders': { post: {} },
        '/api/orders/{id}/refund': { post: {} },
        '/api/coupons/redeem': { post: {} },
        '/api/search': { get: {} },
        '/api/comments': { post: {} },
        '/api/files': { get: {} },
        '/api/fetch': { get: {} },
        '/api/webhooks/payment': { post: {} },
        '/admin/export': { get: {} },
      },
    })
  })

  router.add('GET', '/api/health', async (_req, res) => {
    return json(res, 200, { ok: true, service: 'merchant-support', environment: 'local-lab' })
  })

  router.add('GET', '/internal/metadata', async (_req, res) => {
    return json(res, 200, {
      instanceRole: 'merchant-support-lab',
      temporaryCredential: 'LAB-ONLY-NOT-A-REAL-CREDENTIAL',
    })
  })

  router.add('GET', '/go', async (_req, res, ctx) => {
    // Intentional open redirect.
    res.writeHead(302, { location: ctx.query.next || '/' })
    res.end()
  })
}

module.exports = { register }
