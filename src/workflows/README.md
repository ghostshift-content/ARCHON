# src/workflows — black-box / static / white-box workflow definitions

Declarative descriptions of each mode's phase sequence + quality rules, so the flow is visible and testable
rather than implicit in `event-bus.js` / the dispatchers.

Planned:
- `static.js` — scope → inventories → blueprint → discovery → session-plan → task-board → fast-map → deep-map
  → phase-2 tasks → pattern review → candidates → streaming triage → freehand → judge → report
- `whitebox.js` — static + runtime-validation-task generation → black-box validation → correlation → judge → report
- `blackbox.js` — scope → recon → attack-planner → specialists → candidates → triage → judge → report

**Definitions only, additive.** They mirror the current flows (they do NOT change execution). The real engine
stays in `event-bus.js` / `src/dispatch/*` until a workflow's bridge is proven (M8–M10). Black-box only gains
**task-board visibility** first (M12/§12), execution untouched.
