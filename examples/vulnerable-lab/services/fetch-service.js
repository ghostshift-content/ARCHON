'use strict'

async function fetchUrl(rawUrl) {
  const target = new URL(rawUrl)
  // Keep this intentionally vulnerable feature safe for a local lab: requests can
  // reach loopback services but never external or link-local destinations.
  if (!['127.0.0.1', 'localhost'].includes(target.hostname)) {
    return { blockedByLabSafety: true, status: 403, body: 'lab permits loopback SSRF proof only' }
  }
  const response = await fetch(target, { redirect: 'manual' })
  return { status: response.status, body: (await response.text()).slice(0, 4096) }
}

module.exports = { fetchUrl }
