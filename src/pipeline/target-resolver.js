'use strict'
// target-resolver.js — deterministic canonical-target / virtual-host resolution.
//
// The operator types http://10.129.41.38, but the app is a vhost at
// http://aegis.korvia.htb:3000 — the IP 301-redirects to the name, the app only
// serves correctly with Host: aegis.korvia.htb, and that name isn't in DNS. Nothing
// in Phase 0 follows redirects AND sets a Host header, so every probe hits the wrong
// vhost. This runs after nmap, probes each web service, detects the real vhost, and
// pins canonical-target-<taskId>.json that every daemon probe + agent + crawl keys off.

const { execFileSync } = require('node:child_process')
const dns = require('node:dns/promises')
const fs = require('node:fs')
const { extractHost } = require('./nmap-scan')

const IPV4 = /^(\d{1,3}\.){3}\d{1,3}$/
const isIp = h => IPV4.test(String(h || ''))
// redirect hosts that are edge/CDN canonicalization, NOT vhosts of this app
const CDN_RE = /(cloudflare|akamai|fastly|cloudfront|azureedge|edgekey|edgesuite|incapsula|sucuri|googleusercontent|amazonaws)/i
const sanitizeHost = h => String(h || '').replace(/[^a-zA-Z0-9.\-]/g, '').slice(0, 253)

function hostOf(u) { try { return new URL(u).hostname } catch { return '' } }

// one curl probe → {status, size, redirectUrl}. No -L (we want the single-hop redirect).
// Uses execFileSync (array args, no shell). hostArg sends a Host header to the IP.
function _curlProbe(url, { hostArg, timeoutMs = 10000 } = {}) {
  const args = ['-s', '-o', '/dev/null', '-w', '%{http_code}|%{size_download}|%{redirect_url}',
    '--max-time', String(Math.max(2, Math.ceil(timeoutMs / 1000)))]
  if (hostArg) args.push('-H', 'Host: ' + hostArg)
  args.push(url)
  try {
    const out = execFileSync('curl', args, { timeout: timeoutMs + 2000, encoding: 'utf8' }).trim()
    const [code, size, redirect] = out.split('|')
    return { status: +code || 0, size: +size || 0, redirectUrl: redirect || '' }
  } catch { return { status: 0, size: 0, redirectUrl: '' } }
}

// material difference between two responses = different status OR ≥256-byte body delta
function _materialDiff(a, b) {
  if (!a || !b) return false
  if (a.status !== b.status) return true
  return Math.abs((a.size || 0) - (b.size || 0)) >= 256
}

function _buildCanon({ input, ip, vhost, scheme, port, evidence, webServices, inDns, inHosts, unresolved }) {
  vhost = vhost ? sanitizeHost(vhost) : null
  const defaultPort = (scheme === 'https' && port === 443) || (scheme === 'http' && port === 80)
  const hostForUrl = vhost || ip || extractHost(input)
  const canonical_url = unresolved ? input
    : `${scheme}://${hostForUrl}${defaultPort ? '' : ':' + port}`
  return {
    input, ip: ip || null, vhost: vhost || null, scheme, port,
    canonical_url,
    requires_host_header: !!vhost,
    resolve_mapping: vhost && ip ? `${vhost}:${port}:${ip}` : null,
    in_dns: !!inDns, in_hosts: !!inHosts,
    detection: vhost ? { method: '301-location+host-header-diff', evidence: evidence || '' } : null,
    unresolved: !!unresolved,
    web_services: Array.isArray(webServices) ? webServices : [],
    resolvedAt: undefined, // stamped by caller after the fact (Date.* unavailable in some contexts)
  }
}

// pick the box IP: dns → meta.boxIp → sole in-scope IP literal → null (unresolved)
async function resolveInputIp(input, meta = {}, scope = {}) {
  const host = extractHost(input)
  if (isIp(host)) return host
  try { const r = await dns.lookup(host); if (r && r.address) return r.address } catch {}
  if (meta && isIp(meta.boxIp)) return meta.boxIp
  const ips = ((scope && scope.in_scope) || []).map(s => String(s).split('/')[0].split(':')[0]).filter(isIp)
  if (ips.length === 1) return ips[0]
  return null
}

// resolve the canonical target. _probe injectable for the offline self-check.
async function resolveTarget(input, { ip, httpServices = [], timeoutMs = 60000, _probe = _curlProbe } = {}) {
  const inHost = extractHost(input)
  if (!ip && isIp(inHost)) ip = inHost
  const perProbe = Math.min(12000, Math.max(4000, Math.floor(timeoutMs / 3)))
  const services = httpServices.length ? httpServices : [input]

  let primary = null
  for (const svc of services) {
    let u; try { u = new URL(/^[a-z]+:\/\//i.test(svc) ? svc : 'http://' + svc) } catch { continue }
    const scheme = u.protocol.replace(':', '')
    const port = +(u.port || (scheme === 'https' ? 443 : 80))
    const svcIp = ip || (isIp(u.hostname) ? u.hostname : null)
    if (!svcIp) continue
    const baseUrl = `${scheme}://${svcIp}${port === (scheme === 'https' ? 443 : 80) ? '' : ':' + port}/`
    const noHost = _probe(baseUrl, { timeoutMs: perProbe })

    let vhost = null, evidence = ''
    // case A: the operator typed a hostname (not the IP) → test it as the vhost
    if (!isIp(inHost) && inHost && inHost !== svcIp) {
      const wh = _probe(baseUrl, { hostArg: inHost, timeoutMs: perProbe })
      if (wh.status === 200 || _materialDiff(noHost, wh)) {
        vhost = inHost; evidence = `Host:${inHost} → ${wh.status}/${wh.size} vs no-host ${noHost.status}/${noHost.size}`
      }
    }
    // case B: the IP redirects (301/302) to a different, non-CDN host → that's the vhost
    if (!vhost && (noHost.status === 301 || noHost.status === 302) && noHost.redirectUrl) {
      const rh = hostOf(noHost.redirectUrl)
      if (rh && rh.toLowerCase() !== svcIp && !isIp(rh) && !CDN_RE.test(rh)) {
        const wh = _probe(baseUrl, { hostArg: rh, timeoutMs: perProbe })
        if (_materialDiff(noHost, wh)) {
          vhost = rh; evidence = `IP ${noHost.status}→${rh}; Host:${rh} → ${wh.status}/${wh.size} vs ${noHost.status}/${noHost.size}`
        }
      }
    }

    const built = { input, ip: svcIp, vhost, scheme, port, evidence, webServices: httpServices }
    if (vhost) { primary = built; break }       // a confirmed vhost wins immediately
    if (!primary) primary = built               // else remember the first service as the fallback
  }

  if (!primary) {
    if (!ip) return _buildCanon({ input, scheme: 'http', port: 80, unresolved: true, webServices: httpServices })
    return _buildCanon({ input, ip, vhost: null, scheme: 'http', port: 80, webServices: httpServices })
  }
  // DNS / hosts status for the chosen vhost (best-effort, fail-soft)
  let inDns = false, inHosts = false
  if (primary.vhost) {
    try { await dns.lookup(primary.vhost); inDns = true } catch {}
    try { inHosts = new RegExp(`\\b${primary.vhost.replace(/[.\-]/g, '\\$&')}\\b`).test(fs.readFileSync('/etc/hosts', 'utf8')) } catch {}
  }
  return _buildCanon({ ...primary, inDns, inHosts })
}

// shell-string fragment for the daemon's execSync curls (validated, injection-safe)
function curlResolveArgs(canon) {
  if (!canon || !canon.vhost || !canon.resolve_mapping) return ''
  const vhost = sanitizeHost(canon.vhost)
  const map = canon.resolve_mapping.split(':')
  if (map.length !== 3 || !isIp(map[2])) return ''
  return ` --resolve ${vhost}:${canon.port}:${map[2]} -H "Host: ${vhost}"`
}

// agent prompt block — read FIRST, every tool must pin the vhost
function canonicalPromptBlock(canon, canonFilePath) {
  if (!canon || canon.unresolved) return ''
  if (!canon.vhost) {
    return `\n## CANONICAL TARGET (Phase 0.45 pinned)\nTest this exact URL: ${canon.canonical_url} — it is the live app surface.\n`
  }
  return `\n## CANONICAL TARGET — HOST RESOLUTION (MANDATORY)
Canonical app URL: ${canon.canonical_url}  (IP ${canon.ip}, port ${canon.port})
The host ${canon.vhost} is NOT in DNS. The bare IP 301-redirects and serves the WRONG vhost.
EVERY curl/ffuf/katana/nuclei/nikto request MUST pin the vhost, using EITHER:
  --resolve ${canon.resolve_mapping}
  -H "Host: ${canon.vhost}"
NEVER hit http://${canon.ip}:${canon.port} with no Host header. Examples:
  curl --resolve ${canon.resolve_mapping} ${canon.canonical_url}/
  ffuf -H "Host: ${canon.vhost}" -u http://${canon.ip}:${canon.port}/FUZZ -w <wordlist>
  nuclei -H "Host: ${canon.vhost}" -u http://${canon.ip}:${canon.port}
Full resolution: cat ${canonFilePath} 2>/dev/null\n`
}

module.exports = { resolveTarget, resolveInputIp, curlResolveArgs, canonicalPromptBlock, isIp }

// self-check (offline, injected probe): one vhost-pinning case + one no-vhost case
if (require.main === module) {
  const assert = require('node:assert')
  ;(async () => {
    // fixture: IP 301→aegis.korvia.htb; Host:aegis returns 200/8431 (material diff)
    const vhostProbe = (url, opts = {}) => opts.hostArg === 'aegis.korvia.htb'
      ? { status: 200, size: 8431, redirectUrl: '' }
      : { status: 301, size: 178, redirectUrl: 'http://aegis.korvia.htb:3000/' }
    const a = await resolveTarget('http://10.129.41.38', { ip: '10.129.41.38', httpServices: ['http://10.129.41.38:3000'], _probe: vhostProbe })
    assert.strictEqual(a.vhost, 'aegis.korvia.htb', `vhost: ${a.vhost}`)
    assert.strictEqual(a.port, 3000)
    assert.strictEqual(a.requires_host_header, true)
    assert.strictEqual(a.resolve_mapping, 'aegis.korvia.htb:3000:10.129.41.38')
    assert.strictEqual(a.canonical_url, 'http://aegis.korvia.htb:3000')
    assert.ok(curlResolveArgs(a).includes('--resolve aegis.korvia.htb:3000:10.129.41.38'))

    // fixture: same content with/without Host (CDN-style) → NO vhost pinned
    const noVhost = (url, opts = {}) => ({ status: 200, size: 5000, redirectUrl: '' })
    const b = await resolveTarget('http://10.129.41.38', { ip: '10.129.41.38', httpServices: ['http://10.129.41.38:80'], _probe: noVhost })
    assert.strictEqual(b.vhost, null, `expected no vhost, got ${b.vhost}`)
    assert.strictEqual(b.requires_host_header, false)
    assert.strictEqual(curlResolveArgs(b), '')

    // CDN redirect must NOT be pinned as a vhost
    const cdn = (url, opts = {}) => opts.hostArg ? { status: 200, size: 9000, redirectUrl: '' }
      : { status: 301, size: 100, redirectUrl: 'https://d123.cloudfront.net/' }
    const c = await resolveTarget('http://1.2.3.4', { ip: '1.2.3.4', httpServices: ['http://1.2.3.4:80'], _probe: cdn })
    assert.strictEqual(c.vhost, null, `CDN should not pin, got ${c.vhost}`)
    console.log('ok — vhost pin + no-vhost + CDN-guard')
  })().catch(e => { console.error('selftest FAILED:', e.message); process.exit(1) })
}
