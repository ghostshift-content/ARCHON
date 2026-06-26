# Sprint C.2 — A2A Cross-Squad Handoff Protocol Design

**Date:** 2026-05-10
**Status:** DESIGN DRAFT — awaiting Jay review before implementation plan
**Reference:** Google A2A Protocol v1.2 (https://a2a-protocol.org/latest/) — Linux Foundation, 150+ orgs in production

---

## Problem (from Sprint A+B+C.1 lessons)

The Motorola finding `ASH-CONFIG-001` (supply-chain Lenovo→Zhaopin chat config) was discovered by the **pentest squad** but is genuinely a **3-squad finding**:

- **Pentest** found the misconfiguration in chat widget JS.
- **Cloud-security** (KUBERA) owns data-residency violations (PII to Chinese cloud).
- **Network-pentest** (INDRA) owns DNS/CDN chain attribution (zhaopin.com → it-hw-waf → Huawei Cloud China).

Round-6 published it as a single-squad finding because squads run isolated — there's no protocol for one squad to hand off to another mid-task. Result: incomplete confirmation chain. Bugcrowd triagers see one analyst's claim, not three squads converging on the same evidence.

**Sprint C.2 goal:** when a squad's agent discovers a finding that benefits from another squad's expertise, it can dispatch a structured handoff. The receiving squad runs its specialists against the handoff artifact and adds its own verdict. Final report shows multi-squad corroboration.

---

## Out of scope (explicitly)

- **Cryptographic agent cards.** A2A v1.2 has crypto-signed agent identity; we don't need this. We're an internal system; trust is implicit.
- **Cross-vendor interop.** A2A is designed for OpenAI/Anthropic/Google agents to talk. Our agents are all Claude. Skip the federation complexity.
- **Webhooks / pub-sub.** File-based handoff (drop a JSON in `/root/intel/handoffs/`) is sufficient for MVP — same pattern we use for Telegram outbox + supervisor inbox.

---

## Architecture

```
┌────────────┐  produces handoff JSON  ┌──────────────────┐
│ Pentest    │ ───────────────────▶   │ /root/intel/     │
│ specialist │                        │ handoffs/inbox/  │
└────────────┘                        └──────────────────┘
                                              │ event-bus watcher
                                              ▼
                                      ┌──────────────────┐
                                      │ Resolve target   │
                                      │ squad + agent    │
                                      └──────────────────┘
                                              │
                       ┌──────────────────────┼──────────────────────┐
                       ▼                      ▼                      ▼
                 ┌──────────┐           ┌──────────┐           ┌──────────┐
                 │ Cloud    │           │ Network  │           │ Code-rev │
                 │ KUBERA   │           │ INDRA    │           │ specialist│
                 └──────────┘           └──────────┘           └──────────┘
                       │                      │                      │
                       └──────────┬───────────┴──────────────────────┘
                                  ▼
                          ┌──────────────────┐
                          │ /root/intel/     │
                          │ handoffs/done/   │  ← attached to original finding
                          └──────────────────┘
```

---

## Handoff request format

Each handoff is a JSON file in `/root/intel/handoffs/inbox/{handoff-id}.json`:

```json
{
  "schema_version": "1",
  "handoff_id": "h-1778360700-001",
  "source_task_id": "1778331136333",
  "source_squad": "pentest",
  "source_agent": "ASHWATTHAMA",
  "source_finding_id": "ASH-CONFIG-001",
  "target_squad": "cloud-security",
  "target_capability": "data-residency",
  "request": {
    "question": "Is data flowing to cube.zhaopin.com a data-residency / sovereignty violation? What's the legal posture for US/EU users?",
    "evidence": {
      "chat_config_url": "https://us-llm.moli.lenovo.com/callcenterv2/config.js",
      "api_host": "https://cube.zhaopin.com",
      "dns_chain": ["cube.zhaopin.com", "it-hw-waf.zhaopin.com", "Huawei Cloud China"]
    },
    "expected_artifacts": ["compliance-verdict", "geographic-routing-confirmation"]
  },
  "created_at": "2026-05-10T01:05:00.000Z",
  "status": "pending"
}
```

Once resolved, the file moves to `/root/intel/handoffs/done/{handoff-id}.json` with these fields appended:

```json
{
  ...all-the-above-fields...,
  "status": "completed",
  "resolved_at": "2026-05-10T01:25:00.000Z",
  "resolved_by_agent": "KUBERA",
  "verdict": "CONFIRMED",
  "verdict_reason": "GDPR Article 44 violation: PII transferring to non-adequacy-decision country (China) without SCC. CCPA Section 1798.140(t) violation: third-party sharing without opt-in. ICO 2024 enforcement notice precedent: similar UK→China data flows = £1.5M fine.",
  "evidence_added": {
    "compliance_frameworks_violated": ["GDPR Art. 44", "CCPA §1798.140(t)", "ICO 2024 precedent"],
    "geographic_routing_confirmed": true,
    "huawei_cloud_aspn": "AS136907 (China Telecom Cloud Computing)"
  },
  "cost": 0.42
}
```

---

## Routing — capability map

Each squad publishes a `capabilities.json` declaring what handoffs it accepts:

`/root/agents/squads/cloud-security/capabilities.json`:
```json
{
  "squad": "cloud-security",
  "version": "1",
  "capabilities": [
    {
      "id": "data-residency",
      "agents": ["KUBERA"],
      "description": "Compliance verdict for PII flows across borders (GDPR/CCPA/India DPDPA/etc.)"
    },
    {
      "id": "iam-audit",
      "agents": ["MITRA"],
      "description": "Cloud IAM policy review for over-privileged roles, exposed credentials"
    },
    {
      "id": "s3-bucket-audit",
      "agents": ["AGNI"],
      "description": "Public S3/GCS/Azure Blob exposure check"
    }
  ]
}
```

The handoff resolver reads each squad's capabilities.json and routes by `target_squad + target_capability`. If no match → handoff fails with "no capability" verdict (logged to handoffs/failed/).

---

## Wiring points (file-by-file impact estimate)

| File | Change |
|------|--------|
| `agents/handoff-protocol.js` (new) | `createHandoff()`, `readHandoff()`, `markCompleted()`, schema validation |
| `agents/handoff-resolver.js` (new) | watch inbox, route by capability, dispatch target agent, write back |
| `event-bus.js` | start handoff-resolver alongside other watchers; specialists can call `createHandoff()` from their stdout via a CLI helper |
| `squads/<each>/capabilities.json` (7 new files) | declare each squad's handoff capabilities |
| `verify-framework.js` | GATE-64: every squad has capabilities.json. GATE-65: handoff-resolver is started by SANJAY |
| Specialist prompts (per-squad) | Add a "🔁 HANDOFF" section explaining when + how to request another squad's input |
| `agents/finding-schema.js` | Extend canonical Finding schema with `handoffs: []` array of handoff_ids |

**Estimated scope:** 12-15 commits, 2-3 days of focused work via subagents. Bigger than Sprint A+B+C.1 combined.

---

## MVP success criteria

1. **End-to-end test**: pentest specialist creates a handoff to cloud-security on a synthetic supply-chain finding. Cloud-security KUBERA picks it up, returns a verdict, the verdict appears in the original task's report.
2. **Capability map**: all 7 squads have `capabilities.json` files validated by GATE-64.
3. **Idempotence**: dropping the same handoff JSON twice doesn't create duplicate work (handoff_id is the dedup key).
4. **Failure path**: if `target_capability` doesn't exist, handoff lands in `handoffs/failed/` with clear reason — pipeline never blocks.
5. **Real-target verification**: re-run motorola task, expect ASH-CONFIG-001 to auto-handoff to cloud-security and gain a 3-squad-corroborated verdict in the final report.

---

## Open questions for Jay

1. **Should handoffs be synchronous or async?** Sync = pentest waits for cloud-security. Async = pentest writes report with "handoff pending", cloud-security follows up later. **Recommendation: async** (simpler, matches the rest of our event-bus pattern, allows handoff to take longer than the source task without blocking).

2. **Cost cap per handoff?** A handoff invokes another squad's agent — could be Sonnet/Opus call. **Recommendation: max $0.50 per handoff, $2 cap per source task.** Configurable.

3. **How many handoffs can a finding generate?** **Recommendation: max 3 per finding** — anything beyond is design smell (the finding probably needs to be split).

4. **Can a squad chain handoffs?** E.g., cloud-security receives a handoff and itself sends a handoff to network-pentest. **Recommendation: yes, but cap chain depth at 2** to prevent loops.

5. **Existing memory/spec drift**: the `project_cloud_security_squad.md` and `project_network_pentest_squad.md` memories say these squads are "LIVE". Need to verify they actually have working specialists today before sending real handoffs to them. **First implementation step should be a dry-run** that just creates the handoff file without dispatching, so we can manually inspect targeting.

---

## Decision needed before writing implementation plan

- Approve async + $0.50/$2 caps + 3-handoff-per-finding limit + chain-depth-2?
- Want to scope MVP to **only** pentest→cloud-security (one chain) and add the rest after?
- OK with file-based protocol (no webhooks/HTTP) for MVP?

Once these are answered, I'll write the full TDD implementation plan modeled on Sprint C.1's plan structure (8-12 tasks, bite-sized, subagent-executable).
