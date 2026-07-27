'use strict'
// focus-map.js — vuln-class → specialist mapping + focus gating. Pure and shared by the
// daemon (event-bus.js) AND the portal (scripts/dashboard.js) so there is ONE source of truth
// for "which specialists a focused scan runs" and "may this agent run under the focus".

// Vuln-class → specialist agent(s). Powers the dispatch "focus" option: a targeted scan
// (e.g. only XSS, or XSS + access-control) instead of the full A→Z roster.
const PENTEST_FOCUS_MAP = {
  'access-control': ['warden'], 'idor': ['warden'], 'bola': ['warden'],
  'sqli': ['drill'], 'injection': ['drill', 'ranger'], 'command-injection': ['ranger'],
  'xss': ['viper'], 'ssrf': ['relay'], 'ssti': ['forge'], 'xxe': ['spectre'],
  'csrf': ['decoy'], 'lfi': ['vault'], 'path-traversal': ['vault'],
  'api': ['gateway'], 'jwt': ['gateway'], 'graphql': ['gateway'],
  'business-logic': ['ledger'], 'auth': ['keyring'], 'session': ['keyring'],
}

const FOCUS_FAMILIES = {
  'access-control': ['access-control', 'idor', 'bola'],
  idor: ['idor'],
  bola: ['bola'],
  injection: ['injection', 'sqli', 'command-injection', 'ssti'],
  api: ['api', 'jwt', 'graphql'],
  auth: ['auth', 'session'],
  lfi: ['lfi', 'path-traversal'],
  'path-traversal': ['path-traversal', 'lfi'],
  'authentication-session': ['authentication-session', 'auth', 'session'],
  'account-takeover': ['account-takeover', 'auth'],
  'api-security': ['api-security', 'api', 'jwt', 'graphql'],
  'file-handling': ['file-handling', 'lfi', 'path-traversal'],
  'nosql-injection': ['nosql-injection'],
  deserialization: ['deserialization', 'xxe'],
  'race-conditions': ['race-conditions'],
  'multi-tenant-isolation': ['multi-tenant-isolation', 'access-control', 'idor', 'bola'],
  'secrets-cryptography': ['secrets-cryptography'],
  'data-exposure': ['data-exposure'],
  'webhook-security': ['webhook-security'],
  'cloud-infrastructure': ['cloud-infrastructure'],
  'supply-chain': ['supply-chain'],
  'logging-audit': ['logging-audit'],
  rce: ['rce', 'command-injection'],
}

const CLASS_SIGNALS = [
  ['xss', /\bcwe-?79\b|\bxss\b|cross[- ]site scripting|html injection/i],
  ['sqli', /\bcwe-?89\b|\bsql(?:i| injection)\b/i],
  ['command-injection', /\bcwe-?78\b|command injection|\bcmdi\b|os command/i],
  ['ssrf', /\bcwe-?918\b|\bssrf\b|server[- ]side request forgery/i],
  ['ssti', /\bcwe-?1336\b|\bssti\b|server[- ]side template injection/i],
  ['xxe', /\bcwe-?611\b|\bxxe\b|xml external entit/i],
  ['csrf', /\bcwe-?352\b|\bcsrf\b|cross[- ]site request forgery/i],
  ['path-traversal', /\bcwe-?22\b|path traversal|directory traversal/i],
  ['lfi', /\blfi\b|local file inclusion/i],
  ['idor', /\bcwe-?639\b|\bidor\b|insecure direct object/i],
  ['bola', /\bbola\b|broken object level authorization/i],
  ['access-control', /\bcwe-?(?:284|285|862|863)\b|broken access control|authorization bypass|missing authorization|privilege escalation/i],
  ['graphql', /\bgraphql\b/i],
  ['jwt', /\bjwt\b|json web token/i],
  ['api', /\bapi security\b|\brest api\b/i],
  ['business-logic', /business logic|workflow abuse|race condition/i],
  ['session', /session fixation|session management|cookie security/i],
  ['auth', /authentication bypass|account takeover|credential stuffing|password reset/i],
]

const AGENT_CLASSES = {
  viper: ['xss'],
  drill: ['sqli'],
  ranger: ['command-injection'],
  relay: ['ssrf'],
  forge: ['ssti'],
  spectre: ['xxe'],
  decoy: ['csrf'],
  vault: ['lfi', 'path-traversal'],
  warden: ['access-control', 'idor', 'bola'],
  gateway: ['api', 'jwt', 'graphql'],
  ledger: ['business-logic'],
  keyring: ['auth', 'session'],
}

function normalizeFocusClasses(focusClasses) {
  return Array.isArray(focusClasses)
    ? [...new Set(focusClasses.map(c => String(c || '').toLowerCase().trim()).filter(Boolean))]
    : []
}

function expandedFocusClasses(focusClasses) {
  const expanded = new Set()
  for (const cls of normalizeFocusClasses(focusClasses)) {
    for (const member of (FOCUS_FAMILIES[cls] || [cls])) expanded.add(member)
  }
  return expanded
}

// Given focus classes + the live specialist roster, return the de-duped specialists to run
// (intersected with the roster, in roster order). No selection -> null (full roster).
// A non-empty invalid/unavailable selection -> [] so the caller fails closed instead of
// accidentally turning a focused dispatch into a full A-Z scan.
function focusedSpecialists(focusClasses, roster) {
  const selected = normalizeFocusClasses(focusClasses)
  if (!selected.length) return null
  const want = new Set()
  for (const c of selected) for (const a of (PENTEST_FOCUS_MAP[c] || [])) want.add(a)
  if (!want.size) return []
  const filtered = (Array.isArray(roster) ? roster : []).filter(a => want.has(String(a).toLowerCase()))
  return filtered
}

// May this specialist run under the current focus? focus === null ⇒ full scan ⇒ everyone allowed;
// otherwise ONLY specialists in the focused set. Gates the surface-triggered conditional dispatches
// (SPECTRE/DECOY/RANGER-CMDi) so a focused scan never runs an out-of-focus specialist.
function focusAllows(focus, agent) {
  if (!focus) return true
  return focus.map(a => String(a).toLowerCase()).includes(String(agent).toLowerCase())
}

// The primary specialist a single focus class maps to — for the UI "test plan" chips.
function specialistForClass(cls) {
  const m = PENTEST_FOCUS_MAP[String(cls || '').toLowerCase()]
  return m && m.length ? m[0] : null
}

function detectedFindingClasses(finding) {
  const f = finding || {}
  const explicit = [
    f.vulnerability_class, f.vuln_class, f.class, f.category,
  ].map(v => String(v || '').toLowerCase().trim()).filter(Boolean)
  const detected = new Set()
  for (const cls of explicit) {
    if (PENTEST_FOCUS_MAP[cls] || FOCUS_FAMILIES[cls]) detected.add(cls)
  }
  const haystack = [f.cwe, f.owasp, f.title, f.details, f.finding, f.notes].filter(Boolean).join(' ')
  for (const [cls, pattern] of CLASS_SIGNALS) if (pattern.test(haystack)) detected.add(cls)
  return detected
}

// Output-layer focus gate. Prompt constraints improve agent behaviour; this function
// enforces the contract even if an agent reports an incidental vulnerability.
function focusAllowsFinding(focusClasses, finding) {
  const selected = expandedFocusClasses(focusClasses)
  if (!selected.size) return true
  const detected = detectedFindingClasses(finding)
  if (detected.size) return [...detected].some(cls => selected.has(cls))

  // Last-resort attribution is safe only when the specialist has no mandate outside
  // the selected family. An unclassified SCOUT/TRACER finding is never admitted.
  const agent = String((finding || {}).agent || (finding || {}).original_agent || '').toLowerCase()
  const agentClasses = AGENT_CLASSES[agent] || []
  return agentClasses.length > 0 && agentClasses.every(cls => selected.has(cls))
}

function focusDirective(focusClasses, customFocus) {
  const selected = normalizeFocusClasses(focusClasses)
  const custom = String(customFocus || '').trim()
  if (!selected.length && !custom) return ''
  const objectives = [
    selected.length ? `standard classes: ${selected.join(', ')}` : '',
    custom ? `custom objective: ${custom}` : '',
  ].filter(Boolean).join('; ')
  return `\n\n## OPERATOR-SELECTED TEST BOUNDARY\n` +
    `Test ONLY the selected vulnerability objectives (${objectives}). Application mapping may observe the whole app, ` +
    `but do not actively test, pursue, emit, validate, or report unrelated vulnerability classes. ` +
    `Record unrelated observations only as non-finding context for a future dispatch. This boundary does not expand asset scope.`
}

module.exports = {
  PENTEST_FOCUS_MAP, focusedSpecialists, focusAllows, specialistForClass,
  normalizeFocusClasses, expandedFocusClasses, detectedFindingClasses,
  focusAllowsFinding, focusDirective,
}

// self-check: filtering, gating (incl. the reported bug scenario), and class→specialist mapping.
if (require.main === module) {
  const assert = require('node:assert')
  const roster = ['viper', 'drill', 'relay', 'vault', 'warden', 'forge', 'ledger', 'sentry', 'gateway', 'keyring', 'spectre', 'decoy']
  assert.deepStrictEqual(focusedSpecialists(['xss', 'access-control', 'sqli'], roster), ['viper', 'drill', 'warden'])
  assert.strictEqual(focusedSpecialists([], roster), null)
  assert.strictEqual(focusedSpecialists(null, roster), null)
  assert.deepStrictEqual(focusedSpecialists(['nonsense'], roster), [])
  assert.strictEqual(focusAllows(null, 'spectre'), true)                          // full scan → everyone
  assert.strictEqual(focusAllows(['viper', 'warden', 'drill'], 'spectre'), false) // the reported leak
  assert.strictEqual(focusAllows(['viper', 'warden', 'drill'], 'decoy'), false)
  assert.strictEqual(focusAllows(['viper', 'warden', 'drill'], 'ranger'), false)
  assert.strictEqual(focusAllows(['spectre'], 'spectre'), true)
  assert.strictEqual(specialistForClass('xss'), 'viper')
  console.log('ok — focus-map: focusedSpecialists filters, focusAllows gates, specialistForClass maps')
}
