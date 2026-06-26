// /root/agents/agents/browser-verifier.js
// Pure-Node Playwright executor. Domain-agnostic: takes any recipe matching the
// browser-recipe-validator schema, runs it against a real headless Chromium,
// produces a deterministic verdict.
//
// Generic across squads (mirrors chain-verifier.js pattern):
//   - Pentest: dom-xss, prototype-pollution, csp-bypass, postmessage-abuse...
//   - Stocks: validate JS-rendered financial dashboard claims
//   - Cloud-security: cross-origin browser fetch checks
//   - Code-review: accessibility / UX claim validation
//
// This module knows NOTHING about findings, pentest, KRIPA, or any specific
// finding types. It just executes a recipe and returns a verdict.
//
// Security model:
//   - Recipe schema + AST checks done by browser-recipe-validator BEFORE launch
//   - Browser launched with --no-sandbox/--disable-gpu/etc (container-friendly)
//   - Per-step 15s timeout, per-finding 60s timeout
//   - Browser closed on every code path (try/finally)
//   - Console messages truncated to 500 chars per entry
//   - Network requests COUNTED only — no payloads stored (PII safety)
//   - Returns INDETERMINATE on any unhandled error (never crashes the caller)

const { chromium } = require('playwright')
const { validateRecipe } = require('./browser-recipe-validator')

const STEP_TIMEOUT_MS = 15_000
const FINDING_TIMEOUT_MS = 60_000
const CONSOLE_MSG_CAP = 500

const LAUNCH_ARGS = [
  '--no-sandbox',
  '--disable-gpu',
  '--disable-dev-shm-usage',
  '--disable-extensions',
  '--no-default-browser-check',
]

/**
 * Verify a single recipe. Returns a result object:
 *   {
 *     finding_id, finding_type,
 *     executed: boolean,
 *     browser_fired: boolean,
 *     step_results: Array<{ step_index, action, status, evidence }>,
 *     evidence: { screenshots, console_messages, network_request_count, final_url },
 *     verdict: 'CONFIRMED' | 'KILLED' | 'INDETERMINATE',
 *     reason: string
 *   }
 *
 * Never throws — all errors collapse to verdict='INDETERMINATE'.
 */
async function verifyRecipe(recipe, opts = {}) {
  const findingId = recipe && typeof recipe === 'object' ? (recipe.finding_id || null) : null
  const findingType = recipe && typeof recipe === 'object' ? (recipe.finding_type || null) : null

  // Step 0: validate recipe BEFORE launching browser
  const validation = validateRecipe(recipe, opts)
  if (!validation.ok) {
    return indeterminate({
      finding_id: findingId,
      finding_type: findingType,
      executed: false,
      reason: `recipe rejected by validator: ${validation.reason}`,
    })
  }

  const screenshotDir = opts.screenshotDir || null
  const logger = typeof opts.logger === 'function' ? opts.logger : () => {}

  let browser = null
  let context = null
  let page = null
  const stepResults = []
  const consoleMessages = []
  let networkRequestCount = 0
  let finalUrl = ''

  try {
    // Race the entire finding execution against a hard 60s timeout
    const result = await runWithTimeout(
      FINDING_TIMEOUT_MS,
      async () => {
        browser = await chromium.launch({
          headless: true,
          args: LAUNCH_ARGS,
        })

        const contextOpts = { ignoreHTTPSErrors: true }
        if (recipe.setup && recipe.setup.viewport) {
          contextOpts.viewport = recipe.setup.viewport
        }
        if (recipe.setup && typeof recipe.setup.user_agent === 'string') {
          contextOpts.userAgent = recipe.setup.user_agent
        }
        context = await browser.newContext(contextOpts)
        page = await context.newPage()

        page.on('console', (msg) => {
          try {
            const type = msg.type()
            const text = String(msg.text() || '').slice(0, CONSOLE_MSG_CAP)
            consoleMessages.push({ type, text })
          } catch {}
        })
        page.on('request', () => { networkRequestCount++ })
        page.on('pageerror', (err) => {
          try {
            consoleMessages.push({
              type: 'error',
              text: String(err && err.message || err).slice(0, CONSOLE_MSG_CAP),
            })
          } catch {}
        })

        for (let i = 0; i < recipe.steps.length; i++) {
          const step = recipe.steps[i]
          const action = String(step.action || '').toLowerCase()
          const stepRecord = { step_index: i, action, status: 'pending', evidence: {} }

          try {
            const stepRet = await runWithTimeout(
              STEP_TIMEOUT_MS,
              () => executeStep(page, step, action, { screenshotDir, recipe, stepIndex: i, logger }),
              `step ${i} (${action}) exceeded ${STEP_TIMEOUT_MS}ms`,
            )
            stepRecord.status = 'ok'
            if (stepRet && typeof stepRet === 'object') {
              if ('value' in stepRet) stepRecord.evidence.value = stepRet.value
              if ('url' in stepRet) stepRecord.evidence.url = stepRet.url
              if ('path' in stepRet) stepRecord.evidence.screenshot_path = stepRet.path
            }
          } catch (e) {
            const msg = String(e && e.message || e)
            if (/exceeded.*ms/i.test(msg) || /timeout/i.test(msg)) {
              stepRecord.status = 'timeout'
            } else if (/rejected/i.test(msg)) {
              stepRecord.status = 'rejected'
            } else {
              stepRecord.status = 'failed'
            }
            stepRecord.evidence.error = msg.slice(0, 500)
          }

          stepResults.push(stepRecord)

          // If step failed in a way that prevents continuation, stop early
          if (stepRecord.status !== 'ok' && (action === 'navigate' || action === 'evaluate')) {
            // navigate failure → cannot continue
            // evaluate failure → still record and continue (may have multiple evaluates)
            if (action === 'navigate') break
          }
        }

        try { finalUrl = page.url() } catch {}

        return computeVerdict(recipe, stepResults)
      },
      `recipe execution exceeded ${FINDING_TIMEOUT_MS}ms`,
    )

    return {
      finding_id: findingId,
      finding_type: findingType,
      executed: true,
      browser_fired: result.browser_fired,
      step_results: stepResults,
      evidence: {
        screenshots: stepResults.map(s => s.evidence && s.evidence.screenshot_path).filter(Boolean),
        console_messages: consoleMessages,
        network_request_count: networkRequestCount,
        final_url: finalUrl,
      },
      verdict: result.verdict,
      reason: result.reason,
    }
  } catch (e) {
    // Catch-all: any unhandled error → INDETERMINATE rather than crash
    return {
      finding_id: findingId,
      finding_type: findingType,
      executed: stepResults.length > 0,
      browser_fired: false,
      step_results: stepResults,
      evidence: {
        screenshots: stepResults.map(s => s.evidence && s.evidence.screenshot_path).filter(Boolean),
        console_messages: consoleMessages,
        network_request_count: networkRequestCount,
        final_url: finalUrl,
      },
      verdict: 'INDETERMINATE',
      reason: `unhandled error: ${String(e && e.message || e).slice(0, 300)}`,
    }
  } finally {
    // ALWAYS close browser, no matter what happened
    if (page) { try { await page.close() } catch {} }
    if (context) { try { await context.close() } catch {} }
    if (browser) { try { await browser.close().catch(() => {}) } catch {} }
  }
}

/**
 * Verify multiple recipes serially (no parallelism — keeps Chromium memory
 * footprint bounded, and matches chain-verifier semantics).
 */
async function verifyAll(recipes, opts = {}) {
  const out = []
  const list = Array.isArray(recipes) ? recipes : []
  for (const recipe of list) {
    const r = await verifyRecipe(recipe, opts)
    out.push(r)
  }
  return out
}

/**
 * Execute a single step. Returns an object with step-specific evidence.
 * Throws on failure (caught by caller, which records the failure).
 */
async function executeStep(page, step, action, ctx) {
  switch (action) {
    case 'navigate': {
      const resp = await page.goto(step.url, { waitUntil: 'load', timeout: STEP_TIMEOUT_MS })
      const url = page.url()
      // Optional expected.status check (advisory; does not throw)
      let status = null
      try { status = resp ? resp.status() : null } catch {}
      return { url, value: status }
    }
    case 'fill': {
      await page.fill(step.selector, step.value, { timeout: STEP_TIMEOUT_MS })
      return {}
    }
    case 'click': {
      await page.click(step.selector, { timeout: STEP_TIMEOUT_MS })
      return {}
    }
    case 'evaluate': {
      // The expression has already been AST-checked at validation time.
      // We wrap it as `(() => (EXPR))()` to ensure it's an expression position.
      const wrapped = `(() => (${step.expression}))()`
      const value = await page.evaluate(wrapped)
      return { value }
    }
    case 'wait_for': {
      const timeout = typeof step.timeout_ms === 'number' ? step.timeout_ms : 5000
      if (step.selector) {
        const condition = step.condition || 'attached'
        await page.waitForSelector(step.selector, { state: condition, timeout })
      } else {
        await page.waitForTimeout(timeout)
      }
      return {}
    }
    case 'screenshot': {
      let savedPath = null
      if (ctx.screenshotDir) {
        const fs = require('node:fs')
        const path = require('node:path')
        try { fs.mkdirSync(ctx.screenshotDir, { recursive: true }) } catch {}
        const safeName = String(step.name || 'shot').replace(/[^a-zA-Z0-9._-]/g, '_')
        savedPath = path.join(
          ctx.screenshotDir,
          `${ctx.recipe.finding_id || 'unknown'}-${ctx.stepIndex}-${safeName}.png`,
        )
        await page.screenshot({ path: savedPath, fullPage: false })
      } else {
        // No directory configured → take but discard (still proves the page rendered)
        await page.screenshot({ fullPage: false })
      }
      return { path: savedPath }
    }
    case 'cross_origin_fetch': {
      // Gold-standard credentialed-CORS verifier (Sprint B Task B2).
      // Loads an attacker page via data: URL (null opaque origin — worst-case
      // for the victim's CORS policy) in headless Chromium and attempts
      // fetch(victim_url, {credentials:'include'}). Real browser Fetch-spec
      // semantics: success requires ACAO=<attacker_origin> (NOT '*' under
      // credentials) AND ACAC=true on the FINAL post-redirect response.
      // Failure surfaces as TypeError: Failed to fetch in the attacker JS.
      //
      // Evidence: window.__cors_result is set deterministically to either
      //   { ok:true, status, body_len }    — browser admitted the response
      //   { ok:false, error }              — browser blocked (TypeError / network)
      //
      // The `matched` flag on the return is true ONLY when fetch succeeded
      // with a 2xx/3xx status — false for blocked, network errors, or any
      // non-2xx/3xx response status. This feeds computeVerdict's
      // expected_evaluation_results truthy check.
      const victim = step.victim_url
      const credentials = step.credentials || 'include'
      if (!victim || !/^https?:\/\//.test(victim)) {
        throw new Error(`cross_origin_fetch: victim_url must be http(s), got ${JSON.stringify(victim)}`)
      }
      // JSON.stringify the victim URL before interpolation — prevents script-
      // injection if a Constructor LLM ever emits a payload containing </script>.
      const attackerHtml = `<!doctype html><html><body><script>
(async () => {
  try {
    const r = await fetch(${JSON.stringify(victim)}, {
      credentials: ${JSON.stringify(credentials)},
      mode: 'cors',
    });
    const body = await r.text();
    window.__cors_result = { ok: true, status: r.status, body_len: body.length };
  } catch (e) {
    window.__cors_result = { ok: false, error: String((e && e.message) || e) };
  }
})();
</script></body></html>`
      const attackerUrl = 'data:text/html;base64,' + Buffer.from(attackerHtml).toString('base64')

      await page.goto(attackerUrl, { waitUntil: 'load', timeout: STEP_TIMEOUT_MS })
      const handle = await page.waitForFunction(() => window.__cors_result, { timeout: 10_000 })
      const corsResult = await handle.jsonValue()
      const matched = !!corsResult && corsResult.ok === true &&
        typeof corsResult.status === 'number' &&
        corsResult.status >= 200 && corsResult.status < 400
      // computeVerdict reads `value` for evaluate-style truthy/equals checks.
      // Set value=matched so verdict_rule can assert truthy:true to CONFIRM.
      return {
        value: matched,
        url: victim,
        cors_result: corsResult,
        matched,
      }
    }
    default:
      throw new Error(`unknown action '${action}'`)
  }
}

/**
 * Compute verdict from step results + recipe.verdict_rule.
 *
 *   CONFIRMED      = recipe ran end-to-end AND all expected_evaluation_results held
 *   KILLED         = recipe ran but at least one expected evaluation result mismatched
 *                    (e.g. expected window.__xss_fired__ === true but got false)
 *   INDETERMINATE  = recipe didn't complete (timeout/navigation failure/etc.)
 */
function computeVerdict(recipe, stepResults) {
  const totalSteps = recipe.steps.length
  const okSteps = stepResults.filter(s => s.status === 'ok').length

  // Did the recipe execute every step successfully?
  const ranToCompletion = stepResults.length === totalSteps && okSteps === totalSteps

  if (!ranToCompletion) {
    return {
      verdict: 'INDETERMINATE',
      browser_fired: false,
      reason: `recipe did not complete — ${okSteps}/${totalSteps} steps ok`,
    }
  }

  const rule = recipe.verdict_rule || {}
  const expectedEvals = Array.isArray(rule.expected_evaluation_results)
    ? rule.expected_evaluation_results
    : []

  if (expectedEvals.length === 0) {
    // No verdict rule → treat completion as confirmation that the recipe ran
    return {
      verdict: 'CONFIRMED',
      browser_fired: true,
      reason: 'all steps executed; no explicit verdict_rule provided',
    }
  }

  for (const expected of expectedEvals) {
    const idx = expected.step_index
    const sr = stepResults[idx]
    if (!sr || sr.status !== 'ok') {
      return {
        verdict: 'INDETERMINATE',
        browser_fired: false,
        reason: `expected_evaluation_results references step ${idx} which is not ok`,
      }
    }
    const actual = sr.evidence ? sr.evidence.value : undefined
    if ('equals' in expected) {
      if (actual !== expected.equals) {
        return {
          verdict: 'KILLED',
          browser_fired: false,
          reason: `step ${idx} evaluation expected ${JSON.stringify(expected.equals)}, got ${JSON.stringify(actual)}`,
        }
      }
    } else if ('truthy' in expected) {
      const isTruthy = !!actual
      if (isTruthy !== !!expected.truthy) {
        return {
          verdict: 'KILLED',
          browser_fired: false,
          reason: `step ${idx} evaluation expected truthy=${expected.truthy}, got ${JSON.stringify(actual)}`,
        }
      }
    }
  }

  return {
    verdict: 'CONFIRMED',
    browser_fired: true,
    reason: 'all steps executed and all expected_evaluation_results matched',
  }
}

/**
 * Helper: race a promise-returning function against a timeout.
 * Throws Error(`<msg>`) on timeout (default: "<n>ms timeout").
 */
function runWithTimeout(ms, fn, timeoutMsg) {
  return new Promise((resolve, reject) => {
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      reject(new Error(timeoutMsg || `${ms}ms timeout`))
    }, ms)

    Promise.resolve()
      .then(() => fn())
      .then(
        (v) => { if (!settled) { settled = true; clearTimeout(timer); resolve(v) } },
        (e) => { if (!settled) { settled = true; clearTimeout(timer); reject(e) } },
      )
  })
}

function indeterminate(base) {
  return {
    finding_id: base.finding_id,
    finding_type: base.finding_type,
    executed: !!base.executed,
    browser_fired: false,
    step_results: [],
    evidence: { screenshots: [], console_messages: [], network_request_count: 0, final_url: '' },
    verdict: 'INDETERMINATE',
    reason: base.reason,
  }
}

module.exports = {
  verifyRecipe,
  verifyAll,
  STEP_TIMEOUT_MS,
  FINDING_TIMEOUT_MS,
}
