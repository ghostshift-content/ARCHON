// /root/agents/agents/browser-recipe-validator.js
// Generic schema validator for browser-verifier recipes. Domain-agnostic.
// Schema enforcement + AST check on evaluate-step expressions.
//
// Domain-specific consumers (pentest, stocks, cloud-security, etc.) can
// pass an `allowedFindingTypes` Set in opts to enforce their own type
// allowlist. Without it, any non-empty finding_type string is accepted.
//
// URL safety: by default, only http(s) URLs are accepted for navigate
// steps. file:// URLs are REJECTED — without this gate, a Constructor LLM
// could emit `navigate { url: "file:///etc/passwd" }` and Playwright
// would happily render it. Tests that need fixture URLs must opt in via
// validateRecipe(recipe, { allowFileUrls: true }). Production callers
// (Phase 3.8 dispatcher) leave allowFileUrls at its default false.

const { isReadOnlyExpression } = require('./browser-evaluate-ast')

const ALLOWED_ACTIONS = new Set([
  'navigate', 'fill', 'click', 'evaluate', 'wait_for', 'screenshot',
  // Sprint B Task B2: gold-standard credentialed-CORS verifier.
  // Loads attacker page via data: URL and attempts fetch(victim, {credentials:'include'}).
  // Requires victim_url (http(s)); attacker_origin + credentials optional.
  'cross_origin_fetch',
])

// Valid values for the optional `credentials` field on cross_origin_fetch.
// Mirrors the Fetch spec RequestCredentials enum.
const CORS_CREDENTIALS_MODES = new Set(['include', 'omit', 'same-origin'])

const MAX_STEPS = 20

function validateRecipe(recipe, opts = {}) {
  const allowedFindingTypes = opts.allowedFindingTypes || null  // null = permissive
  const allowFileUrls = !!opts.allowFileUrls  // default-deny file:// URLs

  if (!recipe || typeof recipe !== 'object') return fail('recipe must be object')
  if (typeof recipe.finding_id !== 'string' || !recipe.finding_id) return fail('missing finding_id')
  const findingType = String(recipe.finding_type || '').toLowerCase()
  if (!findingType) return fail('missing finding_type')
  if (allowedFindingTypes && !allowedFindingTypes.has(findingType)) {
    return fail(`finding_type '${findingType}' not in caller-provided allowlist`)
  }
  if (typeof recipe.description !== 'string') return fail('missing description')
  if (!Array.isArray(recipe.steps)) return fail('steps must be array')
  if (recipe.steps.length === 0) return fail('steps array is empty')
  if (recipe.steps.length > MAX_STEPS) return fail(`too many steps (max ${MAX_STEPS})`)

  for (let i = 0; i < recipe.steps.length; i++) {
    const stepCheck = validateStep(recipe.steps[i], i, { allowFileUrls })
    if (!stepCheck.ok) return stepCheck
  }
  return { ok: true }
}

function validateStep(step, index, opts = {}) {
  const allowFileUrls = !!opts.allowFileUrls
  if (!step || typeof step !== 'object') return fail(`step ${index}: not an object`)
  const action = String(step.action || '').toLowerCase()
  if (!ALLOWED_ACTIONS.has(action)) {
    return fail(`step ${index}: action '${action}' not allowed`)
  }

  switch (action) {
    case 'navigate':
      if (typeof step.url !== 'string' || !step.url) return fail(`step ${index}: navigate requires url`)
      if (allowFileUrls) {
        if (!/^(https?|file):\/\//.test(step.url)) return fail(`step ${index}: url must be http(s) or file`)
      } else {
        if (!/^https?:\/\//.test(step.url)) return fail(`step ${index}: url must be http(s) (file:// rejected — pass { allowFileUrls: true } in tests only)`)
      }
      break
    case 'fill':
      if (typeof step.selector !== 'string') return fail(`step ${index}: fill requires selector`)
      if (typeof step.value !== 'string') return fail(`step ${index}: fill requires value`)
      break
    case 'click':
      if (typeof step.selector !== 'string') return fail(`step ${index}: click requires selector`)
      break
    case 'evaluate':
      if (typeof step.expression !== 'string' || !step.expression) {
        return fail(`step ${index}: evaluate requires expression`)
      }
      const astCheck = isReadOnlyExpression(step.expression)
      if (!astCheck.ok) return fail(`step ${index}: evaluate ${astCheck.reason}`)
      break
    case 'wait_for':
      if (step.selector !== undefined && typeof step.selector !== 'string') {
        return fail(`step ${index}: wait_for selector must be string`)
      }
      if (step.timeout_ms !== undefined && typeof step.timeout_ms !== 'number') {
        return fail(`step ${index}: wait_for timeout_ms must be number`)
      }
      break
    case 'screenshot':
      if (typeof step.name !== 'string') return fail(`step ${index}: screenshot requires name`)
      break
    case 'cross_origin_fetch':
      if (typeof step.victim_url !== 'string' || !step.victim_url) {
        return fail(`step ${index}: cross_origin_fetch requires victim_url`)
      }
      if (!/^https?:\/\//.test(step.victim_url)) {
        return fail(`step ${index}: cross_origin_fetch victim_url must be http(s)`)
      }
      if (step.attacker_origin !== undefined && typeof step.attacker_origin !== 'string') {
        return fail(`step ${index}: cross_origin_fetch attacker_origin must be string`)
      }
      if (step.credentials !== undefined) {
        if (typeof step.credentials !== 'string' || !CORS_CREDENTIALS_MODES.has(step.credentials)) {
          return fail(`step ${index}: cross_origin_fetch credentials must be one of include|omit|same-origin`)
        }
      }
      if (step.description !== undefined && typeof step.description !== 'string') {
        return fail(`step ${index}: cross_origin_fetch description must be string`)
      }
      break
  }
  return { ok: true }
}

function fail(reason) { return { ok: false, reason } }

module.exports = { validateRecipe, ALLOWED_ACTIONS, MAX_STEPS }
