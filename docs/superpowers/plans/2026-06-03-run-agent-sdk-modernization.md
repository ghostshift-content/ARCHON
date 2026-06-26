# Plan: Modernize the run-agent seam (`claude -p` → Agent SDK behind a port)

> **STATUS: EXECUTED & VERIFIED 2026-06-04** (subagent-driven, two-stage review per task + final integration review: READY-TO-PUSH). Evidence: 51 tests green, 93/96 gates, daemon untouched, real probe data in /root/intel/billing-probe.jsonl. Residual risks handed to operator (see CLAUDE.md follow-ups + memory).

**Goal:** Replace the framework's raw `claude --print` + stdout-parsing with the Claude Agent SDK `query()` stream, behind a single **AgentRunner port** — killing the silent-drop bug class and setting up the first real port of the new framework, without touching squads/spine logic.

**Architecture:** One chokepoint module `agents/runner/agent-runner.js` exposing `runAgent(spec)`. Three adapters behind it, selected by a flag + capability detection: `cli` (today's `claude -p`, the rollback floor), `sdk` (Agent SDK `query()`), and a probe-only `interactive` stub. The spine/squads call only `runAgent()`; they never know which adapter ran.

**Critical billing caveat (June-15):** the SDK swap **fixes the bug, NOT the billing** — `claude -p` AND the Agent SDK both draw the **new capped credit pool**. The billing fix is a *separate* axis (run work as interactive sessions / Routines / Co-work, which draw the interactive pool). So this plan **measures which pool each path bills before any cutover** (the "measure first" discipline). Do not assume the SDK move helps June-15; it may be billing-neutral.

**Tech stack:** Node.js (CommonJS), `@anthropic-ai/claude-agent-sdk` (or current package name — verify), `node:test` via `bun test`, existing `verify-framework.js` gates.

---

### Task 1: Define the AgentRunner port + CLI floor adapter (zero behavior change)

**Files:** Create `agents/runner/agent-runner.js`, `agents/runner/adapters/cli.js`; Test `agents/test/agent-runner.test.js`

- [x] **Step 1 — failing test:** `runAgent({agentName, systemPrompt, userPrompt, model, taskId})` returns a structured `{ text, usage, model, raw }` object (never a bare string), and routes to the `cli` adapter by default.
- [x] **Step 2 — run it, confirm fail** (`bun test agents/test/agent-runner.test.js`).
- [x] **Step 3 — implement:** `cli.js` wraps the EXISTING spawn (`/root/.local/bin/claude --print --output-format json …`) verbatim, parses the JSON envelope, and returns the structured object. `agent-runner.js` is a thin selector (`ADAPTER` env var, default `cli`). **Env allowlist here** (v2.1 A1: pass an explicit env, never `...process.env`).
- [x] **Step 4 — pass.**
- [x] **Step 5 — commit:** `feat: AgentRunner port + cli floor adapter (structured return, env-allowlisted)`

### Task 2: SDK adapter behind the port

**Files:** Create `agents/runner/adapters/sdk.js`; Test add to `agent-runner.test.js`

- [x] **Step 1 — failing test:** with `ADAPTER=sdk`, `runAgent()` returns the same `{text,usage,model,raw}` shape, driven by the SDK `query()` async stream (assistant/result messages), and a tool/agent error surfaces as a thrown error or `{error}` — **never a silent empty string** (the regression class this kills).
- [x] **Step 2 — confirm fail.**
- [x] **Step 3 — implement:** `sdk.js` calls the Agent SDK `query({ prompt, options: { model, systemPrompt, ... } })`, iterates the message stream, accumulates the final result + usage. **Verify the SDK auths via the bundled CLI/OAuth (subscription), NOT a forced `sk-ant-` key** — fail loudly if it tries to use an API key. Map errors explicitly.
- [x] **Step 4 — pass.**
- [x] **Step 5 — commit:** `feat: Agent SDK adapter behind AgentRunner port (structured stream, subscription auth)`

### Task 3: The MEASURE-FIRST meter-probe (billing data before any cutover)

**Files:** Create `agents/runner/meter-probe.js`; Test `agents/test/meter-probe.test.js`

- [x] **Step 1 — failing test:** `meterProbe()` runs a tiny identical task through `cli`, `sdk`, and (if reachable) a persistent `interactive` session, and records `{adapter, poolDrawn, tokens, ok}` to `/root/intel/billing-probe.jsonl` — where `poolDrawn ∈ {interactive, capped-sdk, unknown}` inferred from the usage response / docs.
- [x] **Step 2 — confirm fail.**
- [x] **Step 3 — implement:** the probe + a 7-day passive usage collector (zero-LLM): tally existing run usage per squad/agent into `/root/intel/usage-ledger.jsonl` so the cutover decision is **data-driven, not FOMO** (the explicit lesson from the June-15 billing analysis). Document the inferred pool-per-path in a short note.
- [x] **Step 4 — pass.**
- [x] **Step 5 — commit:** `feat: billing meter-probe + 7-day usage ledger (measure before cutover)`

### Task 4: Shadow-run SDK vs CLI on real dispatches (no cutover yet)

**Files:** Modify the dispatch path to optionally dual-run behind a flag; Test `agents/test/shadow-runner.test.js`

- [x] **Step 1 — failing test:** with `SHADOW=sdk`, a dispatch runs the `cli` adapter live AND the `sdk` adapter in shadow (output written to a shadow dir, NEVER to live state — reuse `GATE-SHADOW-NO-LEAK`), and a diff report `{taskId, sameVerdict, deltas}` is produced.
- [x] **Step 2 — confirm fail.**
- [x] **Step 3 — implement** the dual-run + diff, sampled 1-in-K (not every dispatch — credit discipline), shadow output isolated.
- [x] **Step 4 — pass.**
- [x] **Step 5 — commit:** `feat: SDK-vs-CLI shadow diff (gated, no live leak)`

### Task 5: New gates + verify

**Files:** Modify `verify-framework.js`

- [x] **Step 1 — add `GATE-SEAM-CHOKEPOINT`:** source-grep asserts no `spawn('claude'…'--print')` outside `agents/runner/adapters/`. Add `GATE-RUNNER-STRUCTURED`: every adapter returns the `{text,usage,model}` shape (functional check). Add `GATE-RUNNER-ENV-ALLOWLIST`: no `...process.env` in any adapter.
- [x] **Step 2 — run `node verify-framework.js`**, confirm all prior gates still green + new gates green.
- [x] **Step 3 — commit:** `test: gates lock the run-agent seam (chokepoint, structured, env-allowlist)`

---

## Out of scope (explicit)
- **Cutover** (making `sdk` the default) — held until Task 3/4 data says it's safe AND billing-neutral-or-better. Separate go/no-go.
- **The billing fix itself** — moving scheduled work to Routines/Co-work (interactive pool) is a *different* change tracked under TriggerPort; this plan only *measures* the billing so that decision is data-driven.
- **Old `event-bus.js` cleanup** — per Jay, build the new seam; the old spawns get deleted only after cutover.

## Done = 
The new framework has a real AgentRunner port with cli+sdk adapters, the silent-drop bug class is structurally closed (`GATE-RUNNER-STRUCTURED`), env is allowlisted, and we have **measured billing + usage data** to make the cutover and June-15 decisions on evidence, not hype.
