# src/runtime — mission execution

Mission-level execution primitives: the **task board** (shared operational truth), the **session planner**
(how many controlled project sessions), the **quota governor** (rate-limit-aware backoff), and event emit.

Planned modules:
- `task-board.js` — read/write/claim `var/intel/task-board-<taskId>.jsonl` (schema: `common/schemas/task-board.schema.json`)
- `session-planner.js` — plan `session_count` / `active_concurrency` / shards (schema: `session-plan.schema.json`)
- `quota-governor.js` — global quota state + backoff ladder (wraps the existing `src/integrations/quota-manager.js`)

Milestones: task board M5 (observe-only) → M8/M9 (drives mapping/review); session planner M6 → M8/M9;
quota governor M11. **Observe-only first** — writes artifacts beside the current flow without changing execution.
