// src/pipeline/env-fingerprint.js
//
// Stage 0.6 — Deep environment fingerprint. ARCHON's tech detection is coarse
// (php/java/node); to generate STACK-SPECIFIC payloads (Adobe AEM → AEM payloads)
// and WAF-vendor-specific bypasses, the AI needs the exact product + WAF. This
// module builds the fingerprint prompt and normalizes the LLM's JSON answer into
// a stable shape the strategist + specialists consume. Pure + fail-soft: any bad
// output → an empty-but-valid fingerprint, and downstream runs generically.
//
// Shape: { product, version, frameworks[], server, waf:{present,vendor},
//          notable_paths[], cve_candidates[], confidence }

'use strict'

const EMPTY = Object.freeze({
  product: '', version: '', frameworks: [], server: '',
  waf: { present: false, vendor: '' }, notable_paths: [], cve_candidates: [], confidence: 'low',
})

function buildFingerprintPrompt({ targetUrl, wafStatus, techStack, reconDump, endpointData, jsBundleData } = {}) {
  return `You are a target-fingerprinting analyst on a web pentest. From the recon evidence below, identify
the EXACT technology stack so the team can craft stack-specific payloads. Name the specific product/CMS/
framework and version when the evidence supports it (e.g. "Adobe AEM 6.5", "WordPress 6.4", "Spring Boot",
"Magento 2", "Sitecore") — not just the runtime ("php"/"java"). Infer ONLY from evidence; do not guess
wildly. If a signal is absent, leave the field empty.

Target: ${targetUrl || '(unknown)'}
Coarse tech hint (headers): ${techStack || '(none)'}
WAF status (Phase 0): ${wafStatus || '(unknown)'}

RECON ACTIVITY (headers, server banners, cookies, error pages):
${(reconDump || '(none)').slice(0, 6000)}

ENDPOINT MAP / NOTABLE PATHS:
${(endpointData || '(none)').slice(0, 4000)}

JS-BUNDLE SIGNALS (build metadata, framework hints):
${(jsBundleData || '(none)').slice(0, 3000)}

Output ONE JSON object and NOTHING else (no prose, no code fence):
{"product":"<specific product or empty>","version":"<version or empty>","frameworks":["<framework>",...],
"server":"<server software>","waf":{"present":<true|false>,"vendor":"<Cloudflare|Akamai|Imperva|AWS|F5|...|empty>"},
"notable_paths":["</admin>","</crx/>",...],"cve_candidates":["CVE-id or product-class advisory keyword",...],
"confidence":"high|medium|low"}`
}

// Pull the first JSON object out of possibly-fenced/prose-wrapped LLM text.
function _extractJson(text) {
  if (!text) return null
  const s = String(text)
  const start = s.indexOf('{')
  const end = s.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  try { return JSON.parse(s.slice(start, end + 1)) } catch { return null }
}

function _strArr(v) {
  if (!Array.isArray(v)) return []
  return v.map(x => String(x || '').trim()).filter(Boolean).slice(0, 25)
}

// Normalize raw LLM output (string or object) → the stable fingerprint shape.
function normalizeFingerprint(raw) {
  const o = (raw && typeof raw === 'object') ? raw : _extractJson(raw)
  if (!o || typeof o !== 'object') return { ...EMPTY, waf: { ...EMPTY.waf } }
  const waf = (o.waf && typeof o.waf === 'object') ? o.waf : {}
  const conf = String(o.confidence || '').toLowerCase()
  return {
    product: String(o.product || '').trim(),
    version: String(o.version || '').trim(),
    frameworks: _strArr(o.frameworks),
    server: String(o.server || '').trim(),
    waf: {
      present: waf.present === true || /detected/i.test(String(waf.present || '')),
      vendor: String(waf.vendor || '').trim(),
    },
    notable_paths: _strArr(o.notable_paths),
    cve_candidates: _strArr(o.cve_candidates),
    confidence: ['high', 'medium', 'low'].includes(conf) ? conf : 'low',
  }
}

// A compact, human-readable line for injecting into specialist prompts.
function fingerprintSummary(fp) {
  if (!fp || (!fp.product && !fp.server && !fp.waf?.present)) return ''
  const bits = []
  if (fp.product) bits.push(`Product: ${fp.product}${fp.version ? ' ' + fp.version : ''}`)
  if (fp.frameworks?.length) bits.push(`Frameworks: ${fp.frameworks.join(', ')}`)
  if (fp.server) bits.push(`Server: ${fp.server}`)
  if (fp.waf?.present) bits.push(`WAF: ${fp.waf.vendor || 'present (vendor unknown)'}`)
  if (fp.cve_candidates?.length) bits.push(`CVE leads: ${fp.cve_candidates.join(', ')}`)
  return bits.join(' · ')
}

module.exports = { buildFingerprintPrompt, normalizeFingerprint, fingerprintSummary, EMPTY }
