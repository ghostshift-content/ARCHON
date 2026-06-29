// src/core/coverage-map.js
//
// The WSTG A-Z coverage map (code source of truth; the human/agent-readable copy
// is common/taxonomy/owasp_wstg.yaml). Lets the strategist walk every test
// category against the fingerprint, and lets the report show what was exercised
// vs not reached. Pure — no deps, no I/O.

'use strict'

// id → { name, owner[] }. Mirrors common/taxonomy/owasp_wstg.yaml.
const WSTG = [
  { id: 'WSTG-INFO', name: 'Information Gathering', owner: ['scout', 'tracer'] },
  { id: 'WSTG-CONF', name: 'Configuration & Deployment', owner: ['scout', 'sentry'] },
  { id: 'WSTG-IDNT', name: 'Identity Management', owner: ['keyring'] },
  { id: 'WSTG-ATHN', name: 'Authentication', owner: ['keyring'] },
  { id: 'WSTG-ATHZ', name: 'Authorization', owner: ['warden'] },
  { id: 'WSTG-SESS', name: 'Session Management', owner: ['keyring'] },
  { id: 'WSTG-INPV', name: 'Input Validation', owner: ['viper', 'drill', 'relay', 'vault', 'spectre', 'ranger'] },
  { id: 'WSTG-ERRH', name: 'Error Handling', owner: ['all'] },
  { id: 'WSTG-CRYP', name: 'Cryptography', owner: ['sentry'] },
  { id: 'WSTG-BUSL', name: 'Business Logic', owner: ['ledger'] },
  { id: 'WSTG-CLNT', name: 'Client-Side', owner: ['decoy', 'viper'] },
  { id: 'WSTG-APIT', name: 'API Testing', owner: ['gateway'] },
]
const BY_ID = Object.fromEntries(WSTG.map(w => [w.id, w]))

// vuln_class / finding-type → WSTG area.
const CLASS_TO_WSTG = {
  xss: 'WSTG-INPV', sqli: 'WSTG-INPV', 'sql injection': 'WSTG-INPV', nosql: 'WSTG-INPV',
  'command-injection': 'WSTG-INPV', 'command injection': 'WSTG-INPV', rce: 'WSTG-INPV', ldap: 'WSTG-INPV',
  ssrf: 'WSTG-INPV', xxe: 'WSTG-INPV', ssti: 'WSTG-INPV', lfi: 'WSTG-INPV', 'path-traversal': 'WSTG-INPV',
  crlf: 'WSTG-INPV', 'header-injection': 'WSTG-INPV',
  idor: 'WSTG-ATHZ', 'access-control': 'WSTG-ATHZ', bola: 'WSTG-ATHZ', authorization: 'WSTG-ATHZ',
  auth: 'WSTG-ATHN', authentication: 'WSTG-ATHN', 'account-takeover': 'WSTG-ATHN',
  session: 'WSTG-SESS', jwt: 'WSTG-SESS',
  csrf: 'WSTG-CLNT', clickjacking: 'WSTG-CLNT', 'dom-xss': 'WSTG-CLNT', cors: 'WSTG-CLNT', redirect: 'WSTG-CLNT',
  'business-logic': 'WSTG-BUSL', api: 'WSTG-APIT', graphql: 'WSTG-APIT',
  crypto: 'WSTG-CRYP', tls: 'WSTG-CRYP',
  'info-disclosure': 'WSTG-ERRH', 'information-disclosure': 'WSTG-ERRH', secrets: 'WSTG-CONF',
}

// agent name → WSTG area(s) it exercises.
const AGENT_TO_WSTG = {}
for (const w of WSTG) for (const a of w.owner) { if (a !== 'all') (AGENT_TO_WSTG[a] = AGENT_TO_WSTG[a] || []).push(w.id) }

function ownerFor(id) { return (BY_ID[id] && BY_ID[id].owner) || [] }

function wstgForFinding(f) {
  const cls = String(f && (f.vuln_class || f.type || f.title) || '').toLowerCase()
  for (const [k, v] of Object.entries(CLASS_TO_WSTG)) if (cls.includes(k)) return v
  // fall back to the agent that produced it
  const ag = String(f && (f.original_agent || f.agent) || '').toLowerCase()
  const areas = AGENT_TO_WSTG[ag]
  return areas && areas.length ? areas[0] : ''
}

// Which WSTG areas were exercised (by findings and/or agents that ran).
//   findings: [{vuln_class|type|title, original_agent}], agentsRun: ['viper',...]
function computeCoverage(findings = [], agentsRun = []) {
  const covered = new Set()
  for (const f of findings || []) { const id = wstgForFinding(f); if (id) covered.add(id) }
  for (const a of agentsRun || []) for (const id of (AGENT_TO_WSTG[String(a).toLowerCase()] || [])) covered.add(id)
  const coveredIds = WSTG.map(w => w.id).filter(id => covered.has(id))
  const notReached = WSTG.filter(w => !covered.has(w.id))
  return {
    covered: coveredIds,
    not_reached: notReached.map(w => ({ id: w.id, name: w.name, owner: w.owner })),
    total: WSTG.length,
    percent: Math.round((coveredIds.length / WSTG.length) * 100),
  }
}

// Compact A-Z checklist for prompt injection.
function checklistText() {
  return WSTG.map(w => `- ${w.id} ${w.name} → ${w.owner.join('/')}`).join('\n')
}

module.exports = { WSTG, ownerFor, wstgForFinding, computeCoverage, checklistText, CLASS_TO_WSTG }
