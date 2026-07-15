# src/personas — built-in + custom personas

A persona shapes **planning, priority, evidence strictness, scan depth, runtime-validation preference, and
report style** — without bypassing scope or safety controls.

```
src/personas/
  builtin/            # read-only, shipped (default, bug-bounty-hunter, appsec-reviewer, …)
  custom/user-created/ # UI/user-created, editable
```

Schema: `common/schemas/persona.schema.json`.

Rules: built-ins are read-only · custom are user-editable · a persona MUST NOT bypass scope/active-poc/evidence
gates · **no persona selected ⇒ current behavior unchanged** (overlay-empty invariant).

Milestones: registry M4 · custom-persona UI M12.
