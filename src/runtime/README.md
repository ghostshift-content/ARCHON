# Adaptive mission runtime

This directory owns ARCHON's mode-agnostic agent team runtime. Black-box,
static, and white-box missions use the same durable lifecycle:

```text
scope and generation pin
  -> inventory
  -> coherent research workstreams
  -> evidence-triggered explore tasks
  -> persistent triage batches
  -> three-lens verifier panels
  -> audit
  -> judge
  -> report
  -> deterministic completion gate
```

Modes change the workstream unit, eligible skills, evidence contract, and
confirmation rule. They do not create separate orchestration engines.

## Runtime authority

- `runtime-generation.js` pins each mission to `legacy`, `shadow`, `canary`, or
  `active`. A running mission never changes generation.
- `runtime-controller.js` is the public prepare/run/inspect seam.
- `runtime-dispatch.js` is the daemon ownership gate. Canary/active execution
  requires `ARCHON_RUNTIME_PARITY_APPROVED=1`.
- `adaptive-scheduler.js` is the only new-runtime task scheduler.
- The legacy dispatcher remains authoritative for legacy and shadow missions.
  A mission must never have two execution owners.

## Durable contracts

- `mission-journal.js`: append-only lifecycle and replan events.
- `task-board.js`: dependency-aware tasks, atomic claims, leases, retries, and
  recovery of expired work.
- `session-registry.js`: session start, heartbeat, current task, and terminal
  state history.
- `runtime-artifacts.js`: deduplicated candidates, verifier votes, phase
  results, and deterministic verifier decisions.
- `decision-log.js`: agent decision trace.
- `pattern-memory.js`: sanitized cross-engagement strategy outcomes only.

Snapshots and UI projections are disposable. The append-only journal and task
board are the recovery authorities.

## Team topology

One mission has one lead-level plan. Each coherent context slice receives one
persistent Researcher session. A Researcher applies all relevant skill and
persona lenses holistically; vulnerability classes are not separate sessions.
It may create at most two bounded Explore tasks, and Explore cannot recurse.

Candidate batches receive exactly three independent verifier lenses:
`REACHABILITY`, `IMPACT`, and `DEFENSES`. Code, not model prose, admits a
candidate only when the panel is complete and at least two lenses vote
`TRUE_POSITIVE`.

## Safety

- Universal scope prevalidation runs before ownership selection.
- `agentic-executor.js` uses the Agent SDK only.
- `tool-scope-gate.js` checks every live network tool call against the scope
  contract. Static/source sessions receive read-only repository tools.
- Report tasks can consume only judge-approved candidate IDs.
- White-box creates linked live-validation tasks when an authorized target is
  present. Otherwise it produces a preliminary source report and the final
  report gate remains blocked.

## Rollout

```bash
# Observe plans and UI only; legacy execution is unchanged.
ARCHON_RUNTIME_V2=shadow

# Deterministic subset selected by task ID; still requires parity approval.
ARCHON_RUNTIME_V2=canary
ARCHON_RUNTIME_CANARY_PERCENT=10
ARCHON_RUNTIME_PARITY_APPROVED=1

# New missions use the adaptive owner. Existing pinned missions do not change.
ARCHON_RUNTIME_V2=active
ARCHON_RUNTIME_PARITY_APPROVED=1
```

Promote mode-by-mode only after task, candidate, evidence, finding, coverage,
status, and report-eligibility parity succeeds. Disable the approval flag to
return all newly pinned missions to the legacy owner.
