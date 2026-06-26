// /root/agents/chain-verifier.js
// Pure-Node chain execution + verification engine. No LLM involved in this module.
//
// Takes a structured chain (from a Constructor agent's JSON output), executes each step
// in order, does variable substitution from prior steps' extracts, matches expected_result,
// returns a deterministic verification verdict.
//
// Generic across squads:
//   - Pentest: attack chains (auth bypass → data exfil)
//   - Stocks: thesis validation chains (earnings beat → margin expansion → rerating)
//   - Red-team: kill chains (initial access → lateral → persistence)
//   - Cloud-security: IAM chains (role assumption → privilege escalation → resource access)
//
// Security model: the executor parses `curl` strings into an argv array and uses spawnSync
// WITHOUT a shell. This means even if the Constructor LLM emits a malicious curl with
// `curl && rm -rf /` or `curl; cat /etc/passwd`, only the first token (`curl`) is executed
// as a binary and subsequent tokens become literal args — no shell interpretation.
//
// Only the `curl` binary is allowed as the command (whitelisted). Anything else = rejected.

const { spawnSync } = require('child_process')
const { isCorsAssertion, extractFinalResponse } = require('../../agents/redirect-aware-curl')

// Maximum time per step (seconds). Prevents runaway curls.
const STEP_TIMEOUT_SEC = 15

// Allowed binaries (universal across squads). 2026-05-12: expanded from
// curl-only to include common information-gathering tools the Constructor
// LLM naturally emits for multi-step recon chains. Round-10 chain-001
// (TLS SAN extraction) failed step 1 with `echo | openssl s_client | grep`
// because only curl was allowed. Each entry in this list is a NETWORK-READ
// tool with no execution side-effects. Shell pipelines remain banned —
// each step must use exactly ONE allowed binary as the first token.
const ALLOWED_COMMANDS = Object.freeze([
  'curl',     // HTTP probes
  'openssl',  // TLS cert inspection (s_client, x509)
  'dig',      // DNS records
  'nslookup', // DNS records (legacy)
  'host',     // DNS records (simple)
])

// Backwards-compat alias kept for any external caller that imported this.
const ALLOWED_COMMAND = 'curl'

/**
 * Verify a single chain. Returns { verified, stepResults, reason }.
 */
function verifyChain(chain, opts = {}) {
  const { dryRun = false, maxSteps = 20, logger = () => {} } = opts
  const stepResults = []
  const context = { steps: [] } // accumulated step outputs for substitution

  const steps = Array.isArray(chain.steps) ? chain.steps.slice(0, maxSteps) : []
  if (steps.length === 0) {
    return { verified: false, stepResults: [], reason: 'chain has no steps' }
  }

  let earlyStop = null

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i]
    const stepRecord = {
      step_id: step.step_id != null ? step.step_id : i + 1,
      description: step.description || `step ${i + 1}`,
      curl: step.curl || '',
      expected_result: step.expected_result || '',
      status: 'pending',
      response: '',
      matched: false,
      extracted: {},
    }

    try {
      // Variable substitution: replace {{ steps[N].extracts.key }} with values from context
      const resolvedCurl = _substituteTemplates(step.curl, context)
      stepRecord.resolvedCurl = resolvedCurl

      // Parse curl into argv — rejects anything not starting with `curl` as the binary
      const parseResult = _parseCurlCommand(resolvedCurl)
      if (!parseResult.ok) {
        stepRecord.status = 'rejected'
        stepRecord.reason = parseResult.reason
        stepResults.push(stepRecord)
        earlyStop = `step ${stepRecord.step_id} rejected: ${parseResult.reason}`
        break
      }
      const argv = parseResult.argv

      if (dryRun) {
        stepRecord.status = 'dry-run'
        stepRecord.argv = argv
        stepResults.push(stepRecord)
        continue
      }

      logger(`[chain-verifier] step ${stepRecord.step_id}: ${stepRecord.description}`)
      // (2026-04-23) Auto-augment curl args so status-code matching actually works.
      // Run 1 (Apr-21) had 0/3 chains verified because Constructor emitted `curl URL`
      // with expected_result "HTTP 200" — but a plain curl doesn't print the status
      // line to stdout, so the status regex never matched reality. Fix: force
      // `-sS` (silent + show errors), inject `-w` to write the real status code on
      // its own line after the body, and ensure we get the body even on 4xx/5xx.
      //
      // 2026-05-12: argv[0] is now one of curl/openssl/dig/nslookup/host
      // (Sprint May-12 multi-binary support). Augmentation runs only for curl.
      const cmdBinary = argv[0]
      const execArgv = cmdBinary === 'curl'
        ? _augmentCurlArgs(argv.slice(1))
        : argv.slice(1)
      const proc = spawnSync(cmdBinary, execArgv, {
        encoding: 'utf-8',
        timeout: (STEP_TIMEOUT_SEC + 2) * 1000,
        maxBuffer: 5 * 1024 * 1024,
      })
      let stdout = (proc.stdout || '').toString()
      const stderr = (proc.stderr || '').toString()
      stepRecord.response = stdout.slice(0, 5000) // cap for storage
      if (stderr) stepRecord.stderr = stderr.slice(0, 500)
      stepRecord.status = 'executed'
      if (proc.error) stepRecord.exec_error = String(proc.error.message || proc.error).slice(0, 200)
      if (proc.status != null) stepRecord.exit_code = proc.status

      // Redirect-aware CORS recheck (Sprint B B1, 2026-05-22)
      // Kills the CORS-on-redirect FP class: browsers re-evaluate CORS only at
      // the final landing (Fetch spec §HTTP-redirect-fetch), but plain curl
      // without -L stops at the first 3xx and we'd match ACAO on a redirect
      // hop. When the step asserts on CORS headers AND the response is 3xx,
      // re-execute the same curl with -L --max-redirs 5 and replace the
      // match-source with the FINAL response only.
      if (cmdBinary === 'curl' && isCorsAssertion(step.expected_result, step.expected_keywords)) {
        const statusMarker = stdout.match(/HTTP\/STATUS\/(\d{3})/)
          || stdout.match(/HTTP\/(?:1\.[01]|2|3)\s+(\d{3})/)
        const observedStatus = statusMarker ? Number(statusMarker[1]) : null
        if (observedStatus != null && observedStatus >= 300 && observedStatus < 400) {
          try {
            const rcArgv = ['-L', '--max-redirs', '5', ...execArgv]
            const rcProc = spawnSync(cmdBinary, rcArgv, {
              encoding: 'utf-8',
              timeout: (STEP_TIMEOUT_SEC + 2) * 1000,
              maxBuffer: 5 * 1024 * 1024,
            })
            if (!rcProc.error && rcProc.stdout) {
              const rcStdout = rcProc.stdout.toString()
              const finalOnly = extractFinalResponse(rcStdout)
              stdout = finalOnly
              stepRecord.response = finalOnly.slice(0, 5000)
              stepRecord.verified_via = 'redirect-aware-recheck'
              if (rcProc.status != null) stepRecord.recheck_exit_code = rcProc.status
            }
          } catch {
            // fall back to original output — don't crash the step on recheck error
          }
        }
      }

      // Match expected_result
      if (step.match_mode === 'semantic') {
        // 2026-05-12 (D1): keywords + status_code_range. Tolerant of variable
        // responses (rotating IDs, varied error messages) where strict regex
        // produced 0/N verification across round-9/round-10.
        const actualStatusMatch = stdout.match(/HTTP\/STATUS\/(\d{3})/)
          || stdout.match(/HTTP\/(?:1\.[01]|2|3)\s+(\d{3})/)
        const actualStatus = actualStatusMatch ? Number(actualStatusMatch[1]) : null
        const semantic = semanticMatch(stdout, {
          keywords: step.expected_keywords || [],
          status_code_range: step.expected_status_range || [200, 299],
          actual_status_code: actualStatus,
        })
        stepRecord.matched = semantic.matched
        stepRecord.match_mode = 'semantic'
        stepRecord.matched_keywords = semantic.matched_keywords
        if (!semantic.matched) {
          stepRecord.match_failure = {
            reason: semantic.reason,
            expected_keywords: step.expected_keywords || [],
            expected_status_range: step.expected_status_range || [200, 299],
            actual_status_code: actualStatus,
            responsePreview: stdout.slice(0, 200).replace(/\n/g, ' '),
          }
        }
      } else if (step.expected_result) {
        stepRecord.matched = _matchExpected(stdout, step.expected_result)
        if (!stepRecord.matched) {
          // Better diagnostic — include WHAT we got vs what was expected
          stepRecord.match_failure = {
            expected: String(step.expected_result).slice(0, 120),
            responsePreview: stdout.slice(0, 200).replace(/\n/g, ' '),
          }
        }
      } else {
        // No expected_result → any non-error response counts as pass
        stepRecord.matched = stdout.length > 0 && !stepRecord.exec_error
      }

      // Extract fields for substitution in later steps
      if (step.extracts && typeof step.extracts === 'object') {
        for (const [key, jsonpath] of Object.entries(step.extracts)) {
          try {
            stepRecord.extracted[key] = _extractJsonpath(stdout, jsonpath)
          } catch {}
        }
      }

      context.steps.push({
        response: stdout,
        extracts: stepRecord.extracted,
      })

      // Early stop: if step failed to match, no point continuing chain (later steps depend on it)
      if (!stepRecord.matched) {
        earlyStop = `step ${stepRecord.step_id} did not match expected result`
        stepResults.push(stepRecord)
        break
      }
    } catch (e) {
      stepRecord.status = 'error'
      stepRecord.reason = e.message.slice(0, 300)
      stepResults.push(stepRecord)
      earlyStop = `step ${stepRecord.step_id} threw: ${e.message.slice(0, 100)}`
      break
    }
    stepResults.push(stepRecord)
  }

  const allMatched = stepResults.every(s => s.matched)
  const verified = stepResults.length === steps.length && allMatched && !earlyStop
  return {
    verified,
    stepResults,
    reason: verified ? 'all steps executed and matched expected results' : (earlyStop || 'unknown'),
  }
}

/**
 * Verify multiple chains, returns summary + per-chain results.
 */
function verifyChains(chains, opts = {}) {
  const results = []
  for (const chain of chains || []) {
    const r = verifyChain(chain, opts)
    results.push({
      id: chain.id || chain.name || 'unnamed',
      name: chain.name || '',
      severity: chain.severity || 'Unknown',
      mitre_technique: chain.mitre_technique || '',
      narrative: chain.narrative || '',
      ...r,
    })
  }
  const verifiedCount = results.filter(r => r.verified).length
  return { total: results.length, verified: verifiedCount, results }
}

/**
 * Parse a "curl ..." string into argv. Rejects:
 *   - Empty/missing input
 *   - First token != "curl"
 *   - Shell metacharacters outside quoted strings (| ; & $() ` > < ...)
 *   - Backtick command substitution anywhere
 *
 * Returns { ok: true, argv: [...] } on success or { ok: false, reason }.
 */
function _parseCurlCommand(input) {
  if (!input || typeof input !== 'string') {
    return { ok: false, reason: 'curl command missing or not a string' }
  }
  const trimmed = input.trim()

  // Reject shell metacharacters that would only be meaningful via a shell
  // (we run without a shell, but we still want to reject these to fail fast with a clear reason)
  if (/[\`\|&;><]/.test(trimmed.replace(/'[^']*'|"[^"]*"/g, ''))) {
    return { ok: false, reason: 'curl command contains shell metacharacters (|, &, ;, >, <, `) outside quotes' }
  }
  if (/\$\(/.test(trimmed)) {
    return { ok: false, reason: 'curl command contains command substitution $(...)' }
  }

  // Tokenize respecting single and double quotes
  const argv = []
  let cur = ''
  let inS = false
  let inD = false
  let esc = false
  for (let i = 0; i < trimmed.length; i++) {
    const c = trimmed[i]
    if (esc) { cur += c; esc = false; continue }
    if (c === '\\' && inD) { esc = true; continue }
    if (c === "'" && !inD) { inS = !inS; continue }
    if (c === '"' && !inS) { inD = !inD; continue }
    if (/\s/.test(c) && !inS && !inD) {
      if (cur) { argv.push(cur); cur = '' }
      continue
    }
    cur += c
  }
  if (cur) argv.push(cur)

  if (argv.length === 0) return { ok: false, reason: 'empty command' }
  if (!ALLOWED_COMMANDS.includes(argv[0])) {
    return {
      ok: false,
      reason: `first token must be one of ${ALLOWED_COMMANDS.join('/')}, got '${argv[0]}'`,
    }
  }
  return { ok: true, argv }
}

/**
 * Augment curl argv so status-code + body + diagnostics are reliably captured.
 * Post-conditions (idempotent — safe to call on already-augmented argv):
 *   - `-sS` is present (silent, but show errors on stderr)
 *   - `-w "\nHTTP/STATUS/%{http_code}\n"` appends a normalized status marker
 *     to stdout after the body. Enables status-code matching against stdout.
 *   - No redirects auto-followed unless Constructor explicitly passed `-L`
 *     (we don't want silent redirects to mask auth issues).
 */
function _augmentCurlArgs(args) {
  const out = args.slice()
  const joined = args.join(' ')
  // Add -sS if no silent flag already present
  if (!/(^| )-sS?\b/.test(joined) && !/(^| )--silent\b/.test(joined)) {
    out.push('-sS')
  }
  // Ensure our status-code marker is appended exactly once.
  // We intentionally don't collapse existing -w flags — if Constructor passed one,
  // it still works (curl emits both); our marker is unique enough to grep out.
  if (!args.some(a => typeof a === 'string' && a.includes('HTTP/STATUS/%{http_code}'))) {
    out.push('-w', '\nHTTP/STATUS/%{http_code}\n')
  }
  return out
}

/**
 * Simple template substitution: replace {{ steps[N].extracts.key }} with context values.
 */
function _substituteTemplates(str, context) {
  if (!str) return ''
  return str.replace(/\{\{\s*steps\[(\d+)\]\.extracts\.(\w+)\s*\}\}/g, (_, idx, key) => {
    const step = context.steps[parseInt(idx)]
    if (step && step.extracts && step.extracts[key] != null) {
      return String(step.extracts[key])
    }
    return '' // unresolved reference — empty string (the curl will probably fail, logged as non-match)
  })
}

/**
 * Match response against expected_result. Supports:
 *   - Regex with explicit /pattern/flags syntax (case-sensitive as specified)
 *   - Status-code shorthand ("HTTP 200" or "status:200")
 *   - Plain substring — case-INSENSITIVE (chains shouldn't fail on "Content-Type" vs "content-type")
 *
 * (2026-04-23) Status-code matching now reads the `HTTP/STATUS/NNN` marker
 * we inject via _augmentCurlArgs, not the legacy HTTP/1.1 status line that
 * only appears with `-i`/`-v`. This is the root fix for Apr-21 Run-1's 0/3.
 */
/**
 * Semantic match: response matches if the actual HTTP status is inside the
 * named status_code_range AND at least one keyword from the keyword set is
 * present in the response body (case-insensitive). Used for chain steps whose
 * exact response Constructor can't predict (rotating IDs, varied error text,
 * timestamps) — round-9/round-10 showed strict regex caused 0/N verification.
 *
 * Returns { matched: boolean, matched_keywords: string[], reason?: string }.
 */
function semanticMatch(responseText, criteria) {
  const text = String(responseText || '')
  const keywords = Array.isArray(criteria.keywords) ? criteria.keywords : []
  const range = Array.isArray(criteria.status_code_range) ? criteria.status_code_range : null
  const actualStatus = criteria.actual_status_code
  const matched_keywords = keywords.filter(k => {
    const escaped = String(k).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    return new RegExp(escaped, 'i').test(text)
  })
  if (range && actualStatus != null) {
    const [low, high] = range
    if (actualStatus < low || actualStatus > high) {
      return { matched: false, reason: 'status_code out of range', matched_keywords }
    }
  }
  if (keywords.length > 0 && matched_keywords.length === 0) {
    return { matched: false, reason: 'no keyword matched', matched_keywords }
  }
  return { matched: true, matched_keywords }
}

function _matchExpected(response, expected) {
  if (!expected) return true
  const trimmed = String(expected).trim()

  // Regex form: /pattern/flags — exact semantics, case respects flags
  if (trimmed.startsWith('/') && trimmed.lastIndexOf('/') > 0) {
    const lastSlash = trimmed.lastIndexOf('/')
    const pattern = trimmed.slice(1, lastSlash)
    const flags = trimmed.slice(lastSlash + 1)
    try {
      const re = new RegExp(pattern, flags)
      return re.test(response)
    } catch {
      // Invalid regex — fall through to substring, case-insensitive
      return response.toLowerCase().includes(trimmed.toLowerCase())
    }
  }

  // Status-code shorthand. Prefer our injected marker; fall back to legacy HTTP/X.Y line.
  const statusMatch = trimmed.match(/^(?:HTTP\s*|status:\s*)(\d{3})/i)
  if (statusMatch) {
    const code = statusMatch[1]
    // New marker injected by _augmentCurlArgs
    if (new RegExp(`HTTP/STATUS/${code}\\b`).test(response)) return true
    // Legacy status-line fallback (only present if chain used -i / -v)
    return new RegExp(`HTTP/(?:1\\.[01]|2|3)\\s+${code}`, 'm').test(response)
  }

  // Plain substring — case-insensitive. Chain authors shouldn't have to worry
  // about casing of response headers vs what they typed in expected_result.
  return response.toLowerCase().includes(trimmed.toLowerCase())
}

/**
 * Minimal jsonpath extractor. Handles simple paths like $.foo, $.foo.bar, $[0].baz, $..token.
 */
function _extractJsonpath(responseText, path) {
  let obj
  try { obj = JSON.parse(responseText) } catch { return null }
  if (!obj) return null
  if (path === '$') return obj
  if (path.startsWith('$..')) {
    const key = path.slice(3)
    return _findRecursive(obj, key)
  }
  const cleaned = path.replace(/^\$/, '').replace(/^\./, '')
  const parts = cleaned.split(/\.|\[|\]/).filter(Boolean)
  let cur = obj
  for (const p of parts) {
    if (cur == null) return null
    const idx = parseInt(p)
    cur = isNaN(idx) ? cur[p] : cur[idx]
  }
  return cur
}

function _findRecursive(obj, key) {
  if (obj == null || typeof obj !== 'object') return null
  if (Array.isArray(obj)) {
    for (const item of obj) {
      const r = _findRecursive(item, key)
      if (r != null) return r
    }
    return null
  }
  if (key in obj) return obj[key]
  for (const v of Object.values(obj)) {
    const r = _findRecursive(v, key)
    if (r != null) return r
  }
  return null
}

// JSON schema that Constructor agents MUST emit against. Exposed so both the spawn site
// and any future consumer can reference the same schema.
const CHAIN_OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    chains: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          name: { type: 'string' },
          severity: { type: 'string', enum: ['Critical', 'High', 'Medium', 'Low', 'Info'] },
          mitre_technique: { type: 'string' },
          narrative: { type: 'string' },
          // Sprint B Task B3.5 (2026-05-22): IDs of the underlying confirmed
          // findings this chain composes. MUST match VALIDATED-FINDINGS IDs —
          // VYASA chain-orphan guard (agents/vyasa-chain-orphan-guard.js)
          // drops chains whose finding_ids have no validated backing. Without
          // this field, the guard would drop every chain in production.
          finding_ids: {
            type: 'array',
            items: { type: 'string' },
            minItems: 1,
            description: 'IDs of the underlying confirmed findings this chain composes — must match VALIDATED-FINDINGS IDs',
          },
          steps: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                step_id: { type: 'number' },
                description: { type: 'string' },
                curl: { type: 'string' },
                expected_result: { type: 'string' },
                extracts: { type: 'object' },
              },
              required: ['step_id', 'description', 'curl', 'expected_result'],
            },
          },
        },
        required: ['id', 'name', 'severity', 'finding_ids', 'steps'],
      },
    },
  },
  required: ['chains'],
}

module.exports = {
  verifyChain,
  verifyChains,
  semanticMatch,
  CHAIN_OUTPUT_SCHEMA,
  STEP_TIMEOUT_SEC,
}
