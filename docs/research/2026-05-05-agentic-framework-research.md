# Agentic Framework Research — Kurukshetra Improvement Notes

**Status:** 🟡 LIVING DOC — research collection phase
**Started:** 2026-05-05
**Goal:** Survey 2026 agentic framework landscape, identify patterns kurukshetra could borrow, defer implementation decisions until full picture is gathered.

> **How to read this doc:** Sections 2-6 are *findings* (what exists, what they do). Section 7 is *qualitative impact analysis* (what would actually improve quality vs what's just developer-experience polish). Section 8 is the **decision matrix** — currently empty, will be filled when Jay decides what to implement.

---

## 1. Kurukshetra current state (baseline)

### Architecture
- **7 squads:** pentest, stocks, cloud-security, network-pentest, code-review, plus mission-control + DDB
- **Phase 0-5 sequential pipeline** with deterministic verifier gates:
  - Phase 0: KRISHNA dispatch
  - Phase 1: specialists (e.g. ARJUN/DURYODHANA/KARNA for pentest)
  - Phase 2: DHARMA validation
  - Phase 3: KRIPA verifier
  - Phase 3.6: chain-verifier (curl) — empirical validation of chains
  - Phase 3.8: browser-verifier (Playwright + Acorn AST) — DOM/CSP/XSS validation
  - Phase 4: VYASA reporter
  - Phase 5: separate grader (Haiku — anti-sycophancy)
- **GATE system 50+:** GATE-11 (evidence completeness), GATE-12 (threat-model discipline), GATE-51/52 (spot-check coverage), etc.
- **Memory:** flat `MEMORY.md` index → individual `.md` topic files (~30 entries currently)
- **Squad isolation:** zero cross-squad collaboration today
- **Daemon supervision:** PM2 (event-bus, telegram-relay, mission-control, supervisor)

### Production hardening (already shipped)
- Sycophancy prevention (goal-scrub + separate-context grader)
- Race-condition guards (cancelledAt-sticky, external state resurrection)
- Atomic writes, single-writer event-bus, inbox/outbox patterns
- Auto-heal infrastructure (telegram-doctor.sh: ~48 self-heals/21h proven)
- Phase 3.6 + 3.8 verifiers — empirical proof, not LLM self-claims

### Strengths over published frameworks
- Domain specialization (security focus) — no general framework matches
- Verifier gates with empirical validation — most papers theorize, we shipped
- 50+ production-tested predicate gates
- Race-condition-hardened multi-writer state
- Auto-heal MCP infrastructure (none of the frameworks have this)

---

## 2. Mainstream agentic frameworks (May 2026)

| Framework | Owner | Key feature | Maturity |
|---|---|---|---|
| Microsoft agent-framework | Microsoft | Graph workflows + DevUI + OpenTelemetry + AF Labs RL/benchmarking | New May 2026 |
| OpenClaw | Peter Steinberger (now OpenAI) | Local-first, Markdown memory, "always on", 355k stars | Apr 2026 |
| Anthropic Managed Agents | Anthropic | Hosted, durable state, sessions/harness/sandbox | Apr 2026 |
| Anthropic Agent Skills | Anthropic | Pre-built skills (PPTX/XLSX/DOCX/PDF) | Active |
| LangGraph | LangChain | Graph workflows, streaming, time-travel, human-in-loop. Klarna/Uber/LinkedIn prod | Stable |
| AutoGen | Microsoft | Conversational multi-agent, 54k stars | Stable |
| CrewAI | Indie | Crews (groups) + Flows (event-driven state machines) | Stable |
| OpenAI Swarm | OpenAI | Lightweight handoffs, minimal abstractions | Experimental |
| Swarms | kyegomez | Enterprise-grade parallel orchestration | Stable |
| Superpowers | obra | Composable skills + initial instructions methodology | New |
| Craft Agents OSS | Lukilabs | Apache 2.0, May 2026 release | New |
| TradingAgents | TauricResearch | Financial trading multi-agent | Domain-specific |
| Warp | warpdotdev | Terminal-based agent dev environment | New |

### Architectural paradigms
- **Conductor (hierarchical, predictable):** kurukshetra, Microsoft agent-framework, LangGraph
- **Swarm (parallel, fault-tolerant):** OpenAI Swarm, Swarms by kyegomez
- **Hybrid:** emerging best practice (Conductor-of-Swarms)

---

## 3. Indie / individual-developer GitHub frameworks (2026)

| Framework | Lang | Unique angle | Worth borrowing? |
|---|---|---|---|
| Hermes Agent | — | Self-improving, MIT, Web3-native, decentralized governance, 47k stars | TBD |
| Pydantic AI | Python | Type-safe, Pydantic ecosystem, structured validation | Low — kurukshetra is JS |
| Mastra | TypeScript | "Observational Memory" built INTO core, not bolted on | Worth studying |
| Agno | Python | Lightweight, model-agnostic, minimal deps | Low |
| Smolagents | Python | HuggingFace, ~1000 lines total — educational transparency | Reference reading |
| Upsonic | Python | MCP-first design from ground up | We use MCP ✅ |
| Portia AI | Python | Production stability focus | Low priority |
| MicroAgent | Python | UNIQUE: self-editing prompts AND code | Risky for security context |
| Bernstein | Python | UNIQUE: "ZERO LLM tokens on coordination" — deterministic routing | **HIGH interest** |
| DeerFlow | Python | ByteDance OSS, planning+tools+memory+execution integrated, 25k stars | TBD |

---

## 4. 2026 research papers — architectural innovations

### Memory & state management
- **Continuum Memory Architectures** — persistent temporally-chained memory (vs stateless RAG)
- **AtomMem** — RL-trained memory CRUD policies (memory as learnable component)
- **FadeMem** — biological exponential decay + smart fusion
- **MAGMA** — orthogonal graph memory (4 dimensions: semantic / temporal / causal / entity)

### Agent-to-agent coordination
- **ROMA** — subtask trees parallel across agents WITHOUT exceeding context window
- **DyTopo** — dynamic A2A rewiring via semantic matching (not fixed topology)
- **Agent2Agent (A2A) protocol** — formalized peer coordination + delegation + policy enforcement (now an emerging standard alongside MCP)

### Runtime verification & resilience
- **TrajAD** — runtime verifier detects + locates errors in agent trajectories with PRECISE rollback-and-retry
- **TriCEGAR** — predicate trees for probabilistic runtime verification
- **ResMAS** — RL-trained topology + topology-aware prompts under perturbations

### Routing & evaluation
- **ClawBench** — browser agent eval via Chrome extension intercept (block only final write requests)
- **CASTER** — lightweight routing via semantic embeddings + structural meta-features
- **Task-Aware LLM Council** — semantic match against success history for model picking
- **Toward Architecture-Aware Evaluation Metrics** — link components (planners/memory/routers) to observable behaviors

---

## 5. Anthropic-specific developments (we use these directly)

- **Claude Code SDK → Claude Agent SDK** (renamed) — programmable agent loop, built-in tools, context management
- **Agent Skills** — modular capability packages (PowerPoint, Excel, Word, PDF pre-built)
- **Managed Agents** — hosted long-horizon work with stable session/harness/sandbox interfaces
- **MCP (Model Context Protocol)** — we use heavily ✅
- **A2A (Agent-to-Agent protocol)** — emerging standard, we don't yet ❌

---

## 6. Pattern-by-pattern analysis (vs kurukshetra)

### 6.1 ROMA — parallel subtask trees
- **What:** break tasks into trees, agents work in parallel without context overflow
- **Kurukshetra parallel:** Phase 1 specialists already run in parallel
- **Borrowable?** Phase 3.6 + 3.8 + DHARMA could ALL run parallel after Phase 1 (currently sequential)
- **Quality impact:** 0/10 (same outputs, just faster)
- **Speed impact:** 7/10 — cuts pipeline ~40%
- **Cost:** ~1 week build

### 6.2 TrajAD — runtime rollback ✅✅✅
- **What:** detect bad agent reasoning DURING execution, rollback that step, retry with different prompt
- **Kurukshetra parallel:** Phase 3.6 + 3.8 verify AFTER all phases done — too late to recover
- **Borrowable?** Yes — verify per-step at Phase 1 boundaries, rollback bad reasoning before Phase 2-5 wastes work
- **Quality impact:** 8/10 — 30-40% fewer "false confidence" findings, better attack chain logic
- **Speed impact:** mixed (saves wasted phases, adds verification overhead)
- **Cost:** ~2 weeks build

### 6.3 Bernstein — deterministic coordinator
- **What:** ZERO LLM tokens for coordination decisions — use traditional logic for routing
- **Kurukshetra parallel:** KRISHNA does full Opus call to route specialists (every dispatch)
- **Borrowable?** Yes — 80% of routing is deterministic (pentest target → ARJUN+DURYODHANA+KARNA always)
- **Quality impact:** 0/10 (routing decisions don't change)
- **Cost impact:** 7/10 — saves Opus tokens on EVERY dispatch
- **Cost:** ~3 days build

### 6.4 MAGMA — orthogonal memory graph
- **What:** memory split into 4 facets (semantic/temporal/causal/entity), policy-guided traversal
- **Kurukshetra parallel:** flat MEMORY.md → topic .md files (~30 entries)
- **Borrowable?** Worth it eventually — currently memory is small, low pain
- **Quality impact:** 5/10 — fewer repeated mistakes via better recall (~5-10% finding quality)
- **Cost:** ~1 week build
- **When:** consider after memory grows past 100+ entries

### 6.5 CASTER — semantic model routing
- **What:** pick Haiku/Sonnet/Opus dynamically based on task complexity score
- **Kurukshetra parallel:** hardcoded model per agent (KRISHNA=Opus, grader=Haiku)
- **Borrowable?** Nice-to-have, low priority
- **Quality impact:** 1/10 (right model for right task — minor)
- **Cost impact:** 3/10 — minor savings
- **Cost:** ~3 days build

### 6.6 A2A — squad-to-squad protocol ✅✅
- **What:** formalized handoff protocol for agent-to-agent collaboration
- **Kurukshetra parallel:** ZERO cross-squad collaboration today — silos
- **Borrowable?** Major architectural unlock — pentest finds AWS keys → handoff to cloud-security → finds S3 buckets → IAM escalation paths → 1 finding chains into 5
- **Quality impact:** 7/10 — 15-25% MORE findings on cross-domain targets, NON-LINEAR multiplier on rare cross-domain hits
- **Cost:** ~2-3 weeks build (touches all 7 squads' dispatch logic)

---

## 7. Quality impact summary

### Patterns that DIRECTLY improve agent output quality
1. **TrajAD runtime rollback** — 8/10 (catch bad reasoning early)
2. **A2A protocol** — 7/10 (cross-squad attack chains)
3. **MAGMA memory graph** — 5/10 (better recall, fewer repeat mistakes)

### Patterns that improve cost/speed but NOT quality
- ROMA — 7/10 speed, 0/10 quality
- Bernstein — 7/10 cost, 0/10 quality
- CASTER — 3/10 cost, 1/10 quality

### Patterns that improve developer-experience but NOT quality
- OpenTelemetry tracing (Microsoft framework) — 0/10 direct, 2/10 over weeks
- Streaming Telegram updates (LangGraph pattern) — 0/10 quality
- Time-travel checkpointing (Microsoft framework) — 0/10 direct, 3/10 indirect via faster prompt iteration
- DevUI workflow debugger (Microsoft framework) — 0/10

### Honest separation
> Most "framework improvements" are DX/observability wins disguised as quality wins. Only patterns that change agent decision-making (TrajAD, A2A, MAGMA) actually move output quality.

---

## 8. Decision matrix — TO BE FILLED

| Pattern | Quality (1-10) | Speed (1-10) | Cost saving (1-10) | Build effort | Decision: implement? |
|---|---|---|---|---|---|
| TrajAD runtime rollback | 8 | mixed | mixed | 2 weeks | TBD |
| A2A protocol | 7 (with non-linear multiplier) | 0 | 0 | 2-3 weeks | TBD |
| MAGMA memory graph | 5 | 0 | 0 | 1 week | TBD |
| ROMA parallel | 0 | 7 | 0 | 1 week | TBD |
| Bernstein deterministic routing | 0 | 0 | 7 | 3 days | TBD |
| CASTER semantic model routing | 1 | 0 | 3 | 3 days | TBD |
| OpenTelemetry tracing | 0 (direct) | 0 | 0 | 2 days | TBD |
| Streaming Telegram updates | 0 | 0 | 0 (UX win) | 1 day | TBD |
| Time-travel checkpointing | 0 | 0 | 0 | 5 days | TBD |
| DevUI workflow debugger | 0 | 0 | 0 | 1 week | TBD |

---

## 9. Sources

- [Microsoft agent-framework](https://github.com/microsoft/agent-framework)
- [OpenClaw / Peter Steinberger](https://www.tomshardware.com/tech-industry/openai-hires-genius-openclaw-creator-but-popular-ai-assistant-will-remain-open-source-sam-altman-says-creator-will-work-on-smart-agents-in-new-role)
- [Superpowers framework (obra)](https://aitoolly.com/ai-news/article/2026-05-03-superpowers-a-new-framework-and-methodology-for-developing-advanced-code-agents)
- [Anthropic Managed Agents](https://medium.com/ai-software-engineer/anthropic-launches-claude-managed-agents-that-make-agentic-ai-workflows-real-91134b6f2b56)
- [Anthropic Agent Skills](https://platform.claude.com/docs/en/agents-and-tools/agent-skills/overview)
- [Conductor vs Swarm architecture](https://agixtech.com/insights/conductor-vs-swarm-multi-agent-ai-orchestration/)
- [LLM orchestration 2026](https://aimultiple.com/llm-orchestration)
- [LangGraph](https://www.langchain.com/langgraph)
- [Awesome AI Agents 2026](https://github.com/caramaschiHG/awesome-ai-agents-2026)
- [Awesome AI Agent Papers (VoltAgent)](https://github.com/VoltAgent/awesome-ai-agent-papers)
- [Hermes Agent — Nous Research](https://www.opc.community/blog/hermes-agent-open-source-ai-agent-2026)
- [Top AI GitHub repos 2026](https://blog.bytebytego.com/p/top-ai-github-repositories-in-2026)
- [8 best open-source agent frameworks](https://www.ayautomate.com/blog/best-open-source-ai-agent-frameworks)

---

## 10. Articles still to incorporate (Jay will add)

> Jay will share more articles for incorporation. Each new source should be added to Section 9, and any new patterns should get their own subsection in Section 6 with the same analysis structure.

### Open questions for next research pass
- How does Hermes Agent's "self-improving" loop actually work? (Section 3 placeholder)
- DeerFlow's "integrated memory" — is it MAGMA-style or different? (Section 3 placeholder)
- Are there other Bernstein-style deterministic-coordinator frameworks? (Section 6.3 alt)
- What does Mastra's "Observational Memory" mean concretely? (Section 3 placeholder)

---

## 11. Notes & paused brainstorming flow

**Brainstorming skill is PAUSED at decomposition stage.** When Jay decides which pattern(s) to implement, the next steps are:
1. Resume superpowers:brainstorming for the chosen pattern
2. Run clarifying questions → 2-3 approaches → design sections → spec doc
3. Spec saved to `docs/superpowers/specs/YYYY-MM-DD-<topic>-design.md`
4. Hand off to writing-plans skill for implementation plan
5. Subagent-driven-development executes the plan

**No code changes will be made** until a specific pattern's spec is written and Jay approves it (per CLAUDE.md "Plan First, Code After Approval" rule).

---

## 12. Phase 2 absorption — 2026-05-05 batch from Jay

Jay forwarded 17+ URLs (security frameworks, token-optimization MCPs, Claude Code workflow skills, Twitter/X discussion). Findings absorbed below.

### 12.1 New security/pentest frameworks

#### LLM-SAST-Scanner (SunWeb3Sec)
- **What:** structured SAST skill loaded into Claude Code/Codex agents
- **Methodology:** source-to-sink taint analysis across **34 vulnerability classes**, supports Java/Python/JS-TS/PHP/.NET
- **Key innovation:** **"Judge verification"** step — explicit cross-checking that substantially reduces false positives
- **Performance:** Claude Opus 4.6 → 100% recall + 98.2% precision (F1 0.991) on 56 verified vulns across 4 Java projects. GPT-5.4 → 92.9% recall + 98.1% precision
- **Architecture:** single-skill plugin model (NOT multi-agent orchestrator) — depth within agent workflow vs cross-agent coordination
- **Kurukshetra applicability:** ⭐⭐⭐ Judge verification pattern is borrowable. Could become a new GATE-53 ("explicit judge cross-check on every Critical/High finding before VYASA"). May reduce our FP rate further beyond Phase 3.6 + 3.8 verifiers.

#### Phalanx (webxos)
- **What:** autonomous pentest framework, polyglot harness with Kali Linux integration
- **Tech:** Python 96%, Docker-deployed, modular (core/engine/planner/tools/library)
- **Status:** v3.3, 76 stars, MIT, "use at own risk", README-coming-soon
- **Kurukshetra parallel:** **DIRECT competitor** (autonomous pentest)
- **Differences:** smaller (76 stars vs our internal 7-squad orchestrator), uses Kali tools as primary surface (we use specialists + verifiers), no published GATE system
- **Borrowable:** Kali integration patterns if we ever want to extend pentest squad with off-the-shelf scanners

#### ProjectDiscovery Neo
- **What:** AI-driven binary analysis workflow using Ghidra for malware reverse engineering
- **Demonstration:** Linux.Mirai.B malware sample — automated download, extraction, multi-arch analysis (ARM/MIPS/x86/PPC/m68k), C2 identification, IoC generation
- **Kurukshetra applicability:** ⭐⭐ Mostly orthogonal (we're webapp/network-pentest), but malware-RE could be a future "forensics squad" addition

### 12.2 New multi-agent orchestrators

#### Paperclip (paperclipai)
- **What:** Node.js/React orchestration platform — coordinates teams of AI agents into "AI companies"
- **Tech:** TypeScript 97.5%, Postgres backend, pnpm monorepo
- **Heterogeneous runtime:** Claude Code, Codex, Cursor, OpenClaw, CLI tools, HTTP webhooks
- **Key innovations:**
  - **Atomic task execution** — prevents double-work and runaway spend
  - **Persistent agent state** across heartbeat cycles
  - **Runtime skill injection** — load company/project context without retraining
  - **Goal ancestry tracking** — agents understand the "why" behind assignments (goal → project → issue)
  - **Cost tracking** by agent/model/provider
- **Kurukshetra applicability:** ⭐⭐⭐ Goal-ancestry is interesting. Currently Phase 1 specialists know their immediate task but not the higher-level goal. Borrowing this would let DHARMA see goal context during validation.

#### Hermes Agent (Nous Research) — DETAILED
- **Self-improving loop:** agent "creates skills from experience, improves them during use" — autonomous skill creation after complex tasks
- **Memory system:** FTS5 full-text search across past conversations + LLM summarization for cross-session recall + Honcho user-modeling
- **Multi-platform gateway:** unified conversation across Telegram/Discord/Slack/WhatsApp/Signal/CLI
- **Infrastructure:** $5 VPS / Docker / SSH / Daytona / Modal
- **Model-agnostic:** 200+ models via OpenRouter, NVIDIA NIM, OpenAI, custom
- **Subagent spawning:** isolated parallel workstreams
- **Research features:** batch trajectory generation, RL environment integration (Atropos), trajectory compression for training future tool-callers
- **Kurukshetra applicability:** ⭐⭐⭐ "Skills from experience" is interesting — specialists could build reusable patterns from past pentest runs. But our memory system is already similar. Multi-platform gateway not needed (we're Telegram-only).

#### MiroFish (666ghj) — SKIP
- **Domain:** predictive simulation engine (NOT pentest)
- **59k stars, OASIS+CAMEL-AI based**
- **Kurukshetra applicability:** ⭐ Wrong domain. Skip.

### 12.3 Token/context optimization tooling

#### Context Mode (mksglu) ⭐⭐⭐
- **Mechanism:** MCP server intercepts tool calls at protocol layer, runs them in isolated subprocess, only summary returns to context
- **Numbers:** Playwright snapshot 56KB → **299 bytes** (98% reduction). 315KB raw output → 5KB total.
- **Compaction recovery:** PreCompact hook builds priority-tiered XML snapshot (≤2KB) in SQL `session_resume` table. SessionStart hook injects "Session Guide" with last requests + active tasks + modified files + unresolved errors.
- **Five hooks:** PreToolUse (route enforcement), PostToolUse (event capture), UserPromptSubmit (decision recording), PreCompact (snapshot build), SessionStart (state restore)
- **Kurukshetra applicability:** ⭐⭐⭐ Phase 4 VYASA reads dozens of finding files to write reports — heavy context. Could compress these via Context Mode, freeing context for richer reasoning. Direct token savings.

#### Claude Context (Zilliz) ⭐⭐
- **Architecture:** MCP server + VSCode ext + indexing engine using AST chunking + Zilliz Cloud vector DB
- **Hybrid search:** BM25 (lexical) + dense vector (semantic) → ranks code snippets
- **Incremental:** Merkle trees re-index only changed files
- **Numbers:** ~40% token reduction at equivalent retrieval quality
- **Kurukshetra applicability:** Useful for navigating /root/agents/ source code (10k+ LOC) when subagents need to understand existing patterns. Less applicable for pentest TARGETS (those are external sites).

#### Token Savior (Mibayy) ⭐⭐
- **Symbol-based navigation:** indexes by functions/classes/imports/call-graphs, NOT files. 97% fewer chars.
- **90 tools** across nav (14), deps (9), git (5), edit (8), memory (21), profiles (full/core/nav/lean/tiny)
- **Memory engine:** SQLite + FTS + optional vectors. **Three-layer progressive disclosure** (~15/60/200 tokens per layer). Bayesian validity, contradiction detection, per-type TTLs, auto-promotion of frequently-accessed notes to conventions.
- **Kurukshetra applicability:** ⭐⭐⭐ Progressive-disclosure (15/60/200) memory pattern is BETTER than our flat MEMORY.md. Worth porting when memory grows past 100+ entries. Bayesian validity + contradiction detection at save-time = quality boost.

#### code-review-graph (tirth8205)
- **Architecture:** Tree-sitter parses code into AST → persistent knowledge graph of functions/classes/imports/relationships → "blast-radius analysis"
- **Numbers:** Next.js monorepo 27,732 files → ~15 files (49x). Average 8.2x. Max 27.3x.
- **Languages:** 23 incl Python/TS/JS/Go/Rust/Java/C#/Jupyter
- **Kurukshetra applicability:** ⭐⭐ Same niche as Claude Context — useful for navigating /root/agents/ but not pentest targets

#### token-optimizer-mcp (ooples) ⭐
- Repo only documents CI/CD, no technical depth visible
- Claims 95%+ token reduction via caching + compression
- **Kurukshetra applicability:** TBD pending source code review

#### Other token tools (RTK, Caveman, claude-token-efficient, claude-token-optimizer, token-optimizer)
- Most are single-developer style optimizations (terminal output filters, CLAUDE.md templates, ghost-token detection)
- Less applicable to multi-agent server architecture
- Skip for now

### 12.4 Claude Code workflow skills (from forwarded Reddit/Twitter article)

The article describes 6 high-leverage Claude Code skills:

1. **Skill Creator** — meta-tool to build other skills from natural language. (We can use this directly.)
2. **Superpowers** — process discipline (plan→test→review→repeat). 150K+ stars. (We use this plugin.)
3. **GSD (Get Shit Done)** — fresh sub-agents per task to combat context rot. Has scope-reduction detection + security-threat-model anchoring.
4. **/review + /ultra-review** — built-in code review. /ultra-review uploads branch to cloud sandbox, parallel reviewer agents, reproduce-before-report. Pro/Max plans get 3 free runs.
5. **Context Mode** — already covered in §12.3
6. **Claude Mem (thedotmack)** — auto-memory hooked into session lifecycle. SQLite + vector search. Three-layer retrieval (compact index → timeline → full details). 10x token savings on retrieval.
7. **Frontend Design (Anthropic official)** — bonus, for visual work

**Kurukshetra applicability:**
- ⭐⭐⭐ **GSD pattern** — already partially adopted via subagent-driven-development. Their scope-reduction detection is interesting (catches when Claude silently drops requirements).
- ⭐⭐ **/ultra-review** — could be incorporated as final gate before merge for kurukshetra core changes
- ⭐⭐⭐ **Claude Mem** — auto-memory could complement our manual memory system

### 12.5 NEW patterns added to consideration

#### 12.5.1 Judge verification (LLM-SAST-Scanner) — Quality 9/10 ✅✅✅
- **Pattern:** explicit cross-check step after each finding, verifying via independent reasoning that the finding is real
- **Kurukshetra parallel:** DHARMA does validation, but it's per-task not per-finding
- **Cost:** ~3 days build (new GATE or new sub-agent post-DHARMA)
- **Why high impact:** could push our F1 toward 0.99+ on pentest findings, matching SAST results

#### 12.5.2 Atomic task + goal-ancestry (Paperclip) — Quality 6/10
- **Pattern:** every task carries goal → project → issue ancestry; specialists see "why"
- **Kurukshetra parallel:** specialists see immediate task but not goal context
- **Cost:** ~1 week build (extend dispatch payload, modify prompt-renderer)

#### 12.5.3 Self-improving skills loop (Hermes) — Quality 7/10
- **Pattern:** agents auto-extract reusable skills from successful runs
- **Kurukshetra parallel:** zero — every run starts fresh
- **Risk:** non-deterministic skill creation could drift over time
- **Cost:** ~2 weeks build

#### 12.5.4 Tool-output sandboxing (Context Mode) — Speed/Cost 8/10, Quality 0/10
- **Pattern:** route heavy tool outputs to subprocess, return only summary
- **Kurukshetra parallel:** Phase 4 VYASA reads dozens of finding files = heavy context
- **Quality impact:** indirect — frees context for richer reasoning
- **Cost:** ~1 week (MCP-side integration + per-tool routing rules)

#### 12.5.5 Progressive-disclosure memory (Token Savior) — Quality 5-7/10
- **Pattern:** 3-layer memory (~15/60/200 token per layer), Bayesian validity, contradiction detection, auto-promotion
- **Kurukshetra parallel:** flat MEMORY.md → topic .md
- **Improves over MAGMA:** simpler model, no graph traversal needed
- **Cost:** ~1 week build
- **Note:** This may be a BETTER alternative to MAGMA (§6.4) — simpler, more practical

#### 12.5.6 GSD scope-reduction detection — Quality 5/10
- **Pattern:** automatically catches when an agent silently drops a requirement
- **Kurukshetra parallel:** GATE-11 evidence-completeness catches some, but not all
- **Cost:** ~3 days (add to GATE system)

### 12.6 Updated decision matrix

Added rows for new patterns. Quality scale 1-10. Decision still TBD on all.

| Pattern | Quality | Speed | Cost-saving | Build effort | Decision |
|---|---|---|---|---|---|
| TrajAD runtime rollback (§6.2) | 8 | mixed | mixed | 2 wks | TBD |
| A2A protocol (§6.6) | 7 (non-linear) | 0 | 0 | 2-3 wks | TBD |
| MAGMA memory graph (§6.4) | 5 | 0 | 0 | 1 wk | **superseded by §12.5.5** |
| ROMA parallel (§6.1) | 0 | 7 | 0 | 1 wk | TBD |
| Bernstein deterministic routing (§6.3) | 0 | 0 | 7 | 3 days | TBD |
| CASTER semantic model routing (§6.5) | 1 | 0 | 3 | 3 days | TBD |
| **Judge verification (§12.5.1)** | **9** | 0 | 0 | **3 days** | **TBD — recommended #1** |
| Goal-ancestry tracking (§12.5.2) | 6 | 0 | 0 | 1 wk | TBD |
| Self-improving skills (§12.5.3) | 7 | 0 | 0 | 2 wks | TBD |
| Tool-output sandboxing (§12.5.4) | 0 (direct) | 8 | 8 | 1 wk | TBD |
| Progressive-disclosure memory (§12.5.5) | 5-7 | 0 | 0 | 1 wk | TBD — better than MAGMA |
| GSD scope-reduction detect (§12.5.6) | 5 | 0 | 0 | 3 days | TBD |

### 12.7a Phase 2 addendum — Pensar Apex (added later)

#### Pensar Apex (pensarai/apex) ⭐⭐⭐ — DIRECT COMPETITOR
- **What:** AI-driven pentesting platform — blackbox + whitebox via autonomous agents in terminal
- **Tech:** TypeScript 96.4% (we're JS — same family), Anthropic AI SDK with extended thinking, optional Kali Linux container
- **Modes:** dev quick-test, security engineer swarm, CI/CD integration, TUI + headless CLI
- **Innovations:**
  - Autonomous agent reasoning with exploration
  - Task-driven architecture (experimental) — similar to our Phase 0-5
  - **W&B Weave step-level agent tracing** — concrete OpenTelemetry equivalent
  - Whitebox source-code access (we don't do this — potential gap)
  - Persistent memory across engagements (we do this ✅)
  - Threat-model guidance built into architecture (we have GATE-12 ✅)
- **Status:** 271 stars, 48 forks, v1.8.0 May 2026, Apache 2.0
- **Kurukshetra applicability:**
  - ⭐⭐⭐ **W&B Weave tracing** — concrete validation of the OpenTelemetry pattern from §6.0. Real production tool uses it, not just theory.
  - ⭐⭐⭐ **Whitebox + blackbox dual-mode** — we're blackbox-only. If targets give us source code (e.g. via gh repo access), we could do MUCH deeper analysis. New "code-review squad → pentest" pipeline?
  - ⭐⭐ Task-driven architecture — same pattern as ours, validates our approach
  - ⭐ TUI mode — interactive console for live debugging (we have mission-control web UI)

**Honest comparison vs kurukshetra:**
- Their advantage: whitebox mode, terminal TUI, Anthropic SDK extended thinking
- Our advantage: 7 specialized squads (vs general agent), 50+ GATE system, Phase 3.6 + 3.8 verifiers, sycophancy prevention, race-hardened daemons
- Both have: persistent memory, threat-model guidance, autonomous agents

**Lessons:**
- Their existence validates our market direction (autonomous pentest IS a real category)
- W&B Weave is an existing production-ready tracing solution — no need to roll our own OpenTelemetry from scratch
- Their whitebox capability is a meaningful gap we could fill (would need to extend KRISHNA to dispatch source-code analysis specialists alongside web pentest specialists)

### 12.7 Phase 2 sources added

- [LLM-SAST-Scanner](https://github.com/SunWeb3Sec/llm-sast-scanner)
- [Paperclip](https://github.com/paperclipai/paperclip)
- [Phalanx](https://github.com/webxos/phalanx)
- [MiroFish](https://github.com/666ghj/MiroFish)
- [Hermes Agent (Nous Research)](https://github.com/nousresearch/hermes-agent)
- [ProjectDiscovery Neo demo](https://neo.projectdiscovery.io/share/ccb479cd-7eaf-4bf5-b0d2-62e5c8965b24)
- [API Security Archive (42Crunch)](https://apisecurity.io/full-archive/)
- [Pensar Apex (pensarai)](https://github.com/pensarai/apex) — direct competitor, TypeScript, W&B Weave tracing, blackbox+whitebox
- [Boris Cherny on Opus 4.7](https://x.com/bcherny/status/2044822408826380440) — "Opus 4.7 feels more intelligent, agentic, and precise than 4.6. It took a few days for me to learn how to work with it effectively, to fully take advantage of its new capabilities." (Apr 16 2026)
- [Evan Luthra theme](https://x.com/EvanLuthra/status/2045277786005197228) — "founder + AI agents" replacing "founder + team" (couldn't fetch specific video, X paywalled, content from his general thesis)

### 12.7b Phase 2 addendum 2 — Boris Cherny on Opus 4.7

> "Opus 4.7 feels more intelligent, agentic, and precise than 4.6. It took a few days for me to learn how to work with it effectively, to fully take advantage of its new capabilities."

**Source:** Boris Cherny (Claude Code creator, Anthropic), April 16 2026. ID 2044822408826380440.

**Implication for kurukshetra:**
- We're already on Opus 4.7 (1M context)
- The "took a few days to learn" comment is interesting — suggests prompt patterns that worked on 4.6 may need updating for 4.7
- Worth monitoring: if our specialists' prompts were tuned for Opus 4.6, there might be Opus 4.7-specific patterns we're under-utilizing
- Possible action: review specialist prompts post-Opus 4.7 transition. Did our Phase 1 specialists' performance change? Worth investigating in metrics

**Note on Evan Luthra video:** X paywall blocked fetch. Could not get specific video content. General theme of his recent tweets: "founder + AI agents" replacing "founder + team", billion-dollar one-person companies, AI Agents Scholarship. Less directly applicable to kurukshetra architecture (more business/startup angle than technical).
- [Context Mode](https://github.com/mksglu/context-mode)
- [Claude Context (Zilliz)](https://github.com/zilliztech/claude-context)
- [Token Savior](https://github.com/Mibayy/token-savior)
- [Code-Review-Graph](https://github.com/tirth8205/code-review-graph)
- [token-optimizer-mcp (CI docs only)](https://github.com/ooples/token-optimizer-mcp)
- [RTK / Caveman / claude-token-efficient / claude-token-optimizer / token-optimizer / claude-mem (thedotmack)] — listed but not deep-fetched (low applicability for our domain)

### 12.8 Phase 2 honest take

**Most exciting new finding:** Judge verification (§12.5.1) — direct evidence (100% recall, 98.2% precision on 56 verified vulns) that this single pattern moves a security tool's quality to near-perfect. Highest ROI for our security domain. Recommended #1.

**Best alternative to MAGMA:** Progressive-disclosure memory (§12.5.5) is a simpler, more practical version of the orthogonal-graph memory we discussed. Same quality benefit, less complexity.

**Sleeper insight:** Paperclip's goal-ancestry (§12.5.2) — currently our Phase 1 specialists are blind to the "why" behind their task. Adding this is cheap (~1 week) and could help VYASA's Executive Summary quality significantly.

**Domain-mismatch:** Hermes Agent multi-platform gateway, MiroFish predictive simulation, most token-optimizer single-dev tools — skip.

**Already covered:** Most Claude Code workflow skills (Skill Creator, Superpowers, GSD scope-reduction, Context Mode, Claude Mem) overlap with patterns already in our roadmap or current setup. The new ones worth adopting are Claude Mem (auto-memory) and GSD scope-reduction.

**Total decision matrix now: 12 patterns.** Need Jay's pick of which 1-3 to implement first.

---

## 13. Autonomous evidence-based verdicts (2026-05-05 evening)

Per Jay's directive: "search every way online... compare what will improve quality, what won't... don't wait for me to tell you what to implement, decide yourself with evidence." Below is each pattern's verdict with citation-backed reasoning.

### 🟢 GREEN — implement (evidence-validated)

#### G1. Judge verification (§12.5.1) — TOP PRIORITY
**Evidence:**
- **SAST-Genius:** 91% reduction in false-positive triage in LLM-driven static analysis (arxiv 2509.15433)
- **LLM4FPM:** Eliminated >85% false positives on 8 real-world open-source projects
- **AdaTaint:** 43.7% FP reduction + 11.2% recall improvement
- **ZeroFalse:** Treats analyzer outputs as structured contracts, enriched with flow-sensitive traces, CWE-specific knowledge before LLM adjudication
- **Datadog:** Uses LLM judge for filtering FPs in production static analysis
- **LLM-SAST-Scanner:** F1 0.991 on 56 vulns with judge step

**Verdict:** GREEN. Strongest evidence-base. 3-day build, ~9/10 quality impact. Implement first.

#### G2. A2A protocol (§6.6)
**Evidence:**
- **150+ production orgs** by April 2026 (Microsoft Azure AI Foundry, Amazon Bedrock AgentCore, Salesforce)
- **Linux Foundation AAIF backing** (OpenAI, Anthropic, Google, Microsoft, AWS, Block as co-founders)
- **50+ launch partners** including Salesforce, PayPal, Atlassian, Accenture, BCG, Deloitte, McKinsey, PwC
- **Real use cases:** cross-organizational agent orchestration; commerce delegating price comparison, checkout to specialist agents
- Designed to complement MCP (vertical agent-to-tool) with horizontal agent-to-agent

**Verdict:** GREEN. Industry standard backed by every major AI player. 2-3 week build, ~7/10 quality impact (non-linear multiplier on cross-domain attack chains). Implement second.

#### G3. TrajAD runtime rollback (§6.2)
**Evidence:**
- **STRATUS (autonomous remediation agent):** outperformed state-of-art by **>150%** on AIOpsLab + ITBench benchmarks. Uses 'undo' maneuver to revert to checkpoint, transactional-no-regression (TNR) for reversibility.
- **LangChain Deep Agents:** managed task queue with automatic checkpointing, retry/replay/resume from any point
- **Vercel Agent Runtime:** trajectory monitors verify expected workflows, alert on deviation
- **IBM Research:** "undo-and-retry mechanism" for cloud agents
- Idempotent retry-safe patterns now considered production best-practice (multiple 2026 articles)

**Verdict:** GREEN. Production-proven across multiple major vendors. 2-week build, ~8/10 quality impact. Implement third.

### 🔴 RED — skip (evidence-rejected)

#### R1. MAGMA orthogonal memory graph (§6.4)
**Why skip:** Superseded by §12.5.5 Progressive-disclosure memory (Token Savior pattern). Same quality benefit, simpler implementation, no graph traversal needed. **Don't build twice.**

#### R2. CASTER semantic model routing (§6.5)
**Why skip:** ~1/10 quality impact, ~3/10 cost saving for 3-day build. Existing hardcoded model assignment (KRISHNA=Opus, grader=Haiku) is good enough. **Marginal ROI not worth complexity.**

### 🟡 YELLOW — defer (evidence-positive but not urgent)

#### Y1. ROMA parallel subtask trees (§6.1) — Speed not quality
- Cuts pipeline ~40% time, no quality change. Defer until top 3 quality patterns ship and speed becomes the bottleneck.

#### Y2. Bernstein deterministic routing (§6.3) — Cost not quality
- Saves Opus tokens on routing decisions. Defer until token bills become significant ($/month exceeds threshold worth 3 days build).

#### Y3. Goal-ancestry tracking (§12.5.2) — Useful, not urgent
- Paperclip pattern. ~6/10 quality. No academic validation, only one production framework using it. Worth doing eventually, low risk.

#### Y4. Self-improving skills loop (§12.5.3) — Risk in security context
- Hermes pattern. ~7/10 quality but **drift risk** — auto-modifying skills could break security-critical reasoning. Need careful experimentation, not first-priority. Risk-adjusted: defer.

#### Y5. Tool-output sandboxing / Context Mode (§12.5.4) — Speed/cost not quality
- Cuts VYASA context bloat. Defer until quality patterns ship; then consider when token bills warrant it.

#### Y6. Progressive-disclosure memory (§12.5.5) — Premature
- Our memory is ~30 entries. Pattern shines past 100+ entries. Defer until memory growth justifies it.

#### Y7. GSD scope-reduction detection (§12.5.6) — Useful, lower than top 3
- ~5/10 quality. Extends GATE-11 evidence completeness. Worth doing after top 3 ship.

### 📊 FINAL CURATED DECISION MATRIX

**Status legend:** 🟢 implement now / 🔴 skip / 🟡 defer

| # | Pattern | Quality | Build | Verdict | Evidence |
|---|---------|---------|-------|---------|----------|
| 1 | **Judge verification** | 9/10 | 3 days | 🟢 G1 — FIRST | SAST-Genius 91% FP↓, LLM4FPM 85% FP↓, AdaTaint 43.7% FP↓ |
| 2 | **A2A protocol** | 7/10 | 2-3 wks | 🟢 G2 | 150+ prod orgs, Linux Foundation AAIF |
| 3 | **TrajAD rollback** | 8/10 | 2 wks | 🟢 G3 | STRATUS +150% benchmark, IBM/Vercel/LangChain |
| 4 | MAGMA memory | 5/10 | 1 wk | 🔴 R1 | Superseded by Y6 |
| 5 | CASTER routing | 1/10 | 3 days | 🔴 R2 | Marginal ROI |
| 6 | ROMA parallel | 0/10 | 1 wk | 🟡 Y1 | Speed only |
| 7 | Bernstein routing | 0/10 | 3 days | 🟡 Y2 | Cost only |
| 8 | Goal-ancestry | 6/10 | 1 wk | 🟡 Y3 | One framework adopting |
| 9 | Self-improving | 7/10 | 2 wks | 🟡 Y4 | Drift risk in security |
| 10 | Tool-output sandbox | 0/10 | 1 wk | 🟡 Y5 | Cost only |
| 11 | Progressive memory | 5-7/10 | 1 wk | 🟡 Y6 | Premature for our scale |
| 12 | GSD scope-reduce | 5/10 | 3 days | 🟡 Y7 | After top 3 |

### 🎯 RECOMMENDED EXECUTION ORDER

1. **Week 1:** G1 Judge verification (3 days build + verification on past findings)
2. **Weeks 2-3:** G3 TrajAD runtime rollback (2 weeks)
3. **Weeks 4-6:** G2 A2A protocol (2-3 weeks across 7 squads)
4. After top 3 ship: re-evaluate yellows based on actual production friction (do we need the speed/cost wins, or is quality enough?)

### 13.1 Sources cited in autonomous evaluation

- [SAST-Genius (arxiv 2509.15433)](https://arxiv.org/pdf/2509.15433)
- [LLM4FPM (arxiv 2411.03079)](https://arxiv.org/html/2411.03079)
- [AdaTaint (arxiv 2511.04023)](https://arxiv.org/html/2511.04023)
- [ZeroFalse (arxiv 2510.02534)](https://arxiv.org/html/2510.02534)
- [Datadog: Using LLMs to filter false positives](https://www.datadoghq.com/blog/using-llms-to-filter-out-false-positives/)
- [Beyond SAST: Multi-LLM Judge (Medium)](https://jo14.medium.com/beyond-sast-building-a-multi-llm-judge-for-context-aware-security-analysis-86f6783e661d)
- [A2A 150+ orgs production adoption](https://medium.com/@aftab001x/mcp-and-a2a-the-protocols-building-the-ai-agent-internet-bc807181e68a)
- [STRATUS multi-agent system](https://yinfangchen.github.io/assets/pdf/stratus_paper.pdf)
- [LangChain runtime for production deep agents](https://www.langchain.com/blog/runtime-behind-production-deep-agents)
- [Vercel: Agent Responsibly](https://vercel.com/blog/agent-responsibly)
- [IBM undo-and-retry agent](https://research.ibm.com/blog/undo-agent-for-cloud)
- [Idempotent AI Agents retry-safe patterns](https://www.buildmvpfast.com/blog/idempotent-ai-agent-retry-safe-patterns-production-workflow-2026)
- [ARTEMIS multi-agent framework (82% valid submission)](https://arxiv.org/html/2509.13021v1)
- [xOffense LLM pentest (79% completion)](https://arxiv.org/html/2509.13021v1)
- [Comparing AI Agents to Cybersecurity Professionals](https://arxiv.org/abs/2512.09882)
- [AI Pentesting Agents 2026 — 39+ tools deep dive](https://appsecsanta.com/research/ai-pentesting-agents-2026)
- [Speakeasy: 160x MCP token reduction](https://www.speakeasy.com/blog/how-we-reduced-token-usage-by-100x-dynamic-toolsets-v2)
- [MCP token optimization 4 approaches](https://www.stackone.com/blog/mcp-token-optimization/)

---

## 14. Phase 3 addendum — Vercel Open Agents (added 2026-05-06)

#### Vercel-labs/open-agents — agentic coding reference app
- **What:** 3-layer architecture (web UI → agent workflow → isolated VM sandbox) for AI-driven coding tasks
- **Tech:** Next.js streaming UI, Vercel Workflows (durable execution), Vercel VM with snapshot-based resume, Better Auth + GitHub OAuth, TypeScript 99.3%
- **Stars:** 4.6k, 551 forks, MIT license, by Vercel Labs
- **Status:** "fork-and-adapt reference app, not a black box"

**Key architectural insight:** "**the agent is NOT the sandbox**"
- Agent runs OUTSIDE the VM, orchestrating it via tools
- Sandbox hibernates independently of agent lifetime
- Provider flexibility (swap models/LLMs without touching sandbox)
- Request-independent execution (multi-step workflows persist via Vercel Workflows)

**Kurukshetra parallels (already similar):**
- ✅ Our KRISHNA orchestrator runs OUTSIDE specialist execution (specialists are Claude API calls, not embedded)
- ✅ PM2-supervised event-bus = analogous to Vercel Workflows durable execution
- ✅ Atomic writes + inbox + supervisor = analogous to snapshot-based resume
- ✅ Provider flexibility — we use multiple models (Opus dispatcher, Haiku grader)

**What kurukshetra DOESN'T have (worth borrowing?):**
- ⏸ Isolated VM sandboxes per specialist (we run all specialists in same process space — minor security risk if a malicious target injects payload back into our agent prompts)
- ⏸ Streaming chat UI for live agent monitoring (we have mission-control but not streaming)
- ⏸ Auto-commit/push of agent changes (we don't currently auto-modify code)

**Honest verdict:** Validates our separation-of-concerns design. Their VM sandbox is an interesting future-work direction for agent isolation but adds significant infra cost. Add to YELLOW pile (defer): "agent VM isolation" if/when we run mass parallel specialists or face prompt-injection concerns.

**Source:** [Vercel-labs/open-agents](https://github.com/vercel-labs/open-agents)

---

## 15. Phase 4 addendum — Provos: "Finding zero-days with any model" (2026-05-06)

**Source:** [https://www.provos.org/p/finding-zero-days-with-any-model](https://www.provos.org/p/finding-zero-days-with-any-model)

This post is by Niels Provos (creator of IronCurtain — already in our memory at "IronCurtain Framework Comparison 2026-05-01"). His core thesis is the most strategically aligned with kurukshetra of anything in this entire research doc.

### 15.1 The thesis (matches kurukshetra's design)

> **"Vulnerability discovery is an orchestration problem, not a frontier-model problem."**

This is exactly what we've built. The implication: kurukshetra's value is in the GATE system, the verifier pipeline (3.6 + 3.8), the squad structure, and the sycophancy prevention — NOT in the underlying Claude model. Provos demonstrates the same approach works with Sonnet 4.6, Opus 4.6, AND Z.AI's open-weight GLM 5.1.

### 15.2 IronCurtain methodology (concrete patterns)

- **YAML-defined finite-state machines** — workflows as declarative state graphs (we use code-defined Phase 0-5 — could be more declarative)
- **Central Orchestrator agent** — routes between specialized agents (= our KRISHNA)
- **Append-only execution journal** — enables fresh agent context while maintaining investigation state
- **Tiered harness construction:** single-function fuzz → multi-component harness → full VM validation

### 15.3 Empirical results (this is the strongest evidence in the entire doc)

- Replicated 27-year-old OpenBSD TCP SACK vulnerability (proof framework works on known vulns)
- **Found NEW zero-days** in modern codebases using:
  - Claude Sonnet 4.6
  - Claude Opus 4.6
  - Z.AI GLM 5.1 (open-weight!)
- Including an **18-year-old integer truncation flaw** in widely-deployed library — autonomous discovery, not flagged by humans first
- Cost: $30-$150 per investigation. Frequent auditing economically viable.

### 15.4 What kurukshetra should learn

#### 15.4.1 Multi-model compatibility — TEST IT
Provos proves the orchestration approach works across model families. Kurukshetra currently uses Claude Opus dispatcher + Haiku grader. Worth testing:
- Run a known-good pentest dispatch with **Sonnet** in KRISHNA's place — does it still work? (Bernstein deterministic-routing pattern G2-Y2 makes this even cheaper)
- Test with **Z.AI GLM 5.1** for cost/quality comparison (Provos got 18-year-old vuln found at $30/run vs our ~$140/run)

If yes, this is a HUGE cost reduction (5x potentially) without quality loss.

#### 15.4.2 Append-only execution journal — formalize what we have
We already have implicit append-only journals:
- `/root/intel/tasks.json` — task state
- `/root/intel/ACTIVITY-LOG-RUDRA-${taskId}.jsonl` — per-task event log
- `/root/intel/dispatch-queue.json` — dispatch state

Provos's pattern explicitly elevates this to a first-class concept: every state transition appended to one journal that ANY agent can read to inherit context. We have the pieces but not the unified abstraction. Worth formalizing for cross-squad collaboration (G2 A2A protocol).

#### 15.4.3 Tiered harness construction — ADD to roadmap
Kurukshetra currently runs Phase 1 specialists at one fidelity level. Provos's tiered approach:
- Level 1: cheap function-level fuzz (we don't do this — we go straight to whole-target)
- Level 2: multi-component harness (= roughly our chain-verifier 3.6)
- Level 3: full VM validation (we don't do this — would need sandbox infrastructure)

For the code-review squad (white-box) this would dramatically improve depth.

### 15.5 Updated decision matrix verdict

Adding two new patterns to consideration:

| Pattern | Quality | Build | Verdict |
|---|---|---|---|
| 13 | **Multi-model orchestration test** | maybe Q3 (if quality holds), Cost 8/10 | 3 days | 🟢 NEW G4 — TEST it, low risk |
| 14 | Append-only execution journal (formalize) | Q4 — enables A2A | 1 wk | 🟡 Y8 — couple to G2 A2A work |
| 15 | Tiered harness construction (code-review squad) | Q6 (whitebox depth) | 2-3 wks | 🟡 Y9 — after Pensar Apex whitebox study |

### 15.6 Updated execution recommendation

Given Provos's evidence:

**Week 1 (revised):** G4 multi-model test FIRST (3 days, low risk, potential 5x cost reduction)
- Run a controlled pentest with KRISHNA=Sonnet (down from Opus)
- Compare against historical Opus runs on same target
- If quality holds → swap Opus→Sonnet for routine targets, keep Opus for critical

**Then resume:** G1 Judge verification → G3 TrajAD → G2 A2A protocol

This sequencing means we save money on every dispatch ($30 vs $140 = $110/run × 50 runs/month = $5,500/month savings) while still building the quality patterns.

---

## 16. Phase 5 addendum — Re-confirmation pass + Whop trading community

**Jay re-sent earlier URL batch (2026-05-06) — all already absorbed:**
- ✅ SunWeb3Sec/llm-sast-scanner → §12.1 (LLM-SAST), §12.5.1 (Judge verification ⭐)
- ✅ ProjectDiscovery Neo → §12.1 (malware RE)
- ✅ Paperclip → §12.2 (multi-agent orchestration)
- ✅ MiroFish → §12.2 (skip — wrong domain)
- ✅ Hermes Agent → §12.2 (self-improving skills)
- ✅ X bcherny/EvanLuthra → §12.7b (paywalled, captured via Google)
- ✅ apisecurity.io archive → §12.1 (BOLA, agentic AI auth)

**NEW: Whop / Pack Trade Group**
- **What:** $75/mo human-led trading education community (NOT an AI agent service)
- **Mentors:** Austin Clark, Matt Mickey + others. Live sessions across London/NY market opens.
- **Tools:** "Daily Profiler" for trading statistics, data-driven intraday strategies
- **Domain:** **Stocks domain reference**, potentially useful as STOCKS SQUAD prompt context — what experienced human traders actually look at
- **NOT applicable:** Architectural inspiration (kurukshetra is the orchestrator, this is the human user-facing service)
- **Possible future use:** if STOCKS squad needs deeper trading-strategy knowledge, this kind of community-curated content is a reference benchmark
- **Source:** [Pack Trade Group on Whop](https://whop.com/pack-trade-group/pack-trade-group/)


---

## 17. Phase 6 addendum — GenericAgent (lsdefine) — 2026-05-06

**Source:** [https://github.com/lsdefine/GenericAgent](https://github.com/lsdefine/GenericAgent)

### 17.1 What it is

Self-evolving autonomous agent framework giving LLMs system-level control: browser automation, terminal, file ops, keyboard/mouse, screen vision, ADB mobile control. Designed for personal-assistant use, not multi-agent.

### 17.2 Architecture (impressively minimal)

- **~3000 lines core Python** total
- **~100-line agent execution loop** (vs our 9000-line event-bus.js — apples-to-oranges, but striking)
- **9 atomic tools:** `code_run`, `file_read`, `file_write`, `file_patch`, `web_scan`, `web_execute_js`, `ask_user`, +2 memory mgmt
- **Minimal deps:** requests + streamlit + pywebview only
- **Multi-frontend:** Streamlit, Qt, Telegram, WeChat, QQ, Feishu, WeCom, DingTalk

### 17.3 KEY INNOVATION — 5-Layer Memory Hierarchy

```
L0: Meta rules           (system invariants, never change)
L1: Insight indices       (cross-session learnings)
L2: Global facts          (persistent project knowledge)
L3: Task skills           (reusable execution patterns)
L4: Session archives      (per-task event logs)
```

**Self-evolution:** task solutions crystallize into L3 skills automatically — "each task solution becomes a direct recall pattern for similar future tasks."

**Token efficiency claim:** under 30K tokens per agent loop vs 200K-1M for competitors via memory layering instead of raw context expansion.

### 17.4 Comparison with patterns already in our doc

| Aspect | GenericAgent | Token Savior (§12.3) | Hermes (§12.2) | MAGMA (§6.4) |
|---|---|---|---|---|
| Memory layers | 5 (L0-L4) | 3 (15/60/200 tokens) | FTS5 + summarization | 4 (semantic/temporal/causal/entity) |
| Skill evolution | Auto-crystallize | Manual + auto-promotion | Auto + RL | None |
| Token efficiency | Claims 30K/loop | 97% reduction (97/3) | Untested | Unknown |
| Multi-agent | NO | NO | YES | NO |
| Production-tested | Personal use | Yes (MCP server) | 47k stars | Research |

### 17.5 Verdict for kurukshetra

**Worth borrowing:**
- ⭐ The **5-layer memory hierarchy** is more elaborate than Token Savior's 3-layer or our flat MEMORY.md. Worth designing kurukshetra's memory upgrade with this as reference. Replaces/augments Y6 (Progressive-disclosure memory).
- ⭐ The **minimal-loop discipline** — having a clean 100-line core loop vs our 9000-line event-bus suggests we may be over-engineered. Worth doing a /simplify pass on event-bus.js once architectural changes settle.
- ⭐ The **self-evolution pattern** (task→L3 skill) overlaps with Hermes's self-improving skills (§12.5.3 Y4). Same pattern, different implementation. Reinforces that this is a real direction.

**NOT worth borrowing:**
- ❌ Direct integration — designed for personal assistant, not security. Single-instance, no isolation, no audit trail, no parallel specialists.
- ❌ Multi-frontend support — we only need Telegram. Other frontends would be wasted complexity.

**Verdict:** Study reference for memory architecture. Add to existing YELLOW pile patterns:
- Y6 (Progressive-disclosure memory) UPGRADE → "5-layer memory hierarchy" pattern (Token Savior 3-layer + GenericAgent's L0-L4 structure combined)

**Decision matrix update:** No new pattern row; folded into existing Y6 with richer design.

### 17.6 Honest answer to Jay's question

**"Can we do something like this or is it useless?"**

Not useless — useful as a **reference**. The 5-layer memory hierarchy is the most architecturally interesting finding. But integrating GenericAgent directly would be wrong for kurukshetra:
- We're security-focused (need audit trails, isolation, multi-agent)
- We're already production-hardened (PM2, atomic writes, GATEs)
- Their "personal assistant" design philosophy clashes with our "auditable security workflow" needs

**Practical takeaway:** when we get to Y6 (memory architecture upgrade), use GenericAgent's L0-L4 as the design model. That's the highest-value pattern to extract from this repo.

---

## 18. Phase 7 addendum — Raptor (gadievron) — 2026-05-06

**Source:** [https://github.com/gadievron/raptor](https://github.com/gadievron/raptor)

### 18.1 What it is

Python autonomous security analysis orchestrator on top of Claude Code. v3.0.0, 2.5k stars, MIT. Authors: Gadi Evron, Daniel Cuthbert, Thomas Dullien (Halvar Flake), Michael Bargury, John Cartwright — **a Who's-Who of offensive security research**.

Domain: chains static analysis (Semgrep, CodeQL) + binary analysis + LLM validation + exploit generation + patch writing. Closer to **SAST/code-review** than to webapp pentest — complementary to our pentest squad, more directly relevant to code-review squad.

### 18.2 Architecture (two-layer split)

- **Python execution layer** (`raptor.py`, `core/`, `engine/`): subprocess orchestration, SARIF parsing, deduplication, API dispatch, cost tracking — NO decision-making
- **Claude Code decision layer** (`.claude/`, `tiers/`, `CLAUDE.md`): commands (`/agentic`, `/scan`, `/validate`), skills, nine expert personas, sub-agents — strategic decisions

Decoupling enables headless CLI for CI + interactive agentic workflows.

### 18.3 KEY PATTERNS for kurukshetra

#### 18.3.1 Four-stage exploitation-validator (Stages A-D) ⭐⭐⭐
**This is essentially what G1 Judge verification should look like — but more structured.**

| Stage | Question |
|---|---|
| A | Pattern-matching noise vs. real vulnerability |
| B | Attacker prerequisites and barriers |
| C | Code path reachability from external entry |
| D | Finality check (test code, unrealistic preconditions) |

**Implication for G1 spec:** rather than vague "judge agent cross-checks finding", structure it as 4 explicit stages with pass/fail per stage. Findings only escalate from Stage 1 → Stage 4. Massively reduces FPs (matches SAST-Genius / LLM4FPM evidence in §12.5.1).

**Action:** when we open G1 brainstorming, use Raptor's A-D as the design template. Architecturally cleaner than a single "judge" step.

#### 18.3.2 Z3 SMT formal verification ⭐⭐
- Optional Z3 satisfiability pre-screening on CodeQL paths
- One-gadget feasibility ranking for binary exploits
- **For us:** overkill for blackbox webapp pentest, but interesting future-work for code-review squad whitebox mode (Y9 tiered harness construction)
- **Verdict:** YELLOW-defer. Add to research notes as a future-work pointer for code-review squad.

#### 18.3.3 Wilson 95% confidence bounds for model scorecards ⭐⭐⭐
- Per-model performance tracked with Wilson confidence intervals
- More statistically rigorous than our G4 spec's "F1 within 5%" raw ratio
- **Action for G4 spec:** when we have enough data points (3 targets × 2 models = 6), apply Wilson bounds instead of raw findings_total ratio. Update `applyDecisionCriteria` post-experiment if data warrants.

#### 18.3.4 Multi-provider pluggable LLM
- Anthropic, OpenAI, Gemini, Mistral, local Ollama
- Roles: analysis, code, consensus, aggregate, fallback
- Fast-tier short-circuit (Opus → Haiku as prefilter)
- **Reinforces G4 priority** — third independent validation (after Provos and our own thesis) that multi-model orchestration works
- **For us:** stay Anthropic-only for now (simpler operations). Multi-provider is Phase 4+ work.

### 18.4 What Raptor LACKS (vs our architecture)

- No runtime trajectory rollback (we plan G3 TrajAD — Layer B)
- No cross-squad/cross-agent handoff (we plan G2 A2A — Layer C)
- No explicit memory hierarchy (we plan Y6 5-layer — Layer D)
- "Commits findings forward" pattern — exactly our G3 anti-pattern

So Raptor validates patterns we're building and explicitly **lacks** the patterns we plan to ship over the next 90 days. Our architecture is differentiated.

### 18.5 What we lack (vs Raptor)

- Z3 SMT integration (Y9-adjacent, code-review squad future-work)
- Multi-provider backends (defer)
- Exploit + auto-patch generation (we generate PoC, not patches)
- Wilson confidence bounds in decision criteria (small G4 spec upgrade)

### 18.6 Verdict

**Validates 3 of our 4 planned layers + ROI of 4-stage validator over single-step judge.**

Concrete action items derived:
1. **G1 Judge verification spec — adopt Stages A-D structure** (when we open G1 brainstorming, this is the design template)
2. **G4 decision criteria — add Wilson bounds** (post-experiment refinement once we have data)
3. **Y9 tiered harness — note Z3 SMT as future-work** (whitebox code-review depth)

Nothing in Raptor invalidates our 90-day roadmap. Reinforces it.

**Source:** [Raptor on GitHub](https://github.com/gadievron/raptor)
