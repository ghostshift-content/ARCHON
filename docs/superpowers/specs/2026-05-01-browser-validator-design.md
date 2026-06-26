# Phase 3.8 Browser-Based Validator — Design Spec

**Date:** 2026-05-01
**Status:** Approved (architectural placement) → Awaiting implementation approval
**Goal:** Add deterministic browser-side execution validation between the existing Offensive Vaccine block (Phase 3.7) and VYASA's final report (Phase 4). Reduce false positives on JS/DOM/CSP findings by proving they actually fire in a real browser before VYASA writes them up.

## Problem

The chain-verifier (Phase 3.6) executes curl chains and inspects HTTP responses. For findings that depend on browser-side behaviour — DOM XSS, prototype pollution, postMessage abuse, CSP bypass, client-side redirects — curl cannot tell whether the payload actually triggers when JavaScript runs. KRIPA (Phase 3) and VYASA (Phase 4 report writer) reason over evidence without browser-execution proof for these finding classes.

Real-world consequence: support.motorola.com Pentest #2 (2026-04-30) produced findings that KRIPA had to validate by reasoning over reflected payload presence, with no proof that the payload would actually execute in a browser. This is a known false-positive risk class.

## Pipeline placement (corrected from initial spec)

Initial spec placed this work as "Phase 3.7 between chain-verifier 3.6 and KRIPA 4". Investigation of the actual code (event-bus.js) showed:
- KRIPA is **Phase 3** (runs BEFORE chain-verifier 3.6), not after
- Phase 3.7 is already taken by Offensive Vaccine
- VYASA (the final report writer) is Phase 4

Corrected placement: **Phase 3.8 — between Offensive Vaccine (3.7) and VYASA (4)**. Browser-verifier reads KRIPA's structured output (`VALIDATED-FINDINGS.jsonl`) and produces evidence that VYASA consumes when writing the final report. VYASA downgrades or removes findings whose `browser_fired === false` AND verdict is KILLED.

Trade-off: this placement does NOT let KRIPA use browser evidence (KRIPA already ran). A future Phase 2.9 (before KRIPA) could add that, but adds cost and complexity. v1 keeps it simple — VYASA is the integration point.

## Scope (decided autonomously based on prior conversation: option C)

In scope — finding types Phase 3.8 will validate:
- `dom-xss` / `xss-dom` — payload reaches a DOM sink that executes JS
- `prototype-pollution` — `Object.prototype` mutation propagates to a real consumer
- `postmessage-abuse` — postMessage handler accepts attacker origin
- `csp-bypass` — payload executes despite Content-Security-Policy
- `client-side-redirect` — `location.href` assignment from attacker-controlled source
- `cors-misconfig-browser` — credentialed cross-origin reads succeed in browser context

Out of scope — handled elsewhere or deferred:
- Server-side findings (SQLi, SSRF, RCE, IDOR, auth bypass) — chain-verifier 3.6 covers
- Cookie flag inspection (HttpOnly/Secure/SameSite) — already covered by curl-based response inspection
- Authenticated browser sessions — deferred to a separate "browser auth-state" feature
- Mobile viewport variants — not needed for v1
- Screenshot diff regression — not needed for v1

## Architecture

### Layering — generic core, domain-specific dispatchers

This is the most important architectural decision: the core browser-verifier is **domain-agnostic** so it can be reused outside the pentest pipeline. Mirrors how `chain-verifier.js` is used across pentest / stocks / red-team / cloud-security squads — same pattern here.

```
┌─────────────────────────────────────────────────────┐
│ GENERIC LAYER (no domain knowledge)                 │
│  agents/browser-verifier.js          ← executor     │
│  agents/browser-recipe-validator.js  ← schema check │
│  agents/browser-evaluate-ast.js      ← AST checker  │
└─────────────────────────────────────────────────────┘
                       ▲
                       │ (importable from any squad)
                       │
┌─────────────────────────────────────────────────────┐
│ DOMAIN LAYER (pentest-specific in v1)               │
│  agents/pentest-browser-recipe-constructor.js       │
│  event-bus.js Phase 3.8 dispatcher (pentest squad)  │
│  VYASA prompt update (pentest squad)                │
└─────────────────────────────────────────────────────┘
```

**What's in the generic layer:**
- `browser-verifier.js` accepts ANY recipe matching the schema. Knows actions (navigate/fill/click/evaluate/wait_for/screenshot), timeout enforcement, verdict computation. **Knows nothing about findings, pentest, KRIPA, or pentest finding types.**
- `browser-recipe-validator.js` validates the recipe schema. Accepts a caller-provided `allowedFindingTypes` Set (defaults to permissive: any non-empty string).
- `browser-evaluate-ast.js` enforces read-only-only expressions. Pure security primitive, zero domain knowledge.

**What's in the domain layer:**
- `pentest-browser-recipe-constructor.js` knows which pentest finding types map to browser recipes, builds the LLM prompt that converts pentest findings into recipes, defines `BROWSER_RELEVANT_TYPES` for pentest.
- `event-bus.js` Phase 3.8 dispatcher wires it into the pentest pipeline between Phase 3.7 (Offensive Vaccine) and Phase 4 (VYASA report writer).

**Future reuse paths (not built in v1, but enabled by this layering):**
- Stocks squad: validate "earnings-beat → margin-expansion" thesis chains on JS-rendered financial dashboards (write `stocks-browser-recipe-constructor.js`, plug into stocks pipeline).
- Code-review squad: validate accessibility/UX claims by running components in real browser.
- Cloud-security squad: validate "S3 bucket publicly accessible" via cross-origin browser fetch.
- Network-pentest squad: validate clickjacking via iframe embedding test.
- Each future squad writes its own constructor + dispatcher. The generic three-module core stays unchanged.

### Pipeline shape (pentest squad — v1)

```
Phase 3.6 — chain-verifier (curl, deterministic)              [existing]
Phase 3.8 — browser-verifier + pentest constructor [new — uses generic core]
Phase 4   — VYASA (LLM final report, reads BROWSER-VERIFICATION as Tier-1 evidence) [prompt update]
```

### Recipe shape (Constructor-agent output)

JSON, validated against a strict schema before execution:

```typescript
{
  finding_id: string,
  finding_type: string,           // must be in IN-SCOPE list above
  description: string,
  setup?: { viewport?: {width, height}, user_agent?: string },
  steps: Array<
    | { action: 'navigate', url: string, expected?: { status?: number } }
    | { action: 'fill',     selector: string, value: string }
    | { action: 'click',    selector: string }
    | { action: 'evaluate', expression: string }     // read-only, AST-validated
    | { action: 'wait_for', selector?: string, condition?: 'attached'|'visible'|'hidden', timeout_ms?: number }
    | { action: 'screenshot', name: string }
  >,
  verdict_rule: {
    // post-conditions; ALL must hold for browser_fired=true
    expected_evaluation_results?: Array<{ step_index: number, equals?: any, truthy?: boolean }>,
    expected_console_message?: { contains: string },
    expected_navigation?: { url_pattern: string }
  }
}
```

### Output shape (`/root/intel/pentest/BROWSER-VERIFICATION-${taskId}.jsonl`)

One line per finding validated:

```typescript
{
  finding_id: string,
  finding_type: string,
  executed: boolean,
  browser_fired: boolean,           // overall verdict: did exploit trigger?
  step_results: Array<{ step_index, action, status: 'ok'|'failed'|'rejected'|'timeout', evidence }>,
  evidence: {
    screenshots: string[],          // file paths under /root/intel/pentest/screenshots/
    console_messages: Array<{ type: 'log'|'error'|'warn', text: string }>,
    network_request_count: number,  // count only, no full payloads stored
    final_url: string
  },
  verdict: 'CONFIRMED' | 'KILLED' | 'INDETERMINATE',
  reason: string
}
```

### Selective dispatch

In `event-bus.js`, after Phase 3.6 completes:

```javascript
const browserRelevantTypes = new Set([
  'dom-xss', 'xss-dom', 'prototype-pollution', 'postmessage-abuse',
  'csp-bypass', 'client-side-redirect', 'cors-misconfig-browser'
])
const browserCandidates = findings.filter(f => browserRelevantTypes.has(String(f.type || '').toLowerCase()))

if (browserCandidates.length > 0) {
  // Phase 3.8 runs only when there are candidates
  const recipes = await runBrowserRecipeConstructor(browserCandidates, taskId)  // LLM call (1 per task, batched)
  const results = browserVerifier.verifyAll(recipes, { logger })                // pure-Node, deterministic
  writeJSONL(`/root/intel/pentest/BROWSER-VERIFICATION-${taskId}.jsonl`, results)
}
```

Cost discipline: one Constructor-agent call per task (batches all browser-relevant findings into recipes), zero LLM cost during execution. Matches chain-verifier 3.6 economics.

### VYASA prompt change

Add to VYASA's report prompt builder (existing function `buildVyasaReportPrompt` in event-bus.js around line 3062):

```
If /root/intel/pentest/BROWSER-VERIFICATION-{taskId}.jsonl exists for this task,
you MUST read it before writing the report.

Browser-verification provides deterministic execution evidence for browser-side
findings. Apply these rules when deciding what makes the final report:

- For each entry in BROWSER-VERIFICATION jsonl:
  * If browser_fired === true AND verdict === 'CONFIRMED' → STRONG evidence the
    finding is real. Include in the report at the original (or higher) severity.
    Cite browser execution as Tier-1 proof.
  * If browser_fired === false AND verdict === 'KILLED' → STRONG evidence the
    finding does not actually fire. DOWNGRADE the severity by one tier OR mark as
    'AWAITING-MANUAL-CONFIRMATION' OR omit from the confirmed-findings section,
    using your judgement. Do NOT claim it as confirmed in the executive summary.
  * If verdict === 'INDETERMINATE' → fall back to KRIPA's verdict and other evidence.

- For findings NOT in BROWSER-VERIFICATION jsonl (non-browser-relevant types):
  use KRIPA validation + chain-verifier evidence as before.
```

Why VYASA, not KRIPA: KRIPA runs at Phase 3, BEFORE browser-verifier. VYASA at Phase 4 is the final gate before the report ships, and it has access to all evidence.

## Security model

### `evaluate` action — AST validation

The `evaluate` step's `expression` is parsed with Acorn before execution. Reject if the AST contains:
- `AssignmentExpression` whose left side is on `window`, `document`, `localStorage`, `sessionStorage`, `indexedDB`
- `CallExpression` to `fetch`, `XMLHttpRequest`, `WebSocket`, `EventSource`, `navigator.sendBeacon`
- `ImportDeclaration` / dynamic `import()`
- `eval`, `Function` constructor calls

Allowed: read-only expressions like `window.__xss_fired__ === true`, `document.cookie.includes('marker')`, `Object.prototype.polluted === 'yes'`.

### Per-step / per-finding timeouts

- Per-step timeout: 15s (matches chain-verifier `STEP_TIMEOUT_SEC`)
- Per-finding total timeout: 60s
- Browser context disposed after each finding (no shared state)

### Browser launch flags

```javascript
{
  headless: true,
  args: [
    '--no-sandbox',           // Docker-friendly
    '--disable-gpu',
    '--disable-dev-shm-usage',
    '--disable-extensions',
    '--no-default-browser-check'
  ],
  ignoreHTTPSErrors: true     // pentest targets sometimes have cert issues
}
```

### Network policy

- Network requests logged (count only, no bodies stored)
- No request modification (pure observation)
- File downloads disabled
- File uploads disabled (no input[type=file] interaction)

### Output sanitization

- Screenshots saved with sanitized filenames: `${taskId}-${finding_id}-${step_index}.png`
- Console messages truncated to 500 chars per entry
- No raw HTML / DOM dumps in output (prevents accidental PII storage)

## Files to create/modify

**Generic layer (domain-agnostic, importable from any squad):**

| Path | Action | Purpose |
|------|--------|---------|
| `agents/browser-verifier.js` | Create | Pure-Node executor; takes any recipe matching schema |
| `agents/browser-recipe-validator.js` | Create | Schema validator; accepts caller-provided allowedFindingTypes |
| `agents/browser-evaluate-ast.js` | Create | Read-only-expression AST checker (Acorn) |

**Pentest domain layer (v1 consumer of the generic core):**

| Path | Action | Purpose |
|------|--------|---------|
| `agents/pentest-browser-recipe-constructor.js` | Create | LLM prompt builder for pentest findings → recipes; defines pentest BROWSER_RELEVANT_TYPES |
| `event-bus.js` | Modify | Add Phase 3.8 dispatch after Phase 3.6 (pentest squad) |
| `event-bus.js` | Modify | Update KRIPA prompt to consume browser-verification output |
| `verify-framework.js` | Modify | Add GATE-53/54/55 |
| `package.json` | Modify | Add `playwright` and `acorn` dependencies |

**Tests (split by layer):**

| Path | Action | Purpose |
|------|--------|---------|
| `test/browser-verifier.test.js` | Create | Generic executor tests with fixture pages |
| `test/browser-recipe-validator.test.js` | Create | Schema validator tests, including caller-allowlist override |
| `test/browser-evaluate-ast.test.js` | Create | Read-only AST validator tests |
| `test/pentest-browser-recipe-constructor.test.js` | Create | Pentest-side prompt builder tests |
| `test/event-bus-phase37-wiring.test.js` | Create | Grep tests for event-bus Phase 3.8 wiring |
| `test/kripa-prompt-browser-aware.test.js` | Create | Grep tests for KRIPA prompt update |
| `test/fixtures/browser-validator/` | Create | Static HTML pages with intentional XSS / proto-pollution / CSP scenarios |

## Test strategy

### Unit tests (`test/browser-verifier.test.js`)

Use plain Node `assert` + `test()` helper convention (existing pattern in `test/chain-verifier.test.js`):

1. **dom-xss-fires.html fixture:** vulnerable sink that writes `location.hash` directly into the DOM via an unsafe assignment. Recipe injects a payload that sets `window.__xss_fired__ = true`, expects `browser_fired === true`.
2. **dom-xss-blocked.html fixture:** same source but uses `textContent` (safe sink). Recipe runs same payload, expects `browser_fired === false`, `verdict: KILLED`.
3. **proto-pollution.html fixture:** vulnerable merge function. Recipe injects `__proto__.polluted=yes`, evaluates `({}).polluted === 'yes'` → confirm.
4. **csp-blocked.html fixture:** page with strict CSP. Recipe injects script payload, expects `console_messages` includes "Refused to execute" → KILLED.
5. **evaluate-AST-rejects-write.test:** verify `localStorage.setItem('a','b')` is rejected at recipe-validation time (before browser launches).
6. **evaluate-AST-rejects-fetch.test:** verify `fetch('http://attacker')` is rejected.
7. **timeout-step.test:** step that runs longer than 15s gets killed and reported as `timeout`.
8. **evaluate-AST-allows-read.test:** verify `window.__xss_fired__` and `document.cookie.includes('marker')` pass AST validation.

Run via: `bun test test/browser-verifier.test.js` (matches existing pattern).

### Integration test

Dispatch a synthetic finding through event-bus.js with type=`dom-xss` against the fixture page, verify:
- BROWSER-VERIFICATION-${taskId}.jsonl is written
- KRIPA prompt includes browser-verification reference
- Final report reflects browser-fired status

## Verify-framework gates

- **GATE-53:** `browser-verifier.js` rejects any non-whitelisted action.
- **GATE-54:** KRIPA prompt builder references "BROWSER-VERIFICATION" in its template.
- **GATE-55:** Any finding with type in browser-relevant set, in a final report, must have a corresponding BROWSER-VERIFICATION entry OR an explicit `browser_validation_skipped: true` flag with a reason.

## Risks and known limitations

1. **Playwright install size:** Chromium binary is ~300MB. First-time install is slow. Mitigation: cache the binary in `/root/agents/node_modules/.playwright-cache`, document in README.
2. **WAF blocks headless Chromium:** Some targets fingerprint and block headless browsers. Output verdict in this case: `INDETERMINATE`, not `KILLED`. KRIPA falls back to existing reasoning.
3. **Self-executed JavaScript reachability:** DOM XSS detection requires injecting a marker (`window.__pentest_xss_fired__`). This only works for findings where the attacker controls a parameter that reaches a sink. For stored-DOM-XSS or non-attacker-controlled paths, browser-verifier returns `INDETERMINATE`.
4. **Auth-state out of scope:** v1 does not log into target apps. Findings on authenticated paths get `INDETERMINATE`. Future work: cookie/session injection per recipe.
5. **Cost of Playwright launches:** ~2-3s per finding. For 30 browser-relevant findings per pentest, ~75-90s extra wall-clock per task. Acceptable.

## Rollout plan

1. **Spec approval** (this doc) → ship
2. **Subagent-driven implementation** in worktree `.worktrees/browser-validator`
3. **Unit tests pass** in worktree
4. **Integration test** against fixture target
5. **Code review** via subagent-driven-development reviewers
6. **Merge** `feature/browser-validator` → `master` after live chain finishes
7. **PM2 reload event-bus** to pick up new code
8. **First live run** on next dispatched target — observe BROWSER-VERIFICATION output
9. **Memory log** the new pipeline phase

## Out of scope for this spec

- Authenticated browser sessions (separate work item)
- Visual regression testing
- Mobile viewport / device emulation
- Network request interception/MITM (we only observe, not modify)
- Per-agent Docker isolation (separate hardening work)

## Estimated effort

- Module + tests: 1-1.5 days
- event-bus.js wiring + KRIPA prompt: 0.5 days
- Verify-framework gates: 0.25 days
- Code review iteration: 0.5 days
- Merge + verify in production: 0.25 days

**Total: ~2.5 days from approval to live.**
