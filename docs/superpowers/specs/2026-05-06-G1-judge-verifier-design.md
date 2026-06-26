# G1: Judge Verifier — Design Spec

**Status:** 🟢 APPROVED (per architecture vision §4 Layer A; Raptor §18.3.1 4-stage validator inspiration)
**Layer:** A (Verification Spine)
**Source:** [Architecture vision](../../architecture/2026-05-06-kurukshetra-quality-architecture.md), [Raptor 4-stage analysis](../../research/2026-05-05-agentic-framework-research.md#1831-four-stage-exploitation-validator-stages-a-d-)
**Estimated effort:** 5 days build + 3 days observation = 8 days total
**Estimated win:** F1 ~0.95 → ~0.99 (validated 85-91% FP reduction across SAST-Genius / LLM4FPM / AdaTaint research)

---

## 1. Goal

Add a **4-stage judge verifier** between Phase 3 (KRIPA) and Phase 4 (VYASA) that explicitly cross-checks every Critical/High finding via independent reasoning, downgrading findings that fail any stage. Modeled on Raptor's exploitation-validator methodology — more structured than a single "judge agent" review.

## 2. The 4-stage structure (Raptor-inspired)

| Stage | Question | Pass criteria | Fail = Downgrade to |
|---|---|---|---|
| **A: Pattern Noise** | Is this pattern-matched noise (e.g., test code, examples, false-positive boilerplate) or a real vulnerability? | Real, exploitable code path | Info |
| **B: Attacker Prerequisites** | What does an attacker need (auth, network access, specific user, race window)? | Reachable from realistic attacker position | Medium (cap) |
| **C: Reachability from External Entry** | Can the vulnerable code be reached from an external entry point (HTTP request, file upload, message queue)? | Yes, demonstrable path | Low |
| **D: Finality Check** | Is this in test code? Unrealistic preconditions? Already mitigated upstream? | Production code, real conditions, no upstream mitigation | Info |

A finding must pass ALL FOUR to retain its original severity. Failing any stage → downgrade per the table.

## 3. Architecture

### 3.1 New module: `agents/judge-verifier.js`

Stateless module exporting:
```javascript
async function judgeFindings(findings, opts) → { results, summary }
```

- `findings`: array from `VALIDATED-FINDINGS-${taskId}.jsonl`
- `opts`: `{ target, modelProfile, agentName, taskId }`
- Returns per-finding judgement with stage A-D results + final verdict

### 3.2 Stage prompt structure

Single LLM call per finding with structured prompt enforcing the 4-stage analysis:
```
You are the Judge Verifier. For the finding below, evaluate 4 stages independently.
Output STRICT JSON: { "stage_a": {pass, reason}, "stage_b": {pass, reason}, ... "verdict": "confirmed|downgraded", "downgrade_to": "Info|Medium|Low|None" }
NEVER agree just because the originating analyst said so. If any stage fails, the finding fails.
```

### 3.3 Phase 3.9 integration (later — initial MVP is post-processing)

**MVP (Phase 1):** standalone CLI script — `scripts/run-judge-verifier.js <taskId>` reads VALIDATED-FINDINGS, writes JUDGED-FINDINGS-${taskId}.jsonl, optionally updates VALIDATED-FINDINGS in place.

**Phase 2 (later):** hook into event-bus.js as Phase 3.9 (between Phase 3.8 browser-verifier and Phase 4 VYASA). VYASA reads JUDGED-FINDINGS instead of raw VALIDATED-FINDINGS. New GATE-56: "Critical/High findings must have judge_verdict='confirmed'".

**Why MVP first:** validates the 4-stage prompt design + per-stage accuracy before integrating into the production pipeline.

### 3.4 Anti-sycophancy guard

The judge-verifier explicitly does NOT see:
- Original analyst agent name
- KRISHNA's task title or any framing language ("test", "verify", "exploit")
- Any prior verdicts (chain-verifier, browser-verifier outputs)

It sees ONLY:
- The finding object (id, severity, title, description, evidence)
- The target URL/context
- The 4-stage rubric

This forces independent reasoning. Matches our existing goal-scrub pattern (CLAUDE.md "feedback_no_sycophancy").

## 4. Decision criteria

A finding is **CONFIRMED** if all 4 stages pass.
A finding is **DOWNGRADED** if any stage fails. Downgrade target = lowest of (current severity, stage's downgrade target).

Downgrade targets:
- Stage A fail → Info
- Stage B fail → Medium (cap, can't be Critical/High)
- Stage C fail → Low
- Stage D fail → Info

## 5. Implementation phases

### MVP (this spec — 3 days)
- `agents/judge-verifier.js` — module + prompt template + parser
- `scripts/run-judge-verifier.js` — CLI runner
- `test/judge-verifier.test.js` — unit tests with mocked LLM responses
- `test/run-judge-verifier.test.js` — integration test on synthetic VALIDATED-FINDINGS

### Phase 2 (later, separate spec)
- Phase 3.9 wiring in event-bus.js
- New GATE-56
- VYASA prompt update to consume JUDGED-FINDINGS
- A/B comparison: VYASA reports with vs without judge

## 6. Verification

- Run on retro-validated past pentest findings (Lenovo v4 backlog) with known FP/TP truth
- Measure: judge's FP-detection rate (target: ≥85% per Raptor + SAST-Genius evidence)
- No new false-Confirmed (judge should never elevate severity, only downgrade)

## 7. What this spec does NOT cover

- **VYASA report integration** — separate spec when MVP validates
- **GATE-56 enforcement** — separate spec
- **Per-stage Wilson confidence** — Phase 3+ refinement
- **Multi-judge ensemble** — out of scope; one judge is sufficient per Raptor's design

## 8. Decision (auto-applied per Jay's autonomy directive)

This spec ships as written. No clarifying questions. Implementation begins immediately.
