'use strict'

const fs = require('fs')
const path = require('path')

const NETWORK_COMMAND = /\b(curl|wget|httpx|nmap|nikto|nuclei|sqlmap|ffuf|feroxbuster|gobuster|dirsearch|dig|nslookup|ping|openssl\s+s_client)\b/i
const GENERIC_NETWORK_RUNTIME = /\b(python\d*|node|ruby|php|perl|nc|netcat|socat|ssh|scp|telnet|ftp|git)\b|\/dev\/(?:tcp|udp)\//i
const URL_PATTERN = /\bhttps?:\/\/[^\s"'`<>()[\]{}]+/gi
const HOST_AFTER_TOOL = /\b(?:curl|wget|httpx|nmap|nikto|nuclei|sqlmap|ffuf|feroxbuster|gobuster|dirsearch|dig|nslookup|ping)\b(?:\s+--?[a-z0-9_-]+(?:[=\s]+[^\s]+)?)*\s+([a-z0-9*_.:-]+)(?=\s|$)/gi
const MUTATING_METHOD = /\bcurl\b[\s\S]*?(?:-X|--request)\s*(DELETE|PUT|PATCH)\b/i

function _deny(reason) {
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: `ARCHON scope contract: ${reason}`,
    },
  }
}

function _entries(scope = {}) {
  const raw = scope.in_scope || scope.hosts || scope.scope_domains || []
  const rows = Array.isArray(raw) ? raw : []
  return rows.map(value => {
    if (value && typeof value === 'object') return value.host || value.hostname || value.url || ''
    return String(value || '')
  }).filter(Boolean)
}

function _host(value) {
  try { return new URL(value).hostname.toLowerCase() } catch {}
  return String(value || '').toLowerCase()
    .replace(/^[a-z]+:\/\//, '')
    .split('/')[0]
    .replace(/:\d+$/, '')
}

function _matchHost(host, pattern) {
  const target = _host(host)
  const allowed = _host(pattern)
  if (!target || !allowed) return false
  if (allowed.startsWith('*.')) {
    const suffix = allowed.slice(2)
    return target === suffix || target.endsWith(`.${suffix}`)
  }
  return target === allowed
}

function hostAllowed(host, scope) {
  const denied = scope && (scope.out_of_scope || scope.hosts_deny || scope.scope_excludes || [])
  if ((Array.isArray(denied) ? denied : []).some(pattern => _matchHost(host, pattern))) return false
  return _entries(scope).some(pattern => _matchHost(host, pattern))
}

function _globPath(value, pattern) {
  const escaped = String(pattern || '').replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')
  return new RegExp(`^${escaped}$`).test(String(value || ''))
}

function _pathRules(scope, kind) {
  const direct = kind === 'deny'
    ? (scope.paths_deny || scope.path_deny || scope.pathsDeny || [])
    : (scope.paths_allow || scope.path_allow || scope.pathsAllow || [])
  return (Array.isArray(direct) ? direct : []).map(String).filter(Boolean)
}

function targetAllowed(value, scope) {
  let url
  try { url = new URL(value) } catch { return hostAllowed(value, scope) }
  if (!hostAllowed(url.hostname, scope)) return false
  const pathname = url.pathname || '/'
  if (_pathRules(scope || {}, 'deny').some(rule => _globPath(pathname, rule))) return false
  const allow = _pathRules(scope || {}, 'allow')
  return !allow.length || allow.some(rule => _globPath(pathname, rule))
}

function _urls(input) {
  const text = typeof input === 'string' ? input : JSON.stringify(input || {})
  return [...new Set(text.match(URL_PATTERN) || [])]
}

function _networkTargets(command) {
  const targets = _urls(command)
  for (const match of String(command || '').matchAll(HOST_AFTER_TOOL)) {
    if (match[1] && !match[1].startsWith('-')) targets.push(match[1])
  }
  return [...new Set(targets)]
}

function _under(file, roots, allowedFiles = []) {
  const exact = new Set(allowedFiles.map(value => path.resolve(value)))
  if (!path.isAbsolute(file)) {
    if (String(file).split(/[\\/]/).includes('..')) return false
    return roots.some(root => {
      try { return fs.existsSync(path.resolve(root, file)) } catch { return false }
    })
  }
  const resolved = path.resolve(file)
  if (exact.has(resolved)) return true
  return roots.some(root => {
    const base = path.resolve(root)
    return resolved === base || resolved.startsWith(`${base}${path.sep}`)
  })
}

function createToolScopeGate(options = {}) {
  const mode = String(options.mode || 'static').toLowerCase()
  const scope = options.scope || {}
  const roots = (options.sourceRoots || []).filter(Boolean)
  const allowedFiles = (options.allowedFiles || []).filter(Boolean)
  const hardLimits = scope.hard_limits || {}
  const hostRequests = new Map()

  function rateAllowed(value) {
    const limit = Number(hardLimits.max_rps_per_host)
    if (!Number.isFinite(limit) || limit <= 0) return true
    const host = _host(value)
    const now = Date.now()
    const recent = (hostRequests.get(host) || []).filter(ts => now - ts < 1_000)
    if (recent.length >= limit) return false
    recent.push(now)
    hostRequests.set(host, recent)
    return true
  }

  return async function toolScopeGate(input) {
    const tool = String(input && input.tool_name || '')
    const toolInput = input && input.tool_input || {}

    if (mode === 'static' || mode === 'whitebox') {
      if (tool === 'Bash' || tool === 'BashOutput') {
        return _deny('source review sessions are read-only and cannot execute shell commands')
      }
      const candidatePath = toolInput.file_path || toolInput.path || toolInput.directory
      if (candidatePath && (roots.length || allowedFiles.length) &&
          !_under(String(candidatePath), roots, allowedFiles)) {
        return _deny(`path is outside the authorized source roots: ${candidatePath}`)
      }
    }

    if (mode === 'blackbox') {
      const directUrls = _urls(toolInput)
      for (const url of directUrls) {
        if (!targetAllowed(url, scope)) return _deny(`network target or path is out of scope: ${_host(url)}`)
      }
      if ((tool === 'Bash' || tool === 'BashOutput') && NETWORK_COMMAND.test(String(toolInput.command || ''))) {
        if (hardLimits.destructive_actions === false && MUTATING_METHOD.test(String(toolInput.command || ''))) {
          return _deny('destructive HTTP methods are disabled by the scope contract')
        }
        const targets = _networkTargets(toolInput.command)
        if (!targets.length) return _deny('network command has no unambiguous in-scope target')
        for (const target of targets) {
          if (!targetAllowed(target, scope)) return _deny(`network target or path is out of scope: ${_host(target)}`)
        }
      } else if ((tool === 'Bash' || tool === 'BashOutput') &&
          GENERIC_NETWORK_RUNTIME.test(String(toolInput.command || ''))) {
        return _deny('generic network-capable runtimes are not allowed; use a scope-checked network tool')
      }
      for (const target of directUrls.length ? directUrls : _networkTargets(toolInput.command || '')) {
        if (!rateAllowed(target)) return _deny(`per-host request rate exceeded for ${_host(target)}`)
      }
    }

    return {}
  }
}

module.exports = { createToolScopeGate, hostAllowed, targetAllowed }
