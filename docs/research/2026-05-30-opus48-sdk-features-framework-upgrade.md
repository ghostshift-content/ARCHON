# Opus 4.8 + Agent SDK — Framework Upgrade Research

**Date:** 2026-05-30
**Asked by:** Jay (Telegram)
**Question:** New Opus 4.8 + Claude Agent SDK features — kya improvements la sakte hain Kurukshetra mein? Aur limits/subscription ki tension kitni real hai?

---

## 0. The #1 thing — billing/limit exposure (Jay's instinct = correct)

**Finding from official SDK docs (code.claude.com/docs/en/agent-sdk/overview):**
> "Starting June 15, 2026, Agent SDK and `claude -p` usage on subscription plans will draw from a new **monthly Agent SDK credit**, separate from your interactive usage limits."

**Our exposure:**
- `anthropic-key.js` → no `sk-ant-` key configured (no `/root/intel/anthropic-config.json`, no env var in pm2). So `keySource()` returns **`oauth`** = subscription/claude.ai login.
- `event-bus.js` spawns `claude --print` / `claude -p` heavily (lines 568, 574, 2774, 2779, 2943, …) — every agent, every phase.
- => After **June 15** our entire framework's spawns get billed against a *separate, capped monthly SDK credit pool*, NOT our interactive Max limit. With parallel squad dispatch (10+ agents/run) this drains fast.

**Two paths:**
- **(A) Switch to a real API key (`sk-ant-`)** — usage-based, no subscription cap. Plumbing already exists: `setAnthropicApiKey()` + mission-control UI. Post-SpaceX/Colossus deal, Tier-1 input limit jumped **30K → 500K tokens/min**. Pay-per-token, but no throttle. **Recommended for production.**
- **(B) Stay on subscription** — accept the new monthly SDK credit, and aggressively cut token burn (effort param + fast mode + caching below).

This is a config decision, not code — but it's the single highest-impact call.

---

## 1. Free wins (same price, low effort, high value)

| Feature | What it gives us | Where it touches |
|---|---|---|
| **Opus 4.8 upgrade** | Same price as 4.7. **~4x less likely to let code flaws pass unremarked** — directly lowers false-negative rate in KRIPA/DHARMARAJ/code-review. Better tool-triggering (fewer skipped tool calls), better compaction recovery on long pentests. | `agents/llm-model-resolver.js:47` `powerful: 'claude-opus-4-7'` → `4-8`; check `model-config.js` too |
| **Effort parameter** (`effort: low/medium/high`, default high on 4.8) | Dial effort per-agent: recon/spot-check = low/medium (cheap+fast), KRIPA verify / DHARMARAJ judge = high. Big token savings without quality loss on the cheap phases. | model-router / spawn flags |
| **Fast mode** (`speed: "fast"`) | 2.5x throughput; on 4.8 it's **$10/$50 per Mtok — 3x cheaper than 4.7's $30/$150**. Good for latency-sensitive phases (spot-check, surface discovery). | spawn flags |
| **Lower cache minimum (1024 tok)** | Shorter prompts now cacheable — many of our per-agent system prompts that were too short to cache on 4.7 now hit cache. Free input-cost cut. | automatic, no code |
| **Mid-conversation system messages** | Append updated instructions mid-run without restating full system prompt → preserves prompt-cache hits on long agentic loops (our pentest chains). | event-bus loop construction |
| **Refusal `stop_details`** | Categorized refusal reasons — security tooling hits refusals often; lets us route/retry intelligently instead of treating all refusals the same. | error handling in spawns |

---

## 2. Structural opportunities (need approval — bigger changes)

| SDK feature | Maps to our | Opportunity |
|---|---|---|
| **Structured Outputs** (schema-validated JSON, native) | `finding-schema.validateFinding()` + auto-repair at `kripa-validated-builder.parseKripaEntry` | Replace hand-rolled JSON-repair with native schema enforcement at the model layer → fewer malformed findings, less defensive code. |
| **Dreaming** (scheduled review of past sessions → curates memory) | `*/memory/episodes/`, `lessons.md`, `grades.json` | We already manually accumulate episodes/lessons. Dreaming is the productized version — could auto-curate agent memory between runs. |
| **Outcomes / rubrics** (define rubric for good output) | DHARMARAJ judge + promotion gate | Native rubric scoring could complement/replace our 4-stage promotion rubric. |
| **Native subagents** (`AgentDefinition` + Agent tool, `parent_tool_use_id` tracking) | Our event-bus squad orchestration | We have a more durable orchestrator (PM2, JSONL, locks) than the SDK's in-process model — likely keep ours, but could borrow `parent_tool_use_id` for cleaner trace attribution. |
| **Dynamic Workflows** (Opus spawns 100s of parallel subagents, research preview) | dispatchPentestParallel / squads | Conceptually our model already. Watch the research preview; not production-ready to bet on yet. |
| **SessionStore adapters** (S3/Redis/Postgres) | our JSONL session state | Only relevant if we scale beyond single-box. Not urgent. |

---

## 3. Recommendation (honest)

1. **Decide auth first** (API key vs subscription) — this is the limits question and it's a real, dated risk (June 15). My lean: **API key** for production reliability.
2. **Ship the free wins now** (one small PR): bump `powerful` → `opus-4-8`, wire `effort` per-agent, optional fast-mode on cheap phases. Low risk, run `verify-framework.js` after.
3. **Structured Outputs** as the one bigger refactor worth doing — it removes a whole class of malformed-finding bugs we currently patch defensively.
4. Don't chase Dynamic Workflows yet (research preview).

## Sources
- https://code.claude.com/docs/en/agent-sdk/overview (June 15 billing note)
- https://platform.claude.com/docs/en/about-claude/models/whats-new-claude-4-8
- https://thenewstack.io/claude-opus-48-release/
- https://venturebeat.com/technology/anthropics-claude-opus-4-8-is-here-with-3x-cheaper-fast-mode-and-near-mythos-level-alignment
- https://www.anthropic.com/news/higher-limits-spacex (Colossus / rate-limit increase)
