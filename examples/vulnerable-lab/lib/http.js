'use strict'

function json(res, status, value, headers = {}) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', ...headers })
  res.end(JSON.stringify(value))
}

function html(res, status, value, headers = {}) {
  res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', ...headers })
  res.end(value)
}

async function body(req) {
  const chunks = []
  for await (const chunk of req) {
    chunks.push(chunk)
    if (chunks.reduce((n, b) => n + b.length, 0) > 1024 * 1024) throw new Error('body too large')
  }
  if (!chunks.length) return {}
  const raw = Buffer.concat(chunks).toString('utf8')
  if ((req.headers['content-type'] || '').includes('application/json')) return JSON.parse(raw)
  return Object.fromEntries(new URLSearchParams(raw))
}

module.exports = { body, html, json }
