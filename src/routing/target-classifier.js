
const __roots = require('../../paths') // portable roots (KURU_*_ROOT) — see paths.js
// /root/agents/target-classifier.js
//
// Target Profile Classifier — produces a 6-dimension profile ABOUT a target
// WITHOUT restricting the agent's scope.
//
// Hard rules (enforced in code + verify-framework GATE-16/17):
//   1. Never returns `allowed_specialists` or `skip_specialists`. Only `priority_order`.
//   2. Profile always carries the non-restriction disclaimer string.
//   3. `unknown` is a first-class value — preferred over guessing.
//   4. Merge precedence: user-provided hints > deterministic rules > LLM inference.
//
// Inputs accepted (all optional):
//   - headers          :  { lowercase-name: value } from Phase 0.7 / probe
//   - hostname         :  string (derived from targetUrl)
//   - bodySnippet      :  first ~32KB of HTML/JSON response
//   - contentTypes     :  array of content-type values observed during crawl
//   - jsBundles        :  array of { url, size_bytes }
//   - redirects        :  array of URLs the target redirected to
//   - cookies          :  array of Set-Cookie values
//   - userHints        :  { surface_shape?, auth_model?, environment?, domain?, ... }
//
// Output (profile shape):
//   {
//     surface_shape, tech_stack, auth_model, hosting, environment, domain,
//     sources:            { dim -> 'user' | 'auto' | 'llm' | 'default' },
//     confidence:         { dim -> 0..1 },
//     disclaimer:         string,
//     generated_at:       ISO timestamp,
//     taskId, targetUrl,
//   }
//
// Generic across squads. Adding a new squad = add entry under per_squad_strategy in rules.json.

const fs = require('fs')
const path = require('path')

const RULES_PATH = (__roots.INTEL_ROOT + '/target-profile-rules.json')
const PROFILE_DIR = __roots.INTEL_ROOT

const DIMENSIONS = ['surface_shape', 'tech_stack', 'auth_model', 'hosting', 'environment', 'domain']

// ── Rules cache with mtime invalidation ──────────────────────────────────
let _rulesCache = null
let _rulesMtime = 0
function loadRules() {
  try {
    const stat = fs.statSync(RULES_PATH)
    if (_rulesCache && stat.mtimeMs === _rulesMtime) return _rulesCache
    _rulesCache = JSON.parse(fs.readFileSync(RULES_PATH, 'utf-8'))
    _rulesMtime = stat.mtimeMs
    return _rulesCache
  } catch {
    return null
  }
}

function resetCache() {
  _rulesCache = null
  _rulesMtime = 0
}

// ── Low-level signature matchers ────────────────────────────────────────
function headersContain(headers, needle) {
  if (!headers) return false
  const low = needle.toLowerCase()
  for (const [k, v] of Object.entries(headers)) {
    const line = `${k}: ${v}`.toLowerCase()
    if (line.includes(low)) return true
    // Some signatures are header-name-only like "cf-ray:"
    if (low.endsWith(':') && k.toLowerCase() === low.slice(0, -1)) return true
  }
  return false
}

function hostnameMatches(hostname, pattern) {
  if (!hostname) return false
  if (pattern.startsWith('*.')) {
    const suffix = pattern.slice(1)
    return hostname.toLowerCase().endsWith(suffix.toLowerCase())
  }
  return hostname.toLowerCase().includes(pattern.toLowerCase())
}

function bodyContains(bodySnippet, marker) {
  if (!bodySnippet) return false
  return bodySnippet.toLowerCase().includes(marker.toLowerCase())
}

// ── Per-dimension classifiers (deterministic) ───────────────────────────
function classifyHosting(ctx, rules) {
  const sig = rules.signatures.hosting || {}
  for (const [label, rule] of Object.entries(sig)) {
    if (rule.headers && rule.headers.some(h => headersContain(ctx.headers, h))) {
      return { value: label, confidence: 0.95 }
    }
    if (rule.hostnames && rule.hostnames.some(p => hostnameMatches(ctx.hostname, p))) {
      return { value: label, confidence: 0.9 }
    }
  }
  return null
}

function classifyTechStack(ctx, rules) {
  const sig = rules.signatures.tech_stack || {}
  for (const [label, rule] of Object.entries(sig)) {
    if (rule.headers && rule.headers.some(h => headersContain(ctx.headers, h))) {
      return { value: label, confidence: 0.9 }
    }
    if (rule.cookies && ctx.cookies && rule.cookies.some(c => ctx.cookies.some(sc => sc.includes(c)))) {
      return { value: label, confidence: 0.8 }
    }
  }
  return null
}

function classifySurfaceShape(ctx, rules) {
  const sig = rules.signatures.surface_shape || {}

  // SPA detection — HTML markers + big JS bundle
  const spaRule = sig.spa
  if (spaRule) {
    const markerHit = spaRule.html_markers?.some(m => bodyContains(ctx.bodySnippet, m))
    const bigBundle = (ctx.jsBundles || []).some(b => (b.size_bytes || 0) >= (spaRule.min_bundle_kb || 200) * 1024)
    if (markerHit && bigBundle) return { value: 'spa', confidence: 0.9 }
    if (markerHit) return { value: 'spa', confidence: 0.7 }
  }

  // API-only — majority content-types are JSON variants
  const apiRule = sig['api-only']
  if (apiRule && ctx.contentTypes && ctx.contentTypes.length > 0) {
    const jsonLike = ctx.contentTypes.filter(ct =>
      apiRule.content_type_majority.some(m => ct.toLowerCase().includes(m))
    ).length
    if (jsonLike / ctx.contentTypes.length > 0.6) {
      return { value: 'api-only', confidence: 0.85 }
    }
  }

  // Static — HTML present, few bundles
  const staticRule = sig.static
  if (staticRule && bodyContains(ctx.bodySnippet, '<!DOCTYPE html>')) {
    const bundleCount = (ctx.jsBundles || []).length
    if (bundleCount <= (staticRule.max_js_bundles || 2) &&
        !(ctx.contentTypes || []).some(ct => ct.includes('json'))) {
      return { value: 'static', confidence: 0.7 }
    }
  }

  // MPA — HTML with forms across multiple routes
  const mpaRule = sig.mpa
  if (mpaRule && mpaRule.html_markers?.some(m => bodyContains(ctx.bodySnippet, m))) {
    return { value: 'mpa', confidence: 0.7 }
  }

  return null
}

function classifyAuthModel(ctx, rules) {
  const sig = rules.signatures.auth_model || {}
  const redirectsStr = (ctx.redirects || []).join(' ').toLowerCase()

  for (const [label, rule] of Object.entries(sig)) {
    if (rule.redirect_contains && rule.redirect_contains.some(p => redirectsStr.includes(p.toLowerCase()))) {
      return { value: label, confidence: 0.9 }
    }
    if (rule.response_headers && rule.response_headers.some(h => headersContain(ctx.headers, h))) {
      return { value: label, confidence: 0.85 }
    }
    if (rule.body_markers && rule.body_markers.some(m => bodyContains(ctx.bodySnippet, m))) {
      return { value: label, confidence: 0.7 }
    }
    if (rule.html_markers && rule.html_markers.some(m => bodyContains(ctx.bodySnippet, m))) {
      return { value: label, confidence: 0.7 }
    }
    if (rule.cookies && ctx.cookies && rule.cookies.some(c => ctx.cookies.some(sc => sc.includes(c)))) {
      return { value: label, confidence: 0.75 }
    }
  }
  return null
}

function classifyEnvironment(ctx, rules) {
  const sig = rules.signatures.environment || {}
  const host = (ctx.hostname || '').toLowerCase()

  for (const label of ['staging', 'dev', 'sandbox']) {
    const rule = sig[label]
    if (rule?.hostname_contains?.some(p => host.includes(p.toLowerCase()))) {
      return { value: label, confidence: 0.9 }
    }
  }
  // prod = none of the above AND no excluded tokens
  const prodRule = sig.prod
  if (prodRule && host && !prodRule.hostname_excludes.some(p => host.includes(p.toLowerCase()))) {
    return { value: 'prod', confidence: 0.7 }
  }
  return null
}

function classifyDomain(ctx, rules) {
  const sig = rules.signatures.domain || {}
  const host = (ctx.hostname || '').toLowerCase()

  // Return FIRST hit with best confidence — order in rules.json matters
  for (const [label, rule] of Object.entries(sig)) {
    if (rule.hostname_contains?.some(p => host.includes(p.toLowerCase()))) {
      // Boost if body also has markers
      const bodyHit = rule.body_markers?.some(m => bodyContains(ctx.bodySnippet, m))
      return { value: label, confidence: bodyHit ? 0.9 : 0.7 }
    }
    if (rule.body_markers?.some(m => bodyContains(ctx.bodySnippet, m))) {
      return { value: label, confidence: 0.6 }
    }
  }
  return null
}

// ── Main entry — produces full profile ──────────────────────────────────
function classify(ctx = {}, opts = {}) {
  const rules = loadRules()
  if (!rules || rules.enabled === false) {
    return buildUnknownProfile(ctx, 'rules-disabled')
  }

  const classifiers = {
    surface_shape: classifySurfaceShape,
    tech_stack:    classifyTechStack,
    auth_model:    classifyAuthModel,
    hosting:       classifyHosting,
    environment:   classifyEnvironment,
    domain:        classifyDomain,
  }

  const profile = {
    disclaimer: rules.non_restriction_disclaimer || 'Profile is a hint, not a scope fence.',
    sources: {},
    confidence: {},
    generated_at: new Date().toISOString(),
    taskId: ctx.taskId || opts.taskId || null,
    targetUrl: ctx.targetUrl || opts.targetUrl || null,
  }

  const userHints = ctx.userHints || {}

  for (const dim of DIMENSIONS) {
    // 1) User-provided wins
    if (userHints[dim]) {
      profile[dim] = userHints[dim]
      profile.sources[dim] = 'user'
      profile.confidence[dim] = 1.0
      continue
    }
    // 2) Deterministic rule match
    const fn = classifiers[dim]
    const hit = fn ? fn(ctx, rules) : null
    if (hit && hit.value) {
      profile[dim] = hit.value
      profile.sources[dim] = 'auto'
      profile.confidence[dim] = hit.confidence
      continue
    }
    // 3) Default to unknown — LLM tie-breaker is called separately by caller
    profile[dim] = 'unknown'
    profile.sources[dim] = 'default'
    profile.confidence[dim] = 0
  }

  // HARD INVARIANT — never leak restriction fields
  delete profile.allowed_specialists
  delete profile.skip_specialists

  return profile
}

function buildUnknownProfile(ctx, reason) {
  const profile = {
    disclaimer: 'Profile classifier disabled or unavailable — agents should treat all dimensions as unknown.',
    sources: {}, confidence: {},
    generated_at: new Date().toISOString(),
    taskId: ctx.taskId || null,
    targetUrl: ctx.targetUrl || null,
    _disabled_reason: reason,
  }
  for (const dim of DIMENSIONS) {
    profile[dim] = 'unknown'
    profile.sources[dim] = 'default'
    profile.confidence[dim] = 0
  }
  return profile
}

// ── Persist / load profile per task ─────────────────────────────────────
function profilePath(taskId) {
  return path.join(PROFILE_DIR, `target-profile-${taskId}.json`)
}

function saveProfile(taskId, profile) {
  if (!taskId) throw new Error('taskId required')
  try { fs.mkdirSync(PROFILE_DIR, { recursive: true }) } catch {}
  const p = profilePath(taskId)
  const tmp = p + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(profile, null, 2))
  fs.renameSync(tmp, p)
  return p
}

function loadProfile(taskId) {
  try {
    const p = profilePath(taskId)
    if (!fs.existsSync(p)) return null
    return JSON.parse(fs.readFileSync(p, 'utf-8'))
  } catch {
    return null
  }
}

// ── Priority lookup — called by event-bus to order specialists ─────────
// Returns a list of agent names (lowercase) in priority order — NOT a filter.
// Agents not in the list are still eligible; they just run at default priority.
function getPriorityOrderForSquad(squad, profile) {
  const rules = loadRules()
  if (!rules || !profile) return []
  const normalized = (squad || '').replace('-squad', '').replace('_squad', '')
  const strategy = rules.per_squad_strategy?.[normalized]
  if (!strategy) return []

  const order = []
  const seen = new Set()

  // Walk dimensions and append priority lists. First-seen wins priority.
  for (const dim of DIMENSIONS) {
    const value = profile[dim]
    if (!value || value === 'unknown') continue
    const key = `prioritize_on_${dim}`
    const list = strategy[key]?.[value]
    if (Array.isArray(list)) {
      for (const agent of list) {
        const a = String(agent).toLowerCase()
        if (!seen.has(a)) { seen.add(a); order.push(a) }
      }
    }
  }
  return order
}

// Severity multiplier — squad-generic, never zeros out a finding
function getSeverityMultiplier(profile) {
  const rules = loadRules()
  if (!rules || !profile) return 1.0
  const envMult = rules.severity_multiplier?.environment?.[profile.environment] ?? 1.0
  const domMult = rules.severity_multiplier?.domain?.[profile.domain] ?? 1.0
  return envMult * domMult
}

// Human-readable prompt fragment — used by event-bus to inject into specialist prompts.
// ALWAYS includes the non-restriction disclaimer.
function buildPromptFragment(profile) {
  if (!profile) return ''
  const rules = loadRules()
  const disclaimer = profile.disclaimer || rules?.non_restriction_disclaimer ||
    'Profile is a hint, not a scope fence.'
  const lines = []
  lines.push('')
  lines.push('## TARGET PROFILE (informational — do not use to shrink scope)')
  for (const dim of DIMENSIONS) {
    const v = profile[dim] || 'unknown'
    const src = profile.sources?.[dim] || 'default'
    const conf = profile.confidence?.[dim] ?? 0
    lines.push(`- ${dim}: ${v} (source=${src}, confidence=${conf.toFixed(2)})`)
  }
  lines.push('')
  lines.push(`DISCLAIMER: ${disclaimer}`)
  lines.push('')
  return lines.join('\n')
}

module.exports = {
  DIMENSIONS,
  RULES_PATH,
  loadRules,
  resetCache,
  classify,
  buildUnknownProfile,
  saveProfile,
  loadProfile,
  profilePath,
  getPriorityOrderForSquad,
  getSeverityMultiplier,
  buildPromptFragment,
}

// CLI mode: node target-classifier.js --task <id> --url <url> [--json-ctx <file>]
if (require.main === module) {
  const args = process.argv.slice(2)
  const get = flag => { const i = args.indexOf(flag); return i === -1 ? null : args[i + 1] }
  const taskId = get('--task') || 'adhoc'
  const url = get('--url')
  const ctxFile = get('--json-ctx')
  let ctx = { taskId, targetUrl: url }
  if (url) {
    try { ctx.hostname = new URL(url).hostname } catch {}
  }
  if (ctxFile && fs.existsSync(ctxFile)) {
    Object.assign(ctx, JSON.parse(fs.readFileSync(ctxFile, 'utf-8')))
  }
  const p = classify(ctx)
  saveProfile(taskId, p)
  console.log(JSON.stringify(p, null, 2))
}
