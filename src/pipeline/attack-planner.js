// src/pipeline/attack-planner.js
//
// Stage 1 — The Strategist. ATLAS reads recon + the env fingerprint and produces
// a RANKED, environment-aware attack plan: which endpoint, which class, why, and
// how hard to prioritize. Specialists then attack the plan's hypotheses for THEIR
// class first (instead of each re-reconning blindly). Pure + fail-soft: bad output
// → empty plan, and specialists run exactly as before.
//
// Hypothesis shape:
//   { id, endpoint, params[], vuln_class, hypothesis, why, priority(1-5),
//     suggested_specialist, cve }

'use strict'

const { checklistText: wstgChecklist } = require('../core/coverage-map')

// Canonical classes the pentest specialists cover (used to bucket hypotheses).
const VULN_CLASSES = [
  'access-control', 'idor', 'auth', 'sqli', 'xss', 'ssrf', 'rce', 'command-injection',
  'ssti', 'xxe', 'lfi', 'csrf', 'business-logic', 'api', 'deserialization', 'other',
]

function buildAttackPlanPrompt({ targetUrl, fingerprint, reconDump, endpointData } = {}) {
  const fp = fingerprint || {}
  const fpLine = [
    fp.product ? `Product: ${fp.product}${fp.version ? ' ' + fp.version : ''}` : '',
    fp.frameworks?.length ? `Frameworks: ${fp.frameworks.join(', ')}` : '',
    fp.server ? `Server: ${fp.server}` : '',
    fp.waf?.present ? `WAF: ${fp.waf.vendor || 'present'}` : '',
    fp.cve_candidates?.length ? `CVE leads: ${fp.cve_candidates.join(', ')}` : '',
  ].filter(Boolean).join(' · ') || '(stack not identified)'

  return `You are ATLAS, the pentest lead. Read the recon evidence + the environment fingerprint and produce
a RANKED ATTACK PLAN: the concrete, highest-value things to attack first. Tie hypotheses to the SPECIFIC
stack — if the product is Adobe AEM, propose AEM-specific attacks (dispatcher bypass, CRX/Sling, known
AEM CVEs); if WordPress, WP-specific; etc. Be specific and evidence-driven, not generic.

Target: ${targetUrl || '(unknown)'}
Environment fingerprint: ${fpLine}

WALK THIS WSTG COVERAGE MAP (the A-Z checklist) against the target — make sure every applicable area has
at least one hypothesis where the evidence supports it; note any area the surface makes irrelevant:
${wstgChecklist()}

RECON / FINDINGS SO FAR:
${(reconDump || '(none)').slice(0, 6000)}

ENDPOINTS / SURFACE:
${(endpointData || '(none)').slice(0, 4000)}

Output ONE JSON array and NOTHING else (no prose, no code fence). Each element:
{"endpoint":"<url or path>","params":["<param>",...],"vuln_class":"<one of: ${VULN_CLASSES.join('|')}>",
"hypothesis":"<what to try, stack-specific>","why":"<evidence that suggests it>","priority":<1-5, 5=highest>,
"suggested_specialist":"<viper|drill|relay|vault|warden|gateway|sentry|keyring|ledger|forge|decoy|spectre|ranger>",
"cve":"<CVE id or empty>"}
Rank by exploitability × impact. 5-15 entries. No padding.`
}

function _extractJsonArray(text) {
  if (!text) return null
  const s = String(text)
  const start = s.indexOf('[')
  const end = s.lastIndexOf(']')
  if (start < 0 || end <= start) return null
  try { const a = JSON.parse(s.slice(start, end + 1)); return Array.isArray(a) ? a : null } catch { return null }
}

function _clampPriority(p) {
  const n = Math.round(Number(p))
  if (!Number.isFinite(n)) return 3
  return Math.min(5, Math.max(1, n))
}

// Normalize raw LLM output (string or array) → ranked, capped hypothesis list.
function normalizePlan(raw) {
  const arr = Array.isArray(raw) ? raw : _extractJsonArray(raw)
  if (!arr) return []
  const out = []
  for (const r of arr) {
    if (!r || typeof r !== 'object') continue
    const vc = String(r.vuln_class || '').toLowerCase().trim()
    const hypothesis = String(r.hypothesis || '').trim()
    if (!hypothesis) continue // a hypothesis with no hypothesis is noise
    out.push({
      endpoint: String(r.endpoint || '').trim(),
      params: Array.isArray(r.params) ? r.params.map(x => String(x || '').trim()).filter(Boolean).slice(0, 10) : [],
      vuln_class: VULN_CLASSES.includes(vc) ? vc : 'other',
      hypothesis,
      why: String(r.why || '').trim(),
      priority: _clampPriority(r.priority),
      suggested_specialist: String(r.suggested_specialist || '').toLowerCase().trim(),
      cve: String(r.cve || '').trim(),
    })
    if (out.length >= 30) break
  }
  // Rank by priority, then number H-1..H-n so H-1 is the top hypothesis.
  out.sort((a, b) => b.priority - a.priority)
  return out.map((h, i) => ({ id: `H-${i + 1}`, ...h }))
}

// Hypotheses relevant to a specialist's vuln class(es). `classes` is a string or array
// of class keys (e.g. WARDEN → ['idor','access-control']).
function planForClasses(plan, classes) {
  if (!Array.isArray(plan) || !plan.length) return []
  const want = (Array.isArray(classes) ? classes : [classes]).map(c => String(c || '').toLowerCase())
  return plan.filter(h => want.includes(h.vuln_class))
}

function planSummary(plan) {
  if (!Array.isArray(plan) || !plan.length) return ''
  const top = plan.slice(0, 3).map(h => `[P${h.priority} ${h.vuln_class}] ${h.hypothesis}`.slice(0, 80))
  return `${plan.length} hypotheses · top: ${top.join(' | ')}`
}

module.exports = { buildAttackPlanPrompt, normalizePlan, planForClasses, planSummary, VULN_CLASSES }
