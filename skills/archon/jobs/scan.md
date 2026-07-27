# Scan job

1. Establish `mode`: `static`, `blackbox`, or `whitebox`.
2. Establish a mode-aware authorization contract:
   - static: readable repository roots and excluded paths
   - blackbox: authorized targets, time window, allow/deny rules, request and impact limits
   - whitebox: both contracts plus source-to-runtime target linkage
3. For black-box, establish `strategy`:
   - `direct`: start from supplied application/API assets without mandatory infrastructure recon
   - `smart_auto`: perform only evidence-driven recon that unlocks useful tests
   - `full_recon`: map the authorized external surface before testing
4. Profile the available context and create coherent workstreams. A context-fit project is one workstream. Large projects are dependency-local slices.
5. Invoke `Workflow(archon:scan)` with JSON containing the mode, strategy, scope, inventory or workstreams, applicable skill families, budget, and effort.
6. Persist the returned plan, coverage, candidates, votes, and admitted findings. Do not call a candidate a finding before deterministic admission.
7. For white-box, keep source evidence and runtime evidence separate. A source candidate requiring live proof becomes a runtime validation task; correlation may upgrade it only after proof.
8. Report completion gaps explicitly. An incomplete verifier panel or unreviewed applicable family blocks final admission for the affected candidate or surface.
