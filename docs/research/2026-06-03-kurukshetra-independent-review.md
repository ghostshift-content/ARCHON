# Independent Architecture Review — the two claims (auto-update + quality)

**Date:** 2026-06-03 · **Method:** 5 independent fresh-eyes reviewers (no stake in the design) + synthesis. Skeptical, doc-cited, web-verified.
**Why:** Jay asked whether the new framework's two headline claims — (A) auto-updates / uses new Claude features, (B) improves output quality — are *real or aspirational*. Reviewing one's own design has self-preference bias (the exact thing the framework guards against), so this was done independently.

## Overall rating
**Sound design, honest body, overstated headlines. ~2 real gaps that matter.** Neither claim is vapor; both were pitched one notch higher than reality, and the gap in each is the same — the safe, buildable version keeps a human in the loop, and the TL;DR framing quietly dropped that human.

## Claim A — "auto-uses new Claude features": PARTIAL, mislabeled, 0% built
- It's an auto-**watcher**, not an auto-**updater**. Confirmed: no adapter-registry / capability-detection / floor-adapter / ASHWATTHAMA / SANATANA code exists.
- Cheap half (read-only changelog digest) is **real and worth building** (~1 day, ~80% of value). Expensive half (auto-authoring a working adapter for a Tuesday feature) is **aspirational** — ~10-25% first-pass success, because the model writing the adapter was trained *before* the feature shipped.
- The design's own rules defeat the claim: "propose-only for ALL ports" (every change ends at a human tap) and "never autonomous self-rewrite" (forbids adopting the high-value features — Dynamic Workflows, ultracode — so the engine could only wrap low-value flag-renames).
- Missing the higher-value alarm: **break-detection** (a primitive you depend on changing under you — e.g. the `workflow`→`ultracode` trigger rename) beats adopt-new.
- Factual error caught: the canonical doc said we were "a year early" on Anthropic's Dreaming — **Dreaming shipped 2026-05-06.** Adopt theirs behind a port.

## Claim B — "improves quality": REAL for verification (mostly already LIVE), long-bet for the loop, with one real danger
- **Strong & shipped:** the verification floor genuinely beats plain Claude Code and most is already in production (chain-verifier, browser-verifier, active-poc, KRIPA, DHARMARAJ). The best idea — **deterministic oracles as the non-gameable reward anchor + judge demoted to down-weight-only** — is *stricter than Anthropic's own Outcomes.*
- **Framing oversold:** "five layers each run" is theater-by-conflation — only **3 layers touch a live finding** (oracles, KRIPA, judge); the eval gate + IPT gate *self-improvement proposals*, never a live dispatch. IPT was mislabeled "highest-value add" for per-run quality (it only guards the benchmark). KRIPA's "independence" = fresh context, not a different model (shared priors remain).
- **⚠️ Real danger — structural false-negative bias:** four down-weight-only filters (oracle-can't-confirm, KRIPA-skeptical, judge-needs-a-quote, severity-cap) compound toward **suppression**, with no promotion counterweight. A genuine business-logic CRITICAL with no quotable string and no oracle replay can be silently filtered to Low — *dropped for a bounty.* The false-negative cost is unpriced. **For a security framework this is the finding that matters.**
- **Not measurable in fact:** no metric of record, no baseline, every quality number in the docs is a fictional worked example, and the 40 "eval" dirs are **rubric checklists, not golden-bug recall fixtures** — they can't measure whether more real bugs are caught. No honeypot/IPT code exists.
- **Loop is a long bet:** design-only; needs ~9 recurring misses to fire; on low volume that's months away — a logarithm, not a hockey stick. Anthropic's Dreaming/Outcomes now do ~70% natively.

## Genuinely strong — keep verbatim
- The **ports / floor-adapter seam** (real future-proofing; `GATE-SEAM-CHOKEPOINT` is a concrete invariant).
- **Oracle-anchored verification + judge-down-weight-only** (best idea, battle-tested).
- The **DGM safety perimeter** ("exactly 3 auto-moves toward known-safe; the improver can never edit its judge; memory may only down-weight, never suppress") — *"keep it verbatim as the constitution."*

## The corrections applied to the design
Captured in `2026-06-03-kurukshetra-THE-FRAMEWORK.md` → "Honest scope & corrections" section: relabel auto-update as a watcher, build only the read-only watcher + break-detection, write adapters by hand, adopt native Dreaming, add the **false-negative counterweight** (suppression ledger + manual-verify queue + recall measurement), and the **quality-metric-of-record + baseline** as the single highest-leverage move.
