# Changelog

All notable changes to ARCHON are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and ARCHON adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

_Post-1.2 work in progress — see [BACKLOG.md](./BACKLOG.md) and [ROADMAP.md](./ROADMAP.md)._

### Added
- **Intercepting-proxy support (Burp Suite / ZAP / mitmproxy)** — `ARCHON_PROXY_URL` (+
  `ARCHON_PROXY_ENABLED`/`_BYPASS`/`_CA_CERT`/`_INSECURE`) routes all outbound agent HTTP/HTTPS
  traffic — every subprocess a specialist agent's Bash tool spawns (curl/nuclei/sqlmap/git/wget/
  python/node), the chain-verifier's curl replay, the browser-verifier's headless Chromium, and
  ARCHON's own `api.anthropic.com` startup check — through a single configurable proxy. Off by
  default; loopback targets always bypass the proxy so local fixtures/staging keep working. See
  `src/integrations/proxy-config.js` and the README's "Proxying traffic through Burp Suite" section.
  Closes the roadmap gap noted in `src/safety/production-safety.js`.

## [1.2.0] — 2026-07-07

Source-runtime parity: the whole static / white-box pipeline now runs as the same controlled,
few-persistent-session agentic runtime as mapping — plan once, assign clearly, stream progress and
findings, validate before reporting.

### Added
- **Spec session ladder** — 1-30→1, 31-90→3, 91-200→4, 201-500→5, 500+→6 persistent sessions, as a
  quota-gated ceiling (backs off to fewer sessions when the subscription bucket is warm/cooling).
- **Review as its own dimension** — every feature now tracks `review_status`
  (pending / in_progress / reviewed_no_issue / candidate_found / needs_more_context / failed /
  duplicate) independently of mapping, plus per-item ledger fields (assigned agent, finished_at,
  vulnerability_classes, duplicate_key). A failed review can no longer clobber a completed map.
- **Triage session ladder** — source-review triage scales 1-20→1, 21-75→2, 76-200→3, 200+→4 (cap 4);
  black-box triage is unchanged.
- **Richer streamed candidates** — each candidate carries mode (static/white-box), vulnerability_class,
  affected_files, affected_endpoint, exploit_hypothesis, requires_runtime_validation, recommendation,
  and a deterministic duplicate_key so the same source→sink flow collapses to one.
- **Dashboard cards** — Feature Coverage (discovered / mapped / deep / reviewed / no-issue /
  candidates / blocked / deferred / follow-ups), Findings Pipeline (candidates → triage → validated →
  judged, with the validation-status breakdown), and a live Timeline event feed. The plan line also
  shows quota mode, planned-vs-active sessions and the sizing reason (explains quota backoff), and the
  triager emits its real session count to the timeline (used over the estimate when present).
- **Freehand review accounting** — a freehand candidate on a feature Phase 2 marked `reviewed_no_issue`
  upgrades its review status to `candidate_found` (with a `freehand_candidates` count), so the ledger
  never reports "no issue" for a feature that produced one.

### Fixed
- **A failed review marked its feature `blocked`, wiping the mapping status.** Review outcomes now write
  the review dimension only; the mapping `done` is preserved and the failure is recorded separately.
- **A streamed candidate's `confirmation_status` could misrepresent validation truth.** A `DISPROVEN`
  candidate was relabelled `SOURCE_CONFIRMED`, and any unconfirmed/hypothesis status was over-promoted to
  `SOURCE_CONFIRMED`. Both `status` and `confirmation_status` now derive from one canonical classifier
  (DISPROVEN stays disproven; unknown/hypothesis stays `NEEDS_LIVE_VALIDATION`; source can never
  self-claim `RUNTIME_CONFIRMED`) and can no longer diverge.
- **Freehand findings were categorised as `freehand`.** The candidate now keeps its emitted vulnerability
  class (`c.vuln_class || c.vulnerability_class || cls`) for `cwe`, `vulnerability_class` and the
  `duplicate_key`, so a freehand business-logic finding is classed correctly and dedupes against a
  Phase-2 hit on the same flow.
- **In-run candidate dedupe ignored `duplicate_key`.** It now prefers the deterministic `duplicate_key`
  (same source→sink flow collapses despite different wording; distinct flows sharing file/line/title
  don't collapse), falling back to `cwe|file|line|title` only when absent.

## [1.1.0] — 2026-07-07

### Added
- **Source Runtime: static & white-box review now runs as a few persistent, Claude-Code-style worker
  sessions** instead of many short-lived spawns. A planner sizes the run (session ladder by feature
  count, sharded by domain/risk, capped for concurrency) and each worker maps many features in one
  long-lived context — closer to how a human reviewer works, and far easier on the rate limit.
- **Rate-limit-aware execution that never stalls coverage.** A rate limit becomes a typed, retryable
  `deferred_rate_limit` that pauses and resumes the affected features — it is no longer conflated with
  a permanent `blocked` coverage gap. Quota health feeds back into session sizing (warm → fewer,
  cooling → pause to one).
- **Honest mapping ledger.** Distinct counters for mapped / in-progress / queued / deferred / blocked /
  reviewed, so progress reports "mapped" (real work done) rather than an accounted-for total that hid
  transient defers and blocks behind one number.
- **Source Runtime dashboard card.** Live per-worker progress, plan/session breakdown, deferred and
  blocked counts, and a White-Box Validation section (`GET /api/source-runtime`).

### Changed
- **White-box source→runtime validation is explicit.** A source candidate carries its live-validation
  target (affected endpoint + required black-box proof) to the board and the deferred pentest queue. A
  source-only finding stays `SOURCE_CONFIRMED` and is promoted to `RUNTIME_CONFIRMED` **only** with real
  captured runtime proof — never on a URL alone.

## [1.0.2] — 2026-07-07

### Fixed
- **Vulnerability-focus picker reappeared in black-box mode.** v1.0.1 hid `#ptStrategyField` with the
  `hidden` attribute, but `applyPtMode()` re-set `display:block` on it when black-box/white-box was
  selected, overriding the attribute. Removed that re-show line so the picker stays hidden and every
  scan is full A→Z, as intended.

## [1.0.1] — 2026-07-07

### Changed
- **Disabled the black-box "Scan strategy → Vulnerability focus" class picker.** Selecting a class
  (e.g. XSS) silently narrowed the strategist to that class only, which read as "the strategy scan
  isn't accurate." Every scan now runs the full A→Z deep dive by default; dispatch is one step shorter.
  Backend focus handling is untouched (reversible). (#10)

## [1.0.0] — 2026-07-06

First stable release. ARCHON is a durable multi-agent AI penetration tester for web applications:
a lead agent plans a stack-specific attack, per-class specialists go deep in parallel, and
independent verifiers reject anything they can't reproduce — confirmed, de-duplicated findings land
live on the operator's board. Runs entirely on a Claude subscription over OAuth (no metered API key).

### Engagement modes
- **Black-box** — recon → stack fingerprint → ranked attack plan → parallel specialist waves
  (fire → observe → mutate → re-fire), WAF-adaptive.
- **Static / white-box** — reads the source: inventories → app blueprint → feature mapping →
  per-class assessment → AUDITOR reverse-check. Findings reported at `file:line` with the vulnerable
  code block as proof; review classes auto-selected from the discovered surface.
- **White-box (combined)** — code review runs first, then aims a source-guided live pentest;
  `cross-view-dedup` merges source and runtime views into one report.

### Core pipeline
- Two squads: **pentest** (lead ATLAS + ~15 specialists) and **code-review** (lead CURATOR + mappers/
  specialists + PROBER runtime validator), plus universal AUDITOR / ARBITER / SCRIBE / TRIAGER / WRITER.
- **Map-all-then-review** code-review pipeline: every feature is mapped before Phase 2 begins
  (fast-map all → deep-map high-risk → completion gate → per-class review), eliminating head-of-line
  stalls; findings stream to the board live with `file:line` + the vulnerable code block.
- Live triage squad that scales with the backlog; multi-judge consensus gates High/Critical.
- **Honest confirmation status** — `RUNTIME_CONFIRMED` / `SOURCE_CONFIRMED` /
  `NEEDS_LIVE_VALIDATION` / `DISPROVEN`; a source read is never dressed up as a live proof.
- **Evidence contract** — a CONFIRMED finding needs replayable evidence or it is demoted.
- Graded per-area OWASP WSTG coverage scoring; on-demand reporting (nothing auto-publishes).

### Safety
- **Fail-closed scope gate** (Phase 0.0) — a dispatch with no scope config is blocked.
- **Detecting ≠ exploiting** — impact-proving exploits fire only behind a 3-gate opt-in; off by default.
- Non-destructive by default; local-operator security (portal binds `127.0.0.1`; `var/` gitignored).

### Operator console
- Zero-build single-page dashboard: dispatch, live progress, triage, CVSS 3.1, and reports.
- Neutral empty-state pipeline preview.

### Tooling
- Portable roots (`KURU_*` + `.env.local` autoload) — a fresh clone runs unconfigured.
- Release gate (`npm run release:check`), clean-artifact packaging (`npm run pack:release`),
  secret/PII scanner + pre-commit hook + CI.
- Flag-gated, off-by-default **Autonomous Agent OS** layer (Mission Director, knowledge graph,
  pattern catalogs, decision logging); flag-off is byte-identical to the deterministic pipeline.

### Field-tested
- ARCHON's white-box review found a real broken-access-control flaw disclosed to GitLab via HackerOne,
  fixed in GitLab's May 2026 security release as **CVE-2026-4524** (CVSS 6.5, CWE-288).

[Unreleased]: https://github.com/ghostshift-content/ARCHON/compare/v1.0.2...HEAD
[1.0.2]: https://github.com/ghostshift-content/ARCHON/releases/tag/v1.0.2
[1.0.1]: https://github.com/ghostshift-content/ARCHON/releases/tag/v1.0.1
[1.0.0]: https://github.com/ghostshift-content/ARCHON/releases/tag/v1.0.0
