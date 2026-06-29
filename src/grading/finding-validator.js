
const __roots = require('../../paths') // portable roots (KURU_*_ROOT) — see paths.js
// /root/agents/finding-validator.js
//
// Autonomous per-finding validator. Where the regular grader evaluates a WHOLE task,
// this validates a SINGLE finding with an independent-context LLM call. Each finding
// gets:
//   - confidence (0..1) — how sure the validator is it's real + exploitable
//   - status: 'confirmed' | 'suspected' | 'disproven'
//   - rationale (one sentence)
//   - evidence_quote (literal substring — same hallucination guard as grader)
//
// Independent of the AUDITOR validator (AUDITOR checks the 7-question gate; this checks
// exploitability from raw evidence). Stacked, they catch different failure classes:
// AUDITOR = procedural quality, finding-validator = evidence-based exploitability.
//
// Config-driven: /root/intel/finding-validator-config.json controls enable + model +
// max-findings-per-task cost cap. Rollback: set enabled=false or mode=noop.

const fs = require('fs')
const anthropicKey = require('../integrations/anthropic-key')
const tracer = (() => { try { return require('../integrations/tracer') } catch { return { span: () => ({ end: () => {} }), event: () => {} } } })()

// ponytail: optional BYO-key path (see grader.js). @anthropic-ai/sdk is not a
// declared dep — absent → loadAnthropicSDK()=null → validateFinding is a no-op
// (the subscription-OAuth default). Install the SDK + set a key to enable it.
let _sdk = null
function loadAnthropicSDK() {
  if (_sdk !== null) return _sdk
  try { _sdk = require('@anthropic-ai/sdk') } catch { _sdk = false }
  return _sdk || null
}
let _clientCache = { key: null, client: null }
function getClient(apiKey) {
  if (_clientCache.key === apiKey && _clientCache.client) return _clientCache.client
  const Anthropic = loadAnthropicSDK()
  if (!Anthropic) return null
  const Ctor = Anthropic.default || Anthropic
  _clientCache = { key: apiKey, client: new Ctor({ apiKey, maxRetries: 2 }) }
  return _clientCache.client
}

const CONFIG_PATH = (__roots.INTEL_ROOT + '/finding-validator-config.json')
const MODEL_CONFIG_PATH = (__roots.INTEL_ROOT + '/model-config.json')

let _cfgCache = null
let _cfgMtime = 0
function loadConfig() {
  try {
    const stat = fs.statSync(CONFIG_PATH)
    if (_cfgCache && stat.mtimeMs === _cfgMtime) return _cfgCache
    _cfgCache = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'))
    _cfgMtime = stat.mtimeMs
    return _cfgCache
  } catch { return null }
}
function resetCache() { _cfgCache = null; _cfgMtime = 0 }

function loadModelFamilies() {
  try {
    return JSON.parse(fs.readFileSync(MODEL_CONFIG_PATH, 'utf-8')).families || {}
  } catch { return {} }
}

const VALIDATE_TOOL = {
  name: 'validate_finding',
  description: 'Return a structured validation judgment for a single security finding.',
  input_schema: {
    type: 'object',
    properties: {
      status: {
        type: 'string',
        enum: ['confirmed', 'suspected', 'disproven'],
        description: 'confirmed = exploitable with proof; suspected = plausible but unconfirmed; disproven = evidence does not support it.',
      },
      confidence: { type: 'number', minimum: 0, maximum: 1 },
      evidence_quote: {
        type: 'string',
        description: 'Literal substring from the provided evidence (≥15 chars) that justifies the verdict. Empty if disproven.',
      },
      rationale: { type: 'string', description: 'One sentence explaining the verdict.' },
      exploitability: {
        type: 'string',
        enum: ['high', 'medium', 'low', 'none'],
        description: 'How easily an attacker could weaponize this in practice.',
      },
    },
    required: ['status', 'confidence', 'evidence_quote', 'rationale', 'exploitability'],
  },
}

// Same normalize-and-substring check as grader.verifyEvidenceQuote
function verifyEvidenceQuote(quote, evidence) {
  if (!quote || typeof quote !== 'string') return false
  if (!evidence || typeof evidence !== 'string') return false
  const norm = s => s.toLowerCase().replace(/\s+/g, ' ').trim()
  const needle = norm(quote)
  if (needle.length < 10) return false
  return norm(evidence).includes(needle)
}

function buildPrompt(finding, evidence, squad) {
  const p = buildPromptParts(finding, evidence, squad)
  return `${p.system}\n\n${p.cachedUser}\n\n${p.dynamicUser}`
}

// Structured split — same caching strategy as grader: evidence is stable per
// task, the finding varies per call. Cache the tools+system+evidence prefix;
// read it at ~10% cost on subsequent findings in the same task.
function buildPromptParts(finding, evidence, squad) {
  const system = `You are an independent validator for security finding exploitability.
You see ONLY the finding and its evidence — no task context, no prior judgments, no agent activity.

Decide independently:
- status=confirmed: evidence contains a concrete HTTP request/response, command output, or response body that genuinely demonstrates exploitability
- status=suspected: evidence is suggestive but inconclusive (e.g., timing hint, missing authoritative proof)
- status=disproven: evidence contradicts the finding OR there is no real evidence at all

If status=confirmed: cite a LITERAL substring (≥15 chars) from the evidence as evidence_quote — copy-pasted, not paraphrased.
If status!=confirmed: evidence_quote=""

Always call the validate_finding tool.`

  const cachedUser = `## RAW EVIDENCE (activity entries + PoC output)
\`\`\`
${(evidence || '').slice(0, 30000)}
\`\`\``

  const dynamicUser = `## FINDING
Title: ${finding.title || '(untitled)'}
Severity claim: ${finding.severity || 'unknown'}
Squad: ${squad || 'pentest'}
URL/Asset: ${finding.url || finding.asset || 'not specified'}

## CLAIMED DETAILS
${finding.details || finding.description || '(no details provided)'}`

  return { system, cachedUser, dynamicUser }
}

// Main entry — validate a single finding against its raw evidence.
// Uses @anthropic-ai/sdk with 1-hour prompt caching. Evidence (same for every
// finding in one task) sits in a cached block; the finding-specific details
// sit in an uncached block. Validating 12 findings in a task hits cache 11 times.
async function validateFinding(finding, evidence, opts = {}) {
  const cfg = loadConfig()
  if (!cfg || cfg.enabled === false || cfg.mode === 'noop') {
    return { validator: 'noop', status: 'unchanged', confidence: null, reason: 'disabled' }
  }
  const apiKey = anthropicKey.getAnthropicApiKey()
  if (!apiKey) return { validator: 'noop', status: 'unchanged', reason: 'no-api-key' }

  const client = getClient(apiKey)
  if (!client) return { validator: 'error', status: 'unchanged', reason: 'anthropic-sdk-not-installed' }

  const families = loadModelFamilies()
  const modelAlias = cfg.model_alias || 'fast'
  const model = families[modelAlias] || families.fast || 'claude-haiku-4-5'
  const timeoutMs = cfg.timeout_ms || 60000
  const cacheTTL = cfg.cache_ttl || '1h'

  const parts = buildPromptParts(finding, evidence, opts.squad)
  const traceSpan = tracer.span('finding-validator.validateFinding', {
    squad: opts.squad, model, finding_title: String(finding.title || '').slice(0, 80),
    severity_claim: finding.severity,
  })

  try {
    // .withResponse() returns {data, response} so we can read x-request-id
    // headers for Anthropic-support debugging. Falls back cleanly if SDK is old.
    const call = client.messages.create({
      model,
      max_tokens: 512,
      tools: [VALIDATE_TOOL],
      tool_choice: { type: 'tool', name: VALIDATE_TOOL.name },
      system: [{ type: 'text', text: parts.system }],
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: parts.cachedUser,
              cache_control: { type: 'ephemeral', ttl: cacheTTL },
            },
            { type: 'text', text: parts.dynamicUser },
          ],
        },
      ],
    }, { timeout: timeoutMs })
    const raw = typeof call?.withResponse === 'function' ? await call.withResponse() : null
    const resp = raw ? raw.data : await call
    const requestId = raw?.response?.headers?.get?.('x-request-id') || null

    const toolUse = (resp.content || []).find(b => b.type === 'tool_use' && b.name === VALIDATE_TOOL.name)
    if (!toolUse?.input) return { validator: 'error', status: 'unchanged', reason: 'no-tool-use' }
    const j = toolUse.input

    if (j.status === 'confirmed' && !verifyEvidenceQuote(j.evidence_quote, evidence)) {
      return {
        validator: 'hallucination-guard',
        status: 'suspected',
        confidence: Math.min(0.4, j.confidence || 0.3),
        rationale: 'LLM claimed confirmed but evidence_quote not found in evidence — demoted.',
        exploitability: j.exploitability || 'medium',
      }
    }

    const result = {
      validator: 'llm',
      model,
      status: j.status,
      confidence: j.confidence,
      evidence_quote: j.evidence_quote,
      rationale: j.rationale,
      exploitability: j.exploitability,
      cache: {
        read: resp.usage?.cache_read_input_tokens || 0,
        write: resp.usage?.cache_creation_input_tokens || 0,
        uncached: resp.usage?.input_tokens || 0,
      },
    }
    traceSpan.end({
      status: result.status, exploitability: result.exploitability,
      cache_read: result.cache.read, cache_write: result.cache.write,
      input_tokens: result.cache.uncached, output_tokens: resp.usage?.output_tokens || 0,
      request_id: requestId || undefined,
    })
    if (requestId) result.requestId = requestId
    return result
  } catch (e) {
    traceSpan.end({ error: e?.message || 'unknown' })
    const Anthropic = loadAnthropicSDK()
    if (Anthropic && e instanceof (Anthropic.default?.RateLimitError || Anthropic.RateLimitError || class {})) {
      return { validator: 'error', status: 'unchanged', reason: 'rate-limited' }
    }
    if (e?.name === 'AbortError' || /timeout/i.test(e?.message || '')) {
      return { validator: 'error', status: 'unchanged', reason: 'timeout' }
    }
    return { validator: 'error', status: 'unchanged', reason: e?.message || 'unknown-error' }
  }
}

// Batch-validate with cost cap. opts: { squad, maxFindings, onProgress }
async function validateFindings(findings, evidenceLookup, opts = {}) {
  const cfg = loadConfig()
  if (!cfg || cfg.enabled === false) return { validations: [], skipped: 'disabled' }
  const max = opts.maxFindings || cfg.max_findings_per_task || 12
  const out = []
  const items = findings.slice(0, max)
  for (const f of items) {
    const ev = typeof evidenceLookup === 'function' ? evidenceLookup(f) : evidenceLookup
    const v = await validateFinding(f, ev, { squad: opts.squad })
    out.push({ finding: f, validation: v })
    if (opts.onProgress) opts.onProgress(f, v)
  }
  return { validations: out, skipped: findings.length > items.length ? findings.length - items.length : 0 }
}

module.exports = {
  CONFIG_PATH,
  VALIDATE_TOOL,
  loadConfig,
  resetCache,
  verifyEvidenceQuote,
  validateFinding,
  validateFindings,
  buildPrompt,
}
