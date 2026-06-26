# Kurukshetra — START HERE (the architecture in 5 ideas)

**Date:** 2026-06-03 · **Status:** design, validated against mid-2026 SOTA · **No code changed.**
This is the front door. The detailed docs (v1/v2/v2.1/deep-dive) are the appendix you read when building a specific piece.

---

## The whole thing, in 5 ideas

```
        triggers ─▶ ┌──────────────┐
                    │  THE SPINE   │   owns: queue · memory · state · crash-recovery · TRACE
                    │ (always on)  │   does NO AI itself; LAUNCHES the workflow below
                    └──────┬───────┘
              calls through 5 PORTS  (swap what's behind one, never the spine)
          run-agent · check-result · remember · report · get-triggered
                           │
                    ┌──────┴───────┐
                    │ CLAUDE CODE  │   the dispatch runs as a DYNAMIC WORKFLOW
                    │ (native)     │   (fan-out · adversarial-verify · loop · quarantine)
                    └──────┬───────┘
                           │
              ┌────────────┴─────────────┐
              │   SQUADS = plugin folders │   pentest · stocks · red-team · <anything>
              │  (agents + rules + tests) │
              └────────────┬─────────────┘
                           │ every run → result + grade + trace
                           ▼
              ┌──────────────────────────┐
              │   THE LEARNING LOOP       │   test → YOU approve → adopt → auto-undo if worse
              │  improves memory/skills/  │   RULE 1: it can't grade itself
              │  prompts from its own runs│   RULE 2: every target is treated as hostile
              └────────────┬─────────────┘
                           └──▶ loops back to make the squads better
```

1. **SPINE** — a small always-on program that owns the durable state (queue, memory, checkpoints, crash-recovery, **and the run trace**) and survives crashes. Runs no AI; it launches and supervises the workflow. *(it's a 24/7 system)*
2. **PORTS** — the spine never calls Claude directly; it goes through ~5 stable sockets, so you swap *what's behind a port* (today a subagent, tomorrow a feature that doesn't exist yet) without touching anything else. **This one idea is the entire future-proofing.**
3. **SQUADS = plugins** — a domain is a folder: agents + rules + a test set. Drop it in, the whole machine works for it. **This is "add anything later."**
4. **THE LEARNING LOOP** — it watches its own runs, proposes small improvements, each is tested and waits for your one tap, and auto-undoes itself if it regresses. **One loop, one human gate.**
5. **TWO RULES** — it can't grade its own work, and it treats everything a target says as an attack. **Quality + safety in one line.**

---

## Is this current, or are we outdated?

**Current — with exactly one exception.** Four independent research passes + Anthropic's own June-3 dynamic-workflows article agree: the spine/ports/squads/loop/rules shape is the literal 2026 consensus, and Anthropic independently shipped both of our safety rules as products (Outcomes = "can't grade itself"; Guardrails/Quarantine = "targets are hostile"). md-file memory is the *native* idiom now (no vector DB). 5 ideas is the right grain.

**The one outdated thing:** raw `claude -p` + stdout-parsing → use the **Agent SDK** behind the run-agent port. (See the modernization plan.)

**Honest scope (independent review):** the "auto-improve" is a **read-only feature watcher + human-authored adapters** (not autonomous adoption — that part stays a long bet), and the quality story is a **3-layer live verification floor that's mostly already in production** — strong and real, but it needs a **false-negative counterweight** so its down-weight-only filters can't silently suppress a real finding. Details: `2026-06-03-kurukshetra-independent-review.md` + THE-FRAMEWORK "Honest scope & corrections".

**The one time-sensitive thing (not architecture):** the **June-15 capped credit pool** — measure usage now, route scheduled work through Anthropic-native scheduling (Routines / Co-work) to stay on the interactive pool, decide overflow billing this week.

---

## What we deliberately are NOT building (KISS)
Temporal/DBOS · microVMs-per-agent · vector DBs · Agent Teams (resurrects old race bugs) · Managed-Agents API (wrong cost model on subscription) · eval-platform products · RBAC/quorum · any fine-tuning infra. All YAGNI on a one-operator box.

---

## The doc set
- **This page** — start here.
- `…-inside-claude-code-vision.md` (v1) — spine + ports + migration.
- `…-v2-self-improving-kernel.md` (v2) — squad kernel + the learning loop.
- `…-v2.1-security-reward-hardening.md` (v2.1) — hostile-target defenses + reward anchoring.
- `…-simple-design-deepdive.md` — the 5 ideas in detail + "one dispatch as a workflow."
- `…-run-agent-sdk-modernization.md` (plan) — the one garment to change.
