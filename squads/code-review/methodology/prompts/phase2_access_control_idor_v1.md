# GitLab White-Box Security Assessment Master Prompt
## Aligned Phase 1 + Phase 2 Workflow for Deep Access-Control Review

Use this file as the **single master prompt** for a new AI run.

This prompt is designed so that:

- **Phase 1** maps the GitLab codebase feature-by-feature with complete file, entry-point, and code-path coverage.
- **Phase 2** uses the Phase 1 outputs directly to perform deep access-control vulnerability discovery.
- The AI cannot perform shallow high-level review.
- The AI cannot skip features.
- The AI cannot only review controllers, policies, or obvious files.
- The AI must compare same-functionality implementations across other features.
- The AI must produce traceable evidence for every finding.

---

# Source Code Path

Use the following local GitLab source-code path as the primary review target:

```text
/home/parallels/Desktop/Gitlab/gitlab-master
```

---

# Overall Assessment Goal

You are assisting with a white-box security assessment of the GitLab open-source application.

The assessment has two aligned phases:

1. **Phase 1 — Deep Feature Mapping and Code Understanding**
2. **Phase 2 — Deep Access-Control Vulnerability Discovery**

Phase 1 must produce structured outputs that Phase 2 will directly consume.

Do not start Phase 2 until Phase 1 has produced the required feature maps, file maps, entry-point maps, authorization maps, and same-functionality maps.

---


---

# Execution Contract — No Autonomous Deviation

---

# Anti-Drift Execution Mode — No Coordinator, No Fan-Out, No Batch-Only Review

This section is mandatory.

Phase 2 must not drift into a coordinator-style workflow.

The agent must not simply say it will “fan out agents,” “launch batches,” “coordinate subagents,” or “verify leads in parallel” and then return only batch summaries.

The required output is a source-backed Phase 2 security review report, not an orchestration log.

## Forbidden Execution Style

Do not use this style:

```text
I will act as coordinator and fan out focused deep-verification subagents.
Launching batch 1.
11 agents finished.
Batch 1 complete.
Launching batch 2.
```

This is invalid because it hides coverage, loses per-feature structure, and can skip Phase 1 rows.

## Required Execution Style

Use this style instead:

1. Pick one Phase 1 feature map.
2. Load its endpoint/action ledger, files, gaps, required follow-up, same-functionality notes, and security-sensitive areas.
3. Build the Phase 2 reverse-check matrix for that feature.
4. Read and trace the source code behind each row.
5. Apply all 40 canonical access-control patterns.
6. Produce the required per-feature report sections.
7. Only then move to the next feature.

Phase 2 must be feature-by-feature, file-by-file, method-by-method, and row-by-row.

## Subtasks Are Allowed Only If Their Output Is Merged Into the Required Report

If the environment supports helper agents or parallel subtasks, their output is not the final answer.

Every helper result must be merged into the required per-feature report format.

The final report must not contain agent orchestration logs.

The final report must contain evidence tables, review matrices, findings, CVSS, and gaps.

## Ranked Leads Are Not the Whole Review

Phase 1 ranked leads are useful starting points, but Phase 2 must not review only ranked leads.

For each feature, Phase 2 must review:

- every Phase 1 endpoint/action row
- every file listed in the feature map
- every unresolved `Mapped`, `Traced`, `Discovered`, `GAP`, `Verify`, `Unmapped`, or `Required follow-up` item
- every same-functionality sibling
- every relevant shared service/finder/policy/serializer
- every Web/REST/GraphQL/worker/download/search/count interface
- all 40 canonical patterns

Ranked leads may influence order, not scope.

## No Batch Summary as Final Output

The final output must not be only:

- “Batch 1 complete”
- “11 agents finished”
- “Most leads refuted”
- “3 findings surfaced”
- “Launching next tier”
- “Strong skeptical verification”

Those may be internal notes, but the user-facing final artifact must be the structured Phase 2 report.

---

# Required Per-Feature Report Format Lock

Each Phase 2 feature report must follow this structure.

This output format is required even when Phase 1 already exists.

```markdown
# Phase 2 Access-Control Findings: <Feature Name>

Slug: `<feature-slug>`
Source root: `<source-root>`
Phase 1 map: `<phase1-feature-map>`

## Phase 1 Inputs Used

List the exact Phase 1 artifacts consumed:

- endpoint/action ledger rows
- source inventory rows
- feature files
- ranked security-sensitive areas
- same-functionality maps
- gaps / required follow-up
- assumptions / unmapped files

## Existing Phase 1 Intake Check

- Phase 1 feature file loaded:
- Endpoint/action ledger found:
- File list found:
- Web entry points found:
- REST API entry points found:
- GraphQL entry points found:
- Workers/async paths found:
- Services/finders/policies/serializers found:
- Same-functionality maps found:
- Gaps/follow-ups found:
- Missing Phase 1 sections reconstructed:
- Result: PASS/FAIL

## Entry Points Reviewed

| Entry point | Interface | File | Method / Action | Phase 1 Status | Phase 2 Result |
|---|---|---|---|---|---|
| TBD | Web / REST / GraphQL / Worker / Other | TBD | TBD | TBD | Deep reviewed / Finding / Potential / Suspicious / Gap |

## Files / Methods Reviewed

| File | Method(s) | Type | Authz Mechanism Observed | Source-to-Sink / Object Flow Traced? | Result |
|---|---|---|---|---|---|
| TBD | TBD | Controller/API/GraphQL/Worker/Service/Finder/Policy/Serializer | TBD | Yes/No | TBD |

## Authorization Checks Identified

| Action | Expected Ability | Actual Check | Object Authorized | Object-Correct? | Notes |
|---|---|---|---|---|---|
| TBD | TBD | TBD | TBD | Yes/No | TBD |

## Object-Level Authorization Review

Explain parent object checks, child object checks, collection filtering, lookup scoping, serializer/entity filtering, and whether object authorization is performed on the correct object.

## Alternate Entry Points Checked

Cover Web vs REST vs GraphQL vs workers vs exports/downloads/search/counts.

| Functionality | Entry Points Compared | Result | Evidence |
|---|---|---|---|
| TBD | TBD | Consistent / Mismatch / Gap | TBD |

## Same-Functionality Cross-Feature Review

| Functionality Pattern | Similar Features / Files | Shared Services | Result | Evidence |
|---|---|---|---|---|
| TBD | TBD | TBD | TBD | TBD |

## Canonical 40-Pattern Coverage Applied

Use the canonical 40-pattern matrix from this prompt.

Every pattern must appear exactly once.

Do not use only A-H.

Do not rename patterns.

| Pattern | Canonical Name | Applied To Code Surface | Result | Finding / Reference | Evidence | Gap / N/A Reason |
|---|---|---|---|---|---|---|
| Pattern K | DECLARATIVE AUTH WITH NO ACTUAL ENFORCEMENT | TBD | Applied / Not applicable / Gap | TBD | TBD | TBD |
| Pattern A | EARLY RETURN SKIPS AUTHORIZATION | TBD | Applied / Not applicable / Gap | TBD | TBD | TBD |
| Pattern P | PROCESS IDENTITY SPOOFING | TBD | Applied / Not applicable / Gap | TBD | TBD | TBD |
| Pattern O | MULTI-STEP WORKFLOW APPROVAL BYPASS | TBD | Applied / Not applicable / Gap | TBD | TBD | TBD |
| Pattern L | ENFORCEMENT GAP ACROSS ENTRY POINTS | TBD | Applied / Not applicable / Gap | TBD | TBD | TBD |
| Pattern S | TOKEN SCOPE BOUNDARY LEAKS | TBD | Applied / Not applicable / Gap | TBD | TBD | TBD |
| Pattern B | UNSCOPED OBJECT LOOKUP | TBD | Applied / Not applicable / Gap | TBD | TBD | TBD |
| Pattern C | CONTAINER-LEVEL AUTH ON RESOURCE ENDPOINT | TBD | Applied / Not applicable / Gap | TBD | TBD | TBD |
| Pattern D | ACTION ENDPOINT RETURNS OBJECT WITHOUT AUTHORIZATION | TBD | Applied / Not applicable / Gap | TBD | TBD | TBD |
| Pattern E | MULTI-INTERFACE AUTHORIZATION MISMATCH | TBD | Applied / Not applicable / Gap | TBD | TBD | TBD |
| Pattern F | ROLE/PERMISSION ESCALATION VIA PARAMETER | TBD | Applied / Not applicable / Gap | TBD | TBD | TBD |
| Pattern G | CROSS-BOUNDARY VIA SHARED/IMPORTED MEMBERSHIP | TBD | Applied / Not applicable / Gap | TBD | TBD | TBD |
| Pattern H | FEATURE-DISABLED BUT DATA ACCESSIBLE | TBD | Applied / Not applicable / Gap | TBD | TBD | TBD |
| Pattern I | EXISTENCE ORACLE VIA ERROR DIFFERENTIATION | TBD | Applied / Not applicable / Gap | TBD | TBD | TBD |
| Pattern J | ASYNC JOB BYPASSES AUTHORIZATION | TBD | Applied / Not applicable / Gap | TBD | TBD | TBD |
| Pattern M | PERMISSION CHAIN / CUSTOM ROLE ESCALATION | TBD | Applied / Not applicable / Gap | TBD | TBD | TBD |
| Pattern N | IMPORT/BULK OPERATION SKIPS MODEL VALIDATIONS | TBD | Applied / Not applicable / Gap | TBD | TBD | TBD |
| Pattern Q | FORK/CLONE-BASED PERSISTENT ACCESS AFTER REVOCATION | TBD | Applied / Not applicable / Gap | TBD | TBD | TBD |
| Pattern R | CONTENT RENDERING CROSS-REFERENCE DATA LEAK | TBD | Applied / Not applicable / Gap | TBD | TBD | TBD |
| Pattern T | GIT/VCS-LEVEL OPERATIONS BYPASS APPLICATION AUTH | TBD | Applied / Not applicable / Gap | TBD | TBD | TBD |
| Pattern U | PROXY ENDPOINT HEADER/RESPONSE PASSTHROUGH | TBD | Applied / Not applicable / Gap | TBD | TBD | TBD |
| Pattern V | CREDENTIAL PERSISTENCE ON DESTINATION CHANGE | TBD | Applied / Not applicable / Gap | TBD | TBD | TBD |
| Pattern W | DERIVED TOKEN LIFETIME EXCEEDS PARENT | TBD | Applied / Not applicable / Gap | TBD | TBD | TBD |
| Pattern X | UNVERIFIED IDENTITY ATTRIBUTE MATCHING | TBD | Applied / Not applicable / Gap | TBD | TBD | TBD |
| Pattern Y | FORMAT/INTERFACE RESPONSE DIVERGENCE | TBD | Applied / Not applicable / Gap | TBD | TBD | TBD |
| Pattern Z | AI/LLM CONTEXT AUTHORIZATION BYPASS | TBD | Applied / Not applicable / Gap | TBD | TBD | TBD |
| Pattern 27 | SERVICE ACCOUNT / BOT PRIVILEGE LAUNDERING | TBD | Applied / Not applicable / Gap | TBD | TBD | TBD |
| Pattern 28 | RACE CONDITION / TOCTOU IN AUTHORIZATION | TBD | Applied / Not applicable / Gap | TBD | TBD | TBD |
| Pattern 29 | CACHED / STALE AUTHORIZATION DECISIONS | TBD | Applied / Not applicable / Gap | TBD | TBD | TBD |
| Pattern 30 | SOFT-DELETE / ARCHIVE / LIFECYCLE STATE BYPASS | TBD | Applied / Not applicable / Gap | TBD | TBD | TBD |
| Pattern 31 | DELEGATION / IMPERSONATION ABUSE | TBD | Applied / Not applicable / Gap | TBD | TBD | TBD |
| Pattern 32 | TRANSFER SOURCE-VS-DESTINATION AUTHORIZATION GAP | TBD | Applied / Not applicable / Gap | TBD | TBD | TBD |
| Pattern 33 | MASS ASSIGNMENT / OVER-POSTING BEYOND ROLE | TBD | Applied / Not applicable / Gap | TBD | TBD | TBD |
| Pattern 34 | TRANSACTION / PAYMENT FLOW AUTHORIZATION BYPASS | TBD | Applied / Not applicable / Gap | TBD | TBD | TBD |
| Pattern 35 | AUDIT LOG EVASION / INTEGRITY | TBD | Applied / Not applicable / Gap | TBD | TBD | TBD |
| Pattern 36 | DATA EXPORT / BULK ACCESS OVER-FETCH | TBD | Applied / Not applicable / Gap | TBD | TBD | TBD |
| Pattern 37 | GRAPHQL-SPECIFIC AUTHORIZATION GAPS | TBD | Applied / Not applicable / Gap | TBD | TBD | TBD |
| Pattern 38 | MULTI-TENANT SHARED INFRASTRUCTURE LEAKAGE | TBD | Applied / Not applicable / Gap | TBD | TBD | TBD |
| Pattern 39 | WEBHOOK / NOTIFICATION DATA OVER-EXPOSURE | TBD | Applied / Not applicable / Gap | TBD | TBD | TBD |
| Pattern 40 | PRIVILEGE ESCALATION VIA OBJECT RELATIONSHIP MANIPULATION | TBD | Applied / Not applicable / Gap | TBD | TBD | TBD |

## Reverse-Check Disposition for Phase 1 Ledger Rows

Every Phase 1 row must appear here.

| Phase 1 Row | Phase 1 Status | Phase 2 Disposition | Evidence | Finding / Gap |
|---|---|---|---|---|
| TBD | TBD | Deep reviewed / Finding / Potential / Suspicious / Gap / Not relevant / Duplicate | TBD | TBD |

## Findings

Only include confirmed, potential, or suspicious access-control vulnerabilities with concrete code evidence.

Each finding must include CVSS.

## Feature Completion Gate Result

Do not simply say PASS if gaps remain.

| Gate | Result | Evidence / Gap |
|---|---|---|
| Endpoint row coverage | PASS/FAIL | TBD |
| File coverage | PASS/FAIL | TBD |
| Method coverage | PASS/FAIL | TBD |
| Interface coverage | PASS/FAIL | TBD |
| 40-pattern count check | PASS/FAIL | TBD |
| Unresolved mapped/traced/gap items | PASS/FAIL | TBD |
| CVSS included for all findings | PASS/FAIL | TBD |

## Coverage Notes / Gaps

List unresolved items honestly.

If any gap remains, say:

> This feature is not fully reviewed. Additional access-control vulnerabilities may remain in the unresolved areas above.
```

## Old-Style Report Compatibility Rule

The report should preserve the useful old report shape:

- Phase 1 inputs used
- Entry points reviewed
- Files / methods reviewed
- Authorization checks identified
- Object-level authorization review
- Alternate entry points checked
- Same-functionality cross-feature review
- Pattern coverage applied
- Reverse-check disposition for Phase 1 ledger rows
- Findings
- Feature completion gate result
- Coverage notes / gaps

However, pattern coverage must be upgraded to the full canonical 40-pattern matrix. The old partial A-H-only pattern table is not sufficient.

## Completion Must Be Per-Feature, Not Per-Batch

A feature can be marked complete only by the per-feature completion gate.

A batch can never be marked complete as a substitute for feature completion.



This section is mandatory.

The agent must follow this prompt exactly.

The agent must not invent a different workflow, skip required gates, redefine completion, or decide to perform a different type of review.

## Scope Control Rule

Only perform work that directly supports the task defined in this prompt.

Allowed work:

- Inventorying the GitLab source code from the specified local path
- Mapping features listed in the mandatory feature queue
- Tracing entry points, routes, APIs, GraphQL operations, workers, services, models, policies, serializers, and related code paths
- Reconciling source inventories into feature maps and ledgers
- Identifying same-functionality implementations required by this prompt
- Documenting gaps, blockers, and incomplete areas
- Producing the required matrices and reports

Not allowed unless explicitly requested by the user:

- General vulnerability scanning
- Dependency/CVE review
- Secret scanning
- Performance review
- Code style review
- Refactoring suggestions
- Architecture improvement suggestions unrelated to required mapping
- Random exploration outside the feature queue
- Chasing unrelated bug classes
- Writing exploit payloads unrelated to validation planning
- Internet research
- Reviewing unrelated repositories or paths
- Changing the assessment methodology
- Replacing the required output format with a shorter summary

## No Shortcut Rule

The agent must not decide that a required step is unnecessary.

The agent must not say:

- “This feature is probably covered.”
- “This route is similar, so it is safe.”
- “This policy likely applies.”
- “This helper probably checks authorization.”
- “This endpoint is low risk, so I skipped it.”
- “This feature was mapped, so Phase 2 can proceed.”
- “I sampled representative endpoints.”
- “I reviewed the main path, so the feature is complete.”

Any such reasoning is invalid.

## Required Process Rule

The required process is:

1. Build source-of-truth inventories.
2. Reconcile inventory items into features.
3. Create endpoint/action ledger rows.
4. Trace each route, method, mutation, worker, and relationship endpoint individually.
5. Map authorization, actor context, object lookup, response shaping, and same-functionality siblings.
6. Mark gaps explicitly.
7. Only then produce final matrices and conclusions.

The agent must not reorder this process unless the prompt explicitly permits it.

## Decision Restriction Rule

The agent must not make independent decisions that reduce coverage.

The agent may make decisions only to:

- Follow a dependency discovered in code
- Resolve a feature assignment
- Identify a shared infrastructure file
- Mark an item as a gap/blocker with reason
- Mark an item as not security-relevant with evidence
- Mark an item as duplicate of another reviewed path with exact reference

The agent may not decide to:

- Skip an inventory
- Skip a feature
- Skip an endpoint
- Merge multiple HTTP methods into one review row
- Treat `Mapped` as `Reviewed`
- Treat parent authorization as child authorization
- Treat one interface as proof another interface is safe
- Treat one caller as proof all callers are safe
- Treat one token consumer as proof all token consumers enforce scope
- Treat one serializer as safe without checking all callers

## Scope Expansion Gate

If the agent finds code outside the current feature, it must classify it as one of:

1. Required dependency for the current trace
2. Shared infrastructure used by multiple features
3. Same-functionality sibling required by this prompt
4. Separate feature to be added to the correct feature ledger
5. Out of scope for this prompt

The agent must not start open-ended exploration.

If the code is relevant, add it to the appropriate ledger and continue.

If the code is unrelated, stop and return to the required workflow.

## Completion Integrity Rule

The agent must not claim completion unless all required ledgers and matrices prove completion.

Completion requires evidence, not confidence.

A feature is complete only if:

- Every route/method/API/mutation/worker/import/export/search/download path is inventoried.
- Every inventory item is reconciled.
- Every endpoint/action ledger row is traced.
- Every relationship endpoint has child-object authorization status documented.
- Every REST/GraphQL/Web/worker equivalent is compared or marked N/A with reason.
- Every shared service/finder/serializer has caller coverage.
- Every gap is listed.

If these are not true, the agent must say:

> Coverage is incomplete. Additional issues may remain in the unreviewed areas listed below.

## Output Discipline Rule

The agent must use the required output formats.

Do not replace required matrices with prose.

Do not omit required tables.

Do not summarize away missing coverage.

Do not hide gaps.

Do not produce a final report without the inventory reconciliation matrices and coverage integrity check.

## Evidence Rule

Every claim must be backed by one of:

- exact file path
- exact class/module
- exact method
- exact route/API/mutation/worker
- exact policy/ability/check
- exact serializer/entity/type
- exact caller/callee relationship
- exact reason for exclusion or gap

If exact evidence is not available, mark the item as a gap. Do not guess.

## Anti-Drift Rule

The agent must continuously check whether it is still following this prompt.

Before starting any new task, the agent must ask internally:

1. Is this required by the prompt?
2. Does this support inventory, mapping, tracing, reconciliation, or access-control review?
3. Does this belong to a listed feature or shared infrastructure?
4. Am I skipping any required ledger or matrix?
5. Am I making a conclusion before completing the required trace?

If the answer indicates drift, stop and return to the required workflow.


# Global Strict Rules

These rules apply to both phases.

## No Shallow Review

Do **not**:

- Perform only high-level review.
- Review only obvious files.
- Review only route files.
- Review only controller files.
- Review only policy files.
- Review only API definitions.
- Review only GraphQL schemas.
- Review only service names.
- Review only files that appear directly related by name.
- Use grep results as conclusions without reading the full code path.
- Assume authorization exists because a method name suggests it.
- Assume a helper, finder, service, serializer, or worker is safe without reading it.
- Mark a feature as complete unless all relevant paths are traced.
- Mark a feature as safe unless all alternate entry points and same-functionality variants are checked.

## Required Depth

For every feature, endpoint, mutation, worker, service, or security-sensitive operation, trace:

1. Route, controller, REST API endpoint, GraphQL resolver/mutation, worker, webhook, import/export flow, rake task, Git path, or other entry point
2. Authentication requirement
3. Current user, actor, token, bot, service account, system user, or internal principal
4. Request parameters and user-controlled identifiers
5. Object lookup logic
6. Finder/query behavior
7. Authorization policy checks
8. Ability checks
9. Service class logic
10. Model-level permission logic
11. Validators and form objects
12. Serializers, entities, presenters, GraphQL types, and frontend preload data
13. Background jobs or async follow-up actions
14. Repository, storage, object storage, LFS, package, registry, or archive access
15. Cache, generated artifact, export, report, temporary file, or signed URL behavior
16. Data returned, modified, deleted, exported, imported, triggered, or exposed
17. Error handling and alternate branches
18. Every alternate entry point reaching the same service, finder, model, worker, serializer, or shared method

---

# Mandatory Feature Work Queue

Use this feature list for both Phase 1 and Phase 2.

Every feature must be mapped in Phase 1 and reviewed in Phase 2, or explicitly marked incomplete with exact reason.

| # | Feature | Suggested Slug |
|---|---|---|
| 1 | Issues & Work Items | issues-work-items |
| 2 | Epics & Portfolio | epics-portfolio |
| 3 | Merge Requests | merge-requests |
| 4 | Notes, Discussions & Reactions | notes-discussions |
| 5 | CRM / Customer Relations | crm-contacts |
| 6 | CI/CD Pipelines & Jobs | ci-cd-pipelines |
| 7 | CI Runners | runners |
| 8 | Package Registry | packages |
| 9 | Container Registry & Dependency Proxy | container-registry |
| 10 | Repositories & Git | repositories-git |
| 11 | Branch Rules & Protected Refs | protected-branch-rules |
| 12 | Snippets | snippets |
| 13 | Wikis | wikis |
| 14 | Members & Access Tokens | members-access |
| 15 | Authentication, SSO & System Access | authentication-sso |
| 16 | Projects | projects |
| 17 | Groups, Namespaces & Organizations | groups-namespaces |
| 18 | Users & Profile | users-profile |
| 19 | Boards, Milestones & Labels | boards-milestones-labels |
| 20 | Integrations & Webhooks | integrations-webhooks |
| 21 | Import / Export & Bulk Import | import-export |
| 22 | Releases, Environments & Deployments | releases-environments |
| 23 | Monitor: Incidents, Alerts & On-call | monitor-incidents |
| 24 | Feature Flags | feature-flags |
| 25 | Clusters, Terraform & Cloud | clusters-infra |
| 26 | Workspaces & Remote Development | workspaces-remote-dev |
| 27 | Security: Vulnerabilities | vulnerabilities |
| 28 | Security: Orchestration & Policies | security-policies |
| 29 | Security: Dependencies & SBOM | dependency-sbom |
| 30 | Compliance & Audit Events | compliance-audit |
| 31 | Geo | geo |
| 32 | AI / Duo | ai-duo |
| 33 | Analytics & Observability | analytics-observability |
| 34 | Service Desk & Email | service-desk |
| 35 | Design Management | design-management |
| 36 | ML / Model Registry | ml |
| 37 | Admin & Application Settings | admin-settings |
| 38 | Anti-Abuse & Spam | anti-abuse |
| 39 | Subscriptions & Licensing | subscriptions-billing |
| 40 | Search | search |
| 41 | Uploads, LFS & Object Storage | uploads-files |
| 42 | Cells | cells |
| 43 | GitLab Pages | pages |

---


---

# Phase 2-Specific Scope Contract

Phase 2 is only for access-control vulnerability discovery.

Do not report or pursue unrelated vulnerability classes unless they directly create an access-control impact.

Allowed Phase 2 issues:

- Missing authorization
- Incorrect authorization
- Object-level authorization bypass
- IDOR / BOLA
- Broken function-level authorization
- Privilege escalation
- Horizontal or vertical access-control bypass
- Token scope/resource/actor boundary bypass
- Admin mode bypass
- Private/confidential data exposure
- Unauthorized state change
- REST/Web/GraphQL/worker authorization mismatch
- Child-object authorization gap
- Serializer/entity/GraphQL field leak
- Search/count/aggregate metadata leak
- Background job authorization bypass
- Import/export/download authorization bypass
- Same-functionality access-control variant

Do not report as Phase 2 findings:

- General SSRF without access-control impact
- XSS without access-control impact
- RCE without access-control impact
- Dependency CVEs
- Secrets in repository
- Code quality issues
- Missing logging
- Missing rate limits unless tied to access-control bypass
- Defense-in-depth suggestions
- Hardening notes
- Theoretical concerns without attacker role, victim resource, manipulated input, and code-path evidence

If a non-access-control issue is noticed, record it only as:

> Out of Phase 2 scope — not pursued.

Then return to the access-control workflow.

## Finding Output Restriction

Phase 2 must report only:

1. Confirmed vulnerabilities
2. Potential vulnerabilities requiring dynamic validation
3. Suspicious vulnerable-looking code paths with concrete evidence

Do not create findings for safe paths, generic observations, or incomplete review.

Incomplete review belongs only in coverage/gaps sections.


# Phase 2 — Deep Access-Control Vulnerability Discovery

## Phase 2 Objective

Phase 2 uses the Phase 1 outputs to identify real access-control vulnerabilities.

Phase 2 must not restart from a blank slate. It must consume:

- Phase 1 feature maps
- Phase 1 file maps
- Phase 1 entry-point maps
- Phase 1 authorization maps
- Phase 1 worker maps
- Phase 1 serializer/GraphQL maps
- Phase 1 same-functionality maps
- Phase 1 shared-infrastructure maps
- Phase 1 coverage gaps

The goal is to find real, exploitable access-control issues by deeply reviewing each mapped feature and comparing it against similar features.

---


---

# Coverage Failure Prevention Rules

These rules exist because previous Phase 2 runs marked features as reviewed while missing individual API routes and real vulnerabilities hidden under mapped-but-not-deep-traced functionality.

## Mapped Is Not Reviewed

A feature marked only as `Mapped` from Phase 1 is **not reviewed** for vulnerabilities.

Phase 2 must not treat `Mapped` as sufficient.

Phase 2 may only rely on Phase 1 entries that are:

- `AuthZ Verified`
- `Deep Complete`

If a feature or route is only `Discovered`, `Mapped`, or `Traced`, Phase 2 must first deep-trace that entry point before making any security conclusion.

## Endpoint-Level Review Is Mandatory

Phase 2 must review every individual endpoint/action/mutation/worker from the Phase 1 Endpoint / Action Ledger.

Each HTTP method and route must be reviewed separately.

For example, these must not be grouped together:

- `GET /api/v4/<parent-resource>/:parent_id/<relationship>`
- `POST /api/v4/<parent-resource>/:parent_id/<relationship>/:child_id`
- `PUT /api/v4/<parent-resource>/:parent_id/<relationship>/:child_id`
- `DELETE /api/v4/<parent-resource>/:parent_id/<relationship>/:child_id`

A GET list endpoint can have a vulnerability even when POST/PUT/DELETE are correctly authorized. Therefore, every method must be traced independently.

## No Feature-Level Shortcut

Do not say “Epics reviewed,” “Runners reviewed,” “Issues reviewed,” or “CI/CD reviewed” unless every endpoint/action in that feature was individually traced.

Feature-level review is not enough.

Route-level, method-level, and action-level review is required.

## No Representative Sampling

Do not review one route and assume sibling routes are safe.

Do not review one controller action and assume the rest of the controller is safe.

Do not review one GraphQL resolver and assume REST is safe.

Do not review one REST endpoint and assume GraphQL is safe.

Do not review one worker and assume all workers in the feature are safe.

Do not review one child-object endpoint and assume all relationship endpoints are safe.

Do not review one access-control pattern and assume related features are safe.

## Mandatory Missed-Endpoint Check

Before finalizing any feature, Phase 2 must answer:

1. Did I review every route listed in the Phase 1 Endpoint / Action Ledger?
2. Did I review every HTTP method separately?
3. Did I review every list/read/count endpoint, not only write endpoints?
4. Did I review every create/update/delete endpoint, not only read endpoints?
5. Did I review every GraphQL equivalent?
6. Did I review every REST equivalent?
7. Did I review every worker triggered by the route?
8. Did I review the serializer/entity/GraphQL type that returns data?
9. Did I check child-object visibility filtering?
10. Did I compare same-functionality implementations in other features?

If the answer to any item is no, the feature is not complete.

---

# Mandatory Phase 2 Endpoint / Action Review Ledger

For every feature, Phase 2 must maintain this ledger.

| Feature | Entry Point | Method / Trigger | File | Class / Method | Parent Auth Check | Child/Object Auth Check | Serializer/Response Check | Alternate Entry Points Checked | Same-Functionality Checked | Vulnerability Candidate? | Phase 2 Status | Notes |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| TBD | TBD | GET/POST/PUT/DELETE/GraphQL/Worker | TBD | TBD | TBD | TBD | TBD | TBD | TBD | Yes/No | Deep Reviewed / Finding / Potential / Suspicious / Gap | TBD |

Rules:

- One row per method, route, mutation, worker, or trigger.
- Do not merge related methods.
- Do not mark a feature complete if any row is missing.
- Do not mark a feature complete if any row is only `Gap`.
- List/count/read endpoints must receive the same depth as write endpoints.
- Child-object-returning endpoints must verify per-child visibility and serializer behavior.
- Relationship endpoints must verify both parent-side and child-side authorization.
- REST and GraphQL equivalent paths must be compared.

---

# Child-Object and Relationship Endpoint Review Rule

Phase 2 must deeply review endpoints that return or mutate child objects of a parent object.

Examples:

- parent object → child objects
- work item → child work items
- issue → notes
- merge request → pipelines
- project → runners
- group → projects
- group → epics
- project → members
- group → members
- vulnerability → issue
- pipeline → jobs
- job → artifacts
- package → package files
- environment → deployments

For every relationship endpoint, verify:

1. Parent object authorization.
2. Child object lookup.
3. Per-child object authorization.
4. Whether the child collection is filtered by current user.
5. Whether confidential/private/protected child objects are filtered.
6. Whether serializer/entity/GraphQL type enforces visibility.
7. Whether REST and GraphQL behave differently.
8. Whether list/read/count actions differ from write actions.
9. Whether cross-project, cross-group, or shared-resource relationships can leak data.

Parent authorization alone is never enough for child objects unless the code proves all child objects are guaranteed readable by the same permission.

---

# Forced Deepening Rule for `Mapped` Features

If Phase 2 encounters a Phase 1 feature with status `Mapped`, `Partial`, or anything less than `Deep Complete`, it must not proceed with a finding summary.

It must first perform deep endpoint-level tracing for that feature.

Output required:

```markdown
## Forced Deepening Performed

- Feature:
- Reason forced deepening was required:
- Routes/actions deepened:
- Files read:
- Authorization checks verified:
- Child-object filters verified:
- Same-functionality siblings checked:
- Remaining gaps:
```

---

# Final Coverage Integrity Check

Before producing the final Phase 2 report, perform this self-check:

```markdown
# Coverage Integrity Check

## Features Not Deep Reviewed

List every feature that was not deep reviewed.

## Endpoints Not Individually Traced

List every route/API/mutation/worker discovered but not individually traced.

## Methods Grouped Incorrectly

List any place where multiple HTTP methods or actions were grouped instead of separately reviewed.

## Relationship Endpoints Not Checked for Child Authorization

List relationship/list/count endpoints where child-object authorization was not verified.

## REST-vs-GraphQL Comparisons Not Completed

List REST/GraphQL equivalent paths that were not compared.

## Same-Functionality Families Not Completed

List functionality families where only one implementation was checked.

## Findings That May Exist Because of Gaps

List areas where more findings may exist because coverage is incomplete.
```

If this check reveals gaps, do not claim the review is complete. Report the gaps honestly and prioritize them.



---

# Mandatory Phase 2 Inventory Reconciliation Gate

Before reviewing vulnerabilities, Phase 2 must load the Phase 1 source inventories and Endpoint / Action Ledger.

Phase 2 must not rely only on feature summaries.

Phase 2 must verify that every source-of-truth inventory item has a Phase 2 disposition.

## Required Phase 2 Dispositions

Every route, API handler, GraphQL operation, worker, serializer, export/download path, search/count path, token path, and shared service must be placed into exactly one category:

1. Deep reviewed for access control
2. Finding reported
3. Potential/suspicious vulnerability candidate reported
4. Not security-relevant with reason
5. Duplicate of another reviewed path with exact reference
6. Not reachable/dead code with evidence
7. Gap/blocker requiring follow-up

No discovered item may be silently ignored.

## Phase 2 Source Inventory Reconciliation Matrix

Use this matrix before finalizing Phase 2:

| Inventory | Total Items From Phase 1 | Deep Reviewed | Finding / Potential / Suspicious | Not Security-Relevant | Duplicate Reviewed Elsewhere | Dead / Not Reachable | Gap / Blocker | Coverage % | Notes |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---|
| Rails routes | TBD | TBD | TBD | TBD | TBD | TBD | TBD | TBD | TBD |
| REST API routes | TBD | TBD | TBD | TBD | TBD | TBD | TBD | TBD | TBD |
| GraphQL operations/fields | TBD | TBD | TBD | TBD | TBD | TBD | TBD | TBD | TBD |
| Workers/async jobs | TBD | TBD | TBD | TBD | TBD | TBD | TBD | TBD | TBD |
| Services/finders/policies | TBD | TBD | TBD | TBD | TBD | TBD | TBD | TBD | TBD |
| Serializers/entities/presenters/types | TBD | TBD | TBD | TBD | TBD | TBD | TBD | TBD | TBD |
| Downloads/exports/archives | TBD | TBD | TBD | TBD | TBD | TBD | TBD | TBD | TBD |
| Search/count/aggregate paths | TBD | TBD | TBD | TBD | TBD | TBD | TBD | TBD | TBD |
| Tokens/actor paths | TBD | TBD | TBD | TBD | TBD | TBD | TBD | TBD | TBD |

## Route-Method Completeness Requirement

For every REST/Rails/API route, review by exact HTTP method and handler.

Do not group:

- `GET`
- `POST`
- `PUT`
- `PATCH`
- `DELETE`

The same URL pattern with different methods must have separate review rows because read/list/count behavior often has different authorization from write/delete behavior.

## Relationship Endpoint Hard Gate

Any endpoint returning a related object collection must explicitly verify child-object authorization.

Examples:

- epic issues
- work item children
- issue notes
- MR pipelines
- pipeline jobs
- job artifacts
- group projects
- project runners
- group runners
- package files
- deployments for environment
- vulnerability linked issues
- project/group members

For each, Phase 2 must answer:

- Is parent authorization checked?
- Is each child object individually filtered or authorized?
- Does the serializer/entity/GraphQL type perform per-object authorization?
- Does REST differ from GraphQL?
- Does list/count differ from create/update/delete?
- Can confidential/private/protected children leak through the parent?

If these answers are not documented, the endpoint is not reviewed.

## Shared-Service Caller Completeness Requirement

If a vulnerability pattern involves a service, finder, model method, serializer, worker, or helper used by multiple callers, Phase 2 must enumerate every caller.

Do not report only the first affected endpoint.

For each shared method, produce:

| Shared Method | Caller | Entry Point | Caller Auth Check | Callee Assumption | Affected? | Notes |
|---|---|---|---|---|---|---|

## Final Completeness Claim Rule

Phase 2 may only claim “complete” when:

- Source inventory reconciliation has no unexplained gaps.
- Endpoint / Action Review Ledger has no missing routes.
- Every feature has no `Mapped only` status.
- Every relationship endpoint has child-object authorization documented.
- Every REST-vs-GraphQL sibling was compared or explicitly marked N/A.
- Every shared service/finder/serializer has caller coverage.
- Every skipped item has a documented, evidence-backed reason.

If any item remains unknown, the final report must say:

> Coverage is incomplete. Additional findings may remain in the following unreviewed or partially reviewed areas.



---

# Anti-Hardcoding Rule for Known Misses

Any previously missed endpoint must be treated only as an example of a failure mode.

Do not hard-code one known route as the only regression target.

The generalized rule is:

- every route must be inventoried
- every HTTP method must be reviewed separately
- every relationship/list/count endpoint must check child-object authorization
- every parent-to-child response must verify per-child visibility
- every REST/Web/GraphQL/worker equivalent must be compared
- every same-functionality implementation must be checked

The agent must not satisfy this prompt by reviewing only one known missed route.

The agent must prove the whole class of similar routes, methods, and functionality was covered.


---


---


---

# Canonical 40-Pattern Coverage Gate

Phase 2 must apply the full canonical 40-pattern access-control catalog.

Phase 2 must not apply only a selected subset such as A-H.

Phase 2 must not rename, redefine, or renumber patterns.

Phase 2 must not invent local pattern names such as “A — parent-only authz” if that is not the canonical Pattern A.

Use the exact canonical pattern IDs and names below.

## Canonical Pattern IDs

| Pattern ID | Canonical Name |
|---|---|
| Pattern K | DECLARATIVE AUTH WITH NO ACTUAL ENFORCEMENT |
| Pattern A | EARLY RETURN SKIPS AUTHORIZATION |
| Pattern P | PROCESS IDENTITY SPOOFING |
| Pattern O | MULTI-STEP WORKFLOW APPROVAL BYPASS |
| Pattern L | ENFORCEMENT GAP ACROSS ENTRY POINTS |
| Pattern S | TOKEN SCOPE BOUNDARY LEAKS |
| Pattern B | UNSCOPED OBJECT LOOKUP |
| Pattern C | CONTAINER-LEVEL AUTH ON RESOURCE ENDPOINT |
| Pattern D | ACTION ENDPOINT RETURNS OBJECT WITHOUT AUTHORIZATION |
| Pattern E | MULTI-INTERFACE AUTHORIZATION MISMATCH |
| Pattern F | ROLE/PERMISSION ESCALATION VIA PARAMETER |
| Pattern G | CROSS-BOUNDARY VIA SHARED/IMPORTED MEMBERSHIP |
| Pattern H | FEATURE-DISABLED BUT DATA ACCESSIBLE |
| Pattern I | EXISTENCE ORACLE VIA ERROR DIFFERENTIATION |
| Pattern J | ASYNC JOB BYPASSES AUTHORIZATION |
| Pattern M | PERMISSION CHAIN / CUSTOM ROLE ESCALATION |
| Pattern N | IMPORT/BULK OPERATION SKIPS MODEL VALIDATIONS |
| Pattern Q | FORK/CLONE-BASED PERSISTENT ACCESS AFTER REVOCATION |
| Pattern R | CONTENT RENDERING CROSS-REFERENCE DATA LEAK |
| Pattern T | GIT/VCS-LEVEL OPERATIONS BYPASS APPLICATION AUTH |
| Pattern U | PROXY ENDPOINT HEADER/RESPONSE PASSTHROUGH |
| Pattern V | CREDENTIAL PERSISTENCE ON DESTINATION CHANGE |
| Pattern W | DERIVED TOKEN LIFETIME EXCEEDS PARENT |
| Pattern X | UNVERIFIED IDENTITY ATTRIBUTE MATCHING |
| Pattern Y | FORMAT/INTERFACE RESPONSE DIVERGENCE |
| Pattern Z | AI/LLM CONTEXT AUTHORIZATION BYPASS |
| Pattern 27 | SERVICE ACCOUNT / BOT PRIVILEGE LAUNDERING |
| Pattern 28 | RACE CONDITION / TOCTOU IN AUTHORIZATION |
| Pattern 29 | CACHED / STALE AUTHORIZATION DECISIONS |
| Pattern 30 | SOFT-DELETE / ARCHIVE / LIFECYCLE STATE BYPASS |
| Pattern 31 | DELEGATION / IMPERSONATION ABUSE |
| Pattern 32 | TRANSFER SOURCE-VS-DESTINATION AUTHORIZATION GAP |
| Pattern 33 | MASS ASSIGNMENT / OVER-POSTING BEYOND ROLE |
| Pattern 34 | TRANSACTION / PAYMENT FLOW AUTHORIZATION BYPASS |
| Pattern 35 | AUDIT LOG EVASION / INTEGRITY |
| Pattern 36 | DATA EXPORT / BULK ACCESS OVER-FETCH |
| Pattern 37 | GRAPHQL-SPECIFIC AUTHORIZATION GAPS |
| Pattern 38 | MULTI-TENANT SHARED INFRASTRUCTURE LEAKAGE |
| Pattern 39 | WEBHOOK / NOTIFICATION DATA OVER-EXPOSURE |
| Pattern 40 | PRIVILEGE ESCALATION VIA OBJECT RELATIONSHIP MANIPULATION |

## Full 40-Pattern Matrix Required Per Feature

Every Phase 2 feature review must include a full 40-row pattern matrix.

Every canonical pattern must appear exactly once.

Each pattern must be assigned one of:

- Applied — finding
- Applied — potential/suspicious
- Applied — no issue found
- Not applicable — with evidence-backed reason
- Gap/blocker — could not complete

Do not omit patterns.

Do not collapse patterns.

Do not rename patterns.

Do not mark `n/a` without explaining why the feature has no relevant code surface for that pattern.

Use this exact matrix:

| Pattern | Canonical Name | Applied To Code Surface | Result | Finding / Reference | Evidence | Gap / N/A Reason |
|---|---|---|---|---|---|---|
| Pattern K | DECLARATIVE AUTH WITH NO ACTUAL ENFORCEMENT | TBD | Applied / Not applicable | TBD | TBD | TBD |
| Pattern A | EARLY RETURN SKIPS AUTHORIZATION | TBD | Applied / Not applicable | TBD | TBD | TBD |
| Pattern P | PROCESS IDENTITY SPOOFING | TBD | Applied / Not applicable | TBD | TBD | TBD |
| Pattern O | MULTI-STEP WORKFLOW APPROVAL BYPASS | TBD | Applied / Not applicable | TBD | TBD | TBD |
| Pattern L | ENFORCEMENT GAP ACROSS ENTRY POINTS | TBD | Applied / Not applicable | TBD | TBD | TBD |
| Pattern S | TOKEN SCOPE BOUNDARY LEAKS | TBD | Applied / Not applicable | TBD | TBD | TBD |
| Pattern B | UNSCOPED OBJECT LOOKUP | TBD | Applied / Not applicable | TBD | TBD | TBD |
| Pattern C | CONTAINER-LEVEL AUTH ON RESOURCE ENDPOINT | TBD | Applied / Not applicable | TBD | TBD | TBD |
| Pattern D | ACTION ENDPOINT RETURNS OBJECT WITHOUT AUTHORIZATION | TBD | Applied / Not applicable | TBD | TBD | TBD |
| Pattern E | MULTI-INTERFACE AUTHORIZATION MISMATCH | TBD | Applied / Not applicable | TBD | TBD | TBD |
| Pattern F | ROLE/PERMISSION ESCALATION VIA PARAMETER | TBD | Applied / Not applicable | TBD | TBD | TBD |
| Pattern G | CROSS-BOUNDARY VIA SHARED/IMPORTED MEMBERSHIP | TBD | Applied / Not applicable | TBD | TBD | TBD |
| Pattern H | FEATURE-DISABLED BUT DATA ACCESSIBLE | TBD | Applied / Not applicable | TBD | TBD | TBD |
| Pattern I | EXISTENCE ORACLE VIA ERROR DIFFERENTIATION | TBD | Applied / Not applicable | TBD | TBD | TBD |
| Pattern J | ASYNC JOB BYPASSES AUTHORIZATION | TBD | Applied / Not applicable | TBD | TBD | TBD |
| Pattern M | PERMISSION CHAIN / CUSTOM ROLE ESCALATION | TBD | Applied / Not applicable | TBD | TBD | TBD |
| Pattern N | IMPORT/BULK OPERATION SKIPS MODEL VALIDATIONS | TBD | Applied / Not applicable | TBD | TBD | TBD |
| Pattern Q | FORK/CLONE-BASED PERSISTENT ACCESS AFTER REVOCATION | TBD | Applied / Not applicable | TBD | TBD | TBD |
| Pattern R | CONTENT RENDERING CROSS-REFERENCE DATA LEAK | TBD | Applied / Not applicable | TBD | TBD | TBD |
| Pattern T | GIT/VCS-LEVEL OPERATIONS BYPASS APPLICATION AUTH | TBD | Applied / Not applicable | TBD | TBD | TBD |
| Pattern U | PROXY ENDPOINT HEADER/RESPONSE PASSTHROUGH | TBD | Applied / Not applicable | TBD | TBD | TBD |
| Pattern V | CREDENTIAL PERSISTENCE ON DESTINATION CHANGE | TBD | Applied / Not applicable | TBD | TBD | TBD |
| Pattern W | DERIVED TOKEN LIFETIME EXCEEDS PARENT | TBD | Applied / Not applicable | TBD | TBD | TBD |
| Pattern X | UNVERIFIED IDENTITY ATTRIBUTE MATCHING | TBD | Applied / Not applicable | TBD | TBD | TBD |
| Pattern Y | FORMAT/INTERFACE RESPONSE DIVERGENCE | TBD | Applied / Not applicable | TBD | TBD | TBD |
| Pattern Z | AI/LLM CONTEXT AUTHORIZATION BYPASS | TBD | Applied / Not applicable | TBD | TBD | TBD |
| Pattern 27 | SERVICE ACCOUNT / BOT PRIVILEGE LAUNDERING | TBD | Applied / Not applicable | TBD | TBD | TBD |
| Pattern 28 | RACE CONDITION / TOCTOU IN AUTHORIZATION | TBD | Applied / Not applicable | TBD | TBD | TBD |
| Pattern 29 | CACHED / STALE AUTHORIZATION DECISIONS | TBD | Applied / Not applicable | TBD | TBD | TBD |
| Pattern 30 | SOFT-DELETE / ARCHIVE / LIFECYCLE STATE BYPASS | TBD | Applied / Not applicable | TBD | TBD | TBD |
| Pattern 31 | DELEGATION / IMPERSONATION ABUSE | TBD | Applied / Not applicable | TBD | TBD | TBD |
| Pattern 32 | TRANSFER SOURCE-VS-DESTINATION AUTHORIZATION GAP | TBD | Applied / Not applicable | TBD | TBD | TBD |
| Pattern 33 | MASS ASSIGNMENT / OVER-POSTING BEYOND ROLE | TBD | Applied / Not applicable | TBD | TBD | TBD |
| Pattern 34 | TRANSACTION / PAYMENT FLOW AUTHORIZATION BYPASS | TBD | Applied / Not applicable | TBD | TBD | TBD |
| Pattern 35 | AUDIT LOG EVASION / INTEGRITY | TBD | Applied / Not applicable | TBD | TBD | TBD |
| Pattern 36 | DATA EXPORT / BULK ACCESS OVER-FETCH | TBD | Applied / Not applicable | TBD | TBD | TBD |
| Pattern 37 | GRAPHQL-SPECIFIC AUTHORIZATION GAPS | TBD | Applied / Not applicable | TBD | TBD | TBD |
| Pattern 38 | MULTI-TENANT SHARED INFRASTRUCTURE LEAKAGE | TBD | Applied / Not applicable | TBD | TBD | TBD |
| Pattern 39 | WEBHOOK / NOTIFICATION DATA OVER-EXPOSURE | TBD | Applied / Not applicable | TBD | TBD | TBD |
| Pattern 40 | PRIVILEGE ESCALATION VIA OBJECT RELATIONSHIP MANIPULATION | TBD | Applied / Not applicable | TBD | TBD | TBD |

## Per-Endpoint Pattern Sweep Rule

For every endpoint/action/mutation/worker/search/count/export/token path, Phase 2 must consider every canonical pattern.

The output does not need a separate 40-row table for every single endpoint if that would be too large, but the feature-level 40-pattern matrix must clearly show which endpoints/files/methods were considered for each pattern.

For high-risk endpoints and any finding candidate, include a path-level pattern checklist:

| Entry Point / Method | Pattern ID | Relevant? | Result | Evidence |
|---|---|---|---|---|
| TBD | Pattern K | Yes/No | TBD | TBD |
| TBD | Pattern A | Yes/No | TBD | TBD |
| TBD | Pattern P | Yes/No | TBD | TBD |
| TBD | Pattern O | Yes/No | TBD | TBD |
| TBD | Pattern L | Yes/No | TBD | TBD |
| TBD | Pattern S | Yes/No | TBD | TBD |
| TBD | Pattern B | Yes/No | TBD | TBD |
| TBD | Pattern C | Yes/No | TBD | TBD |
| TBD | Pattern D | Yes/No | TBD | TBD |
| TBD | Pattern E | Yes/No | TBD | TBD |
| TBD | Pattern F | Yes/No | TBD | TBD |
| TBD | Pattern G | Yes/No | TBD | TBD |
| TBD | Pattern H | Yes/No | TBD | TBD |
| TBD | Pattern I | Yes/No | TBD | TBD |
| TBD | Pattern J | Yes/No | TBD | TBD |
| TBD | Pattern M | Yes/No | TBD | TBD |
| TBD | Pattern N | Yes/No | TBD | TBD |
| TBD | Pattern Q | Yes/No | TBD | TBD |
| TBD | Pattern R | Yes/No | TBD | TBD |
| TBD | Pattern T | Yes/No | TBD | TBD |
| TBD | Pattern U | Yes/No | TBD | TBD |
| TBD | Pattern V | Yes/No | TBD | TBD |
| TBD | Pattern W | Yes/No | TBD | TBD |
| TBD | Pattern X | Yes/No | TBD | TBD |
| TBD | Pattern Y | Yes/No | TBD | TBD |
| TBD | Pattern Z | Yes/No | TBD | TBD |
| TBD | Pattern 27 | Yes/No | TBD | TBD |
| TBD | Pattern 28 | Yes/No | TBD | TBD |
| TBD | Pattern 29 | Yes/No | TBD | TBD |
| TBD | Pattern 30 | Yes/No | TBD | TBD |
| TBD | Pattern 31 | Yes/No | TBD | TBD |
| TBD | Pattern 32 | Yes/No | TBD | TBD |
| TBD | Pattern 33 | Yes/No | TBD | TBD |
| TBD | Pattern 34 | Yes/No | TBD | TBD |
| TBD | Pattern 35 | Yes/No | TBD | TBD |
| TBD | Pattern 36 | Yes/No | TBD | TBD |
| TBD | Pattern 37 | Yes/No | TBD | TBD |
| TBD | Pattern 38 | Yes/No | TBD | TBD |
| TBD | Pattern 39 | Yes/No | TBD | TBD |
| TBD | Pattern 40 | Yes/No | TBD | TBD |

## Partial Pattern Coverage Is Failure

The following is not acceptable:

```markdown
## Pattern coverage applied
| Pattern | Applied to | Result |
| A | parent-only authz | reviewed |
| B | route/token mismatch | no issue |
| C | service-delegated authz | no issue |
| E | bulk | n/a |
| G | bot actor | no issue |
| H | token confusion | no issue |
```

This is invalid because:

- it omits most canonical patterns
- it renames pattern meanings
- it does not show Pattern K, L, S, I, J, M-Z, 27-40
- it can hide unreviewed bug classes
- it does not provide an evidence-backed `not applicable` reason for omitted patterns

If Phase 2 produces partial pattern coverage, the feature is incomplete.

## Pattern Name Consistency Rule

If a local shorthand is useful, it may be added only after the canonical ID and canonical name.

Valid:

```markdown
Pattern C — CONTAINER-LEVEL AUTH ON RESOURCE ENDPOINT — local note: parent/child relationship list
```

Invalid:

```markdown
Pattern A — parent-only authz on child/list
```

Pattern A must always mean `EARLY RETURN SKIPS AUTHORIZATION`.

## Final Pattern Count Check

Every feature must end with:

```markdown
# Pattern Count Check

- Canonical patterns required: 40
- Pattern rows present: 40
- Patterns applied with finding/potential/suspicious:
- Patterns applied with no issue:
- Patterns marked not applicable with evidence:
- Patterns marked gap/blocker:
- Renamed/non-canonical patterns used: Yes/No
- Result: PASS/FAIL

If Pattern rows present is not 40, the feature review is incomplete.
If renamed/non-canonical patterns were used, the feature review is incomplete.
```


# Phase 2 Full Feature-Code Sweep Gate

Phase 2 must perform a full code review of each feature, not only a review of selected endpoint rows.

When Phase 2 opens a Phase 1 feature map, it must treat that feature map as a launch point into the full source code.

The reviewer must read and trace the complete code surface for that feature across:

- Web routes and controllers
- REST API / Grape endpoints
- GraphQL queries
- GraphQL mutations
- GraphQL resolvers
- GraphQL types and fields
- Workers and async jobs
- Services
- Finders
- Models
- Policies and abilities
- Serializers
- Entities
- Presenters
- Helpers
- Concerns
- Validators and form objects
- Mailers and notifications
- Import/export paths
- Download/archive/generated-resource paths
- Search/count/aggregate paths
- Token and actor-selection paths
- Shared infrastructure used by the feature
- Same-functionality code in other features

Phase 2 must not only review rows marked High priority.

Phase 2 must not only review rows already flagged as suspicious.

Phase 2 must not only review files listed in a summary table.

Phase 2 must open and read the actual source code behind the full feature.

## No `Mapped`, `Traced`, or `GAP` Can Remain Unresolved

Phase 1 feature maps may contain statuses such as:

- `Discovered`
- `Mapped`
- `Traced`
- `GAP`
- `Verify`
- `Needs trace`
- `Not deeply traced`
- `Phase 2`
- `Flag P2`
- `Unmapped`
- `Assumption`
- `Required follow-up`

Phase 2 must treat every one of these as mandatory work.

A Phase 2 feature review is not complete until each such item is converted into one of:

- Deep reviewed — no issue found
- Confirmed vulnerability
- Potential vulnerability requiring dynamic validation
- Suspicious vulnerable-looking path requiring deeper review
- Duplicate / covered by exact referenced row
- Not security-relevant with evidence
- Dead / unreachable code with evidence
- Gap / blocker with exact reason

If any Phase 1 `Mapped`, `Traced`, `Discovered`, `GAP`, `Verify`, `Unmapped`, or `Required follow-up` item remains unresolved, Phase 2 is incomplete.

## Full Feature File Coverage Rule

For every feature, Phase 2 must build a file coverage ledger from the Phase 1 feature map.

Every file listed in Phase 1 must receive a Phase 2 disposition.

If Phase 2 discovers additional related files while tracing, those files must be added to the ledger.

| Feature | File Path | File Type | Important Classes/Methods | Read in Phase 2? | Callers/Callees Traced? | AuthZ-Relevant? | Phase 2 Disposition | Evidence / Gap |
|---|---|---|---|---|---|---|---|---|
| TBD | TBD | Controller/API/GraphQL/Worker/Service/Finder/Model/Policy/Serializer/Other | TBD | Yes/No | Yes/No | Yes/No | TBD | TBD |

Rules:

- Every file listed in Phase 1 must appear in this matrix.
- Every newly discovered file must be added.
- A file cannot be marked reviewed just because its name appeared in Phase 1.
- A file cannot be marked reviewed unless relevant methods were opened and traced.
- If a file contains multiple security-relevant methods, each method must be accounted for.
- If the file is excluded, the reason must be evidence-backed.

## Full Method-Level Review Rule

For each feature file, Phase 2 must identify security-relevant methods and trace them.

Security-relevant methods include methods that:

- handle request/action/trigger
- perform object lookup
- choose current actor/user/token
- check authorization
- check authentication
- call policy/ability logic
- filter collections
- serialize or expose data
- create/update/delete/link/unlink/reorder/move resources
- enqueue workers
- generate exports/downloads/reports
- search/count/aggregate data
- call shared services
- bypass validation/callbacks
- accept user-controlled parameters
- return child objects
- choose parent/child relationships
- enforce feature/license/visibility checks

Use this matrix:

| Feature | File | Method | Purpose | User-Controlled Inputs | Object Lookup | Auth/AuthZ Check | Response/State Change | Callers | Callees | Phase 2 Disposition | Notes |
|---|---|---|---|---|---|---|---|---|---|---|---|
| TBD | TBD | TBD | TBD | TBD | TBD | TBD | TBD | TBD | TBD | TBD | TBD |

A feature is incomplete if security-relevant methods are not traced.

## Interface Completeness Rule

For each feature, Phase 2 must explicitly cover the full interface picture:

| Interface | Required Coverage |
|---|---|
| Web | routes, controllers, before_actions, concerns, helpers, views/preload data, serializers |
| REST API | Grape resources, route_setting authorization, helpers, params, entities, pagination/count headers |
| GraphQL | queries, mutations, resolvers, types, fields, batch loaders, authorize declarations, ready/authorized/resolve methods |
| Workers | enqueue callers, input IDs, actor/user context, execution-time authorization, system/bot context |
| Services | every caller, assumed authorization, object lookup, side effects, validation bypass |
| Finders | current_user scoping, visibility filtering, confidentiality filtering, skip flags |
| Policies/Abilities | exact ability names, object checked, parent-vs-child boundaries, custom-role behavior |
| Serializers/Entities/Presenters | field-level authorization, nested object filtering, count/metadata leakage |
| Search/Counts | visibility filtering, stale index, count leaks, pagination header leaks |
| Downloads/Exports | authorization before generation and before download/reuse |
| Tokens/Actors | scope, owner, actor, expiry, revocation, namespace/project boundary |

If any interface exists for the feature and is not reviewed, the feature is incomplete.

## End-to-End Code Path Rule

For each endpoint/action/mutation/worker, Phase 2 must trace end-to-end:

1. Entry point
2. Authentication
3. Actor/current_user/token
4. Params and user-controlled identifiers
5. Parent object lookup
6. Child object lookup
7. Finder/filter behavior
8. Policy/ability checks
9. Service calls
10. Model methods
11. Workers enqueued
12. Serializer/entity/type output
13. Data returned or state changed
14. Error/alternate branches
15. Equivalent Web/REST/GraphQL/worker paths
16. Same-functionality implementations in other features

Do not stop at the first authorization check.

Do not stop at the parent object.

Do not stop at the controller/API layer.

Do not stop at route declarations.

Do not stop at GraphQL `authorize` declarations.

Do not stop at service names.

Read the code.

## Phase 2 Feature Completion Gate

A feature may be marked complete only when all of the following are true:

1. Every Phase 1 endpoint/action row has a Phase 2 disposition.
2. Every Phase 1 file row has a Phase 2 disposition.
3. Every Phase 1 `Mapped`, `Traced`, `Discovered`, `GAP`, `Verify`, `Unmapped`, or `Required follow-up` item is resolved.
4. Every Web route/controller path is reviewed.
5. Every REST API path is reviewed.
6. Every GraphQL query/mutation/resolver/type path is reviewed.
7. Every worker/async path is reviewed.
8. Every service/finder/model/policy/serializer path used by the feature is reviewed.
9. Every child-object/relationship/list/count path has child-object authorization checked.
10. Every same-functionality sibling is reviewed or listed as a gap.
11. Every skipped item has an evidence-backed reason.
12. The row-count consistency check has zero unmatched Phase 1 rows.
13. The file coverage ledger has zero unresolved files.
14. The method coverage ledger has zero unresolved security-relevant methods.

If any condition is false, the report must say:

> Feature coverage is incomplete. Additional vulnerabilities may remain in the unresolved files, methods, endpoints, or same-functionality paths listed below.

## Required Per-Feature Final Section

Every Phase 2 feature review must end with this section:

```markdown
# Feature Completion Gate Result

## Endpoint Row Coverage

- Total Phase 1 endpoint/action rows:
- Phase 2 reviewed rows:
- Unmatched rows:
- Result: PASS/FAIL

## File Coverage

- Total Phase 1 files:
- Additional files discovered:
- Files read in Phase 2:
- Files unresolved:
- Result: PASS/FAIL

## Method Coverage

- Security-relevant methods identified:
- Methods traced:
- Methods unresolved:
- Result: PASS/FAIL

## Interface Coverage

| Interface | Exists? | Fully Reviewed? | Gaps |
|---|---|---|---|
| Web | Yes/No | Yes/No | TBD |
| REST API | Yes/No | Yes/No | TBD |
| GraphQL | Yes/No | Yes/No | TBD |
| Workers | Yes/No | Yes/No | TBD |
| Services | Yes/No | Yes/No | TBD |
| Finders | Yes/No | Yes/No | TBD |
| Policies/Abilities | Yes/No | Yes/No | TBD |
| Serializers/Entities | Yes/No | Yes/No | TBD |
| Search/Count | Yes/No | Yes/No | TBD |
| Download/Export | Yes/No | Yes/No | TBD |
| Tokens/Actors | Yes/No | Yes/No | TBD |

## Unresolved Phase 1 Items

List every unresolved `Mapped`, `Traced`, `Discovered`, `GAP`, `Verify`, `Unmapped`, or `Required follow-up` item.

## Completion Decision

Complete / Incomplete

If incomplete, state:

> This feature is not fully reviewed. Additional access-control vulnerabilities may remain.
```



---

# Strict Mode When Phase 1 Was Already Run

Sometimes Phase 1 has already been run and Phase 2 starts from existing Phase 1 feature-map files.

In that case, Phase 2 must still enforce the full Phase 2 process.

Existing Phase 1 output is not proof of security review.

Existing Phase 1 output is only input material.

## Required Inputs From Existing Phase 1

When running Phase 2 from existing Phase 1 output, load every available Phase 1 artifact:

- feature map files
- endpoint/action ledgers
- file coverage lists
- authorization maps
- data exposure maps
- worker maps
- same-functionality maps
- security-sensitive area lists
- required follow-up sections
- unmapped file lists
- gap lists
- assumptions
- source inventory coverage matrices if present

Do not run Phase 2 from only a summary.

## If Existing Phase 1 Is Incomplete

If a Phase 1 feature file lacks any of the following, Phase 2 must reconstruct the missing data before reviewing vulnerabilities:

- endpoint/action ledger
- file list
- Web/REST/GraphQL/worker entry point list
- service/finder/policy/serializer list
- same-functionality map
- gap/follow-up list
- unresolved mapped/traced/discovered items

The missing data must be reconstructed from source code, not guessed.

## Existing Phase 1 Does Not Reduce Pattern Coverage

Even when Phase 1 already exists, Phase 2 must still apply the full canonical 40-pattern matrix to every feature.

Do not apply only A-H.

Do not apply only patterns mentioned by Phase 1.

Do not apply only patterns that seem relevant from the summary.

Do not skip patterns because the Phase 1 output looks deep.

Every feature must still include exactly 40 canonical pattern rows.

## Existing Phase 1 Does Not Reduce Code Coverage

Even when Phase 1 already exists, Phase 2 must still perform:

- reverse-check of every Phase 1 endpoint/action row
- full feature-code sweep
- file coverage ledger
- method-level coverage ledger
- interface coverage matrix
- unresolved Phase 1 item resolution
- shared-service caller coverage
- row-count consistency check
- canonical 40-pattern count check

## Phase 2 Starting Checklist for Existing Phase 1

Before reviewing any vulnerability, Phase 2 must produce:

```markdown
# Existing Phase 1 Intake Check

- Phase 1 feature files loaded:
- Endpoint/action ledgers found:
- File lists found:
- Web entry points found:
- REST API entry points found:
- GraphQL entry points found:
- Workers/async paths found:
- Services/finders/policies/serializers found:
- Same-functionality maps found:
- Gaps/follow-ups found:
- Missing Phase 1 sections that must be reconstructed:
- Result: PASS/FAIL
```

If the result is FAIL, Phase 2 must reconstruct the missing Phase 1 inventory pieces before continuing.

## No Completion From Existing Phase 1 Alone

Phase 2 must not say:

- “Phase 1 already mapped this, so no need to check.”
- “Phase 1 marked this AuthZ Verified, so no Phase 2 review needed.”
- “Only high-priority Phase 1 rows need pattern review.”
- “Only the patterns mentioned by Phase 1 need to be applied.”

These statements are invalid.

Phase 2 must independently review the source code for access-control vulnerabilities.

# Phase 2 Reverse-Check Gate — Every Phase 1 Row Must Be Tested

Phase 2 must reverse-check every endpoint, action, mutation, worker, serializer, search/count path, export/download path, and shared-service row produced by Phase 1.

Phase 2 must not only review high-priority rows.

Phase 2 must not only review rows marked as suspicious.

Phase 2 must not only review rows marked as gaps.

Phase 2 must review **all mapped Phase 1 rows** and assign a Phase 2 disposition to each.

## Mandatory Left-Join Rule

Phase 2 must perform a left-join from the Phase 1 inventory/ledger to the Phase 2 review ledger.

For every row in Phase 1:

- there must be exactly one matching Phase 2 review row, or
- the row must be explicitly marked as merged into another Phase 2 row with an exact reference and reason.

If a Phase 1 row has no Phase 2 row, Phase 2 is incomplete.

## Phase 2 Disposition Required for Every Phase 1 Row

Every Phase 1 ledger row must receive one of these Phase 2 dispositions:

| Phase 2 Disposition | Meaning |
|---|---|
| Deep reviewed — no issue found | Full code path reviewed; no access-control vulnerability found |
| Confirmed vulnerability | Source-confirmed vulnerable code path |
| Potential vulnerability | Strong candidate requiring dynamic validation |
| Suspicious vulnerable-looking path | Concrete suspicious access-control path requiring deeper follow-up |
| Duplicate / covered by another reviewed row | Must include exact referenced row |
| Not security-relevant | Must include evidence-backed reason |
| Dead / unreachable code | Must include evidence-backed reason |
| Gap / blocker | Could not complete; must be listed as incomplete coverage |

No Phase 1 row may be left without a disposition.

## Phase 1 Status Does Not Exempt Phase 2 Review

Phase 2 must review rows regardless of Phase 1 status.

Rows with these statuses require special handling:

- `Discovered` → must be deepened or marked as blocker
- `Mapped` → must be deepened; mapped is not reviewed
- `Traced` → must verify authz, child-object filtering, serializer behavior, and same-functionality siblings
- `AuthZ Verified` → must still be vulnerability-reviewed against Phase 2 patterns
- `Deep Complete` → must still be checked against Phase 2 access-control patterns and source-confirmed assumptions

Phase 2 must not skip a row because Phase 1 looked complete.

## Full Endpoint Testing Rule

For every endpoint/action row, Phase 2 must test for access-control vulnerability by checking:

1. exact route/method/mutation/worker
2. actor/current_user/token context
3. parent object authorization
4. child object authorization
5. object lookup scope
6. policy/ability correctness
7. service-level assumptions
8. shared-service callers
9. serializer/entity/GraphQL response filtering
10. background jobs triggered
11. alternate REST/Web/GraphQL/worker/download/search path
12. same-functionality implementations in other features
13. list/read/count vs create/update/delete differences
14. confidential/private/protected/disabled feature behavior
15. token, role, membership, and namespace boundary behavior

## Phase 2 Reverse-Check Matrix

Phase 2 must include this matrix in the final report.

| Phase 1 Feature | Phase 1 Row ID / Entry Point | Phase 1 Status | Phase 2 Reviewed? | Phase 2 Disposition | Finding ID / Reference | Evidence | Remaining Gap |
|---|---|---|---|---|---|---|---|
| TBD | TBD | Discovered / Mapped / Traced / AuthZ Verified / Deep Complete | Yes/No | TBD | TBD | TBD | TBD |

## Row-Count Consistency Check

At the end of Phase 2, report:

```markdown
# Phase 2 Row-Count Consistency Check

- Total Phase 1 ledger rows:
- Total Phase 2 matched rows:
- Total duplicate/merged rows:
- Total unmatched Phase 1 rows:
- Total new Phase 2 rows discovered:
- Completion status:

If `Total unmatched Phase 1 rows` is greater than zero, Phase 2 is incomplete.
```

## New Rows Discovered During Phase 2

If Phase 2 discovers an endpoint/action/path that Phase 1 missed:

1. Add it to the Phase 2 ledger.
2. Mark it as `Phase 1 miss discovered during Phase 2`.
3. Deep-review it immediately.
4. Add it to the final coverage integrity check.
5. State that Phase 1 inventory was incomplete.

## No Final Completion Without Reverse-Check

Phase 2 may not claim completion unless:

- every Phase 1 row has a Phase 2 disposition
- every HTTP method is reviewed separately
- every relationship/list/count endpoint has child-object authorization checked
- every REST/Web/GraphQL/worker equivalent is compared or marked N/A
- every shared-service caller is enumerated or marked as a gap
- row-count consistency check has zero unmatched Phase 1 rows

If these conditions are not met, the report must say:

> Phase 2 is incomplete. Some Phase 1 mapped endpoints/actions were not fully reverse-checked.


## Phase 2 Access-Control Review Goal

For each feature, determine whether a user can perform an action or access data they should not be able to access.

Focus on:

- Missing authorization checks
- Incorrect permission checks
- Authorization performed in one entry point but missing in another
- Inconsistent authorization between Web, REST API, GraphQL, background jobs, services, and internal callers
- Object-level authorization bypass
- IDOR / BOLA
- Broken function-level authorization
- Privilege escalation
- Horizontal access-control bypass
- Vertical access-control bypass
- Group/project/namespace boundary bypass
- Admin-only action exposed to non-admin users
- Private project/group/resource data exposure
- Confidential issue or private discussion exposure
- Repository access bypass
- Protected branch or protected tag bypass
- Merge request permission bypass
- Wiki, snippet, package, registry, artifact, export, report, or pipeline permission bypass
- CI/CD job token permission abuse
- Token scope bypass
- Background job authorization bypass
- Import/export authorization bypass
- Webhook/integration authorization bypass
- GraphQL resolver or mutation authorization bypass
- Serializer/entity field leakage
- Search/index authorization mismatch
- Cached/generated resource access leakage
- Confused deputy issues
- Same-functionality variant bugs in other features

---

# Phase 2 Required Workflow

For each feature from Phase 1:

## Step 1: Load Phase 1 Map

Read the Phase 1 feature map.

Use it to identify:

- entry points
- files
- code paths
- authorization checks
- same-functionality links
- shared dependencies
- known gaps

## Step 2: Re-Trace Security-Sensitive Paths

Do not trust the Phase 1 map blindly.

For security conclusions, verify current code directly.

## Step 3: Apply Access-Control Patterns

Apply all relevant patterns from the catalog below.

## Step 4: Compare Same Functionality

Use the Phase 1 same-functionality map.

If a pattern is found in one feature, review all similar implementations in other features.

## Step 5: Produce Finding or Safe Conclusion

Classify each reviewed path internally, but do **not** report every reviewed path as a finding.

Only create a finding when the reviewed code path is one of:

- Confirmed vulnerability
- Potential vulnerability requiring dynamic validation
- Suspicious vulnerable-looking code path requiring deeper review

Do **not** create finding entries for:

- No issue found after full trace
- Expected authorization behavior
- Correctly protected code
- Generic observations
- Theoretical issues without code evidence
- Informational notes
- Low-confidence guesses

Safe or non-vulnerable paths should be summarized only in coverage matrices, not written as findings.

A reported item must have concrete code-path evidence and a plausible unauthorized access-control impact.

---

# Access-Control Pattern Catalog for Phase 2

Apply these patterns to every feature where relevant.

## Pattern A: Early Return Skips Authorization

Look for no-op, same-target, already-done, unchanged, or early-return paths that return before authorization.

Vulnerability condition:

1. Object is fetched before read permission is checked.
2. Service returns early before authorization.
3. Endpoint serializes or returns the object.

Review move, transfer, reassign, link, unlink, clone, import, retarget, retry, approve, update, reorder, duplicate, and restore flows.

## Pattern B: Unscoped Object Lookup

Look for raw object lookup without scoping to current user or without post-fetch authorization.

Review user-controlled IDs such as project_id, group_id, namespace_id, user_id, issue_id, merge_request_id, epic_id, note_id, runner_id, job_id, pipeline_id, artifact_id, token_id, environment_id, deployment_id, package_id, file_path, branch, tag, ref, sha, gid, and global_id.

## Pattern C: Parent Auth Without Child Auth

Look for authorization on project/group/namespace only, followed by access to a child object with its own visibility or permission rules.

Review confidential, private, internal, restricted, protected, archived, locked, hidden, disabled, external, draft, or security-sensitive child objects.

## Pattern D: Action Endpoint Returns Object Without Authorization

Look for write/action endpoints that fetch a sensitive object, fail the action, but still serialize or return the object.

Review POST, PUT, PATCH, DELETE, GraphQL mutations, validation errors, partial success responses, and entity/serializer output in error responses.

## Pattern E: Multi-Interface Authorization Mismatch

Compare the same resource across Web, REST API, GraphQL, export, search, download, email, background jobs, Git/VCS, and AI/Duo paths.

## Pattern F: Role or Permission Escalation via Parameter

Review user-controlled role, access_level, permission, member_role_id, custom_role, admin, owner, user_id, group_id, namespace_id, scopes, expires_at, protected, and visibility_level parameters.

## Pattern G: Cross-Boundary via Shared or Imported Membership

Review shared groups, shared projects, inherited membership, imported users, transferred projects, bulk membership operations, and custom roles.

## Pattern H: Feature Disabled but Data Accessible

Check whether disabled features still expose data through API, GraphQL, search, export, dashboard, reports, widgets, email, or background jobs.

## Pattern I: Existence Oracle via Error Differentiation

Check for different responses between not found, forbidden, unauthorized, validation failure, different timing, different counts, different messages, different HTTP status, or different GraphQL errors.

## Pattern J: Async Job Bypasses Authorization

Review enqueue-time and execution-time authorization for all workers and jobs.

## Pattern K: Declarative Auth With No Actual Enforcement

Review route settings, before_actions, GraphQL authorization declarations, API helpers, token allowlists, and metadata-only permission declarations.

Verify runtime enforcement.

## Pattern L: Enforcement Gap Across Entry Points

Compare enforcement of blocked user, banned user, deactivated user, external user, SSO, SAML, 2FA, IP restriction, password expiry, terms acceptance, admin mode, feature flags, licensed features, and namespace restrictions across all entry points.

## Pattern M: Permission Chain / Custom Role Escalation

Review custom roles, permission definitions, policy chains, controller-level gates, and narrow permissions unlocking broad backend actions.

## Pattern N: Import/Bulk Operation Skips Model Validations

Review skip_validation, skip_authorization, skip_callbacks, importing: true, bulk: true, save(validate: false), insert_all, upsert_all, raw SQL, and unsafe creation paths.

## Pattern O: Multi-Step Workflow Approval Bypass

Review approval workflows where approval may persist after content, branch, ref, target, source, fork, policy config, or pipeline config changes.

## Pattern P: Process Identity Spoofing

Review how pipeline user, trigger user, mirror user, import user, author, committer, creator, owner, branch deletion user, bot user, system user, scheduled job owner, security policy bot, or job token actor is selected.

## Pattern Q: Fork/Clone Persistent Access After Revocation

Review forks, clones, templates, mirrors, upstream sync, pull mirroring, copied resources, and visibility changes.

## Pattern R: Content Rendering Cross-Reference Data Leak

Review Markdown, rich text, references, mentions, quick actions, links, previews, emails, notifications, and AI summaries.

## Pattern S: Token Scope Boundary Leak

Review PAT, project access token, group access token, deploy token, trigger token, CI/CD job token, OAuth token, impersonation token, Workhorse JWT, runner token, and session token usage.

## Pattern T: Git/VCS-Level Operations Bypass Application Auth

Review refs, branches, tags, protected refs, ambiguous refs, replace refs, notes refs, push rules, hooks, raw files, archive downloads, compare, mirrors, and deploy keys.

## Pattern U: Proxy Endpoint Header/Response Passthrough

Review proxy, relay, dependency proxy, external fetch, preview, import, integration, and webhook test endpoints.

## Pattern V: Credential Persistence on Destination Change

Review integrations, webhooks, external service configs, callback URLs, mirror URLs, import URLs, and notification endpoints.

## Pattern W: Derived Token Lifetime Exceeds Parent

Review session-to-JWT, PAT-to-registry-token, job-token-to-downstream-token, OAuth refresh-to-access-token, runner-token-to-job-credential, Workhorse JWT, and temporary archive/download tokens.

## Pattern X: Unverified Identity Attribute Matching

Review identity matching by email, username, external UID, SAML identity, SCIM identity, OAuth identity, commit email, service desk email, and invitation email.

## Pattern Y: Format / Interface Response Divergence

Review JSON, XML, CSV, Atom/RSS, patch/diff, PDF, raw, archive, GraphQL, export, email, and HTML data attributes.

## Pattern Z: AI/LLM Context Authorization Bypass

Review AI/Duo features, summarization, chat, code suggestions, semantic search, embeddings, RAG, prompts, and AI-generated explanations.

## Pattern 27: Service Account / Bot Privilege Laundering

Review bot users, service accounts, machine users, project bots, group bots, automation users, and service account tokens.

## Pattern 28: Race Condition / TOCTOU in Authorization

Review check-then-act flows where permission may change between check and action.

## Pattern 29: Cached / Stale Authorization Decisions

Review permission caches, Redis caches, session-stored roles, JWT claims, memoized ability checks, cached memberships, cached visibility, and feature availability caches.

## Pattern 30: Search / Index Authorization Mismatch

Review global search, project search, group search, advanced search, Elasticsearch indexing, snippets, issues, MRs, code search, package search, and AI semantic search.

## Pattern 31: Export / Report / Archive Authorization Bypass

Review project export, group export, user export, compliance reports, audit reports, CSV exports, pipeline artifacts, archive downloads, package archives, and generated bundles.

## Pattern 32: Notification / Email / Webhook Data Leak

Review emails, notifications, webhooks, system hooks, Slack integrations, Jira integrations, issue-by-email, service desk, and alerting.

## Pattern 33: Admin Mode / Elevated Session Bypass

Review admin-only operations and admin mode enforcement across Web, REST API, GraphQL, workers, and tokens.

## Pattern 34: Visibility Change Does Not Cascade

Review project/group/resource visibility changes and whether caches, forks, exports, artifacts, packages, pages, wikis, snippets, search indexes, and archives update correctly.

## Pattern 35: Relationship Mutation Without Dual-Side Authorization

Review actions that connect two objects, such as issue-to-epic, runner-to-project, vulnerability-to-issue, project-to-group, project sharing, deploy key linking, environment/deployment linking, and package/artifact linking.

## Pattern 36: Indirect Privileged Action Trigger

Review actions where a low-privileged user can indirectly trigger privileged behavior through pipelines, bots, workers, mirrors, imports, exports, webhooks, scans, policies, deployments, or notifications.

## Pattern 37: Serializer / Entity / Presenter Field Leak

Review REST entities, serializers, presenters, GraphQL types, view models, frontend preload data, and HTML data attributes.

## Pattern 38: Count / Aggregate / Metadata Leak

Review counts, badges, dashboard widgets, statistics, analytics, health status, pipeline status, issue counts, MR counts, vulnerability counts, package counts, and search counts.

## Pattern 39: License / Plan / Feature Entitlement Bypass

Review licensed/paid features, namespace entitlements, subscription checks, trial/expired plan behavior, frontend-only restrictions, API/GraphQL bypass, and background job bypass.

## Pattern 40: Unmapped Shared Infrastructure Used by Feature

Review shared helpers, concerns, finders, services, workers, serializers, and model methods used by multiple features.

---



---

# Mandatory CVSS Scoring Gate for Findings

Every Phase 2 confirmed vulnerability, potential vulnerability, and suspicious vulnerable-looking code path must include a CVSS assessment.

Do not report a finding without:

- CVSS vector
- CVSS score
- severity
- score status
- confidence
- metric-by-metric justification

For source-confirmed findings that are not dynamically validated yet, mark the score as:

> Provisional CVSS — source-confirmed, dynamic validation pending.

For suspicious paths that require deeper validation, mark the score as:

> Provisional CVSS — suspicious path, exploitability pending.

## Required CVSS Output

Each finding must include:

```markdown
## CVSS Assessment

- CVSS Vector:
- CVSS Score:
- Severity:
- Score Status: Final / Provisional — source-confirmed dynamic validation pending / Provisional — suspicious path exploitability pending
- Confidence: High / Medium / Low

| Metric | Value | Reason |
|---|---|---|
| AV | N/A/L/P | TBD |
| AC | L/H | TBD |
| PR | N/L/H | TBD |
| UI | N/R | TBD |
| S | U/C | TBD |
| C | N/L/H | TBD |
| I | N/L/H | TBD |
| A | N/L/H | TBD |
```

## Severity Bands

| Score Range | Severity |
|---|---|
| 0.0 | None |
| 0.1–3.9 | Low |
| 4.0–6.9 | Medium |
| 7.0–8.9 | High |
| 9.0–10.0 | Critical |

## Metric Definitions

### Attack Vector — AV

| Metric | Definition | Examples |
|---|---|---|
| AV:N | Attack is triggered by making a network request to GitLab.com or a self-managed GitLab instance. | API request, Web request, GraphQL request, Git HTTP/SSH request |
| AV:A | Attack must be launched from a limited physical or logical network distance. | Adjacent network or limited-scope network condition |
| AV:P | Attacker requires physical access to the vulnerable component. | Physical access to infrastructure/component |
| AV:L | Attack is committed through a local application vulnerability, by the victim running something locally, or by an attacker able to log in locally. | Malicious or compromised server administrator attacks after logging in to a self-managed instance server |

### Attack Complexity — AC

| Metric | Definition | Examples |
|---|---|---|
| AC:L | Attacker can exploit the vulnerability at any time, reliably. | Simple/guessable ID; reliable proof-of-concept; stored XSS in normal workflow; reasonable non-default setting required but otherwise easy |
| AC:H | Successful attack depends on conditions beyond the attacker's control. | Private project name required; timing-dependent exploitation; discouraged non-default setting; victim must visit a different-domain website |

### Privileges Required — PR

| Metric | Definition | Examples |
|---|---|---|
| PR:N | No attacker privileges required. | Unauthenticated API access to confidential information; CSRF/reflected XSS where attacker crafts URL while victim is logged in |
| PR:L | Authenticated user, sub-Maintainer/sub-Owner membership, or sub-admin instance rights required. | Any authenticated user; lower project/group role; attacker-created project/group plus invited victim with UI:N |
| PR:H | Maintainer/Owner/Custom permissions to a specific victim project/group, or instance admin rights required. | High-privilege role required in the victim's existing project/group |

Side note for triage: high-privilege users using a bug only to sabotage their own projects may be out of scope. Still document the code path, but mark bounty/triage uncertainty separately from CVSS.

### User Interaction — UI

| Metric | Definition | Examples |
|---|---|---|
| UI:R | Successful attack requires user interaction. | Any victim action is needed, including logging in; includes XSS and CSRF |
| UI:N | Attack can be accomplished without user interaction. | Attack works even if the victim never logs back in to GitLab |

### Scope — S

| Metric | Definition | Examples |
|---|---|---|
| S:C | Impact is caused to systems beyond the exploitable component. | Protected CI/CD variables affecting production/third-party systems; XSS affecting browser; SSRF fetching cloud metadata |
| S:U | Impact is localized to the exploitable component. | Developer can perform Maintainer-only GitLab action within GitLab |

### Confidentiality — C

| Metric | Definition | Examples |
|---|---|---|
| C:N | No confidential information is disclosed. | No confidentiality impact |
| C:L | Some information can be obtained, or attacker lacks control over kind/degree. | Private issue/MR titles but not content; small number of private issues/MRs; previously accessible private data; minor private data; XSS without GitLab.com CSP bypass |
| C:H | All information is disclosed, or critical information is disclosed. | Full read access to instance; tokens/session IDs; private repositories; XSS with GitLab.com CSP bypass |

### Integrity — I

| Metric | Definition | Examples |
|---|---|---|
| I:N | No integrity loss. | No modification possible |
| I:L | Some information can be altered, or attacker lacks control over kind/degree. | Modify private issue/MR titles but not content; modify small number of private issues/MRs; minor private data; XSS without GitLab.com CSP bypass |
| I:H | Attacker can modify any information at any time, or critical information can be modified. | Add malicious runner without permission; add malicious OAuth app; modify GitLab instance data; XSS with GitLab.com CSP bypass |

### Availability — A

| Metric | Definition | Examples |
|---|---|---|
| A:N | No availability impact. | No availability loss |
| A:L | Reduced performance, non-critical resource denied, or part of system affected. | Small number of projects inaccessible while attack runs |
| A:H | Critical resource or entire system affected. | Runners stop picking up pipelines; instance or critical service unavailable |

## CVSS Selection Rules for Access-Control Findings

1. Most GitLab Web/API/GraphQL access-control bugs are `AV:N`.
2. If exploitation requires only an authenticated account, use `PR:L`.
3. If exploitation requires Maintainer/Owner/admin rights in the victim resource, use `PR:H`.
4. If the attacker can create their own project/group and invite the victim, do not automatically use `PR:H`; evaluate whether victim-resource privilege is truly required.
5. If no victim action is needed, use `UI:N`.
6. If victim action is required, including login, click, CSRF, or XSS interaction, use `UI:R`.
7. Use `S:C` only when impact crosses from GitLab into another security authority/component, such as browser, production server, cloud metadata, third-party system, or protected CI/CD secrets affecting external systems.
8. Use `S:U` when both vulnerable and impacted component are GitLab.
9. For read-only access-control leaks, impact is usually `C:L` or `C:H`, with `I:N/A:N` unless state can be changed.
10. For unauthorized state change, impact is usually `I:L` or `I:H`, with confidentiality/availability set only if also affected.
11. For count/metadata leaks, usually start with `C:L` unless the metadata is critical or broad enough for `C:H`.
12. For token/session/secret disclosure, usually use `C:H`.
13. For private repository disclosure, usually use `C:H`.
14. For private issue/MR title-only or limited object disclosure, usually use `C:L`.
15. If dynamic validation may change exploitability, keep the score provisional and explain assumptions.

## CVSS Must Not Hide Uncertainty

If a finding is source-confirmed but exploitability details are not fully proven, include both the most likely CVSS vector and a short uncertainty note.

Example:

```markdown
- CVSS Vector: CVSS:3.1/AV:N/AC:L/PR:L/UI:N/S:U/C:L/I:N/A:N
- CVSS Score: 4.3
- Severity: Medium
- Score Status: Provisional — source-confirmed, dynamic validation pending
- Uncertainty: Dynamic validation may change C:L to C:H if the endpoint exposes full confidential issue bodies rather than metadata only.
```

## CVSS Is Required For

- confirmed vulnerabilities
- potential vulnerabilities requiring dynamic validation
- suspicious vulnerable-looking code paths with concrete evidence

CVSS is not required for safe paths, not-applicable pattern rows, general coverage gaps with no vulnerable code path, or out-of-scope notes.

# Phase 2 Finding Reporting Gate

Before reporting any Phase 2 issue as a finding, apply this gate.

## Report the item only if all required conditions are met

### Required Condition 1: Concrete Code Path

The report must include:

- exact entry point
- exact file path
- exact class/module
- exact method
- exact service/finder/model/worker/serializer/resolver path
- exact authorization check that is missing, incorrect, inconsistent, bypassable, or applied to the wrong object

### Required Condition 2: Attacker and Victim Model

The report must include:

- attacker role
- victim resource
- expected permission boundary
- manipulated input or alternate entry point
- unauthorized action or data access

### Required Condition 3: Access-Control Impact

The report must explain at least one of:

- unauthorized read
- unauthorized create/update/delete
- privilege escalation
- horizontal access-control bypass
- vertical access-control bypass
- object-level authorization bypass
- token scope/resource boundary bypass
- private/confidential data exposure
- admin/owner/maintainer action reachable by lower role
- background job or service acting on behalf of wrong user
- same-functionality variant likely affected

### Required Condition 4: Not Merely Informational

Do not report the item if it is only:

- code style concern
- missing defense-in-depth check with no exploit path
- duplicate expected authorization check
- safe behavior
- expected denial
- generic “review this more” note
- theoretical issue without current-code evidence
- historical issue not proven in current code

## Finding Status Rules

Use only these statuses for reported findings:

1. **Confirmed vulnerability**
   - Current code clearly permits unauthorized access/action.
   - The missing or incorrect authorization is proven by code-path tracing.

2. **Potential vulnerability requiring dynamic validation**
   - Current code strongly suggests an exploitable access-control issue.
   - Dynamic testing is needed to confirm runtime behavior.

3. **Suspicious vulnerable-looking code path requiring deeper review**
   - Current code contains a concrete suspicious authorization gap.
   - The path is specific enough to justify targeted follow-up.
   - This must not be a vague or generic note.

Do not create findings with status:

- No issue found
- Informational
- Best practice
- Hardening
- Low risk observation
- Incomplete review

Incomplete review should appear only in the coverage matrix and gaps section.

## Noise-Control Rule

The final report must prioritize quality over quantity.

It is better to report fewer high-confidence actionable vulnerability candidates than many generic observations.


# Phase 2 Output Format Per Feature

Use this exact structure.

```markdown
# Phase 2 Access-Control Review: [Feature Name]

## Phase 1 Inputs Used

- Feature map:
- File map:
- Entry-point map:
- Authorization map:
- Same-functionality map:
- Known Phase 1 gaps:

## Feature Scope

Explain what part of GitLab this feature covers.

## Expected Permission Model

Describe who should and should not access this feature.

## Entry Points Reviewed

| Entry Point | Type | File/Method | Auth/Authz Behavior | Notes |
|---|---|---|---|---|

## Files and Methods Reviewed

| File Path | Class/Module | Method | Purpose | Auth/Authz Notes |
|---|---|---|---|---|

## Full Execution Flow

Trace the complete path from request/trigger to final data access or state change.

## Authorization Checks Identified

| Check | File/Method | Object Checked | Actor Used | Notes |
|---|---|---|---|---|

## Object-Level Authorization Review

Explain whether authorization is checked against the exact target object, not only parent/container objects.

## Alternate Entry Points Checked

List other routes, APIs, GraphQL paths, workers, services, internal callers, exports, search paths, serializers, and Git paths that reach the same logic.

## Same-Functionality Cross-Feature Review

List other features implementing similar logic and confirm whether they were reviewed.

## Pattern Coverage Applied

| Pattern | Candidate Paths | Result | Notes |
|---|---|---|---|

## Role/Resource Abuse Scenarios Reviewed

| Attacker Role | Victim Resource | Expected Result | Code Path Reviewed | Dynamic Test Needed | Notes |
|---|---|---|---|---|---|

## Findings

Only report actionable vulnerability candidates.

Allowed finding statuses:

- Confirmed vulnerability
- Potential vulnerability requiring dynamic validation
- Suspicious vulnerable-looking code path requiring deeper review

Do not include the following as findings:

- No issue found after full trace
- Incomplete review
- Safe behavior
- Expected authorization behavior
- Generic hardening notes
- Missing best practices without exploitability
- Theoretical concerns without a concrete attacker path

If no issue is found for the feature, state this briefly in `Coverage Notes` and the feature coverage matrix only. Do not create a “No issue found” finding.

## Evidence for Confirmed or Potential Issues

For each issue include:

- exact code path
- missing or incorrect check
- affected object
- attacker role
- victim resource
- manipulated input
- why the check is insufficient
- unauthorized impact

## Dynamic Test Case

For each confirmed or potential issue include:

- attacker role
- victim role/resource
- setup steps
- endpoint/action
- manipulated parameter
- expected unauthorized result
- expected secure result

## Coverage Notes

- Fully reviewed? Yes/No
- Missing files:
- Missing entry points:
- Unclear logic:
- Required follow-up:
```

---

# Phase 2 Final Report Required Sections

Produce a consolidated final report with:

1. Executive summary
2. Phase 1 coverage consumed
3. Feature coverage matrix
4. Pattern coverage matrix
5. Confirmed access-control vulnerabilities
6. Potential vulnerabilities requiring dynamic testing
7. Suspicious vulnerable-looking code paths requiring deeper review
8. Non-vulnerable coverage summary
9. Incomplete or unclear areas
10. Role/resource abuse matrix
11. Entry-point consistency matrix across Web, REST API, GraphQL, workers, services, exports, search, serializers, Git/VCS, and emails
12. Token and scope abuse review
13. Background job authorization review
14. GraphQL field-level authorization review
15. Serializer/entity/presenter field authorization review
16. Cache/generated-resource authorization review
17. Import/export and bulk-operation authorization review
18. Service account/bot/custom-role review
19. AI/Duo authorization review
20. Git/VCS-level authorization review
21. Same-functionality cross-feature review summary
22. Access-control test cases for dynamic validation
23. Files/directories reviewed
24. Files/directories not reviewed with reason
25. Final gaps and next-step review queue
26. Coverage integrity check showing any endpoints, methods, relationship paths, or same-functionality families not deeply traced
27. Phase 2 source inventory reconciliation matrix
28. Shared-service caller coverage matrix
29. Phase 2 reverse-check matrix covering every Phase 1 ledger row
30. Phase 2 row-count consistency check
31. Per-feature full file coverage ledger
32. Per-feature method-level coverage ledger
33. Per-feature interface coverage matrix
34. Unresolved Phase 1 item resolution table
35. Full canonical 40-pattern matrix for every feature
36. Pattern count check for every feature
37. CVSS assessment for every confirmed/potential/suspicious finding
38. Existing Phase 1 intake check when Phase 2 starts from prior Phase 1 outputs
39. Required per-feature old-style report sections
40. Anti-drift confirmation: no coordinator/fan-out/batch-only output

---

# Phase 2 Feature Coverage Matrix Format

Use this matrix in the final report.

| # | Feature | Phase 1 Map Used | Entry Points Reviewed | Core Files Reviewed | Supporting Files Reviewed | Same-Functionality Cross-Feature Checks | Patterns Applied | Findings | Coverage Status | Gaps / Notes |
|---|---|---|---|---|---|---|---|---|---|---|
| 1 | Issues & Work Items | Yes/No | TBD | TBD | TBD | TBD | TBD | TBD | Complete / Partial / Incomplete | TBD |
| 2 | Epics & Portfolio | Yes/No | TBD | TBD | TBD | TBD | TBD | TBD | Complete / Partial / Incomplete | TBD |
| 3 | Merge Requests | Yes/No | TBD | TBD | TBD | TBD | TBD | TBD | Complete / Partial / Incomplete | TBD |
| 4 | Notes, Discussions & Reactions | Yes/No | TBD | TBD | TBD | TBD | TBD | TBD | Complete / Partial / Incomplete | TBD |
| 5 | CRM / Customer Relations | Yes/No | TBD | TBD | TBD | TBD | TBD | TBD | Complete / Partial / Incomplete | TBD |
| 6 | CI/CD Pipelines & Jobs | Yes/No | TBD | TBD | TBD | TBD | TBD | TBD | Complete / Partial / Incomplete | TBD |
| 7 | CI Runners | Yes/No | TBD | TBD | TBD | TBD | TBD | TBD | Complete / Partial / Incomplete | TBD |
| 8 | Package Registry | Yes/No | TBD | TBD | TBD | TBD | TBD | TBD | Complete / Partial / Incomplete | TBD |
| 9 | Container Registry & Dependency Proxy | Yes/No | TBD | TBD | TBD | TBD | TBD | TBD | Complete / Partial / Incomplete | TBD |
| 10 | Repositories & Git | Yes/No | TBD | TBD | TBD | TBD | TBD | TBD | Complete / Partial / Incomplete | TBD |
| 11 | Branch Rules & Protected Refs | Yes/No | TBD | TBD | TBD | TBD | TBD | TBD | Complete / Partial / Incomplete | TBD |
| 12 | Snippets | Yes/No | TBD | TBD | TBD | TBD | TBD | TBD | Complete / Partial / Incomplete | TBD |
| 13 | Wikis | Yes/No | TBD | TBD | TBD | TBD | TBD | TBD | Complete / Partial / Incomplete | TBD |
| 14 | Members & Access Tokens | Yes/No | TBD | TBD | TBD | TBD | TBD | TBD | Complete / Partial / Incomplete | TBD |
| 15 | Authentication, SSO & System Access | Yes/No | TBD | TBD | TBD | TBD | TBD | TBD | Complete / Partial / Incomplete | TBD |
| 16 | Projects | Yes/No | TBD | TBD | TBD | TBD | TBD | TBD | Complete / Partial / Incomplete | TBD |
| 17 | Groups, Namespaces & Organizations | Yes/No | TBD | TBD | TBD | TBD | TBD | TBD | Complete / Partial / Incomplete | TBD |
| 18 | Users & Profile | Yes/No | TBD | TBD | TBD | TBD | TBD | TBD | Complete / Partial / Incomplete | TBD |
| 19 | Boards, Milestones & Labels | Yes/No | TBD | TBD | TBD | TBD | TBD | TBD | Complete / Partial / Incomplete | TBD |
| 20 | Integrations & Webhooks | Yes/No | TBD | TBD | TBD | TBD | TBD | TBD | Complete / Partial / Incomplete | TBD |
| 21 | Import / Export & Bulk Import | Yes/No | TBD | TBD | TBD | TBD | TBD | TBD | Complete / Partial / Incomplete | TBD |
| 22 | Releases, Environments & Deployments | Yes/No | TBD | TBD | TBD | TBD | TBD | TBD | Complete / Partial / Incomplete | TBD |
| 23 | Monitor: Incidents, Alerts & On-call | Yes/No | TBD | TBD | TBD | TBD | TBD | TBD | Complete / Partial / Incomplete | TBD |
| 24 | Feature Flags | Yes/No | TBD | TBD | TBD | TBD | TBD | TBD | Complete / Partial / Incomplete | TBD |
| 25 | Clusters, Terraform & Cloud | Yes/No | TBD | TBD | TBD | TBD | TBD | TBD | Complete / Partial / Incomplete | TBD |
| 26 | Workspaces & Remote Development | Yes/No | TBD | TBD | TBD | TBD | TBD | TBD | Complete / Partial / Incomplete | TBD |
| 27 | Security: Vulnerabilities | Yes/No | TBD | TBD | TBD | TBD | TBD | TBD | Complete / Partial / Incomplete | TBD |
| 28 | Security: Orchestration & Policies | Yes/No | TBD | TBD | TBD | TBD | TBD | TBD | Complete / Partial / Incomplete | TBD |
| 29 | Security: Dependencies & SBOM | Yes/No | TBD | TBD | TBD | TBD | TBD | TBD | Complete / Partial / Incomplete | TBD |
| 30 | Compliance & Audit Events | Yes/No | TBD | TBD | TBD | TBD | TBD | TBD | Complete / Partial / Incomplete | TBD |
| 31 | Geo | Yes/No | TBD | TBD | TBD | TBD | TBD | TBD | Complete / Partial / Incomplete | TBD |
| 32 | AI / Duo | Yes/No | TBD | TBD | TBD | TBD | TBD | TBD | Complete / Partial / Incomplete | TBD |
| 33 | Analytics & Observability | Yes/No | TBD | TBD | TBD | TBD | TBD | TBD | Complete / Partial / Incomplete | TBD |
| 34 | Service Desk & Email | Yes/No | TBD | TBD | TBD | TBD | TBD | TBD | Complete / Partial / Incomplete | TBD |
| 35 | Design Management | Yes/No | TBD | TBD | TBD | TBD | TBD | TBD | Complete / Partial / Incomplete | TBD |
| 36 | ML / Model Registry | Yes/No | TBD | TBD | TBD | TBD | TBD | TBD | Complete / Partial / Incomplete | TBD |
| 37 | Admin & Application Settings | Yes/No | TBD | TBD | TBD | TBD | TBD | TBD | Complete / Partial / Incomplete | TBD |
| 38 | Anti-Abuse & Spam | Yes/No | TBD | TBD | TBD | TBD | TBD | TBD | Complete / Partial / Incomplete | TBD |
| 39 | Subscriptions & Licensing | Yes/No | TBD | TBD | TBD | TBD | TBD | TBD | Complete / Partial / Incomplete | TBD |
| 40 | Search | Yes/No | TBD | TBD | TBD | TBD | TBD | TBD | Complete / Partial / Incomplete | TBD |
| 41 | Uploads, LFS & Object Storage | Yes/No | TBD | TBD | TBD | TBD | TBD | TBD | Complete / Partial / Incomplete | TBD |
| 42 | Cells | Yes/No | TBD | TBD | TBD | TBD | TBD | TBD | Complete / Partial / Incomplete | TBD |
| 43 | GitLab Pages | Yes/No | TBD | TBD | TBD | TBD | TBD | TBD | Complete / Partial / Incomplete | TBD |

---

# Pattern Coverage Matrix Format

Use this matrix in the final report.

| Pattern | Applied To Features | Candidate Code Paths | Confirmed Issues | Potential Issues | Safe After Full Trace | Gaps / Notes |
|---|---|---|---|---|---|---|
| Pattern A: Early Return Skips Authorization | TBD | TBD | TBD | TBD | TBD | TBD |
| Pattern B: Unscoped Object Lookup | TBD | TBD | TBD | TBD | TBD | TBD |
| Pattern C: Parent Auth Without Child Auth | TBD | TBD | TBD | TBD | TBD | TBD |
| Pattern D: Action Endpoint Returns Object Without Auth | TBD | TBD | TBD | TBD | TBD | TBD |
| Pattern E: Multi-Interface Authorization Mismatch | TBD | TBD | TBD | TBD | TBD | TBD |
| Pattern F: Role/Permission Escalation via Parameter | TBD | TBD | TBD | TBD | TBD | TBD |
| Pattern G: Shared/Imported Membership Boundary | TBD | TBD | TBD | TBD | TBD | TBD |
| Pattern H: Feature Disabled but Data Accessible | TBD | TBD | TBD | TBD | TBD | TBD |
| Pattern I: Existence Oracle | TBD | TBD | TBD | TBD | TBD | TBD |
| Pattern J: Async Job Bypasses Authorization | TBD | TBD | TBD | TBD | TBD | TBD |
| Pattern K: Declarative Auth With No Enforcement | TBD | TBD | TBD | TBD | TBD | TBD |
| Pattern L: Entry-Point Enforcement Gap | TBD | TBD | TBD | TBD | TBD | TBD |
| Pattern M: Permission Chain / Custom Role Escalation | TBD | TBD | TBD | TBD | TBD | TBD |
| Pattern N: Import/Bulk Skips Validation | TBD | TBD | TBD | TBD | TBD | TBD |
| Pattern O: Approval Bypass | TBD | TBD | TBD | TBD | TBD | TBD |
| Pattern P: Process Identity Spoofing | TBD | TBD | TBD | TBD | TBD | TBD |
| Pattern Q: Fork/Clone Persistent Access | TBD | TBD | TBD | TBD | TBD | TBD |
| Pattern R: Cross-Reference Data Leak | TBD | TBD | TBD | TBD | TBD | TBD |
| Pattern S: Token Scope Boundary Leak | TBD | TBD | TBD | TBD | TBD | TBD |
| Pattern T: Git/VCS Auth Bypass | TBD | TBD | TBD | TBD | TBD | TBD |
| Pattern U: Proxy Header/Response Passthrough | TBD | TBD | TBD | TBD | TBD | TBD |
| Pattern V: Credential Persistence on Destination Change | TBD | TBD | TBD | TBD | TBD | TBD |
| Pattern W: Derived Token Lifetime Exceeds Parent | TBD | TBD | TBD | TBD | TBD | TBD |
| Pattern X: Unverified Identity Attribute Matching | TBD | TBD | TBD | TBD | TBD | TBD |
| Pattern Y: Format/Interface Response Divergence | TBD | TBD | TBD | TBD | TBD | TBD |
| Pattern Z: AI/LLM Context Authorization Bypass | TBD | TBD | TBD | TBD | TBD | TBD |
| Pattern 27: Service Account/Bot Privilege Laundering | TBD | TBD | TBD | TBD | TBD | TBD |
| Pattern 28: Race Condition / TOCTOU | TBD | TBD | TBD | TBD | TBD | TBD |
| Pattern 29: Cached/Stale Authorization Decisions | TBD | TBD | TBD | TBD | TBD | TBD |
| Pattern 30: Search/Index Authorization Mismatch | TBD | TBD | TBD | TBD | TBD | TBD |
| Pattern 31: Export/Report/Archive Authorization Bypass | TBD | TBD | TBD | TBD | TBD | TBD |
| Pattern 32: Notification/Email/Webhook Data Leak | TBD | TBD | TBD | TBD | TBD | TBD |
| Pattern 33: Admin Mode / Elevated Session Bypass | TBD | TBD | TBD | TBD | TBD | TBD |
| Pattern 34: Visibility Change Does Not Cascade | TBD | TBD | TBD | TBD | TBD | TBD |
| Pattern 35: Relationship Mutation Without Dual-Side Auth | TBD | TBD | TBD | TBD | TBD | TBD |
| Pattern 36: Indirect Privileged Action Trigger | TBD | TBD | TBD | TBD | TBD | TBD |
| Pattern 37: Serializer/Entity/Presenter Field Leak | TBD | TBD | TBD | TBD | TBD | TBD |
| Pattern 38: Count/Aggregate/Metadata Leak | TBD | TBD | TBD | TBD | TBD | TBD |
| Pattern 39: License/Plan/Feature Entitlement Bypass | TBD | TBD | TBD | TBD | TBD | TBD |
| Pattern 40: Unmapped Shared Infrastructure Used by Feature | TBD | TBD | TBD | TBD | TBD | TBD |

---

# Same-Functionality Cross-Feature Matrix Format

Use this matrix to avoid missing vulnerabilities in other features that implement similar logic.

| Functionality Pattern | Primary Feature Reviewed | Similar Features Reviewed | Shared Services/Methods | Authorization Differences | Candidate Issues | Status |
|---|---|---|---|---|---|---|
| Move/Reassign/Transfer | TBD | TBD | TBD | TBD | TBD | Complete / Partial / Incomplete |
| Relationship Mutation | TBD | TBD | TBD | TBD | TBD | Complete / Partial / Incomplete |
| Token Creation/Rotation | TBD | TBD | TBD | TBD | TBD | Complete / Partial / Incomplete |
| Export/Archive/Download | TBD | TBD | TBD | TBD | TBD | Complete / Partial / Incomplete |
| Approval/Invalidation | TBD | TBD | TBD | TBD | TBD | Complete / Partial / Incomplete |
| Runner/Pipeline Action | TBD | TBD | TBD | TBD | TBD | Complete / Partial / Incomplete |
| GraphQL/REST Equivalent | TBD | TBD | TBD | TBD | TBD | Complete / Partial / Incomplete |
| Import/Bulk Operation | TBD | TBD | TBD | TBD | TBD | Complete / Partial / Incomplete |
| Search/Indexing | TBD | TBD | TBD | TBD | TBD | Complete / Partial / Incomplete |
| Notification/Webhook | TBD | TBD | TBD | TBD | TBD | Complete / Partial / Incomplete |

---

# Actionable Finding Format

Only use this format for actionable vulnerability candidates.

Do not use this format for safe code, expected behavior, or generic notes.

A finding must satisfy at least one of the following:

1. A confirmed missing/incorrect authorization check creates unauthorized access or action.
2. A concrete code path appears vulnerable and requires dynamic validation.
3. A suspicious code path has enough evidence to justify targeted testing as a likely access-control issue.

For every confirmed, potential, or suspicious vulnerable-looking issue, use this exact format.

```markdown
# Finding: [Title]

## Status

Confirmed vulnerability / Potential vulnerability requiring dynamic validation / Suspicious vulnerable-looking code path requiring deeper review

## Feature

TBD

## Pattern

TBD

## Attacker Role

TBD

## Victim Resource

TBD

## Affected Entry Point

TBD

## Affected Files and Methods

TBD

## Full Code Path

TBD

## Missing or Incorrect Authorization Check

TBD

## Manipulated Input

TBD

## Impact

TBD

## Why Existing Checks Are Insufficient

TBD

## Same-Functionality Variant Review

List similar features/code paths reviewed and whether they are also affected.

## Dynamic Validation Test Case

TBD

## Expected Secure Behavior

TBD

## Evidence

TBD

## Confidence

High / Medium / Low
```

---

# Multi-Agent Review Approach

The main agent may use subagents or an agent team.

If multiple agents are available, divide work by feature and pattern coverage.

## Suggested Agents

### Agent 1: Coordinator and Coverage QA

- Owns the full feature queue.
- Ensures no feature is skipped.
- Ensures Phase 1 and Phase 2 stay aligned.
- Ensures no feature is marked complete without deep tracing.
- Consolidates output.
- Challenges shallow conclusions.

### Agent 2: Architecture and Feature Mapping Agent

- Leads Phase 1 feature mapping.
- Builds feature maps, file maps, entry-point maps, shared-infra maps, and same-functionality maps.

### Agent 3: Projects, Groups, Namespaces, Members

- Reviews projects, groups, namespaces, organizations, users, members, custom roles, shared groups, shared projects, and access tokens.

### Agent 4: Issues, Work Items, Epics, MRs, Notes, Wikis, Snippets

- Reviews collaboration features and checks confidential/private object access, approval flows, quick actions, references, and relationship mutations.

### Agent 5: CI/CD, Runners, Tokens, Environments

- Reviews pipelines, jobs, artifacts, variables, runners, job tokens, trigger tokens, deploy tokens, environments, deployments, protected refs, and pipeline identity.

### Agent 6: API, GraphQL, Serializers, Search

- Reviews REST API, GraphQL, resolvers, mutations, global IDs, batch loaders, entities, serializers, presenters, search indexing, and response field authorization.

### Agent 7: Background Jobs, Import/Export, Webhooks, Integrations

- Reviews Sidekiq workers, scheduled jobs, import/export, bulk operations, webhooks, external services, integrations, and async authorization.

### Agent 8: Security-Sensitive Systems

- Reviews repository/Git, uploads, LFS, object storage, packages, container registry, dependency proxy, AI/Duo, compliance/audit, security policies, vulnerabilities, and admin settings.

### Agent 9: Pattern QA Agent

- Applies the 40-pattern catalog across all reviewed features.
- Identifies missed pattern coverage.
- Finds same-class vulnerabilities and variant candidates.
- Ensures findings have exact code-path evidence.

---

# Final Strict Instructions

- Use `/home/parallels/Desktop/Gitlab/gitlab-master` as the source-code path.
- Phase 1 must map all features before Phase 2 begins.
- Phase 2 must consume Phase 1 maps.
- Review feature-by-feature.
- Apply the access-control pattern catalog to each feature.
- Perform deep code-path tracing.
- Review same functionality across other features.
- Do not perform shallow high-level review.
- Do not perform any work outside this prompt’s defined scope.
- Do not invent a different workflow or redefine completion.
- Do not pursue non-access-control issues unless they directly create access-control impact.
- Do not skip required inventories, ledgers, matrices, or gates.
- Do not skip any Phase 1 endpoint/action ledger row during Phase 2.
- Do not finalize Phase 2 unless every Phase 1 row has a Phase 2 disposition.
- Do not finalize a feature unless every Phase 1 file, endpoint, mapped item, gap, and security-relevant method has been read, traced, and given a Phase 2 disposition.
- Do not finalize a feature unless all 40 canonical access-control patterns are accounted for exactly once in the feature pattern matrix.
- Do not rename, redefine, or partially apply the pattern catalog.
- Do not report a confirmed, potential, or suspicious vulnerability without CVSS vector, score, severity, and metric justification.
- Do not treat existing Phase 1 output as a substitute for Phase 2 source-code review and 40-pattern coverage.
- Do not stop at controllers.
- Do not stop at policies.
- Do not stop at route definitions.
- Do not stop at GraphQL schema declarations.
- Do not stop at grep results.
- Do not assume authorization exists because one check exists.
- Do not assume a helper performs authorization; verify it.
- Do not assume a finder is scoped; verify it.
- Do not assume a serializer is safe; verify field-level filtering.
- Do not assume background jobs are safe; verify enqueue-time and execution-time authorization.
- Do not assume service classes are safe; review every caller.
- Do not assume token scope is enforced; verify every consumer.
- Do not mark a feature complete unless all entry points, shared services, same-functionality variants, and Phase 1/Phase 2 requirements were checked.
- Only report confirmed vulnerabilities, potential vulnerabilities requiring dynamic validation, or suspicious vulnerable-looking code paths with concrete evidence.
- Do not report safe code paths as findings.
- Do not report generic observations, hardening notes, or theoretical issues as findings.
- Every reported issue must pass the Phase 2 Finding Reporting Gate.
- Every reported issue must include exact code-path evidence.
- Every potential or suspicious issue must include a dynamic validation test case.
- If analysis is incomplete, say exactly what remains unreviewed in the coverage/gaps sections only.
- The final output must prioritize real findings over generic observations.
- If no issue is found in a feature, state this only in the coverage matrix and coverage notes, not as a finding.



---

# Final Anti-Drift Prohibitions

The following outputs are invalid as final Phase 2 results:

- coordinator-only output
- agent batch logs
- lead-only verification summaries
- “most leads refuted” summaries without per-feature matrices
- findings-only output without reverse-check disposition
- partial pattern table using only A-H
- feature completion claim while gaps remain
- CVSS-less confirmed/potential/suspicious findings

If any of these occur, the Phase 2 run must be considered off-track and incomplete.
