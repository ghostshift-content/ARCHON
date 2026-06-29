
const __roots = require('../../paths') // portable roots (KURU_*_ROOT) — see paths.js
// /root/agents/grader.js
//
// Hybrid Grader — LLM refinement of regex-failed expectations.
//
// Pipeline:
//   1. event-bus.js gradeTask runs 99 regex branches (cheap, deterministic)
//   2. Any expectation still marked passed=false gets sent HERE to refineWithLLM()
//   3. Haiku 4.5 judges with JSON output (forced tool-use = guaranteed schema)
//   4. Every LLM PASS must include evidence_quote that is a literal substring of
//      the task activity. Hallucinated quotes are rejected back to FAIL.
//   5. Target-profile severity multiplier is applied to the final passRate.
//
// Config-driven: /root/intel/grader-config.json
//   - enabled / rollback_mode flag — disabling keeps regex-only behavior
//   - model_alias (fast/balanced/powerful)
//   - max_refinements_per_task — cost cap
//   - squad-specific grading notes — tunes "what PASS means"
//
// Squad-generic: uses getSquadConfig + grader-config.squad_grading_notes[squad].
// Missing squad entry → falls back to _default notes. Zero code edits for a new squad.
//
// Hallucination defense: evidence_quote must be a literal substring of taskActivity
// (case-insensitive, whitespace-normalized). No quote = auto-fail, even if the LLM
// says PASS. No exceptions.

const fs = require('fs')
const anthropicKey = require('../integrations/anthropic-key')
// (2026-06-04) AgentRunner port — replaces the raw `claude --print` spawn in
// _refineViaCLIInner with runAgent(spec). Adapter selected by process.env.ADAPTER
// (default 'sdk' — Agent SDK over subscription OAuth, no API key). Returns
// { text, usage, model, raw } already unwrapped, or throws.
const { runAgent } = require('../../agents/runner/agent-runner')
const targetClassifier = (() => { try { return require('../routing/target-classifier') } catch { return null } })()
const tracer = (() => { try { return require('../integrations/tracer') } catch { return { span: () => ({ end: () => {} }), event: () => {} } } })()

// ponytail: optional bring-your-own-API-key path. @anthropic-ai/sdk is NOT a
// declared dependency (ARCHON runs on subscription OAuth). If it's absent, this
// require fails → _sdk=false → refineOne falls back to the OAuth/CLI path. Install
// @anthropic-ai/sdk + set a key only if you want the direct-API grading path.
let _sdk = null
function loadAnthropicSDK() {
  if (_sdk !== null) return _sdk
  try { _sdk = require('@anthropic-ai/sdk') } catch { _sdk = false }
  return _sdk || null
}
let _clientCache = { key: null, client: null }
let _testClient = null // test-only injection; production always uses getClient(apiKey)
function getClient(apiKey) {
  if (_testClient) return _testClient
  if (_clientCache.key === apiKey && _clientCache.client) return _clientCache.client
  const Anthropic = loadAnthropicSDK()
  if (!Anthropic) return null
  const Ctor = Anthropic.default || Anthropic
  _clientCache = { key: apiKey, client: new Ctor({ apiKey, maxRetries: 2 }) }
  return _clientCache.client
}

const CONFIG_PATH = (__roots.INTEL_ROOT + '/grader-config.json')
const MODEL_CONFIG_PATH = (__roots.INTEL_ROOT + '/model-config.json')

// ── Config loading with mtime cache ───────────────────────────────────
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

let _modelCache = null
function loadModelFamilies() {
  if (_modelCache) return _modelCache
  try {
    const raw = JSON.parse(fs.readFileSync(MODEL_CONFIG_PATH, 'utf-8'))
    _modelCache = raw.families || {}
    return _modelCache
  } catch { return {} }
}

function resetCache() {
  _cfgCache = null
  _cfgMtime = 0
  _modelCache = null
}

// ── Evidence-quote hallucination check ───────────────────────────────
// Returns true if the LLM's cited quote is actually present in the activity text.
// Normalizes whitespace + case so LLMs that reformat minor spacing still pass.
function verifyEvidenceQuote(quote, taskActivity) {
  if (!quote || typeof quote !== 'string') return false
  if (!taskActivity || typeof taskActivity !== 'string') return false
  const norm = s => s.toLowerCase().replace(/\s+/g, ' ').trim()
  const needle = norm(quote)
  if (needle.length < 10) return false // too short to be meaningful
  const haystack = norm(taskActivity)
  return haystack.includes(needle)
}

// ── JSON schema for the grade tool — Haiku is forced to emit this exact shape
const GRADE_TOOL = {
  name: 'grade_expectation',
  description: 'Return a structured judgment for a single expectation against evidence.',
  input_schema: {
    type: 'object',
    properties: {
      passed: { type: 'boolean', description: 'Does the evidence actually satisfy this expectation?' },
      confidence: { type: 'number', minimum: 0, maximum: 1, description: 'Confidence in the judgment (0-1).' },
      evidence_quote: {
        type: 'string',
        description: 'Literal substring from the provided evidence (≥15 chars) that justifies PASS. REQUIRED if passed=true. Empty string allowed only when passed=false.',
      },
      reason: { type: 'string', description: 'One sentence explaining the judgment.' },
    },
    required: ['passed', 'confidence', 'evidence_quote', 'reason'],
  },
}

// ── Build the refiner prompt — squad-aware notes ──────────────────────
// Kept for backward compat with tests. Produces ONE big string. The SDK path
// below uses buildRefinerPromptParts() which splits into (system, cached_user,
// dynamic_user) so the cache hits across expectations within a task.
function buildRefinerPrompt(expectation, taskActivity, squad, profileFragment = '') {
  const parts = buildRefinerPromptParts(expectation, taskActivity, squad, profileFragment)
  return `${parts.system}\n\n${parts.cachedUser}\n\n${parts.dynamicUser}`
}

// Structured split: system + stable user prefix (evidence) + dynamic user suffix (expectation).
// When cached, the first two layers are re-used across every expectation in the same task.
// With ≥4096 cached tokens (typical activity logs clear this on Haiku 4.5), subsequent refine
// calls read 90% of the evidence at ~10% input cost.
function buildRefinerPromptParts(expectation, taskActivity, squad, profileFragment = '') {
  const cfg = loadConfig()
  const notes = cfg?.squad_grading_notes?.[squad]
    || cfg?.squad_grading_notes?.[(squad || '').replace('-squad', '')]
    || cfg?.squad_grading_notes?._default
    || 'PASS only if the expectation is addressed with concrete, verifiable evidence.'
  // Structured sliding window: prioritise validated findings + report summary over raw log tail.
  // This prevents early-phase recon (most valuable) being truncated by narrative activity chatter.
  let evidence = taskActivity
  if (taskActivity.length > 30000) {
    // Tier 1: extract structured finding blocks (lines containing severity keywords)
    const findingLines = taskActivity.split('\n')
      .filter(l => /critical|high|medium|low|finding|validated|confirmed|PASS|FAIL/i.test(l))
      .join('\n')
    // Tier 2: first 3KB (report header / summary) + last 12KB (recent activity) + all findings
    const head = taskActivity.slice(0, 3000)
    const tail = taskActivity.slice(-12000)
    const combined = [head, '\n[...]\n', findingLines.slice(0, 10000), '\n[...]\n', tail].join('')
    evidence = combined.length > 30000 ? combined.slice(-30000) : combined
  }

  // System: grading persona + squad rules. Stable across all calls for this squad.
  const system = `You are an independent quality grader for squad "${squad || 'unknown'}".
You see ONLY the expectation and the evidence — not the task brief or agent output.

## GRADING RULES FOR THIS SQUAD
${notes}

Decide whether the evidence genuinely satisfies the expectation.
If PASS: cite a LITERAL substring from the evidence (≥15 chars) as evidence_quote. Do NOT paraphrase. Do NOT summarize. Quote must be copy-pasted from the evidence provided.
If FAIL: set passed=false, evidence_quote="", reason = what's missing.

Always call the grade_expectation tool with your judgment.`

  // Cached user block — evidence is stable across every expectation for the same task.
  // Cache_control at the END of this block caches tools + system + this block.
  const cachedUser = `${profileFragment ? `## TARGET CONTEXT\n${profileFragment}\n\n` : ''}## EVIDENCE (task activity log + report, last 30KB)
\`\`\`
${evidence}
\`\`\``

  // Dynamic user block — varies per expectation, NOT cached.
  const dynamicUser = `## EXPECTATION\n${expectation}`

  return { system, cachedUser, dynamicUser }
}

// ── Single-expectation LLM refinement call ────────────────────────────
// Uses @anthropic-ai/sdk with 1-hour prompt caching on the stable prefix
// (tools + system + evidence). Subsequent refines for the same task hit the
// cache and read at ~10% input cost. Break-even vs uncached is 3 calls for
// 1-hour TTL (2× write + 0.2× reads = 2.2× vs 3× uncached), so even a modest
// task with 4-5 regex failures recoups the write premium.
// ── CLI-based refiner (OAuth path) ────────────────────────────────────
// Mirrors refineOne but uses `claude --print` subprocess instead of the SDK.
// Works in OAuth-only environments where ANTHROPIC_API_KEY is absent.
// (2026-04-20) Added because hybridGrader was silently no-opping on every
// task — this project runs OAuth-only, and refineOne returned early with
// "no-api-key-for-llm-fallback" before. Now the LLM refiner actually runs
// via the same CLI binary that spawns every agent.

// (2026-04-20 I3 fix) Bounded semaphore for concurrent CLI refinements.
// refineWithLLM calls refineViaCLI sequentially PER task, but across MANY
// concurrent tasks we could spawn dozens of claude subprocesses. Cap total
// in-flight CLI refiners at 4 — fair-queue the rest.
const CLI_REFINE_MAX_CONCURRENT = 4
let _cliRefineInFlight = 0
const _cliRefineWaiters = []
function _cliAcquire() {
  return new Promise(resolve => {
    if (_cliRefineInFlight < CLI_REFINE_MAX_CONCURRENT) {
      _cliRefineInFlight++
      return resolve()
    }
    _cliRefineWaiters.push(resolve)
  })
}
function _cliRelease() {
  const next = _cliRefineWaiters.shift()
  if (next) {
    // Hand the slot directly to the next waiter — count stays the same.
    next()
  } else {
    _cliRefineInFlight = Math.max(0, _cliRefineInFlight - 1)
  }
}

async function refineViaCLI(expectation, taskActivity, squad, profileFragment, cfg) {
  await _cliAcquire()
  try {
    return await _refineViaCLIInner(expectation, taskActivity, squad, profileFragment, cfg)
  } finally {
    _cliRelease()
  }
}

async function _refineViaCLIInner(expectation, taskActivity, squad, profileFragment, cfg, opts = {}) {
  const families = loadModelFamilies()
  const modelAlias = cfg?.llm_fallback?.model_alias || 'fast'
  const model = families[modelAlias] || families.fast || 'claude-haiku-4-5'
  const timeoutMs = cfg?.llm_fallback?.timeout_ms || 45000
  const minQuoteLen = cfg?.llm_fallback?.min_evidence_quote_length || 15
  const requireQuote = cfg?.llm_fallback?.require_evidence_quote !== false

  const parts = buildRefinerPromptParts(expectation, taskActivity, squad, profileFragment)

  // Append explicit JSON instruction since CLI path doesn't enforce tool schema.
  const systemPrompt = parts.system + `\n\nCRITICAL: Your entire response MUST be a single JSON object matching this shape:\n{"passed": boolean, "confidence": number (0-1), "evidence_quote": string, "reason": string}\nNo prose, no markdown, no explanation outside the JSON. The JSON object is your entire reply.`
  const userPrompt = `${parts.cachedUser}\n\n${parts.dynamicUser}`

  const traceSpan = tracer.span('grader.refineViaCLI', {
    squad, model, expectation_preview: String(expectation).slice(0, 120),
  })

  // omitApiKey:true preserves this site's deliberate force-OAuth (the old code
  // did `delete spawnEnv.ANTHROPIC_API_KEY`) — the adapter never injects a key.
  const _runAgent = opts._runAgent || runAgent // DI seam for tests

  let resultText
  try {
    const res = await _runAgent({
      agentName: 'GRADER',
      model,
      systemPrompt,
      userPrompt,
      omitApiKey: true,
      timeoutMs,
    })
    // Adapter returns `text` already unwrapped from the { type, result, ... } envelope.
    resultText = res.text || ''
  } catch (e) {
    // Map adapter throws to the same envelopes the spawn path used: timeout
    // (message contains "timed out") → timeout envelope; everything else
    // (spawn error / non-zero exit / parse failure) → the generic error envelope.
    if (/timed out/i.test(e.message || '')) {
      traceSpan.end({ ok: false, reason: 'timeout' })
      return { source: 'llm-cli-timeout', passed: false, reason: `CLI timeout ${timeoutMs}ms` }
    }
    traceSpan.end({ ok: false, reason: 'cli-error', err: e.message })
    return { source: 'llm-cli-error', passed: false, reason: `CLI: ${e.message}` }
  }

  try {
    // Extract the first JSON object from the model's reply
    const m = String(resultText).match(/\{[\s\S]*\}/)
    if (!m) {
      traceSpan.end({ ok: false, reason: 'no-json' })
      return { source: 'llm-cli-parse-fail', passed: false, reason: 'no JSON in model reply' }
    }
    const parsed = JSON.parse(m[0])
    const passedRaw = !!parsed.passed
    const quote = String(parsed.evidence_quote || '')

    // Hallucination defense — same rules as SDK path. Evidence quote must be a
    // literal substring of the task activity (case+whitespace normalized).
    if (passedRaw && requireQuote) {
      if (quote.length < minQuoteLen) {
        traceSpan.end({ ok: true, verdict: 'quote-too-short' })
        return { source: 'llm-cli', passed: false, reason: `evidence_quote too short (${quote.length}<${minQuoteLen})` }
      }
      const norm = s => String(s).toLowerCase().replace(/\s+/g, ' ').trim()
      if (!norm(taskActivity).includes(norm(quote))) {
        traceSpan.end({ ok: true, verdict: 'hallucinated-quote' })
        return { source: 'llm-cli', passed: false, reason: 'evidence_quote hallucinated (not in activity)' }
      }
    }

    traceSpan.end({ ok: true, verdict: passedRaw ? 'pass' : 'fail', confidence: parsed.confidence })
    return {
      source: 'llm', // use 'llm' so refineWithLLM treats this identically to SDK path
      passed: passedRaw,
      confidence: Number(parsed.confidence) || 0.5,
      evidence_quote: quote,
      reason: String(parsed.reason || ''),
      model,
    }
  } catch (e) {
    traceSpan.end({ ok: false, reason: 'parse-error', err: e.message })
    return { source: 'llm-cli-parse-error', passed: false, reason: `parse: ${e.message}` }
  }
}

async function refineOne(expectation, taskActivity, squad, profileFragment, cfg) {
  const apiKey = anthropicKey.getAnthropicApiKey()
  if (!apiKey) {
    // (2026-04-20 architecture fix) No API key → fall back to claude CLI subprocess,
    // which uses the system's OAuth token. Same refinement, same schema, no SDK.
    return refineViaCLI(expectation, taskActivity, squad, profileFragment, cfg)
  }
  const client = getClient(apiKey)
  if (!client) {
    // SDK genuinely missing — try CLI as last resort too.
    return refineViaCLI(expectation, taskActivity, squad, profileFragment, cfg)
  }
  const families = loadModelFamilies()
  const modelAlias = cfg?.llm_fallback?.model_alias || 'fast'
  const model = families[modelAlias] || families.fast || 'claude-haiku-4-5'
  const timeoutMs = cfg?.llm_fallback?.timeout_ms || 45000

  const parts = buildRefinerPromptParts(expectation, taskActivity, squad, profileFragment)
  const cacheTTL = cfg?.llm_fallback?.cache_ttl || '1h'

  const traceSpan = tracer.span('grader.refineOne', {
    squad, model, expectation_preview: String(expectation).slice(0, 120),
  })

  try {
    // withResponse gives us headers (x-request-id) in addition to parsed data.
    // x-request-id is the handle Anthropic support uses to diagnose issues —
    // log it to tracer so any LLM error has a reference we can quote.
    const raw = await client.messages.create({
      model,
      max_tokens: 512,
      tools: [GRADE_TOOL],
      tool_choice: { type: 'tool', name: 'grade_expectation' },
      system: [
        { type: 'text', text: parts.system }, // stable across all calls for this squad
      ],
      messages: [
        {
          role: 'user',
          content: [
            // Stable per-task block with cache breakpoint. Caches tools + system
            // + this block. Next expectation refresh for the same task reads it.
            {
              type: 'text',
              text: parts.cachedUser,
              cache_control: { type: 'ephemeral', ttl: cacheTTL },
            },
            // Dynamic block — varies per expectation, NOT cached.
            { type: 'text', text: parts.dynamicUser },
          ],
        },
      ],
    }, { timeout: timeoutMs }).withResponse?.() ?? null
    const resp = raw ? raw.data : await client.messages.create({
      model, max_tokens: 512, tools: [GRADE_TOOL],
      tool_choice: { type: 'tool', name: 'grade_expectation' },
      system: [{ type: 'text', text: parts.system }],
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: parts.cachedUser, cache_control: { type: 'ephemeral', ttl: cacheTTL } },
          { type: 'text', text: parts.dynamicUser },
        ],
      }],
    }, { timeout: timeoutMs })
    const requestId = raw?.response?.headers?.get?.('x-request-id') || null

    const toolUse = (resp.content || []).find(b => b.type === 'tool_use' && b.name === GRADE_TOOL.name)
    if (!toolUse || !toolUse.input) {
      return { source: 'llm-parse-error', passed: false, reason: 'no-tool-use-block' }
    }
    const judgment = toolUse.input

    if (judgment.passed === true) {
      const minLen = cfg?.llm_fallback?.min_evidence_quote_length || 15
      if (!judgment.evidence_quote || judgment.evidence_quote.length < minLen) {
        return {
          source: 'llm-hallucination-guard',
          passed: false, confidence: 0, evidence_quote: '',
          reason: `LLM said PASS but evidence_quote missing/too short (<${minLen} chars)`,
        }
      }
      if (!verifyEvidenceQuote(judgment.evidence_quote, taskActivity)) {
        return {
          source: 'llm-hallucination-guard',
          passed: false, confidence: 0, evidence_quote: judgment.evidence_quote,
          reason: 'LLM cited evidence_quote not found in activity — hallucination rejected',
        }
      }
    }

    const result = {
      source: 'llm',
      passed: !!judgment.passed,
      confidence: typeof judgment.confidence === 'number' ? judgment.confidence : 0.5,
      evidence_quote: judgment.evidence_quote || '',
      reason: judgment.reason || '',
      model,
      cache: {
        read: resp.usage?.cache_read_input_tokens || 0,
        write: resp.usage?.cache_creation_input_tokens || 0,
        uncached: resp.usage?.input_tokens || 0,
      },
    }
    traceSpan.end({
      passed: result.passed, source: result.source,
      cache_read: result.cache.read, cache_write: result.cache.write,
      input_tokens: result.cache.uncached, output_tokens: resp.usage?.output_tokens || 0,
      request_id: requestId || undefined,
    })
    if (requestId) result.requestId = requestId
    return result
  } catch (e) {
    traceSpan.end({ error: e?.message || 'unknown', source: 'llm-exception' })
    // SDK throws typed errors — Anthropic.RateLimitError, Anthropic.APIError, etc.
    const Anthropic = loadAnthropicSDK()
    if (Anthropic && e instanceof (Anthropic.default?.RateLimitError || Anthropic.RateLimitError || class {})) {
      return { source: 'llm-rate-limit', passed: false, reason: 'rate-limited' }
    }
    if (e?.name === 'AbortError' || /timeout/i.test(e?.message || '')) {
      return { source: 'llm-exception', passed: false, reason: 'timeout' }
    }
    return { source: 'llm-exception', passed: false, reason: e?.message || 'unknown-error' }
  }
}

// ── Shared build: extract list of pending refinements + profile fragment ─
// Used by BOTH the per-call refineWithLLM path and the batched refineWithLLMBatch path
// so the filtering logic stays identical (DRY — bugs get fixed once).
function _buildRefinementPlan(expectations, taskActivity, opts, cfg) {
  const squad = opts.squad || 'unknown'
  const minLen = cfg.llm_fallback?.min_expectation_length || 20
  const maxRefs = cfg.llm_fallback?.max_refinements_per_task || 12

  let profileFragment = ''
  try {
    if (targetClassifier && opts.taskId) {
      const profile = targetClassifier.loadProfile(opts.taskId)
      if (profile) profileFragment = targetClassifier.buildPromptFragment(profile)
    }
  } catch {}

  const toRefine = []
  for (let i = 0; i < expectations.length; i++) {
    const e = expectations[i]
    if (e.skipped) continue
    if (e.passed === true) continue
    if (typeof e.text !== 'string' || e.text.length < minLen) continue
    toRefine.push({ i, exp: e })
    if (toRefine.length >= maxRefs) break
  }
  return { toRefine, profileFragment, squad }
}

// Apply a single LLM judgment to the expectations array in the same way both paths do.
// Centralizes hallucination-guard + annotation so batch and sync paths stay in sync.
function _applyJudgment(next, idx, exp, judgment, taskActivity, model, cfg) {
  if (!judgment || typeof judgment !== 'object') {
    next[idx] = { ...exp, refined: true, source: 'llm-parse-error', reason: 'no-tool-use-block' }
    return { refined: false, source: 'llm-parse-error' }
  }

  if (judgment.passed === true) {
    const minLen = cfg?.llm_fallback?.min_evidence_quote_length || 15
    if (!judgment.evidence_quote || judgment.evidence_quote.length < minLen) {
      next[idx] = {
        ...exp, refined: true, source: 'llm-hallucination-guard',
        reason: `LLM said PASS but evidence_quote missing/too short (<${minLen} chars)`,
      }
      return { refined: false, source: 'llm-hallucination-guard' }
    }
    if (!verifyEvidenceQuote(judgment.evidence_quote, taskActivity)) {
      next[idx] = {
        ...exp, refined: true, source: 'llm-hallucination-guard',
        reason: 'LLM cited evidence_quote not found in activity — hallucination rejected',
      }
      return { refined: false, source: 'llm-hallucination-guard' }
    }

    next[idx] = {
      ...exp,
      passed: true,
      matchRate: Math.round(((typeof judgment.confidence === 'number' ? judgment.confidence : 0.5)) * 100),
      refined: true,
      source: 'llm',
      evidence_quote: judgment.evidence_quote,
      reason: judgment.reason || '',
      model,
    }
    return { refined: true, source: 'llm' }
  }

  // Answered FAIL — annotate so UI shows "LLM also reviewed".
  next[idx] = { ...exp, refined: true, source: 'llm', reason: judgment.reason || '' }
  return { refined: false, source: 'llm' }
}

// ── Batched LLM refinement — Anthropic Batches API (50% cost reduction) ─
// Submits one batch with all failed expectations, polls until processing_status === 'ended',
// then parses each result line individually. Per-request errors don't crash the batch —
// failed items pass through unchanged (regex verdict stands).
//
// Same input/output contract as refineWithLLM: { expectations, llmRefined, disabled?, reason? }.
// Respects the same cache_control as refineOne — Anthropic caches are a property of the prompt,
// not the delivery mode, so batches still hit cache.
async function refineWithLLMBatch(expectations, taskActivity, opts = {}) {
  const cfg = loadConfig()
  if (!cfg || cfg.enabled === false || cfg.rollback_mode === 'regex-only') {
    return { expectations, llmRefined: 0, disabled: true, reason: cfg?.rollback_mode || 'config-disabled' }
  }
  if (!Array.isArray(expectations) || expectations.length === 0) {
    return { expectations, llmRefined: 0 }
  }
  if (!taskActivity || taskActivity.length < 100) {
    return { expectations, llmRefined: 0, reason: 'insufficient-evidence' }
  }

  const apiKey = anthropicKey.getAnthropicApiKey()
  if (!apiKey) {
    return { expectations, llmRefined: 0, reason: 'no-api-key-for-llm-fallback' }
  }
  const client = getClient(apiKey)
  if (!client || !client.messages?.batches) {
    // SDK too old or missing — fall back to per-call path.
    return refineWithLLM(expectations, taskActivity, { ...opts, _forceSync: true })
  }

  const { toRefine, profileFragment, squad } = _buildRefinementPlan(expectations, taskActivity, opts, cfg)
  if (toRefine.length === 0) {
    return { expectations, llmRefined: 0, reason: 'nothing-to-refine' }
  }

  const families = loadModelFamilies()
  const modelAlias = cfg.llm_fallback?.model_alias || 'fast'
  const model = families[modelAlias] || families.fast || 'claude-haiku-4-5'
  const cacheTTL = cfg.llm_fallback?.cache_ttl || '1h'
  // Use nullish-coalesce so batch_max_wait_seconds=0 is respected (lets tests force immediate timeout).
  const maxWaitSec = cfg.llm_fallback?.batch_max_wait_seconds ?? 600

  // Build one batch request per expectation. Same tools/system/messages shape as refineOne.
  // cache_control on the stable prefix (tools + system + evidence) is identical — so when
  // batch workers run these through the normal Messages API pipeline, cache still hits.
  const requests = toRefine.map(({ i, exp }) => {
    const parts = buildRefinerPromptParts(exp.text, taskActivity, squad, profileFragment)
    return {
      custom_id: `exp_${i}`,
      params: {
        model,
        max_tokens: 512,
        tools: [GRADE_TOOL],
        tool_choice: { type: 'tool', name: GRADE_TOOL.name },
        system: [{ type: 'text', text: parts.system }],
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: parts.cachedUser, cache_control: { type: 'ephemeral', ttl: cacheTTL } },
              { type: 'text', text: parts.dynamicUser },
            ],
          },
        ],
      },
    }
  })

  const submitSpan = tracer.span('grader.batch.submit', {
    squad, model, batch_size: requests.length,
  })

  let batch
  try {
    batch = await client.messages.batches.create({ requests })
    submitSpan.end({ batch_id: batch.id, processing_status: batch.processing_status })
  } catch (e) {
    submitSpan.end({ error: e?.message || 'unknown', source: 'batch-submit-error' })
    return refineWithLLM(expectations, taskActivity, { ...opts, _forceSync: true })
  }

  // Poll until ended or timeout. Linear backoff capped at 30s — responsive for small batches,
  // gentle on API for large ones.
  const pollSpan = tracer.span('grader.batch.poll', { batch_id: batch.id, max_wait_sec: maxWaitSec })
  const startMs = Date.now()
  const deadlineMs = startMs + maxWaitSec * 1000
  let pollIntervalMs = 2000
  let current = batch
  try {
    while (current.processing_status !== 'ended') {
      if (Date.now() >= deadlineMs) {
        pollSpan.end({ timed_out: true, elapsed_ms: Date.now() - startMs, processing_status: current.processing_status })
        try { await client.messages.batches.cancel(batch.id) } catch {}
        return refineWithLLM(expectations, taskActivity, { ...opts, _forceSync: true, _batchTimedOut: true })
      }
      await new Promise(r => setTimeout(r, pollIntervalMs))
      pollIntervalMs = Math.min(30000, Math.floor(pollIntervalMs * 1.5))
      try {
        current = await client.messages.batches.retrieve(batch.id)
      } catch (e) {
        tracer.event('grader.batch.poll_error', { batch_id: batch.id, message: e?.message })
      }
    }
    pollSpan.end({
      elapsed_ms: Date.now() - startMs,
      succeeded: current.request_counts?.succeeded || 0,
      errored: current.request_counts?.errored || 0,
      canceled: current.request_counts?.canceled || 0,
      expired: current.request_counts?.expired || 0,
    })
  } catch (e) {
    pollSpan.end({ error: e?.message || 'unknown', source: 'batch-poll-exception' })
    return refineWithLLM(expectations, taskActivity, { ...opts, _forceSync: true })
  }

  // Fetch results. SDK returns a JSONLDecoder — async-iterable by custom_id → result.
  const resultsSpan = tracer.span('grader.batch.results', { batch_id: batch.id })
  const next = expectations.slice()
  let refinedCount = 0
  let cacheRead = 0
  let cacheWrite = 0
  let inputTokens = 0
  let outputTokens = 0
  try {
    const decoder = await client.messages.batches.results(batch.id)
    for await (const item of decoder) {
      const custom = item?.custom_id || ''
      const m = /^exp_(\d+)$/.exec(custom)
      if (!m) continue
      const idx = Number(m[1])
      const exp = expectations[idx]
      if (!exp) continue

      const res = item.result
      if (!res || res.type !== 'succeeded' || !res.message) {
        // Per-item errors don't crash the batch — annotate and move on.
        next[idx] = {
          ...exp, refined: true,
          source: res?.type === 'errored' ? 'llm-batch-errored' : `llm-batch-${res?.type || 'unknown'}`,
          reason: res?.error?.error?.message || res?.type || 'batch-item-missing-message',
        }
        continue
      }

      const msg = res.message
      const toolUse = (msg.content || []).find(b => b.type === 'tool_use' && b.name === GRADE_TOOL.name)
      const judgment = toolUse?.input
      const usage = msg.usage || {}
      cacheRead += usage.cache_read_input_tokens || 0
      cacheWrite += usage.cache_creation_input_tokens || 0
      inputTokens += usage.input_tokens || 0
      outputTokens += usage.output_tokens || 0

      const applied = _applyJudgment(next, idx, exp, judgment, taskActivity, model, cfg)
      if (applied.refined) refinedCount++
    }
    resultsSpan.end({
      refined: refinedCount, cache_read: cacheRead, cache_write: cacheWrite,
      input_tokens: inputTokens, output_tokens: outputTokens,
    })
  } catch (e) {
    resultsSpan.end({ error: e?.message || 'unknown', source: 'batch-results-exception' })
    // Partial results may have been applied; return what we have instead of crashing.
  }

  return {
    expectations: next,
    llmRefined: refinedCount,
    disabled: false,
    batchCost: {
      cache_read_tokens: cacheRead,
      cache_write_tokens: cacheWrite,
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      batch_size: requests.length,
      model,
    },
  }
}

// ── Main entry — refine a batch of failed expectations ─────────────────
// Input:
//   expectations    — array of { text, passed, matchRate, skipped? } (from regex stage)
//   taskActivity    — full evidence string
//   opts:
//     squad         — squad id for grading-notes lookup
//     taskId        — for target-profile lookup (optional)
//     _forceSync    — internal: set when batch path dispatches back to sync (avoids recursion)
//
// Output: updated array with LLM-refined entries marked with `refined: true` + source.
// Entries that already passed regex are NOT sent to LLM — cost optimization.
// Entries marked skipped (agent didn't run) are passed through unchanged.
//
// Auto-dispatch: if cfg.llm_fallback.use_batch_api=true AND toRefine.length >=
// min_expectations_for_batch, calls refineWithLLMBatch for 50% cost reduction.
async function refineWithLLM(expectations, taskActivity, opts = {}) {
  const cfg = loadConfig()
  if (!cfg || cfg.enabled === false || cfg.rollback_mode === 'regex-only') {
    return { expectations, llmRefined: 0, disabled: true, reason: cfg?.rollback_mode || 'config-disabled' }
  }
  if (!Array.isArray(expectations) || expectations.length === 0) {
    return { expectations, llmRefined: 0 }
  }
  if (!taskActivity || taskActivity.length < 100) {
    return { expectations, llmRefined: 0, reason: 'insufficient-evidence' }
  }

  const { toRefine, profileFragment, squad } = _buildRefinementPlan(expectations, taskActivity, opts, cfg)
  const refinedIndexes = new Set()

  if (toRefine.length === 0) {
    return { expectations, llmRefined: 0, reason: 'nothing-to-refine' }
  }

  // Auto-dispatch to batch API if enabled + batch size meets threshold.
  // _forceSync guards against infinite recursion when batch path falls back to us.
  const useBatch = cfg.llm_fallback?.use_batch_api === true
  const minForBatch = cfg.llm_fallback?.min_expectations_for_batch || 3
  if (useBatch && !opts._forceSync && toRefine.length >= minForBatch) {
    return refineWithLLMBatch(expectations, taskActivity, opts)
  }

  // Run refinements sequentially — low rate limits on Haiku + we want to respect cost cap
  const next = expectations.slice()
  let refinedCount = 0
  for (const { i, exp } of toRefine) {
    const r = await refineOne(exp.text, taskActivity, squad, profileFragment, cfg)
    if (r.source === 'llm' && r.passed === true) {
      next[i] = {
        ...exp,
        passed: true,
        matchRate: Math.round((r.confidence || 0.5) * 100),
        refined: true,
        source: 'llm',
        evidence_quote: r.evidence_quote,
        reason: r.reason,
        model: r.model,
      }
      refinedIndexes.add(i)
      refinedCount++
    } else if (r.source?.startsWith('llm')) {
      // LLM answered but did not pass — annotate so the UI can show "LLM also reviewed"
      next[i] = {
        ...exp,
        refined: true,
        source: r.source,
        reason: r.reason,
      }
    }
    // no-api-key and similar → leave entry unchanged (regex verdict stands)
  }

  return { expectations: next, llmRefined: refinedCount, disabled: false }
}

// ── Severity multiplier application ───────────────────────────────────
// Applies target-profile's environment+domain multipliers to an overall passRate.
// Bounded by config.severity_multiplier.floor/ceiling. Never zeros.
function applySeverityMultiplier(passRate, taskId) {
  const cfg = loadConfig()
  if (!cfg?.severity_multiplier?.enabled) return { adjusted: passRate, multiplier: 1.0 }
  if (!targetClassifier || !taskId) return { adjusted: passRate, multiplier: 1.0 }

  let profile = null
  try { profile = targetClassifier.loadProfile(taskId) } catch {}
  if (!profile) return { adjusted: passRate, multiplier: 1.0 }

  let mult = targetClassifier.getSeverityMultiplier(profile)
  const floor = cfg.severity_multiplier.floor ?? 0.3
  const ceil = cfg.severity_multiplier.ceiling ?? 1.5
  mult = Math.max(floor, Math.min(ceil, mult))

  return {
    adjusted: Math.min(100, Math.round(passRate * mult)),
    multiplier: mult,
    raw: passRate,
  }
}

// ── Test-only injection hook ──────────────────────────────────────────
// Tests mock the Anthropic SDK client by setting a getter here. Production
// callers never touch this — getClient() is used directly. Keeping the hook
// out of the hot path means zero overhead in prod.
function _setClientForTests(clientOrNull) {
  _testClient = clientOrNull
}

module.exports = {
  CONFIG_PATH,
  GRADE_TOOL,
  loadConfig,
  resetCache,
  verifyEvidenceQuote,
  refineWithLLM,
  refineWithLLMBatch,
  applySeverityMultiplier,
  buildRefinerPrompt, // exported for tests
  _setClientForTests, // exported for tests
  _refineViaCLIInner, // exported for tests (DI seam: opts._runAgent)
}
