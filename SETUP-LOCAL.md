# Local Development Setup

ARCHON was written for a server deployment at `/root/agents` (code) + `/root/intel`
(data). This guide gets it running **as a normal user, anywhere on disk** — so you can
develop and build on it without `sudo` or `/root` access.

The mechanism: the two deployment roots are now **env-overridable** (defaults unchanged,
so a real `/root` deploy is byte-identical to before). `paths.js` autoloads `.env.local`,
making the daemon, the gate suite, and any spawned `node` subprocess pick up your local
paths automatically.

## One-time setup

```bash
npm install                       # deps: claude-agent-sdk, acorn (+ optional playwright)
cp .env.local.example .env.local  # then edit the three paths inside
npm run setup                     # scaffold + seed the local data layer (var/intel)
```

`.env.local` (gitignored) defines three things:

| Var | Default (prod) | Local value |
|---|---|---|
| `KURU_AGENTS_ROOT` | `/root/agents` | the repo dir (where `event-bus.js` lives) |
| `KURU_INTEL_ROOT`  | `/root/intel`  | `<repo>/var/intel` — the data layer (gitignored) |
| `KURU_CLAUDE_BIN`  | `/root/.local/bin/claude` | your Claude CLI (`which claude`) |

> Real shell env vars override `.env.local`. The `claude` CLI must be installed and
> logged in (OAuth subscription) for agents to actually run.

## Daily commands

```bash
npm start          # boot the event-bus daemon (foreground)
npm run verify     # the regression-gate suite
npm test           # unit suite (test/run-all.js)
npm run setup      # re-scaffold var/intel (idempotent — never clobbers existing state)
```

To dispatch a task, append a JSON entry to `var/intel/dispatch-queue.json`; the daemon
picks it up on its poll cycle (schema in the upstream `/root/intel/CLAUDE.md`).

## How portability works (for when you edit the code)

- **Single source of truth for the roots:** `paths.js` exports `AGENTS_ROOT` and
  `INTEL_ROOT`. **Never hardcode `/root/intel` or `/root/agents`** in new code — import
  from `paths.js` (`const agentPaths = require('./paths')` → `agentPaths.INTEL_ROOT`).
- **`.env.local` autoload** lives at the top of `paths.js`, keyed off its own directory,
  so it works no matter where the process is launched.
- The original cutover was done by an AST codemod (`tools/_codemod-roots.js`) that
  rewrote ~470 hardcoded literals into `paths.js`-derived expressions. It's kept in
  `tools/` if you ever need to re-sweep after a big merge.

## What runs locally vs. what needs the full server

`npm run verify` will **not** be 147/147 locally — and that's expected. The gap is
infrastructure this repo doesn't contain, **not** broken logic:

| Not green locally | Why | Gates |
|---|---|---|
| **mission-control dashboard** | A separate Next.js app (`/root/mission-control`), not in this repo | 23, 26, 30, 31, 32, 33, 34, 38, 44, 128 |
| **PM2 services** | Gates assert live PM2 processes (`event-bus`, `mc`, `telegram-relay`, log-rotator cron) | 7, 11, 13, 36, 43 |
| **Unit suite (GATE-1)** | Many tests are coupled to the production `/root` data layer + fixtures | 1 |

Everything else — schema/config gates, routing, classifier, phase-wire, judge,
canonical-selection, learning-loop, safety-perimeter gates — passes against the seeded
local data layer.

The **daemon itself boots cleanly** (`npm start` → "NEXUS v3 active"), reads/writes the
local `var/intel`, and routes models from the seeded config. That's the foundation to
build on.

### Known cosmetic stragglers (non-blocking)

- A few **mission-control feature paths** are still absolute (e.g. the calendar file
  `/root/mission-control/data/calendar.json`). They're fail-soft no-ops locally.
- `scrub-goal-paths.js` scrubs the literal `/root/intel` prefix from agent-visible text;
  locally it won't match your `var/intel` prefix. Harmless (defense-in-depth only); make
  its regex root-aware if you want it to scrub the local prefix too.

## Seeding details

`npm run setup` (`scripts/setup-local.js`) creates `var/intel/` with:
- the directory skeleton (reports, tasks, episodes, handoffs, …),
- gate-valid default **configs** (`model-config.json`, `grader-config.json`,
  `target-profile-rules.json`, `prompts-config.json`), sourced from each module's own
  fallback + the field requirements the gates assert,
- empty **state** collections (`tasks.json`, `dispatch-queue.json`, …).

It refuses to run against the real `/root/intel` unless `KURU_FORCE_PROD_SEED=1`, so it
can't clobber a production data layer.
