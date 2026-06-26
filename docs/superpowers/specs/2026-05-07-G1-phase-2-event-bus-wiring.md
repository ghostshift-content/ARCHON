# G1 Phase 2: Event-Bus Phase 3.9 Wiring + VYASA Integration

**Status:** 🟡 SPEC DRAFTED — awaiting Jay's approval per Plan-First rule
**Predecessor:** [G1 MVP spec](./2026-05-06-G1-judge-verifier-design.md) — MVP shipped 2026-05-06
**Layer:** A (Verification Spine)
**Estimated effort:** 1 day code + 1 day observation = 2 days
**Effective FP catch rate from MVP retro:** ≥85% on real Motorola pentest data ([retro summary](../../../intel/g1-retro-validation/RETRO-SUMMARY-2026-05-07.md))

---

## 1. Goal

Wire the validated G1 Judge Verifier into the production pentest pipeline so every Critical/High finding gets independent 4-stage validation BEFORE VYASA writes the final report.

## 2. Pre-flight evidence

Per the [MVP retro validation](../../../intel/g1-retro-validation/RETRO-SUMMARY-2026-05-07.md), two real bugs were caught and fixed during MVP retro before any production wiring:
- Schema mismatch: prompt-builder field names didn't match real production data (fixed `fdc5a2e`)
- Sycophancy bias: analyst-claim fields were priming the judge to defer (fixed `a49e3ef`)

The corrected v3 prompt produces sound independent reasoning on real pentest findings. Phase 2 wiring is now justified.

## 3. Architecture

### 3.1 Phase 3.9 hook in event-bus.js

Insert a new phase between Phase 3.8 (browser-verifier) and Phase 4 (VYASA), at `event-bus.js:4866-4868`.

```javascript
// (existing) end of Phase 3.8 try/catch at line 4866
}

// ── PHASE 3.9: Judge Verifier (G1) — independent 4-stage validation ──
try {
  const judgeFile = `/root/intel/VALIDATED-FINDINGS-${taskId}.jsonl`
  if (fs.existsSync(judgeFile)) {
    log(`⚖️  Phase 3.9: Judge Verifier — 4-stage validation`)
    logActivity('SANJAY', `⚖️ Phase 3.9: Judge Verifier`, {
      type: 'dispatch-phase', squad, taskId, projectId: projectId || '',
      details: 'Independent 4-stage validation (anti-sycophancy)'
    })
    updateProgress(82, 'Phase 3.9: Judge Verifier')

    const { runJudge } = freshRequire('./scripts/run-judge-verifier')
    // SCOPE FILTER: only Critical/High go through real LLM (cost optimization).
    // Medium/Low/Info pass through unchanged.
    const callLLM = (prompt) => callRealLLM(prompt, { model: 'claude-haiku-4-5' })
    const judgeResult = await runJudge({
      taskId, file: judgeFile, target: targetUrl,
      callLLM,
      severityFilter: ['Critical', 'High'],  // NEW opt
    })
    log(`⚖️  Phase 3.9 complete: ${judgeResult.summary.confirmed} confirmed, ` +
        `${judgeResult.summary.downgraded} downgraded`)
    logActivity('SANJAY', `⚖️ Phase 3.9 complete`, {
      type: 'phase-complete', squad, taskId,
      details: `Confirmed: ${judgeResult.summary.confirmed} | Downgraded: ${judgeResult.summary.downgraded} | By stage: A=${judgeResult.summary.downgraded_by_stage.A} B=${judgeResult.summary.downgraded_by_stage.B} C=${judgeResult.summary.downgraded_by_stage.C} D=${judgeResult.summary.downgraded_by_stage.D}`
    })
  }
} catch (e) {
  // Fail-soft: log error, VYASA falls back to raw VALIDATED-FINDINGS
  log(`⚖️  Phase 3.9 error (non-fatal, VYASA will use raw VALIDATED-FINDINGS): ${e.message}`)
}

// ── PHASE 4: Report (VYASA) ── (existing, line 4868)
```

**Key design decisions:**

| Decision | Rationale |
|---|---|
| Critical/High only, not all findings | LLM cost. Medium/Low/Info pass through. Saves ~50% calls. |
| Sequential per-finding (not parallel) | Matches MVP pattern. ~28s per finding × ~3 Critical/High = ~1.5 min. Acceptable. |
| Fail-soft (try/catch wrap) | Judge is augmentation, not gate. If LLM fails, pipeline continues with raw VALIDATED-FINDINGS. |
| `freshRequire('./scripts/run-judge-verifier')` | Hot-reload pattern matches Phase 3.8. |
| Output to JUDGED-FINDINGS-{taskId}.jsonl alongside VALIDATED | Keeps both for VYASA + audit. |

### 3.2 Add `severityFilter` opt to judge-verifier

Currently `judgeFindings` runs every finding. Add scope filter:

```javascript
async function judgeFindings(findings, opts = {}) {
  const target = opts.target || ''
  const callLLM = opts.callLLM || callJudgeLLM
  const severityFilter = opts.severityFilter || null  // NEW

  const results = []
  for (const f of findings) {
    const sev = normalizeSeverity(f.severity)
    if (severityFilter && !severityFilter.includes(sev)) {
      // Pass-through: keep finding unchanged, mark not-judged
      results.push({ ...f, judge_verdict: 'not-judged', judge_reason: `severity ${sev} below threshold` })
      continue
    }
    // ... existing logic
  }
}
```

### 3.3 VYASA prompt update

Modify `buildVyasaReportPrompt` (event-bus.js:3063) to read JUDGED-FINDINGS if present. Add to the prompt:

```
JUDGE VERDICTS (Phase 3.9):
Each Critical/High finding has been independently 4-stage validated.
- judge_verdict='confirmed' → all 4 stages passed, severity preserved
- judge_verdict='downgraded' → ONE stage failed, severity reduced
- judge_verdict='not-judged' → below severity threshold (Medium/Low/Info)
- judge_verdict='indeterminate' → judge LLM error, treat as raw

When writing the report:
- For 'downgraded' findings, USE THE NEW severity (not severity_original)
- Include the judge's failure reason in the finding's "Notes" section
- For 'indeterminate', flag in Notes: "Judge unavailable — review manually"
```

### 3.4 GATE-59

```javascript
gate('GATE-59: when JUDGED-FINDINGS exists, post-deploy reports respect judge verdicts', () => {
  // Find post-Phase-3.9-deploy reports that should have judge_verdict references
  // Verify Critical/High in final report have judge_verdict='confirmed' (or explicit override note)
})
```

## 4. Failure modes & rollback

| Failure | Behavior |
|---|---|
| LLM call fails on a finding | That finding marked indeterminate, others continue. VYASA flags in report. |
| All LLM calls fail (e.g., rate limit) | Phase 3.9 caught by try/catch, VYASA uses raw VALIDATED-FINDINGS. Log warning. |
| run-judge-verifier.js missing | freshRequire throws, caught, fail-soft same as above. |
| Judge confirms a real FP | Wrong but not catastrophic — same as the pre-Phase-3.9 baseline. |
| Judge downgrades a real TP | Documented in report Notes. Human reviewer can override at PR-review stage. |

**Rollback path:** Phase 3.9 can be disabled in 1 minute via env flag `KURUKSHETRA_PHASE_3_9=disabled`. Add this to the try guard:

```javascript
if (process.env.KURUKSHETRA_PHASE_3_9 === 'disabled') {
  log(`⚖️  Phase 3.9 disabled by env`)
} else { /* the hook */ }
```

## 5. Implementation phases (within Phase 2)

### Task A: severityFilter opt + tests (TDD)
- Modify `agents/judge-verifier.js` `judgeFindings`
- Add 3 tests in `test/judge-verifier.test.js` for the new opt
- 1 commit

### Task B: Phase 3.9 hook in event-bus.js
- Insert hook block between Phase 3.8 and Phase 4
- Add module-level grep test in `test/event-bus-phase-3-9-wiring.test.js`
- 1 commit

### Task C: VYASA prompt update
- Modify `buildVyasaReportPrompt` to reference JUDGED-FINDINGS
- Update existing `test/vyasa-prompt-browser-aware.test.js` or new sibling
- 1 commit

### Task D: GATE-59 + verify-framework
- Add GATE-59 like GATE-54 (post-deploy report content check)
- 1 commit

### Task E: Live observation (NOT done by Claude)
- Jay does PM2 reload of event-bus daemon
- Re-dispatch a test target
- Compare report quality before/after
- Decision: keep enabled or rollback via env flag

## 6. What this spec does NOT cover

- **Multi-judge ensemble** — out of scope. One judge is sufficient per Raptor's design.
- **Per-stage Wilson confidence** — Phase 3+ refinement, not gating Phase 2.
- **A/B comparison report** — useful but separate experiment (similar to G4 multi-model test pattern).
- **Other squads** (cloud-security, network-pentest, code-review) — Phase 2 is pentest squad only. Other squads roll out after observation.

## 7. Approval gate

Per Plan-First rule, this spec needs Jay's "ok" before code is written.

**Action requested from Jay:** review this spec → say "kar de" / "approve" / "haan" → I implement Tasks A-D on a feature branch, leave Task E (PM2 reload) for Jay to do manually.

## 8. Decisions baked in

- ✅ Critical/High scope filter (cost saving)
- ✅ Sequential, not parallel (latency acceptable)
- ✅ Fail-soft, not blocking (judge is augmentation)
- ✅ Env-flag rollback (`KURUKSHETRA_PHASE_3_9=disabled`)
- ✅ Pentest squad only first (other squads come after observation)

These can be revisited on the spec review pass.
