# src/patterns/custom

**Bring-your-own patterns.** Drop a JSON pack here (or under `custom/user-created/`) and the relevant specialist
picks it up on the next scan — no code edit. Created via the dashboard (M12) or by hand.

Pack format (`common/schemas/pattern.schema.json`):
```json
{
  "class": "xss",
  "mode": "append",
  "author": "you",
  "patterns": [
    { "id": "xss.custom.dom-clobbering", "name": "DOM clobbering via id/name",
      "category": "xss", "description": "...", "severity": "Medium", "cwe": "CWE-79" }
  ]
}
```
- `mode`: `append` (default, adds to the built-ins) or `override` (replaces the class's built-in set).
- Invalid packs are **logged and skipped** — they never crash a scan.
- A brand-new `class` value makes a new class available.
