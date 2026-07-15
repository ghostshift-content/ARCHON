# src/agents — agent registry + role mapping

Maps the **existing** agent names (CURATOR, MARSHAL, SIPHON, CIPHER, QUILL, BEACON, BREAKER, TRIAGER,
AUDITOR, JUDGE, SCRIBE, …) to clean roles (mission_lead, specialist, freehand_reviewer, recon_mapper,
triage, auditor, judge, reporter) + specialties + supported modes.

**Rule: old agent names remain valid.** This registry only *describes* their responsibilities so the new
architecture (task board, session planner, UI) can reason about them. It does not rename or remove anything.

Planned modules:
- `agent-registry.json` — the name → role/specialties/modes map
- `registry.js` — fail-soft loader + lookups (`roleOf`, `specialtiesOf`, `agentsForClass`, `all`)

Milestone: M2.
