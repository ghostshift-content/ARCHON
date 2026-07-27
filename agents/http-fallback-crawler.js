'use strict'

// Dependency-free application mapper used when optional crawlers are absent.
// It stays same-origin, fetches GET pages only, caps response size/page count,
// records HTML links/forms, and imports linked OpenAPI path declarations.

function _attrs(tag) {
  const out = {}
  for (const match of tag.matchAll(/([:\w-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g)) {
    out[match[1].toLowerCase()] = match[2] ?? match[3] ?? match[4] ?? ''
  }
  return out
}

function _sameOriginUrl(value, base, origin) {
  try {
    const url = new URL(value, base)
    if (url.origin !== origin || !['http:', 'https:'].includes(url.protocol)) return null
    url.hash = ''
    return url
  } catch {
    return null
  }
}

function _htmlSignals(html, pageUrl, origin) {
  const links = []
  const forms = []

  for (const match of html.matchAll(/<(?:a|link|script)\b[^>]*(?:href|src)\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s>]+))[^>]*>/gi)) {
    const url = _sameOriginUrl(match[1] || match[2] || match[3], pageUrl, origin)
    if (url) links.push(url.href)
  }

  for (const match of html.matchAll(/<form\b[^>]*>[\s\S]*?<\/form>/gi)) {
    const tag = match[0]
    const open = tag.match(/<form\b[^>]*>/i)?.[0] || '<form>'
    const attrs = _attrs(open)
    const action = _sameOriginUrl(attrs.action || pageUrl, pageUrl, origin)
    if (!action) continue
    const inputs = []
    for (const field of tag.matchAll(/<(?:input|textarea|select)\b[^>]*>/gi)) {
      const name = _attrs(field[0]).name
      if (name) inputs.push(name)
    }
    forms.push({
      method: String(attrs.method || 'GET').toUpperCase(),
      action: action.href,
      path: action.pathname,
      params: [...new Set(inputs)],
      source: 'builtin-html-form',
    })
  }

  return { links: [...new Set(links)], forms }
}

function _openApiEndpoints(value) {
  if (!value || typeof value !== 'object' || !value.paths || typeof value.paths !== 'object') return []
  const endpoints = []
  const methods = new Set(['get', 'post', 'put', 'patch', 'delete', 'options', 'head'])
  for (const [routePath, operations] of Object.entries(value.paths)) {
    if (!operations || typeof operations !== 'object') continue
    for (const method of Object.keys(operations)) {
      if (!methods.has(method.toLowerCase())) continue
      const params = [...String(routePath).matchAll(/\{([^}]+)\}/g)].map(match => match[1])
      endpoints.push({
        method: method.toUpperCase(),
        path: routePath,
        params,
        source: 'builtin-openapi',
      })
    }
  }
  return endpoints
}

async function crawl(target, options = {}) {
  const root = new URL(target)
  const origin = root.origin
  const maxPages = Math.max(1, Math.min(Number(options.maxPages || 100), 500))
  const timeoutMs = Math.max(500, Math.min(Number(options.timeoutMs || 8000), 30000))
  const maxBytes = Math.max(1024, Math.min(Number(options.maxBytes || 1024 * 1024), 4 * 1024 * 1024))
  const queue = [root.href]
  const queued = new Set(queue)
  const visited = new Set()
  const urls = new Set()
  const forms = []
  const endpoints = []
  const errors = []

  while (queue.length && visited.size < maxPages) {
    const next = queue.shift()
    if (visited.has(next)) continue
    visited.add(next)

    try {
      const response = await fetch(next, {
        redirect: 'manual',
        signal: AbortSignal.timeout(timeoutMs),
        headers: { accept: 'text/html,application/json,application/yaml;q=0.8,*/*;q=0.2' },
      })
      urls.add(next)

      if (response.status >= 300 && response.status < 400) {
        const redirect = _sameOriginUrl(response.headers.get('location') || '', next, origin)
        if (redirect && !queued.has(redirect.href)) {
          queued.add(redirect.href)
          queue.push(redirect.href)
        }
        continue
      }

      const raw = Buffer.from(await response.arrayBuffer()).subarray(0, maxBytes).toString('utf8')
      const contentType = response.headers.get('content-type') || ''
      if (contentType.includes('html') || /^\s*<!doctype html|^\s*<html/i.test(raw)) {
        const signals = _htmlSignals(raw, next, origin)
        forms.push(...signals.forms)
        endpoints.push(...signals.forms)
        for (const href of signals.links) {
          urls.add(href)
          if (!queued.has(href)) {
            queued.add(href)
            queue.push(href)
          }
        }
      } else if (contentType.includes('json') || /^\s*\{/.test(raw)) {
        try {
          endpoints.push(..._openApiEndpoints(JSON.parse(raw)))
        } catch {}
      }
    } catch (error) {
      errors.push({ url: next, error: String(error.message || error) })
    }
  }

  const uniqueEndpoints = new Map()
  for (const endpoint of endpoints) {
    const key = `${endpoint.method}:${endpoint.path}`
    const prior = uniqueEndpoints.get(key)
    if (!prior || (endpoint.params || []).length > (prior.params || []).length) uniqueEndpoints.set(key, endpoint)
  }

  return {
    urls: [...urls],
    forms,
    endpoints: [...uniqueEndpoints.values()],
    pagesFetched: visited.size,
    errors,
  }
}

module.exports = { crawl, _htmlSignals, _openApiEndpoints }
