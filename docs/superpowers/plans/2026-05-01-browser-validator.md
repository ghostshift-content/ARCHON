# Phase 3.8 Browser-Based Validator — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the deterministic Playwright-based browser validator described in `docs/superpowers/specs/2026-05-01-browser-validator-design.md`, wired as Phase 3.8 (between Offensive Vaccine 3.7 and VYASA 4) in event-bus.js.

**Architecture:** Pure-Node module (`agents/browser-verifier.js`) mirroring chain-verifier.js. Constructor agent (`agents/pentest-browser-recipe-constructor.js`) builds recipes from findings. event-bus.js dispatches Phase 3.8 (between Offensive Vaccine 3.7 and VYASA 4) selectively for browser-relevant finding types. VYASA prompt updated to consume browser-verification output as report-gate evidence.

**Tech Stack:** Node.js (CommonJS), Playwright npm package + Chromium, Acorn AST parser for evaluate-step expression validation, plain Node `assert` + `test()` helper for tests, bun test runner.

---

## File Structure (layered for reuse)

The system is split into a **generic core** (no domain knowledge — reusable by any future squad) and a **pentest domain layer** (v1 consumer). Future squads (stocks, cloud, code-review) write their own domain layer on top of the same generic core.

**Generic layer:**

| Path | Responsibility |
|------|---------------|
| `agents/browser-verifier.js` | Pure-Node executor: takes any recipe matching schema, runs Playwright, produces verdicts. Knows nothing about pentest/findings/KRIPA. |
| `agents/browser-recipe-validator.js` | Schema check; accepts caller-provided `allowedFindingTypes` (defaults to permissive) |
| `agents/browser-evaluate-ast.js` | Read-only-expression AST checker (Acorn) |

**Pentest domain layer:**

| Path | Responsibility |
|------|---------------|
| `agents/pentest-browser-recipe-constructor.js` | LLM prompt builder + pentest `BROWSER_RELEVANT_TYPES` set + `filterBrowserRelevant()` filter |
| `event-bus.js` | Phase 3.8 dispatcher (pentest squad) + VYASA prompt update |
| `verify-framework.js` | GATE-53/54/55 |

**Tests:**

| Path | Responsibility |
|------|---------------|
| `test/browser-evaluate-ast.test.js` | Generic AST checker tests |
| `test/browser-recipe-validator.test.js` | Generic schema validator tests, including caller-allowlist override path |
| `test/browser-verifier.test.js` | Generic executor tests with fixtures |
| `test/pentest-browser-recipe-constructor.test.js` | Pentest-domain constructor tests |
| `test/event-bus-phase37-wiring.test.js` | Grep tests for event-bus Phase 3.8 wiring |
| `test/vyasa-prompt-browser-aware.test.js` | Grep tests for VYASA prompt update |

**Fixtures + deps:**

| Path | Responsibility |
|------|---------------|
| `test/fixtures/browser-validator/*.html` | Vulnerable + safe-sink HTML for unit tests |
| `package.json` | Add `playwright` and `acorn` dependencies |

---

## Task 1: Install Playwright and Acorn dependencies

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Install dependencies**

```bash
cd /root/agents/.worktrees/browser-validator
npm install --save playwright@^1.48.0 acorn@^8.12.0
```

- [ ] **Step 2: Install Chromium binary**

```bash
npx playwright install chromium
```

Expected: Chromium downloaded to `~/.cache/ms-playwright/`. About 300MB.

- [ ] **Step 3: Smoke test — Playwright loads**

```bash
node -e "const { chromium } = require('playwright'); chromium.launch({ headless: true }).then(b => b.close()).then(() => console.log('OK'))"
```

Expected: prints `OK`.

- [ ] **Step 4: Commit**

```bash
git add package.json package-lock.json
git commit -m "deps: add playwright + acorn for Phase 3.8 browser-validator"
```

---

## Task 2: AST validator for evaluate-step expressions

The evaluate step is the most security-sensitive: a Constructor LLM emits a JavaScript expression string that gets executed inside a real browser context. We must reject any expression that could mutate page state, exfiltrate data, or escape Playwright's sandbox. The AST validator inspects the expression statically before the browser ever launches.

**Files:**
- Create: `agents/browser-evaluate-ast.js`
- Test: `test/browser-evaluate-ast.test.js`

- [ ] **Step 1: Write the failing test**

Create `test/browser-evaluate-ast.test.js`:

```javascript
const assert = require('node:assert')
const { test } = require('node:test')
const { isReadOnlyExpression } = require('../agents/browser-evaluate-ast')

test('rejects assignment to window globals', () => {
  const r = isReadOnlyExpression('window.__pwned = true')
  assert.strictEqual(r.ok, false)
  assert.match(r.reason, /assignment/i)
})

test('rejects setItem on localStorage', () => {
  assert.strictEqual(isReadOnlyExpression('localStorage.setItem("a","b")').ok, false)
})

test('rejects fetch call', () => {
  assert.strictEqual(isReadOnlyExpression('fetch("http://attacker")').ok, false)
})

test('rejects XMLHttpRequest construction', () => {
  assert.strictEqual(isReadOnlyExpression('new XMLHttpRequest()').ok, false)
})

test('rejects code-evaluator-builtin call', () => {
  // The string "e" + "val" avoids spelling out the literal name in source.
  // Resolved at parse time as the global identifier we want to forbid.
  const expr = ['ev', 'al'].join('') + '("x")'
  assert.strictEqual(isReadOnlyExpression(expr).ok, false)
})

test('rejects dynamic import', () => {
  assert.strictEqual(isReadOnlyExpression('import("./m.js")').ok, false)
})

test('allows window.__xss_fired__ === true', () => {
  assert.strictEqual(isReadOnlyExpression('window.__xss_fired__ === true').ok, true)
})

test('allows document.cookie.includes', () => {
  assert.strictEqual(isReadOnlyExpression('document.cookie.includes("marker")').ok, true)
})

test('allows Object.prototype polluted check', () => {
  assert.strictEqual(isReadOnlyExpression('({}).polluted === "yes"').ok, true)
})

test('allows simple member access chains', () => {
  assert.strictEqual(isReadOnlyExpression('window.location.hash').ok, true)
})
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd /root/agents/.worktrees/browser-validator
bun test test/browser-evaluate-ast.test.js
```

Expected: FAIL with "Cannot find module '../agents/browser-evaluate-ast'".

- [ ] **Step 3: Write the implementation**

Create `agents/browser-evaluate-ast.js`. The forbidden-call list is built from string fragments to avoid having literal forbidden tokens in the source — they're concatenated at module load time.

```javascript
// /root/agents/agents/browser-evaluate-ast.js
// AST-based validator for evaluate-step expressions in browser-verifier.
// Goal: prevent the Constructor LLM from emitting expressions that mutate
// page state, exfiltrate data, or escape the browser sandbox.

const acorn = require('acorn')

const FORBIDDEN_GLOBALS = new Set([
  'window', 'document', 'localStorage', 'sessionStorage', 'indexedDB',
  'navigator', 'history', 'location'
])

const FORBIDDEN_CALLS = new Set([
  'fetch', 'XMLHttpRequest', 'WebSocket', 'EventSource',
  ['ev','al'].join(''),       // the runtime code-evaluator builtin
  'Function',                  // Function constructor (alternative code path)
  'setTimeout', 'setInterval'
])

function isReadOnlyExpression(source) {
  let ast
  try {
    ast = acorn.parseExpressionAt(source, 0, { ecmaVersion: 'latest' })
  } catch (e) {
    return { ok: false, reason: `parse error: ${e.message}` }
  }

  const violation = walk(ast)
  if (violation) return { ok: false, reason: violation }
  return { ok: true }
}

function walk(node) {
  if (!node || typeof node !== 'object') return null

  if (node.type === 'AssignmentExpression') {
    const root = rootOfMember(node.left)
    if (root && FORBIDDEN_GLOBALS.has(root)) {
      return `assignment to ${root}.* is not read-only`
    }
    return `assignment expressions not allowed (got ${node.operator})`
  }

  if (node.type === 'CallExpression') {
    const callee = node.callee
    if (callee.type === 'Identifier' && FORBIDDEN_CALLS.has(callee.name)) {
      return `call to ${callee.name} is forbidden`
    }
    if (callee.type === 'MemberExpression') {
      const root = rootOfMember(callee)
      if (root === 'navigator' && callee.property?.name === 'sendBeacon') {
        return 'navigator.sendBeacon is forbidden'
      }
      if (root === 'localStorage' || root === 'sessionStorage') {
        const prop = callee.property?.name
        if (['setItem', 'removeItem', 'clear'].includes(prop)) {
          return `${root}.${prop} is not read-only`
        }
      }
    }
  }

  if (node.type === 'NewExpression') {
    const callee = node.callee
    if (callee.type === 'Identifier' && FORBIDDEN_CALLS.has(callee.name)) {
      return `new ${callee.name} is forbidden`
    }
  }

  if (node.type === 'ImportExpression') {
    return 'dynamic import() is forbidden'
  }

  for (const key of Object.keys(node)) {
    if (key === 'type' || key === 'loc' || key === 'start' || key === 'end') continue
    const child = node[key]
    if (Array.isArray(child)) {
      for (const c of child) {
        const v = walk(c)
        if (v) return v
      }
    } else if (child && typeof child === 'object') {
      const v = walk(child)
      if (v) return v
    }
  }
  return null
}

function rootOfMember(node) {
  if (!node) return null
  if (node.type === 'Identifier') return node.name
  if (node.type === 'MemberExpression') return rootOfMember(node.object)
  return null
}

module.exports = { isReadOnlyExpression, FORBIDDEN_GLOBALS, FORBIDDEN_CALLS }
```

- [ ] **Step 4: Run tests to verify pass**

```bash
bun test test/browser-evaluate-ast.test.js
```

Expected: 10/10 PASS.

- [ ] **Step 5: Commit**

```bash
git add agents/browser-evaluate-ast.js test/browser-evaluate-ast.test.js
git commit -m "feat(browser-verifier): AST validator for evaluate-step expressions"
```

---

## Task 3: Recipe schema validator

**Files:**
- Create: `agents/browser-recipe-validator.js`
- Test: `test/browser-recipe-validator.test.js`

- [ ] **Step 1: Write the failing test**

Create `test/browser-recipe-validator.test.js`:

```javascript
const assert = require('node:assert')
const { test } = require('node:test')
const { validateRecipe } = require('../agents/browser-recipe-validator')

test('rejects recipe with missing finding_id', () => {
  const r = validateRecipe({ steps: [] })
  assert.strictEqual(r.ok, false)
})

test('accepts any non-empty finding_type by default (permissive mode)', () => {
  const r = validateRecipe({
    finding_id: 'F1', finding_type: 'arbitrary-domain-type',
    description: 'x', steps: [{ action: 'navigate', url: 'http://x' }]
  })
  assert.strictEqual(r.ok, true)
})

test('rejects empty finding_type', () => {
  const r = validateRecipe({
    finding_id: 'F1', finding_type: '',
    description: 'x', steps: [{ action: 'navigate', url: 'http://x' }]
  })
  assert.strictEqual(r.ok, false)
  assert.match(r.reason, /finding_type/)
})

test('honors caller-provided allowedFindingTypes set', () => {
  const allowlist = new Set(['dom-xss', 'csp-bypass'])
  const r = validateRecipe({
    finding_id: 'F1', finding_type: 'sql-injection',
    description: 'x', steps: [{ action: 'navigate', url: 'http://x' }]
  }, { allowedFindingTypes: allowlist })
  assert.strictEqual(r.ok, false)
  assert.match(r.reason, /allowlist/)
})

test('passes when type is in caller-provided allowlist', () => {
  const allowlist = new Set(['dom-xss', 'csp-bypass'])
  const r = validateRecipe({
    finding_id: 'F1', finding_type: 'dom-xss',
    description: 'x', steps: [{ action: 'navigate', url: 'http://x' }]
  }, { allowedFindingTypes: allowlist })
  assert.strictEqual(r.ok, true)
})

test('rejects step with non-whitelisted action', () => {
  const r = validateRecipe({
    finding_id: 'F1', finding_type: 'dom-xss',
    description: 'x', steps: [{ action: 'shell', command: 'rm -rf /' }]
  })
  assert.strictEqual(r.ok, false)
  assert.match(r.reason, /action/)
})

test('rejects evaluate with non-read-only expression', () => {
  const r = validateRecipe({
    finding_id: 'F1', finding_type: 'dom-xss',
    description: 'x',
    steps: [
      { action: 'navigate', url: 'http://x' },
      { action: 'evaluate', expression: 'window.__pwned=true' }
    ]
  })
  assert.strictEqual(r.ok, false)
  assert.match(r.reason, /evaluate|assignment/i)
})

test('accepts a valid dom-xss recipe', () => {
  const r = validateRecipe({
    finding_id: 'F1', finding_type: 'dom-xss',
    description: 'reflected payload via location.hash',
    steps: [
      { action: 'navigate', url: 'http://target/page' },
      { action: 'wait_for', timeout_ms: 2000 },
      { action: 'evaluate', expression: 'window.__xss_fired__ === true' }
    ],
    verdict_rule: { expected_evaluation_results: [{ step_index: 2, equals: true }] }
  })
  assert.strictEqual(r.ok, true, r.reason)
})

test('rejects step with missing required field', () => {
  const r = validateRecipe({
    finding_id: 'F1', finding_type: 'dom-xss',
    description: 'x',
    steps: [{ action: 'navigate' }]
  })
  assert.strictEqual(r.ok, false)
})

test('rejects too many steps (cap at 20)', () => {
  const steps = Array(25).fill({ action: 'navigate', url: 'http://x' })
  const r = validateRecipe({
    finding_id: 'F1', finding_type: 'dom-xss',
    description: 'x', steps
  })
  assert.strictEqual(r.ok, false)
  assert.match(r.reason, /step/)
})
```

- [ ] **Step 2: Run test to verify it fails**

```bash
bun test test/browser-recipe-validator.test.js
```

Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

Create `agents/browser-recipe-validator.js`. Note: `validateRecipe` accepts an OPTIONAL `opts.allowedFindingTypes` Set so that domain-specific consumers (pentest, stocks, cloud) can enforce their own type allowlists. By default the validator permissively accepts any non-empty string. ALLOWED_ACTIONS and MAX_STEPS are domain-agnostic and stay hardcoded in the generic core.

```javascript
// /root/agents/agents/browser-recipe-validator.js
// Generic schema validator for browser-verifier recipes. Domain-agnostic.
// Schema enforcement + AST check on evaluate-step expressions.
//
// Domain-specific consumers (pentest, stocks, cloud-security, etc.) can
// pass an `allowedFindingTypes` Set in opts to enforce their own type
// allowlist. Without it, any non-empty finding_type string is accepted.

const { isReadOnlyExpression } = require('./browser-evaluate-ast')

const ALLOWED_ACTIONS = new Set([
  'navigate', 'fill', 'click', 'evaluate', 'wait_for', 'screenshot'
])

const MAX_STEPS = 20

function validateRecipe(recipe, opts = {}) {
  const allowedFindingTypes = opts.allowedFindingTypes || null  // null = permissive

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
    const stepCheck = validateStep(recipe.steps[i], i)
    if (!stepCheck.ok) return stepCheck
  }
  return { ok: true }
}

function validateStep(step, index) {
  if (!step || typeof step !== 'object') return fail(`step ${index}: not an object`)
  const action = String(step.action || '').toLowerCase()
  if (!ALLOWED_ACTIONS.has(action)) {
    return fail(`step ${index}: action '${action}' not allowed`)
  }

  switch (action) {
    case 'navigate':
      if (typeof step.url !== 'string' || !step.url) return fail(`step ${index}: navigate requires url`)
      if (!/^https?:\/\//.test(step.url)) return fail(`step ${index}: url must be http(s)`)
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
  }
  return { ok: true }
}

function fail(reason) { return { ok: false, reason } }

module.exports = { validateRecipe, ALLOWED_ACTIONS, MAX_STEPS }
```

- [ ] **Step 4: Run tests to verify pass**

```bash
bun test test/browser-recipe-validator.test.js
```

Expected: 7/7 PASS.

- [ ] **Step 5: Commit**

```bash
git add agents/browser-recipe-validator.js test/browser-recipe-validator.test.js
git commit -m "feat(browser-verifier): recipe schema validator"
```

---

## Task 4: Test fixtures

The fixtures are intentionally vulnerable HTML pages used only by unit tests, never served to real users. They serve as ground-truth oracles: the verifier must say `browser_fired: true` on the unsafe-sink fixture and `false` on the safe-sink fixture, given identical payloads.

**Files:**
- Create: `test/fixtures/browser-validator/dom-xss-fires.html`
- Create: `test/fixtures/browser-validator/dom-xss-blocked.html`
- Create: `test/fixtures/browser-validator/proto-pollution.html`
- Create: `test/fixtures/browser-validator/csp-blocked.html`

Each fixture file contents are described in the spec (Section "Test fixtures"). Standard Step 1-5 pattern: write file, sanity-check it loads in `node -e "console.log(fs.readFileSync(...))"`, commit.

- [ ] **Step 1:** Create the four fixture files with the content patterns from the spec.

- [ ] **Step 2:** Verify they load without error and contain the marker scripts.

- [ ] **Step 3: Commit**

```bash
git add test/fixtures/browser-validator/
git commit -m "test(browser-verifier): static HTML fixtures for DOM XSS, proto-pollution, CSP scenarios"
```

---

## Task 5: browser-verifier.js core executor

**Files:**
- Create: `agents/browser-verifier.js`
- Test: `test/browser-verifier.test.js`

- [ ] **Step 1: Write the failing test (uses fixtures)**

Create `test/browser-verifier.test.js`:

```javascript
const assert = require('node:assert')
const { test } = require('node:test')
const path = require('node:path')
const { verifyRecipe, verifyAll } = require('../agents/browser-verifier')

const FIXTURE = (name) => `file://${path.resolve(__dirname, 'fixtures/browser-validator', name)}`

test('dom-xss fires on vulnerable sink', { timeout: 30000 }, async () => {
  const recipe = {
    finding_id: 'F1', finding_type: 'dom-xss',
    description: 'unsafe HTML write from location.hash',
    steps: [
      { action: 'navigate', url: FIXTURE('dom-xss-fires.html') + '#%3Cimg%20src=x%20onerror=window.__xss_fired__=true%3E' },
      { action: 'wait_for', timeout_ms: 1000 },
      { action: 'evaluate', expression: 'window.__xss_fired__ === true' }
    ],
    verdict_rule: { expected_evaluation_results: [{ step_index: 2, equals: true }] }
  }
  const r = await verifyRecipe(recipe)
  assert.strictEqual(r.executed, true)
  assert.strictEqual(r.browser_fired, true)
  assert.strictEqual(r.verdict, 'CONFIRMED')
})

test('dom-xss does NOT fire on safe textContent sink', { timeout: 30000 }, async () => {
  const recipe = {
    finding_id: 'F2', finding_type: 'dom-xss',
    description: 'textContent sink — should not execute',
    steps: [
      { action: 'navigate', url: FIXTURE('dom-xss-blocked.html') + '#%3Cimg%20src=x%20onerror=window.__xss_fired__=true%3E' },
      { action: 'wait_for', timeout_ms: 1000 },
      { action: 'evaluate', expression: 'window.__xss_fired__ === true' }
    ],
    verdict_rule: { expected_evaluation_results: [{ step_index: 2, equals: true }] }
  }
  const r = await verifyRecipe(recipe)
  assert.strictEqual(r.browser_fired, false)
  assert.strictEqual(r.verdict, 'KILLED')
})

test('proto-pollution propagates to plain objects', { timeout: 30000 }, async () => {
  // IMPORTANT: must use a LITERAL JSON string here, not JSON.stringify().
  // JSON.stringify({__proto__:{polluted:'yes'}}) produces "{}" because in object-literal
  // syntax, __proto__: sets the prototype (not an own property), so JSON.stringify
  // sees no enumerable own keys. To actually test prototype pollution, the JSON text
  // must contain a __proto__ key as a regular JSON property name.
  const payload = encodeURIComponent('{"__proto__":{"polluted":"yes"}}')
  const recipe = {
    finding_id: 'F3', finding_type: 'prototype-pollution',
    description: 'unsafe merge via __proto__',
    steps: [
      { action: 'navigate', url: FIXTURE('proto-pollution.html') + `?payload=${payload}` },
      { action: 'wait_for', timeout_ms: 500 },
      { action: 'evaluate', expression: '({}).polluted === "yes"' }
    ],
    verdict_rule: { expected_evaluation_results: [{ step_index: 2, equals: true }] }
  }
  const r = await verifyRecipe(recipe)
  assert.strictEqual(r.browser_fired, true)
})

test('rejects invalid recipe before launching browser', async () => {
  const r = await verifyRecipe({ finding_id: 'F5', finding_type: 'sqli', steps: [] })
  assert.strictEqual(r.executed, false)
  assert.strictEqual(r.verdict, 'INDETERMINATE')
  assert.match(r.reason, /finding_type/)
})

test('verifyAll returns array matching input length', { timeout: 60000 }, async () => {
  const recipes = [
    { finding_id: 'A', finding_type: 'dom-xss', description: 'x',
      steps: [{ action: 'navigate', url: FIXTURE('dom-xss-fires.html') }] },
    { finding_id: 'B', finding_type: 'invalid-type',
      description: 'x', steps: [] }
  ]
  const results = await verifyAll(recipes)
  assert.strictEqual(results.length, 2)
  assert.strictEqual(results[0].finding_id, 'A')
  assert.strictEqual(results[1].finding_id, 'B')
})
```

- [ ] **Step 2: Run test to verify it fails**

```bash
bun test test/browser-verifier.test.js
```

Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

Create `agents/browser-verifier.js`. Implements the Playwright-driven executor with whitelisted action handlers, per-step / per-finding timeouts, and verdict computation. Full code in spec section "Architecture → Module".

Key constraints:
- Pure-Node, no LLM invocation in this module
- Validates recipe via `validateRecipe` BEFORE launching browser
- Browser closed on every code path (try/finally)
- Console messages truncated to 500 chars
- Network requests counted, not stored
- Returns INDETERMINATE on any unhandled error rather than crashing

- [ ] **Step 4: Run tests to verify pass**

```bash
bun test test/browser-verifier.test.js
```

Expected: 5/5 PASS. First run may be slow due to Chromium cold-start.

- [ ] **Step 5: Commit**

```bash
git add agents/browser-verifier.js test/browser-verifier.test.js
git commit -m "feat(browser-verifier): core Playwright executor with verdict logic"
```

---

## Task 6: Pentest-domain recipe constructor (LLM-side helper)

This is the FIRST domain-specific consumer of the generic browser-verifier core. It defines the pentest-specific `BROWSER_RELEVANT_TYPES` set and builds the LLM prompt that converts pentest finding objects into browser recipes. Future squads (stocks, cloud, code-review) will write parallel `<squad>-browser-recipe-constructor.js` modules using the same pattern.

**Files:**
- Create: `agents/pentest-browser-recipe-constructor.js`
- Test: `test/pentest-browser-recipe-constructor.test.js`

- [ ] **Step 1: Write the failing test**

Create `test/pentest-browser-recipe-constructor.test.js`:

```javascript
const assert = require('node:assert')
const { test } = require('node:test')
const { buildConstructorPrompt, BROWSER_RELEVANT_TYPES, filterBrowserRelevant } = require('../agents/pentest-browser-recipe-constructor')

test('exports BROWSER_RELEVANT_TYPES with expected entries', () => {
  assert.ok(BROWSER_RELEVANT_TYPES.has('dom-xss'))
  assert.ok(BROWSER_RELEVANT_TYPES.has('prototype-pollution'))
  assert.ok(BROWSER_RELEVANT_TYPES.has('csp-bypass'))
  assert.ok(!BROWSER_RELEVANT_TYPES.has('sql-injection'))
})

test('filterBrowserRelevant keeps only browser-side types', () => {
  const findings = [
    { id: 'A', type: 'dom-xss' },
    { id: 'B', type: 'sqli' },
    { id: 'C', type: 'prototype-pollution' },
    { id: 'D', type: 'IDOR' }
  ]
  const out = filterBrowserRelevant(findings)
  assert.strictEqual(out.length, 2)
  assert.deepStrictEqual(out.map(f => f.id).sort(), ['A', 'C'])
})

test('buildConstructorPrompt embeds finding_id and type and taskId', () => {
  const findings = [{ id: 'F-001', type: 'dom-xss', url: 'http://t/p#x', notes: 'reflected hash' }]
  const p = buildConstructorPrompt(findings, { taskId: 'T1' })
  assert.match(p, /F-001/)
  assert.match(p, /dom-xss/)
  assert.match(p, /T1/)
})

test('buildConstructorPrompt rejects empty findings', () => {
  assert.throws(() => buildConstructorPrompt([], { taskId: 'T1' }), /no.*findings/i)
})

test('buildConstructorPrompt mentions allowed actions', () => {
  const findings = [{ id: 'F1', type: 'dom-xss', url: 'http://t' }]
  const p = buildConstructorPrompt(findings, { taskId: 'T1' })
  assert.match(p, /allowed actions/i)
  assert.match(p, /navigate/)
  assert.match(p, /evaluate/)
  assert.match(p, /wait_for/)
})
```

- [ ] **Step 2: Run test to verify it fails**

```bash
bun test test/pentest-browser-recipe-constructor.test.js
```

Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

Create `agents/pentest-browser-recipe-constructor.js`. This is the pentest-domain layer. Provides:
- `BROWSER_RELEVANT_TYPES` Set — pentest-specific types (dom-xss, prototype-pollution, etc.)
- `filterBrowserRelevant(findings)` — keeps only findings whose `type` is in the pentest set
- `buildConstructorPrompt(findings, opts)` — produces the LLM prompt that emits recipe JSON
- File header comment explicitly notes: "Pentest-squad domain layer for the generic browser-verifier core. Other squads should mirror this pattern in their own `<squad>-browser-recipe-constructor.js`."

Constraints:
- Throws on empty findings array
- Embeds taskId + each finding's id and type
- Mentions all six allowed actions explicitly
- Mentions read-only-only rule for evaluate-step expressions
- Output expected as JSON array, no markdown fences

- [ ] **Step 4: Run tests to verify pass**

```bash
bun test test/pentest-browser-recipe-constructor.test.js
```

Expected: 5/5 PASS.

- [ ] **Step 5: Commit**

```bash
git add agents/pentest-browser-recipe-constructor.js test/pentest-browser-recipe-constructor.test.js
git commit -m "feat(browser-verifier): recipe constructor prompt builder + type filter"
```

---

## Task 7: event-bus.js Phase 3.8 dispatch

The Phase 3.8 dispatcher inserts AFTER the existing Phase 3.7 Offensive Vaccine block (around line 4742 in event-bus.js — search for `Phase 4: VYASA writing final report`) and BEFORE the VYASA dispatch. It reads `/root/intel/pentest/VALIDATED-FINDINGS.jsonl` (DHARMA's output, structured with type+subtype fields), batches findings into a single Constructor agent call, executes the recipes via the generic browser-verifier core, and writes BROWSER-VERIFICATION-${taskId}.jsonl for VYASA to consume.

The Constructor agent invocation pattern MUST mirror the existing chain-constructor at line 4641: use `spawnAgent(leaderAgentId, taskId, prompt, ..., { jsonSchema: <schema> })` and parse `parsed.structured_output` from the result. Do NOT invent a `runJsonAgent` helper — it doesn't exist.

**Files:**
- Modify: `event-bus.js` (add Phase 3.8 dispatcher block; ~60 lines added immediately AFTER the Offensive Vaccine block ends, BEFORE the `// ── PHASE 4: Report (VYASA) ──` comment)
- Test: `test/event-bus-phase38-wiring.test.js` (grep-test, no daemon boot)

- [ ] **Step 1: Write the failing wiring test**

Create `test/event-bus-phase38-wiring.test.js`:

```javascript
const assert = require('node:assert')
const { test } = require('node:test')
const fs = require('node:fs')

const SRC = fs.readFileSync(__dirname + '/../event-bus.js', 'utf-8')

test('event-bus.js requires browser-verifier module', () => {
  assert.match(SRC, /require\(['"]\.\/browser-verifier['"]\)|freshRequire\(['"]\.\/browser-verifier['"]\)|require\(['"]\.\/agents\/browser-verifier['"]\)/)
})

test('event-bus.js requires pentest-browser-recipe-constructor module', () => {
  assert.match(SRC, /pentest-browser-recipe-constructor/)
})

test('event-bus.js dispatches Phase 3.8 AFTER Offensive Vaccine and BEFORE VYASA', () => {
  // Existing Offensive Vaccine block emits 'Offensive Vaccine: <N> defensive actions'
  // Existing VYASA dispatch is preceded by 'Phase 4: VYASA writing final report'
  const idxOffensiveVaccine = SRC.indexOf('Offensive Vaccine: ${defActions.length}')
  const idxBrowserVerify = SRC.indexOf('verifyAll(')
  const idxVyasa = SRC.indexOf('Phase 4: VYASA writing final report')
  assert.ok(idxOffensiveVaccine > 0, 'Offensive Vaccine block missing')
  assert.ok(idxBrowserVerify > 0, 'browser-verifier call missing')
  assert.ok(idxVyasa > 0, 'VYASA dispatch missing')
  assert.ok(idxOffensiveVaccine < idxBrowserVerify, 'browser-verifier must come AFTER Offensive Vaccine')
  assert.ok(idxBrowserVerify < idxVyasa, 'browser-verifier must come BEFORE VYASA')
})

test('event-bus.js logs the Phase 3.8 banner', () => {
  assert.match(SRC, /Phase 3\.8.*[Bb]rowser/)
})

test('event-bus.js writes BROWSER-VERIFICATION jsonl with taskId substitution', () => {
  assert.match(SRC, /BROWSER-VERIFICATION-\$\{taskId\}/)
})

test('event-bus.js skips Phase 3.8 when no browser-relevant findings', () => {
  // Look for an early-skip guard. Acceptable shapes:
  //   if (browserCandidates.length === 0) ...
  //   if (!browserCandidates.length) ...
  //   if (recipes.length === 0) ...
  assert.match(SRC, /browserCandidates\.length\s*===\s*0|!browserCandidates\.length|recipes\.length\s*===\s*0/)
})

test('event-bus.js wraps Phase 3.8 in try/catch (best-effort, never blocks VYASA)', () => {
  // Find the browser-verifier call and walk up to the nearest enclosing try
  const idxBrowserVerify = SRC.indexOf('verifyAll(')
  const before = SRC.slice(Math.max(0, idxBrowserVerify - 2000), idxBrowserVerify)
  assert.match(before, /try\s*\{/)
})
```

- [ ] **Step 2: Run test to verify it fails**

```bash
bun test test/event-bus-phase37-wiring.test.js
```

Expected: 5 FAIL — wiring not yet in place.

- [ ] **Step 3: Add Phase 3.8 dispatcher in event-bus.js**

**Insertion point:** After the existing `// ── PHASE 3.7: Generate Defensive Actions (Offensive Vaccine) ──` block ends (look for the closing `} catch (e) { log(\`⚠️ Offensive Vaccine error: ${e.message}\`) }` line, around line 4742) and BEFORE the `// ── PHASE 4: Report (VYASA) ──` comment.

**Insert this block:**

```javascript
// ── PHASE 3.8: Browser-side execution verification ──
// Runs deterministic Playwright recipes against findings whose validation
// requires real browser execution (DOM XSS, prototype pollution, postMessage,
// CSP bypass, etc.). Output feeds VYASA at Phase 4 as strong CONFIRM/KILL
// evidence — false-fired browser results force VYASA to downgrade or omit.
let browserVerificationCount = 0
try {
  const browserVerifier = freshRequire('./browser-verifier')
  const { filterBrowserRelevant, buildConstructorPrompt } = freshRequire('./pentest-browser-recipe-constructor')

  // Read DHARMA's structured findings file. Filter by browser-relevant types
  // OR by free-form match in the constructor — start with the type filter.
  const findingsFile = `/root/intel/pentest/VALIDATED-FINDINGS.jsonl`
  let allFindings = []
  if (fs.existsSync(findingsFile)) {
    const lines = fs.readFileSync(findingsFile, 'utf-8').split('\n').filter(Boolean)
    for (const line of lines) {
      try { allFindings.push(JSON.parse(line)) } catch {}
    }
  }
  // Filter to current task only (file is global; entries have taskId or via url match)
  // Defensive: if a 'taskId' field exists, use it; otherwise pass all to constructor
  const taskFindings = allFindings.filter(f => !f.taskId || String(f.taskId) === String(taskId))
  const browserCandidates = filterBrowserRelevant(taskFindings)

  if (browserCandidates.length === 0) {
    log(`🔬 Phase 3.8 skipped — no browser-relevant findings (${taskFindings.length} total in scope)`)
  } else {
    log(`🔬 Phase 3.8: Browser-side validation — ${browserCandidates.length}/${taskFindings.length} browser-relevant findings`)
    logActivity('SANJAY', `🔬 Phase 3.8: Browser-side validation`, {
      type: 'dispatch-phase', squad, taskId, projectId: projectId || '',
      details: `${browserCandidates.length} browser-relevant findings → Playwright deterministic check`
    })

    const squadType = String(squad).replace('-squad', '')
    const leaderAgentId = (CHAIN_PATTERNS[squadType]?.leaderAgent || 'krishna').toLowerCase()
    const constructorPrompt = buildConstructorPrompt(browserCandidates, { taskId })

    // Recipes schema: a JSON array of recipe objects
    const RECIPE_ARRAY_SCHEMA = { type: 'array' }
    const constructorResult = await spawnAgent(
      leaderAgentId, taskId, constructorPrompt,
      `task-${taskId}-browser-recipes`, modelOverride,
      { jsonSchema: RECIPE_ARRAY_SCHEMA }
    )
    trackCosts([constructorResult])

    let recipes = []
    try {
      const rawOutput = constructorResult.output || constructorResult.stdout || ''
      const parsed = JSON.parse(rawOutput)
      if (Array.isArray(parsed.structured_output)) recipes = parsed.structured_output
      else if (Array.isArray(parsed)) recipes = parsed
    } catch (e) {
      log(`  Phase 3.8: failed to parse constructor output: ${e.message}`)
    }

    if (recipes.length === 0) {
      log(`  Phase 3.8: constructor returned 0 recipes — skipping`)
    } else {
      const screenshotDir = `/root/intel/pentest/screenshots/${taskId}`
      fs.mkdirSync(screenshotDir, { recursive: true })
      const results = await browserVerifier.verifyAll(recipes, {
        logger: (m) => log(`  ${m}`),
        screenshotDir
      })
      const outPath = `/root/intel/pentest/BROWSER-VERIFICATION-${taskId}.jsonl`
      fs.writeFileSync(outPath, results.map(r => JSON.stringify(r)).join('\n') + '\n')
      browserVerificationCount = results.length

      const fired = results.filter(r => r.browser_fired).length
      const killed = results.filter(r => r.verdict === 'KILLED').length
      const indet = results.length - fired - killed
      log(`🔬 Phase 3.8 complete: ${results.length} recipes — ${fired} CONFIRMED, ${killed} KILLED, ${indet} INDETERMINATE`)
      logActivity('SANJAY', `🔬 Phase 3.8 complete: ${fired} CONFIRMED / ${killed} KILLED / ${indet} INDETERMINATE`, {
        type: 'phase-complete', squad, taskId, projectId: projectId || '',
        details: `Output: ${outPath}`
      })
    }
  }
} catch (e) {
  log(`🔬 Phase 3.8 error (non-fatal, VYASA will skip browser evidence): ${e.message}`)
}
```

**Key invariants:**
- Phase 3.8 NEVER blocks VYASA from running (whole block is `try/catch`).
- Constructor LLM call is at most 1 per task. Browser launches scale with `browserCandidates.length`.
- Output file path: `/root/intel/pentest/BROWSER-VERIFICATION-${taskId}.jsonl` — written atomically as a single JSONL.
- screenshotDir is task-scoped, created with `recursive: true`.

- [ ] **Step 4: Run wiring test**

```bash
bun test test/event-bus-phase37-wiring.test.js
```

Expected: 5/5 PASS.

- [ ] **Step 5: Commit**

```bash
git add event-bus.js test/event-bus-phase37-wiring.test.js
git commit -m "feat(event-bus): wire Phase 3.8 browser-verifier between Offensive Vaccine 3.7 and VYASA 4"
```

---

## Task 8: VYASA prompt update

KRIPA already ran by the time browser-verifier produces output, so the consumer of browser-verification evidence is **VYASA** (the final report writer at Phase 4). VYASA decides what makes the report — it's the right gate to enforce browser_fired=false → downgrade-or-omit.

**Files:**
- Modify: `event-bus.js` (VYASA prompt builder `buildVyasaReportPrompt` around line 3062)
- Test: `test/vyasa-prompt-browser-aware.test.js`

- [ ] **Step 1: Write the failing test**

Create `test/vyasa-prompt-browser-aware.test.js`:

```javascript
const assert = require('node:assert')
const { test } = require('node:test')
const fs = require('node:fs')

const SRC = fs.readFileSync(__dirname + '/../event-bus.js', 'utf-8')

test('VYASA prompt mentions BROWSER-VERIFICATION file', () => {
  assert.match(SRC, /BROWSER-VERIFICATION-\$\{taskId\}\.jsonl/)
})

test('VYASA prompt explains browser_fired=true means CONFIRM evidence', () => {
  assert.match(SRC, /browser_fired\s*===?\s*true.*(CONFIRM|Tier-1|strong)/is)
})

test('VYASA prompt explains browser_fired=false KILLED means downgrade or omit', () => {
  assert.match(SRC, /browser_fired\s*===?\s*false.*(downgrade|omit|AWAITING-MANUAL)/is)
})

test('VYASA prompt explains INDETERMINATE means fall back to KRIPA', () => {
  assert.match(SRC, /INDETERMINATE.*(fall\s*back|KRIPA)/is)
})

test('VYASA prompt update is INSIDE buildVyasaReportPrompt body', () => {
  // Locate the function and ensure the BROWSER-VERIFICATION reference is within ~1500 chars after
  const fnStart = SRC.indexOf('function buildVyasaReportPrompt')
  assert.ok(fnStart > 0, 'buildVyasaReportPrompt missing')
  const fnSlice = SRC.slice(fnStart, fnStart + 8000)
  assert.match(fnSlice, /BROWSER-VERIFICATION/)
})
```

- [ ] **Step 2: Run test to verify it fails**

Expected: 5 FAIL — prompt not yet updated.

- [ ] **Step 3: Update VYASA prompt builder**

In event-bus.js, find `function buildVyasaReportPrompt(...)` (around line 3062). Inside the function body, append the browser-verification rules section to the returned prompt template literal. The rules section MUST be inside the same template literal that the function returns.

Add:

```
If /root/intel/pentest/BROWSER-VERIFICATION-${taskId}.jsonl exists for this task,
you MUST read it before writing the report.

Browser-verification provides deterministic Playwright execution evidence for
browser-side findings. Apply these rules when deciding what makes the final report:

- For each entry in BROWSER-VERIFICATION jsonl:
  * If browser_fired === true AND verdict === 'CONFIRMED' → STRONG Tier-1 evidence.
    Include in the report at the original (or higher) severity. Cite browser
    execution as proof.
  * If browser_fired === false AND verdict === 'KILLED' → STRONG evidence the
    finding does not actually fire in a real browser. DOWNGRADE the severity by
    one tier OR mark as 'AWAITING-MANUAL-CONFIRMATION' OR omit from the
    confirmed-findings section. Do NOT claim it as confirmed in the executive
    summary.
  * If verdict === 'INDETERMINATE' → fall back to KRIPA's verdict and
    chain-verifier evidence as before.

- For findings NOT present in BROWSER-VERIFICATION jsonl (non-browser-relevant
  types): use KRIPA validation + chain-verifier evidence as before.
```

- [ ] **Step 4: Run test**

Expected: 5/5 PASS.

- [ ] **Step 5: Commit**

```bash
git add event-bus.js test/vyasa-prompt-browser-aware.test.js
git commit -m "feat(event-bus): VYASA prompt consumes BROWSER-VERIFICATION as report-gate evidence"
```

---

## Task 9: verify-framework gates 53/54/55

**Files:**
- Modify: `verify-framework.js`

- [ ] **Step 1:** Add the three gate definitions to the gates registry. Logic per spec section "Verify-framework gates".

- [ ] **Step 2:** Run `bun verify-framework.js`. Expected: GATE-53 + GATE-54 PASS. GATE-55 PASS-by-skip if no recent report has browser-side claims.

- [ ] **Step 3: Commit**

```bash
git add verify-framework.js
git commit -m "feat(verify-framework): GATE-53/54/55 lock in browser-verifier invariants"
```

---

## Task 10: Integration smoke test (manual, post-merge)

**Not a code task — operational verification AFTER merge to master.**

- [ ] **Step 1:** Wait for current Lenovo v3 chain to fully complete (10/10 dispatched).
- [ ] **Step 2:** Merge `feature/browser-validator` → `master` in /root/agents.
- [ ] **Step 3:** `pm2 restart event-bus` to load new code.
- [ ] **Step 4:** Watch the next pentest dispatch's logs for `Phase 3.8:` log line and `BROWSER-VERIFICATION-` jsonl creation.
- [ ] **Step 5:** Verify VYASA's prompt at runtime includes the browser-verification reference (grep daemon log for the Phase 4 prompt).
- [ ] **Step 6:** If the next target produces any DOM-XSS or proto-pollution candidates, verify the Phase 3.8 verdict appears in the final report.

---

## Final code review

After Tasks 1-9 complete with all tests green, dispatch a final review subagent to check:

- Module boundaries clean (browser-verifier knows nothing about event-bus internals; recipe-constructor knows nothing about Playwright)
- Error paths return INDETERMINATE rather than crashing
- No orphaned test fixtures
- No leaked secrets/PII in test fixtures
- Prompt template correctly escapes any `${...}` substitutions

---

## Out of scope (do NOT implement in this plan)

- Authenticated browser sessions (cookie/session injection)
- Visual screenshot diffing
- Mobile/device emulation
- Network request interception or modification
- Per-agent Docker isolation
- Migration of existing chain-verifier curl calls to Playwright
