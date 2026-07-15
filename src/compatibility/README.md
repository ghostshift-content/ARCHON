# src/compatibility — bridges to the current engine

The seam between the new clean contracts and the **existing** `event-bus.js` + dispatchers
(`src/dispatch/code-review-dispatcher.js`, the pentest pipeline). Nothing here changes current execution; it
**observes** current behavior and normalizes it into the new artifacts (task board, decision log, coverage).

Planned bridges:
- `task-board-bridge.js` — mirror current phase/agent events into `task-board-<taskId>.jsonl` (observe-only, M5)
- `event-bridge.js` — adapt existing event-bus/log events to the new event contract
- `dispatch-bridge.js` — later, let the dispatchers read the task board / session plan (M8–M10)

Rule: **old imports keep working.** Bridges are one-directional (old → new) until a subsystem is fully migrated
and its tests + a live scan pass (per the Migration Plan). Physical folder cleanup is the LAST step (M14).
