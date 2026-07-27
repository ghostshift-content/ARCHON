'use strict'

class Router {
  constructor() {
    this.routes = []
  }

  add(method, pattern, handler) {
    const names = []
    const source = pattern.replace(/:[A-Za-z_][A-Za-z0-9_]*/g, token => {
      names.push(token.slice(1))
      return '([^/]+)'
    })
    this.routes.push({ method, pattern, regex: new RegExp(`^${source}$`), names, handler })
  }

  async dispatch(req, res, context) {
    const url = new URL(req.url, context.origin)
    for (const route of this.routes) {
      if (route.method !== req.method) continue
      const match = url.pathname.match(route.regex)
      if (!match) continue
      const params = Object.fromEntries(route.names.map((name, i) => [name, decodeURIComponent(match[i + 1])]))
      return route.handler(req, res, { ...context, params, query: Object.fromEntries(url.searchParams) })
    }
    return false
  }
}

module.exports = { Router }
