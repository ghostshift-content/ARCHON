// src/integrations/proxy-config.js
//
// SINGLE SOURCE OF TRUTH for routing ARCHON's outbound HTTP/HTTPS traffic
// through an intercepting proxy (Burp Suite, OWASP ZAP, mitmproxy, or any
// HTTP(S)/SOCKS proxy). Addresses the roadmap gap documented in
// src/safety/production-safety.js:
//
//   "ARCHON does not proxy the HTTP that the specialist agents fire through
//    their own tools ... A network egress proxy that enforces this for ALL
//    agent traffic is a roadmap item."
//
// WHY A SINGLE MODULE: proxy config is consumed from several very different
// call sites (spawned-subprocess env, Playwright's native `proxy` launch
// option, curl arg augmentation, a raw https.request to api.anthropic.com).
// Each has different shapes for "the proxy". Keeping the parsing/validation
// in one place means every call site gets a consistent operator config
// (ARCHON_PROXY_URL, bypass list, CA cert) instead of five copies drifting.
//
// CONFIG (env vars — set in .env.local or the daemon's shell env):
//
//   ARCHON_PROXY_URL       Proxy URL, e.g. http://127.0.0.1:8080 (Burp's
//                          default listener) or socks5://127.0.0.1:1080.
//                          If unset, falls back to the standard
//                          HTTPS_PROXY / HTTP_PROXY env vars so operators
//                          who already export those get proxying "for free"
//                          (this is also what curl/git/npm honour natively).
//
//   ARCHON_PROXY_ENABLED   Explicit on/off switch.
//                          - unset            → enabled iff a proxy URL was resolved above
//                          - 0/false/off/no   → force DISABLED even if a URL is set
//                                               (quick kill-switch without unsetting env)
//                          - 1/true/on/yes    → force ENABLED (errors if no URL resolved)
//
//   ARCHON_PROXY_BYPASS    Comma-separated extra NO_PROXY entries (e.g.
//                          "*.internal,10.0.0.0/8"). localhost/127.0.0.1/::1
//                          are ALWAYS bypassed regardless of this setting —
//                          routing loopback fixtures through a proxy silently
//                          breaks local/staging targets (see chain-verifier.js).
//
//   ARCHON_PROXY_CA_CERT   Path to a PEM CA certificate to trust IN ADDITION
//                          to Node's default trust store — typically Burp's
//                          "PortSwigger CA" cert exported from
//                          Proxy > Options > Import / export CA certificate.
//                          Forwarded as NODE_EXTRA_CA_CERTS to spawned Node
//                          processes and as `--cacert` to curl. This is the
//                          supported way to make TLS verification PASS
//                          through Burp's MITM without disabling verification.
//
//   ARCHON_PROXY_INSECURE  1/true to skip TLS verification entirely instead
//                          of trusting a CA cert (NODE_TLS_REJECT_UNAUTHORIZED=0,
//                          curl -k). Off by default. Convenient for a quick
//                          lab session; ARCHON_PROXY_CA_CERT is the safer,
//                          recommended option for anything longer-lived.
//
// SCOPE: this module governs (a) the env every specialist-agent subprocess
// tree inherits (agents/runner/adapters/common.js → covers curl, nuclei,
// sqlmap, git, wget, pip, npm, and any other tool/child-process an agent's
// Bash tool invokes), (b) the Playwright browser the browser-verifier agent
// launches, and (c) ARCHON's own direct calls to api.anthropic.com. It does
// NOT change what agents are allowed to do — see src/safety/production-safety.js
// for the destructive-action guardrails, which are unaffected by proxying.
'use strict'

const TRUTHY = /^(1|true|on|yes|enabled)$/i
const FALSY = /^(0|false|off|no|disabled)$/i

let _cache = null

function _resolveUrl() {
  const explicit = process.env.ARCHON_PROXY_URL
  if (explicit && explicit.trim()) return explicit.trim()
  // Fall back to the standard proxy env vars — these already work for curl
  // (chain-verifier.js) and any tool that honours them natively; ARCHON_PROXY_URL
  // just gives operators one canonical, ARCHON-specific way to set it.
  const std = process.env.HTTPS_PROXY || process.env.https_proxy
    || process.env.HTTP_PROXY || process.env.http_proxy
  return std ? std.trim() : ''
}

function _resolveEnabled(url) {
  const flag = String(process.env.ARCHON_PROXY_ENABLED || '').trim()
  if (FALSY.test(flag)) return false
  if (TRUTHY.test(flag)) return true
  // No explicit flag: enabled iff we resolved a URL from somewhere.
  return !!url
}

function _resolveBypass() {
  // Always-bypassed loopback hosts — mirrors chain-verifier.js's existing
  // rationale: a dead/misconfigured proxy must never silently eat requests
  // to local fixtures or staging targets running on the operator's own box.
  const always = ['localhost', '127.0.0.1', '::1']
  const extra = String(process.env.ARCHON_PROXY_BYPASS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  return [...new Set([...always, ...extra])]
}

/**
 * Resolve and validate the proxy configuration from the environment.
 * Cached — re-read explicitly via resetCache() (tests only; config is
 * expected to be stable for the life of the process otherwise).
 *
 * @returns {{enabled: boolean, url: string, bypass: string[], caCert: string|null, insecure: boolean}}
 */
function getProxyConfig() {
  if (_cache) return _cache

  const url = _resolveUrl()
  const enabled = _resolveEnabled(url)

  if (enabled && !url) {
    throw new Error(
      '[proxy-config] ARCHON_PROXY_ENABLED is set but no proxy URL was found. ' +
      'Set ARCHON_PROXY_URL (e.g. http://127.0.0.1:8080 for Burp) or HTTPS_PROXY/HTTP_PROXY.'
    )
  }

  let caCert = null
  if (process.env.ARCHON_PROXY_CA_CERT) {
    const fs = require('fs')
    const p = process.env.ARCHON_PROXY_CA_CERT.trim()
    if (p) {
      if (!fs.existsSync(p)) {
        throw new Error(`[proxy-config] ARCHON_PROXY_CA_CERT points at a missing file: ${p}`)
      }
      caCert = p
    }
  }

  const insecure = TRUTHY.test(String(process.env.ARCHON_PROXY_INSECURE || '').trim())

  _cache = { enabled, url, bypass: _resolveBypass(), caCert, insecure }
  return _cache
}

/** Test-only: clear the cached config so env-var changes take effect. */
function resetCache() {
  _cache = null
}

/**
 * Env vars to MERGE into any subprocess env so it routes through the
 * configured proxy. Returns {} (nothing to merge) when proxying is disabled.
 *
 * Sets both the upper- and lower-case forms of HTTP_PROXY/HTTPS_PROXY/NO_PROXY
 * because tool support is inconsistent (curl/git/most CLIs check both; some
 * check only one or the other — setting both is the pragmatic, widely-used
 * convention, matching what chain-verifier.js already does for NO_PROXY).
 */
function getProxyEnv() {
  const cfg = getProxyConfig()
  if (!cfg.enabled) return {}

  const noProxy = cfg.bypass.join(',')
  const env = {
    HTTP_PROXY: cfg.url,
    http_proxy: cfg.url,
    HTTPS_PROXY: cfg.url,
    https_proxy: cfg.url,
    NO_PROXY: noProxy,
    no_proxy: noProxy,
  }
  if (cfg.caCert) env.NODE_EXTRA_CA_CERTS = cfg.caCert
  if (cfg.insecure) env.NODE_TLS_REJECT_UNAUTHORIZED = '0'
  return env
}

/**
 * Playwright's native `proxy` launch/context option shape, or undefined when
 * proxying is disabled (Playwright treats "key present but undefined" the
 * same as "omit the key", so callers can always spread `{ proxy: getPlaywrightProxyOption() }`).
 */
function getPlaywrightProxyOption() {
  const cfg = getProxyConfig()
  if (!cfg.enabled) return undefined
  return {
    server: cfg.url,
    bypass: cfg.bypass.join(','),
  }
}

/**
 * Extra curl argv entries needed for TLS to work cleanly against an
 * intercepting proxy's MITM certificate. curl already honours
 * HTTP_PROXY/HTTPS_PROXY from the env (getProxyEnv() above) — this only
 * covers the CA-trust / insecure-mode piece, which curl needs as an explicit
 * flag rather than an env var.
 *
 * @returns {string[]}
 */
function getCurlProxyArgs() {
  const cfg = getProxyConfig()
  if (!cfg.enabled) return []
  if (cfg.caCert) return ['--cacert', cfg.caCert]
  if (cfg.insecure) return ['--insecure']
  return []
}

/**
 * A Node `http.Agent` that tunnels HTTPS requests through the configured
 * HTTP(S) proxy via CONNECT, for ARCHON's own direct calls to
 * api.anthropic.com (src/routing/model-router.js's startup model-list
 * validation) — the one piece of "agent" traffic that ISN'T a spawned
 * subprocess, so it can't pick up the proxy via env vars alone the way curl
 * or the claude CLI subprocess do.
 *
 * Deliberately dependency-free (no https-proxy-agent package): a bare CONNECT
 * tunnel is ~30 lines and this is the only call site that needs it. Returns
 * `null` when proxying is disabled, or the target is a SOCKS proxy (SOCKS
 * tunneling needs a real client library — out of scope for this one
 * low-frequency call; the request just goes direct in that case).
 *
 * @returns {import('http').Agent|null}
 */
function getAnthropicApiAgent() {
  const cfg = getProxyConfig()
  if (!cfg.enabled) return null
  if (!/^https?:\/\//i.test(cfg.url)) return null // SOCKS etc. — not supported for this call site

  const http = require('http')
  const https = require('https')
  const { URL } = require('url')
  const proxyUrl = new URL(cfg.url)
  const tlsOpts = {}
  if (cfg.caCert) tlsOpts.ca = require('fs').readFileSync(cfg.caCert)
  if (cfg.insecure) tlsOpts.rejectUnauthorized = false

  class ProxyTunnelAgent extends https.Agent {
    createConnection(options, callback) {
      const connectReq = http.request({
        host: proxyUrl.hostname,
        port: proxyUrl.port || 80,
        method: 'CONNECT',
        path: `${options.host}:${options.port || 443}`,
        headers: { Host: `${options.host}:${options.port || 443}` },
      })
      connectReq.on('connect', (res, socket) => {
        if (res.statusCode !== 200) {
          callback(new Error(`[proxy-config] CONNECT to proxy failed: ${res.statusCode} ${res.statusMessage}`))
          return
        }
        const tlsSocket = require('tls').connect({
          socket,
          servername: options.servername || options.host,
          ...tlsOpts,
        })
        callback(null, tlsSocket)
      })
      connectReq.on('error', callback)
      connectReq.end()
    }
  }

  return new ProxyTunnelAgent()
}

/** One-line human summary for startup logs / `npm run doctor`. Never leaks credentials (URLs here are local proxy addresses, not secrets). */
function describeProxy() {
  const cfg = getProxyConfig()
  if (!cfg.enabled) return 'proxy: disabled'
  const trust = cfg.caCert ? `CA-trusted (${cfg.caCert})` : (cfg.insecure ? 'TLS verification DISABLED' : 'default TLS trust store')
  return `proxy: ${cfg.url} — bypass=[${cfg.bypass.join(', ')}] — ${trust}`
}

module.exports = {
  getProxyConfig,
  getProxyEnv,
  getPlaywrightProxyOption,
  getCurlProxyArgs,
  getAnthropicApiAgent,
  describeProxy,
  resetCache,
}
