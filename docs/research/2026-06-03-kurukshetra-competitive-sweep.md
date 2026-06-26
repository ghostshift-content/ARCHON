# Competitive Sweep — are we missing anything / reinventing the wheel / best quality?

**Date:** 2026-06-03 · **Method:** 6 web-research lanes (Agentic-OS landscape, cross-agent collaboration, CC primitive ladder + latest blog, self-decision, quality competitive, configurability) + synthesis. KISS-disciplined.
**Asked by:** Jay — search all agent frameworks + "Agentic OS" projects; are we missing anything; is our output quality best; cross-agent live collaboration + self-decision; configurable/future-proof; latest Claude features.

## Headline
**Best-in-class to AHEAD on what matters.** The honest work is small and mostly *subtraction*: adopt 3-4 native primitives we hand-roll, add a false-NEGATIVE recall metric + escalate-counterweight, ship a `squad.yaml`, and **resist nearly every "Agentic OS / live debate / judge panel" feature as FOMO.** Net result: a *simpler* framework.

## Are we missing anything? (genuine gaps)
1. **No golden-bug RECALL metric-of-record** (highest leverage) — every quality number is fictional; the 40 eval dirs are rubric checklists, not recall fixtures. Can't answer "is our quality best?" without it. Fix: 10-20 confirmed-true-bug fixtures + recall metric + suppression ledger.
2. **False-NEGATIVE bias** — four down-weight-only filters, no promotion counterweight; LLM evaluators have TNR<25% (bad at reject/flag). Fix: minority-veto-to-**ESCALATE** (route to manual-verify, not silent-drop). Zero LLM cost.
3. **Hand-rolling loop-until-done** (`early-exit-decision.js`) = native **`/goal`** (CC 2.1.139). Use `/goal` with our oracle as done-condition.
4. **No bounded tool-call retry/self-heal** — the silent-drop bug class. ~1 helper, ≤2 attempts.
5. **Operational knobs scattered in JS** — add `squad.yaml`.

## Reinventing the wheel? (use native instead)
- loop-until-done → native `/goal` · custom memory-curation → native **Dreaming** · vector-DB/Letta → md-files+Dreaming (OpenClaw @163K stars validated md-no-vectorDB) · open-web recon → native `/deep-research` (prelude only) · "Agentic OS" rebuild → nothing (it's a dashboard over OpenClaw minus our gates/oracle/security) · Google A2A → nothing (no second party) · Nous-Psyche weights → nothing (banned fine-tuning) · "Semantic Firewall" → nothing (we already do it).

## Cross-agent live collaboration — PARTIAL, strongly skip-leaning
**ADD one narrow slice:** a 2-3 judge council on **CRITICAL-publish verdicts only** (workflow fan-out+vote, adaptive-stop, dissent→escalate-to-human). **SKIP everywhere else:** finding-existence (groupthink = 65% of debate errors, toxic for security), cross-squad chains (already covered by A2A-handoff+chain-verifier), self-direction (that's `/goal`). **NOT Agent Teams** (no session resumption → resurrects race bugs). Caveat: same-model-class judges amplify bias → borderline, lowest priority.

## Self-decision — bounded where an oracle verifies, human for ship/promote/self-modify
Add A1 (tool-retry self-heal), A2 (oracle-disagreement deep-probe), A3 (specialist-pruning at recon = cost lever). Never bare intrinsic self-correction (degrades quality without an oracle).

## Quality / config / Agentic-OS verdicts
- **Quality:** best-in-class on false-POSITIVE suppression (same architecture as 0sec/Shannon/autonomous, the 2026 pentest frontier). The 2 improvements are both false-NEGATIVE: recall metric + escalate-counterweight. **A judge panel does nothing here — wrong axis, amplifies same-model bias at 3× cost. Skip.**
- **Config/future-proof:** STRONG, ahead — ports/adapters out-future-proof LangGraph/CrewAI/ADK/MS (nobody else has runtime-swap insulation). One add: `squad.yaml`. Skip CRD engines, hot-reload, config-UI.
- **Agentic-OS:** spine+ports+squads IS a sound, more-honest agentic-OS kernel. OS-builders have nothing real we lack except a skill marketplace (skip — supply-chain surface) and multi-channel ingress (skip — one operator).

## Top additions folded into THE-FRAMEWORK ("v-next refinements")
1. Golden-bug recall fixtures + recall metric-of-record + suppression ledger (highest leverage). 2. Minority-veto-to-escalate. 3. `/goal` for the loop (delete bespoke heuristic). 4. Prompt-cache-fixed CC version NOW (free June-15 relief). 5. Dreaming behind remember port. 6. Bounded tool-retry self-heal. 7. `squad.yaml` (read-only in mission-control). 8. Narrow judge-council on CRITICAL-publish (lowest priority). 9. Correct any "uncapped firehose" cost lore — workflows are bounded 16/1000. 10. `/deep-research` for recon prelude only.

## Bottom line
Not behind — ahead where it counts. Stop hand-rolling what Anthropic ships (`/goal`, Dreaming, prompt-cache, `/deep-research`), add the two false-negative quality gaps no panel can fix, and say **no, hard,** to Agent Teams / A2A / judge-panels / LATS / PRMs / learned-routers / Psyche / vector-DB / marketplace. The correct direction is *simpler.*
