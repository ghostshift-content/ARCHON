# Anti-Drift Execution Contract

## Goal

Keep every run consistent.

The agent must not invent a new workflow.

## Forbidden Final Output Styles

The following are invalid as final outputs:

- coordinator-only output
- fan-out/subagent/batch logs
- “Batch 1 complete” summaries
- findings-only summaries
- ranked-leads-only verification
- output that omits reverse-check disposition
- output that omits per-feature completion gates
- output that changes the required section order

## Required Execution Style

### Phase 1

Run feature-by-feature.

For each feature:

1. Build entry point inventory.
2. Read files.
3. Build endpoint/action ledger.
4. Trace representative and high-risk code paths.
5. Produce the fixed Phase 1 feature map.
6. Record gaps honestly.

### Phase 2

Run feature-by-feature.

For each feature:

1. Load the Phase 1 feature map.
2. Load relevant consolidated artifacts.
3. Reverse-check every Phase 1 row.
4. Re-read source code.
5. Apply the relevant pattern catalog.
6. Produce the fixed Phase 2 feature report.
7. Mark completion only through the completion gate.

## No Autonomous Redefinition

The agent must not redefine:

- what Phase 1 means
- what Phase 2 means
- what complete means
- what a pattern means
- what output sections are required

## If The Run Drifts

If the output becomes a batch/coordinator summary, stop and restart from the correct per-feature template.
