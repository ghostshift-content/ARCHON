# src/workflows — black-box / static / white-box workflow definitions

Declarative descriptions of each mode's phase sequence and quality rules. The
mode adapter changes evidence acquisition; the adaptive runtime remains shared.

## Canonical team runtime

The executable Claude workflow is now available at `workflows/scan.js`, backed
by `src/runtime/agent-team.js`. It uses the same five roles in every mode:
ARCHON Lead, Inventory, Researcher, Explore, and Verifier.

The research unit is a coherent context-budget workstream, not
`feature × vulnerability class`. One Researcher applies all relevant registered
skill families holistically and may use at most two Explore children. Candidates
are deduplicated and sent in bounded batches to the REACHABILITY, IMPACT, and
DEFENSES verifier lenses; code computes the two-of-three admission decision.

`ARCHON_RUNTIME_V2=shadow` persists the canonical plan, task board, mission
journal, and UI projection beside current execution. Canary and active
ownership additionally require `ARCHON_RUNTIME_PARITY_APPROVED=1`. Runtime
generation is pinned per mission, so deployment or configuration changes never
switch an in-flight scan between engines.

White-box is composed rather than duplicated:

```text
source workstream
  -> source candidate
  -> linked runtime_validate task
  -> same candidate ID enriched with runtime evidence
  -> verifier panel
  -> audit
  -> judge
  -> final report
```

Without an authorized live target, the source report is preliminary and the
final white-box completion gate remains blocked.
