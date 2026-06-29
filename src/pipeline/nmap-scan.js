'use strict'
// nmap-scan.js — deterministic, daemon-run service scan. The "heart truth".
//
// The user gives http://<target> (often no port), but the real attack surface is
// every open port/service on the HOST — FTP, SSH, a web app on :3000, an API on
// :8080, a DB, etc. Letting an LLM recon agent "remember" to run nmap is flaky and
// its output never becomes a structured artifact the pipeline keys off. So we run
// nmap ourselves, ONCE, before the recon agents, and write nmap-<taskId>.json that
// every downstream agent + the crawl read as ground truth.
//
// Scan: nmap -sV -p- --min-rate 3000 -T4 --open  (all 65535 ports, version detect,
// fast). Connect scan (unprivileged) so it runs without root. Bounded by a timeout.

const { execFile } = require('node:child_process')

// host from a URL or bare host:port — port-agnostic (we scan the whole host)
function extractHost(target) {
  const t = String(target || '').trim()
  try { return new URL(/^[a-z]+:\/\//i.test(t) ? t : 'http://' + t).hostname }
  catch { return t.replace(/^[a-z]+:\/\//i, '').split('/')[0].split(':')[0] }
}

// parse nmap -oX XML → [{port, proto, state, service, product, version}] (open only)
function parseNmapXml(xml) {
  const ports = []
  const portRe = /<port\s+protocol="(\w+)"\s+portid="(\d+)">([\s\S]*?)<\/port>/g
  let m
  while ((m = portRe.exec(String(xml || '')))) {
    const [, proto, portid, body] = m
    if (((body.match(/<state\s+state="(\w+)"/) || [])[1] || '') !== 'open') continue
    const svc = (body.match(/<service\s+([^>]*?)\/?>/) || [])[1] || ''
    const attr = k => (svc.match(new RegExp(`${k}="([^"]*)"`)) || [])[1] || ''
    ports.push({ port: +portid, proto, state: 'open', service: attr('name'), product: attr('product'), version: attr('version') })
  }
  return ports
}

const HTTP_SVC = /^(http|https|http-alt|http-proxy|https-alt|ssl\/http|sslhttp|ssl)$/i
const WEB_PORTS = new Set([80, 443, 8080, 8000, 8443, 3000, 5000, 8888, 9000, 8081, 4000, 8001])
// every web service → a URL the pipeline should crawl/test (default ports drop the :port)
function httpServicesOf(host, ports) {
  const urls = []
  for (const p of ports) {
    const https = /https|ssl/i.test(p.service) || p.port === 443 || p.port === 8443
    if (!(HTTP_SVC.test(p.service) || WEB_PORTS.has(p.port))) continue
    const scheme = https ? 'https' : 'http'
    const isDefault = (scheme === 'https' && p.port === 443) || (scheme === 'http' && p.port === 80)
    urls.push(isDefault ? `${scheme}://${host}` : `${scheme}://${host}:${p.port}`)
  }
  return [...new Set(urls)]
}

function runNmapScan(target, { timeoutMs = 8 * 60 * 1000, ip } = {}) {
  return new Promise(resolve => {
    // scan the box IP when given (hostname targets that aren't in DNS); else the URL host.
    // httpServices still report the original host so the vhost flows downstream.
    const host = (ip && /^(\d{1,3}\.){3}\d{1,3}$/.test(ip)) ? ip : extractHost(target)
    if (!host || !/^[a-zA-Z0-9.\-]+$/.test(host)) {
      return resolve({ ok: false, host, error: 'invalid host', ports: [], httpServices: [] })
    }
    const args = ['-sV', '-p-', '--min-rate', '3000', '-T4', '--open', '-oX', '-', host]
    execFile('nmap', args, { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 }, (err, stdout) => {
      const ports = parseNmapXml(stdout)
      if (!ports.length && err) {
        return resolve({ ok: false, host, error: err.killed ? `timeout after ${Math.round(timeoutMs / 60000)}min` : err.message, ports: [], httpServices: [] })
      }
      resolve({ ok: true, host, scannedAt: new Date().toISOString(), command: 'nmap ' + args.join(' '),
        ports, httpServices: httpServicesOf(host, ports) })
    })
  })
}

// one-line summary for logs/recon panel: "21/tcp ftp vsftpd 3.0.3, 22/tcp ssh ..."
function nmapSummary(r) {
  if (!r || !r.ok || !r.ports.length) return ''
  return r.ports.map(p => `${p.port}/${p.proto} ${p.service || '?'}${p.product ? ' ' + p.product : ''}${p.version ? ' ' + p.version : ''}`).join(', ')
}

// authoritative block injected into every agent prompt
function nmapPromptBlock(r, nmapFilePath) {
  if (!r || !r.ok || !r.ports.length) return ''
  const rows = r.ports.map(p => `  - ${p.port}/${p.proto} — ${p.service || 'unknown'}${p.product ? ` (${p.product}${p.version ? ' ' + p.version : ''})` : ''}`).join('\n')
  const web = r.httpServices.length
    ? `\nWeb services discovered (test EVERY one, not just the URL in your task):\n${r.httpServices.map(u => '  - ' + u).join('\n')}`
    : ''
  return `\n## AUTHORITATIVE NMAP — HEART TRUTH (read FIRST, test EVERY service)\nA full -p- -sV service scan ALREADY RAN on the host. This is ground truth — every open port/service:\n${rows}${web}\nDO NOT re-run a full port scan (no \`nmap -p-\`, no \`-T2/--max-rate\` sweeps) — it is DONE and wastes ~25 min. Only run a targeted \`nmap -sV -sC -p <known-port>\` on a specific service if you need deeper version/script detail. Test EVERY service above (FTP, SSH, web on any port, APIs, DBs) — do NOT limit yourself to the single URL in your task. Raw scan: cat ${nmapFilePath} 2>/dev/null\n`
}

module.exports = { runNmapScan, extractHost, parseNmapXml, httpServicesOf, nmapSummary, nmapPromptBlock }

// self-check: parse a representative nmap XML (run directly)
if (require.main === module) {
  const assert = require('node:assert')
  const xml = `<nmaprun><host><ports>
    <port protocol="tcp" portid="21"><state state="open"/><service name="ftp" product="vsftpd" version="3.0.3"/></port>
    <port protocol="tcp" portid="22"><state state="open"/><service name="ssh" product="OpenSSH"/></port>
    <port protocol="tcp" portid="3000"><state state="open"/><service name="http" product="Node.js Express"/></port>
    <port protocol="tcp" portid="9999"><state state="closed"/><service name="x"/></port>
  </ports></host></nmaprun>`
  const ports = parseNmapXml(xml)
  assert.strictEqual(ports.length, 3, `expected 3 open ports, got ${ports.length}`)
  assert.strictEqual(ports[0].service, 'ftp')
  assert.strictEqual(ports[0].version, '3.0.3')
  const web = httpServicesOf('10.0.0.1', ports)
  assert.deepStrictEqual(web, ['http://10.0.0.1:3000'], `web services: ${JSON.stringify(web)}`)
  assert.strictEqual(extractHost('http://10.0.0.1/foo'), '10.0.0.1')
  assert.strictEqual(extractHost('10.0.0.1:3000'), '10.0.0.1')
  console.log('ok — nmap XML parse + httpServices + host extraction')
}
