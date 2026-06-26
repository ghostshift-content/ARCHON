# Kurukshetra Mission Control — Dashboard Redesign Spec (v2)
**Date:** 2026-06-04 · **Updated:** 2026-06-05 (post build-sprint — adds Inbox view, learning-loop approval, suppression review, quality trends, quarantine, break alerts) · **For:** Claude.ai design session (Jay takes this spec there, Claude designs, Jay brings back to code)

## What this is replacing
A Next.js dashboard at `/root/mission-control/`. Currently shows: task list, live agent streams, pentest findings, stock reports. It was designed for the OLD framework (raw `claude -p` spawns, static pipeline). The new framework is fundamentally different.

---

## The new framework's mental model (design must reflect this)

```
TRIGGERS → SPINE (thin, always-on) → DYNAMIC WORKFLOWS → SQUADS (plugins) → LEARNING LOOP → HUMAN TAP
```

Six ideas the UI must make real:
1. **Squads** — not "jobs". Each squad is a domain plugin (stocks, pentest, cloud-security, network-pentest, code-review). Add any domain by authoring a folder. Each squad now carries its own `squad.json` config (model tier, effort, severity profile, caps).
2. **Phases** — a dispatch runs through 18 phases. You need to see WHERE a run is, not just "running".
3. **Agents** — each phase spawns named agents (BHISHMA, KRIPA, DHARMARAJ, VYASA etc.) with real costs and outputs. You want to watch them think.
4. **Findings/quality** — for pentest: live findings with severity, verified status, and the evidence chain. For stocks: live analyst sections with verdict. Quality is now MEASURED per run (quality tracker) — the UI shows trends, not just point-in-time.
5. **The health number** — 104/104 gates passing is the production health signal. It belongs on the dashboard, alongside break-detection alerts from the changelog watcher.
6. **The human tap** — the framework observes itself (episodes), distills patterns, and PROPOSES improvements — but never auto-applies. Suppressed findings and quarantined payloads also wait for human eyes. All of it lands in ONE inbox. **This is the single most important new view.**

---

## Pages / Views

### 1. HOME — Mission Control Overview
The "2am command center" view. One screen, no scrolling.

**Left column (40%) — Active Operations**
- List of IN-FLIGHT dispatches with:
  - Squad badge (color-coded: terracotta=pentest, amber=stocks, blue=cloud, etc.)
  - Target/title (truncated)
  - Current phase + phase progress (e.g. "Phase 3 · KRIPA verifying" with a phase dot-track)
  - Elapsed time + estimated remaining
  - Live cost ticker ($X.XX, updating)
  - Click → drill into Task View

**Right column (60%) — Live Agent Feed**
- Real-time stream of agent activity across ALL active dispatches
- Each line: `[AGENT] Squad · phase · action text preview`
- SDK stream lines look like: `[BHISHMA] stocks · phase-1 · "ITC's FMCG margins have..."`
- Color by exit type: green=ok, amber=processing, red=error
- Auto-scrolls; pinnable

**Bottom bar — System Health**
- 7 metrics in a row: Gates (104/104 ✓), Active tasks, Squads ready, Event-bus ✓/✗, Last dispatch time, Monthly cost this period (from usage ledger), **Inbox count** (pending human-tap items — terracotta badge when > 0)
- If changelog-watcher has active break alerts → a thin red alert strip ABOVE the bottom bar: `⚠ BREAK DETECTED: <alert name>` (clicking goes to Health). This strip is the only thing allowed to interrupt the calm of Home.

---

### 2. TASK VIEW — Single dispatch drill-down
Accessed by clicking any task from Home or History.

**Header**: Target title · Squad · Status badge · Total cost · Duration

**Phase timeline** (horizontal track, top of page):
```
● 0.0 scope  ● 0.5 WAF  ● 1 recon  ● 2 specialists  ● 3 KRIPA  ◐ 3.9 judge  ○ 4 report
```
- Completed phases = filled circle
- Current = half-filled with pulse
- Click any phase → jump to its agent outputs below
- If the goal evaluator has fired (convergence check): show a small "goal: converging / converged / diverging" chip next to the timeline — oracle-anchored, so it reflects evidence, not optimism

**Main content (tabbed)**:
- **Agents** — card per agent that ran: name, model tier, cost, exit code, output preview (expandable), runtime. Each settled agent also shows its **episode summary** (grade, cost vs squad baseline, anomaly flag if the learning loop's OBSERVE marked it an outlier)
- **Live Stream** — the raw SDK stream, formatted: `[sdk:assistant]` lines show thinking text; click to expand full output
- **Findings** (pentest only) — live findings bus with severity chips, VALIDATED/ARCHIVED status, evidence links. **Suppressed findings show inline** with a muted strikethrough row + "why suppressed" tooltip (from suppression ledger) — never silently hidden. If a suppression is queued for manual review, show a small terracotta "needs review" chip linking to Inbox.
- **Report** — the final VYASA report rendered as markdown when done
- **Quality** — this run's quality record vs the squad baseline: pass-rate, grade, cost. One sparkline: this run as a dot on the squad's 30-day trend.

---

### 3. INBOX — The Human Tap (NEW — the most important new view)
Everything in the framework that is waiting for Jay's decision, in ONE place. Nav shows a count badge. Empty inbox = a calm "all clear" state, not a blank page.

Three sections (collapsible, newest first):

**A. Learning-loop proposals** (`/root/intel/learning/proposals.jsonl` via `learning-loop.js` CLI)
- Each proposal card: title, type (recurring-failure / cost-outlier / low-grade-cluster), the evidence that produced it (episode count, squad, pattern), the PROPOSED change (diff-style preview if it's a config change), and confidence
- Actions: **Approve** (applies via the gated apply path) · **Reject** (logs reason) · **Snooze**
- Hard rule reflected in UI: nothing here ever auto-applies — `requiresHumanTap:true` is gate-locked (GATE-103). The UI should say this in the section header so the trust model is visible.

**B. Suppression manual-review queue** (`/root/intel/manual-review-queue.jsonl` — escalations written by `logManualReviewNeeded`; resolve via `node agents/review-queue.js resolve <id> <promote|dismiss>` or `list`/`count`. SEPARATE file from `suppression-ledger.jsonl`, which is the full down-weight visibility log — the queue is only the high-conviction escalations needing a human tap.)
- Each card: finding title, original severity (High/Critical), what downweighted it (which cap/discipline), the evidence snapshot, and the agent's conviction note
- Actions: **Agree with suppression** (closes item) · **Restore finding** (re-promotes into VALIDATED-FINDINGS with an audit note)
- This is the false-negative safety net — design it so reviewing one item takes < 30 seconds

**C. Quarantine queue** (phase-envelope `quarantine()` output)
- Payloads that failed inter-phase validation: source phase, taskId, validation error, raw payload (expandable JSON)
- Actions: **Dismiss** (acknowledged, was garbage) · **Re-inject** (after manual fix — advanced, can be a v2 affordance)
- Usually empty. When non-empty, something structural broke — visually heavier than A/B (red left-border).

---

### 4. SQUADS — Plugin registry
Shows each squad as a card:
- Squad name + leader agent name
- Status: ACTIVE / STANDBY / DISABLED
- Last dispatch: N hours ago · $X.XX
- **Quality baseline sparkline** — 30-day pass-rate/grade trend from `quality-snapshot.json` (this replaces "gate health" on the card — gates are global, quality is per-squad)
- **Config summary** from `squads/<squad>/squad.json`: model tier · effort · severity profile · caps (read-only chips; editing config stays in code/git for now — display only)
- "Dispatch" button → opens dispatch modal

**Dispatch modal** (right slide-over):
- Target input (URL, ticker, or source dir depending on squad)
- Goal text area
- Severity profile dropdown (bounty / pentest / comprehensive) — pre-filled from squad.json default
- Model override (leave blank = auto)
- Estimated cost range (from usage-ledger data)

---

### 5. HISTORY — All dispatches
Table view: date, squad, target, status, cost, duration, **quality grade**, report link.
Filterable by squad, status, date range.
Click row → Task View.

---

### 6. HEALTH — Framework vitals
**Break alerts** (top of page, from `changelog-watcher.js breaks-only`): sdk-version-pinned, agent-runner-sdk-default, claude-binary-present, gate-suite-health — 4 named checks, green/red, last-checked timestamp. Plus the weekly CC changelog digest (collapsed list of upstream changes worth knowing).
**Gate Suite**: table of all 104 gates, green/red status, last-run timestamp. Run on demand (~2 min — show a progress state, don't fake instant).
**Quality**: per-squad quality trend charts from `quality.jsonl` — pass-rate, mean grade, cost-per-run, 30-day rolling. The "is the framework getting better or worse" page.
**Episodes**: recent OBSERVE feed from `episodes.jsonl` — one line per settled agent run: agent, squad, grade, cost, anomaly flag. This is the raw material the learning loop reads; seeing it builds trust in the proposals.
**Billing**: usage-ledger chart — daily cost by squad, 30-day rolling.
**Billing probe**: the June-15 measurement — shows `/root/intel/billing-probe.jsonl` data: cli vs sdk pool inference, token trends.
**Adapter**: current default (**sdk** — pure-SDK cutover live), rollback (`ADAPTER=cli`), last reload time.

---

## Design system (non-negotiable — from DESIGN.md)
- **Font**: Geist everywhere, Geist Mono for numbers/code/agent output
- **Background**: `#09090B` page, `#111113` cards, `#1A1A1C` hover
- **Accent**: `#D97757` (Claude terracotta) — active nav, buttons, focus, **Inbox badge**
- **Borders**: `rgba(255,255,255,0.06)` — barely visible
- **Status colors**: `#22C55E` green (running/ok), `#F59E0B` amber (working), `#EF4444` red (error/break-alert/quarantine)
- **Text**: `#EDEDEF` primary, `#A0A0AB` secondary, `#63636E` timestamps
- **Vibe**: Linear.app data density + Claude.ai warmth. Calm authority. No glow, no glassmorphism, no pulse animations.

---

## What's NEW vs the old dashboard (the key design challenges)

| Old | New |
|---|---|
| Job list with status dot | Phase timeline per task showing exactly WHERE in the 18-phase pipeline |
| Static "running" state | Live SDK stream — actual agent thoughts as they generate |
| No cost visibility | Per-agent cost ticker + monthly total from usage ledger |
| Findings only after completion | **Live findings bus** — findings appear as KRIPA validates them |
| Suppressed findings invisible | **Suppression visible inline** + manual-review queue in Inbox |
| No framework health | Gates panel (104/104) + break alerts + adapter status + billing probe |
| No self-improvement surface | **Inbox: learning-loop proposals with Approve/Reject** — the human-tap loop made tangible |
| No quality memory | Per-squad quality trends — every run measured against its baseline |
| One page | 6 views, but Home is the 2am screen you live on; Inbox is the morning-coffee screen |

---

## Data sources (so Claude knows what's real-time vs polled)

| Data | Source | Refresh |
|---|---|---|
| Active tasks | `/root/intel/dispatch-queue.json` | 2s poll |
| Agent streams | `/root/intel/streams/<agent>-<taskId>.stream` | SSE/tail |
| Live findings | `/root/intel/live-findings-<taskId>.jsonl` | SSE |
| Cost events | `/root/intel/ACTIVITY-LOG.jsonl` | 5s poll |
| Gate health | `node /root/agents/verify-framework.js` | On demand (~2 min) |
| Break alerts | `node /root/agents/agents/changelog-watcher.js breaks-only` | 60s poll or on page load |
| Learning proposals | `/root/intel/learning/proposals.jsonl` (read) + `learning-loop.js` CLI (approve/reject) | 30s poll |
| Suppression queue | `/root/intel/manual-review-queue.jsonl` (status=pending; via `agents/review-queue.js`) | 30s poll |
| Quarantine | phase-envelope quarantine dir under `/root/intel/` | 30s poll |
| Episodes | `/root/intel/episodes/episodes.jsonl` | 30s poll |
| Quality trends | `/root/intel/quality.jsonl` + `/root/intel/quality-snapshot.json` | On page load |
| Squad configs | `/root/agents/agents/squads/<squad>/squad.json` | On page load (read-only) |
| Usage/billing | `/root/intel/usage-ledger.jsonl` + `billing-probe.jsonl` | On page load |
| Reports | `/root/intel/reports/<taskId>.md` | Polled until present |

The server at `mission-control/server.js` already has SSE and file-tail endpoints — the new UI can reuse them. New endpoints needed: proposals list/approve/reject, suppression list/resolve, quarantine list/dismiss, quality snapshot, breaks-only runner. **Approve/Reject actions must go through the gated CLI paths (learning-loop.js), never write the jsonl directly** — the gate-locked invariants live in those modules, and the UI must not create a bypass.

---

## Ask for Claude.ai
"Design a dark command center dashboard for an AI agent orchestration system called Kurukshetra Mission Control. It monitors AI agents (named BHISHMA, KRIPA, DHARMARAJ etc.) running security research and stock analysis, and includes a human-approval inbox for the framework's self-improvement proposals.

Design system: Geist font, #09090B background, #D97757 terracotta accent (Claude brand), cards at #111113, barely-visible borders. Aesthetic: Linear.app data density + Claude.ai warmth. No gradients, no glow, no glassmorphism.

Design these 6 views: [paste the Pages section above]. Key design challenges: (1) make the phase timeline and live agent stream feel like mission control, not a generic dashboard; (2) make the Inbox feel like a calm decision queue — each item reviewable in under 30 seconds with clear Approve/Reject affordances; (3) suppressed findings must be visible-but-muted, never hidden."
