# Access Control Code Review — the code-review specialist skill

**Scope:** Authorization bypass, IDOR, BOLA, BFLA, privilege escalation, missing permission checks, broken role boundaries. NO XSS, NO injection — those are separate frameworks.

**Sourced from:** ARCHON_V0 `frameworks/ACCESS_CONTROL.md` — 26 patterns A through Z, condensed for our code-review squad 2026-04-23. Full pattern text available at `/tmp/archon_v0/frameworks/ACCESS_CONTROL.md` if you need deeper reference.

---

## Methodology

### Phase 1: Master the app's auth model
Before hunting, answer:
1. **Authentication surface** — every login method, token type (session/API key/OAuth/JWT/service), every entry point (REST/GraphQL/WebSocket/gRPC/queue consumers).
2. **Authorization model** — roles, permissions, policies. How are checks enforced? Middleware? Policy classes? Decorators? Inline?
3. **Framework semantics** — what happens when a permission is DECLARED but not DEFINED? Fail-open or fail-closed? (Pattern K trigger)
4. **Role-permission matrix** — what can each role actually do. Document per-endpoint.

Search to seed discovery:
```
grep -rn "authenticate\|current_user\|currentUser\|jwt\|passport" .
grep -rn "authorize\|policy\|permission\|role\|can\|ability\|gate\|require_role" .
grep -rn "skip_authorization\|skip_auth\|no_auth\|@AllowAnonymous\|public_access" .
```

---

## Priority-Ranked Pattern Library (26 patterns A-Z)

Run top-down. Each pattern = a candidate if the search returns a match and the gap applies.

### P-0 — K: Declarative auth with no enforcement (highest priority)
**Pattern:** An annotation / decorator / config says "this endpoint requires role X" but no enforcement code reads it.
**Gap:** Declarative metadata ≠ enforcement. Framework may treat annotations as doc-only.
**Search:**
```
grep -rn "@Authorize\|@PreAuthorize\|@Secured\|@RolesAllowed\|requires_role\|allowed_roles:" .
# For each: find where that annotation is READ. Does it throw on missing permission?
```
**Test for fail-open:** pick an endpoint with annotation `requires_role: nonexistent`. Hit it as anon user. If 200 → fail-open bug.

### P-1 — A: Early return skips authorization
**Pattern:** Endpoint handler returns early on some condition (e.g. not found, empty param) BEFORE the auth check runs.
**Search:**
```
grep -rn -B3 "authorize\|check_permission" . | grep -B3 "return\|throw"
# Look for authorize calls AFTER returns, not before
```

### P-2 — P: Process identity spoofing (CI/CD pipeline user attribution)
**Pattern:** Code uses `current_user.id` when running in CI/worker context — but the context has a shared "pipeline user" with elevated perms.
**Search:** `grep -rn "process_user\|pipeline_user\|system_user\|background_user"` — check if downstream code trusts `current_user` as end-user identity.

### P-3 — O: Multi-step workflow approval bypass
**Pattern:** Approval endpoint only checks "is this a valid approval request" but not "can THIS user approve." Steps 1+2 were auth'd, step 3 isn't.

### P-4 — L: Enforcement gap across entry points (REST vs GraphQL vs WebSocket)
**Pattern:** REST endpoint enforces X; equivalent GraphQL mutation or WebSocket handler skips X.
**Search:** For every sensitive REST endpoint, grep for the same operation in GraphQL resolvers + WS handlers. Compare auth paths.

### P-5 — S: Token scope boundary leaks
**Pattern:** OAuth/API token issued with scope `read:issues` can call `write:issues` endpoint because scope check only runs on some routes.

### P-6 — B: Unscoped object lookup
**Pattern:** `Model.find(params[:id])` without scoping to current user/tenant. Classic IDOR.
**Search:**
```
grep -rn "\.find(\|\.findOne(\|\.findById(\|User.find\|Document.find" . | grep -v "current_user\|tenant_id\|scope"
```

### P-7 — D: Action endpoint returns object without authorization
**Pattern:** POST /api/widgets/:id/action — action endpoint authorizes the action but RETURNS the widget. No check that user can READ the widget.

### P-8 — N: Import/bulk operation skips model validations
**Pattern:** `bulk_create` / `insert_many` / CSV import bypasses per-record `before_save` hooks that normally enforce authorization.

### P-9 — Q: Fork-based persistent access after revocation
**Pattern:** User A shares project with User B. User B forks. User A revokes. User B still has the fork (and the data).

### P-10 — T: Git-level operations bypassing application auth
**Pattern:** App-level auth protects web UI. Git protocol (push/pull) uses a different auth path that doesn't enforce the same checks.

### P-11 — R: Content rendering cross-reference data leak
**Pattern:** Rendering a widget triggers server-side fetch of a related widget — no auth check on the related fetch.

### P-12 — C: Container-level auth on resource endpoint
**Pattern:** `/projects/:project_id/issues/:issue_id` — checks access to project but not issue. If issue belongs to a different project, access leaks.

### P-13 — E: Multi-interface authorization mismatch
**Pattern:** Web + mobile API + admin panel all expose the same resource but through different code paths with different auth rules.

### P-14 — M: Permission chain escalation / custom role overly-broad gate
**Pattern:** Role A has perm X. Perm X lets you grant perm Y to yourself. Perm Y is what Role B has.

### P-15 — F: Role/permission escalation via parameter
**Pattern:** `PATCH /users/me` accepts `role` field. User changes own role.
**Search:** `grep -rn "params.permit\|request.json" | grep -iE "role|permission|is_admin"` — filter for endpoints that accept role-like params.

### P-16 — G: Cross-boundary via shared/imported membership
**Pattern:** Project A imports from Project B. Import copies membership. Now Project A members can reach Project B resources.

### P-17 — H: Feature-disabled but data accessible
**Pattern:** Feature flag "hide_admin_panel" hides the UI. API endpoint still works.

### P-18 — I: Existence oracle via error differentiation
**Pattern:** `/users/1` → 403 if exists + no access, 404 if not exists. Attacker enumerates IDs via 403 vs 404.

### P-19 — J: Async job bypasses authorization
**Pattern:** Background job runs as `system_user`. User queues job with attacker-controlled params. Job skips auth.

### P-20 — U: Proxy endpoint header/response passthrough
**Pattern:** App proxies to upstream service. Proxy strips response auth headers OR forwards upstream sensitive headers.

### P-21 — V: Credential persistence on destination change
**Pattern:** OAuth redirect_uri changes but old token still valid for new target.

### P-22 — W: Derived token lifetime exceeds parent
**Pattern:** Parent session token expires. Derived (API/refresh) token doesn't. User keeps access after logout.

### P-23 — X: Unverified identity attribute matching
**Pattern:** SSO trusts `email_verified: false` claim. Attacker creates account with victim's email.

### P-24 — Y: Format/interface response divergence
**Pattern:** `/api/users/1?format=json` → 403. `/api/users/1?format=xml` → 200 (different serializer, no auth).

### P-25 — Z: AI/LLM context authorization bypass
**Pattern:** LLM chatbot accepts user query, fetches internal docs as context. No auth on the internal doc fetch — LLM leaks them.
**Search:** `grep -rn "openai\|anthropic\|llm\|chat\|embedding" | grep -iE "context|retrieve|search"` — audit what gets fetched for LLM context.

---

## Output Format

For each candidate found:
```json
{
  "id": "CT-AC-<N>",
  "framework": "access-control",
  "pattern": "K",
  "severity": "Critical|High|Medium|Low",
  "title": "Short descriptive title",
  "file": "app/controllers/admin_controller.rb",
  "line": 42,
  "source": "URL param :id / request body / session",
  "sink": "the vulnerable code site",
  "gap": "one-sentence why it's vulnerable",
  "attack_plan": "exactly what UTTARA should curl/send",
  "evidence": "<code snippet, 5-10 lines max>",
  "needs_live_validation": true
}
```

## When to Stop
- All 26 patterns applied across every endpoint
- Every sensitive model checked for unscoped finds
- Every multi-interface surface (REST/GraphQL/WS/worker) cross-compared
- No more candidates emerge after 2 full passes

Then: write candidates to `/root/intel/code-review/findings/<taskId>/dhrishtadyumna-access-control.jsonl` and signal done.

---

## False Positive Prevention (MANDATORY before emitting)

Universal discipline across frameworks (Rails, Django, Express, Spring, Laravel, Go web frameworks, ASP.NET, PHP, Ruby, Python, Node). Principle: **don't claim a gap exists until you've inspected every layer that could close it.**

### Pipeline trace checklist — access-control
Before emitting BFLA / missing-admin-gate / horizontal-privesc candidate at Critical or High, inspect and record:

1. **Router constraint** — route-table auth/role constraint before dispatch
2. **Middleware stack** — global middleware inspecting request.path and enforcing role
3. **Controller ancestors** — full class chain (parent → grandparent → prepends/includes)
4. **Framework convention** — admin-module/namespace auto-wiring (e.g., Rails Admin:: prefix, Django admin site)
5. **before_action / before_filter / guard** — controller-scoped filters
6. **Policy / Ability check** — inline authorize (Pundit, CanCanCan, Casbin, @PreAuthorize)
7. **Model scope** — query restricted by current_user (default_scope, manager override)
8. **Sink behavior** — the actual dangerous op

### Schema requirements (every candidate MUST include)
- `evidence_completeness`: `"full"` | `"partial"` | `"local_only"`
- `pipeline_trace`: layer names actually inspected (min 3 for "full")
- `upstream_defenses_checked`: array of `{"layer": "...", "file": "...", "outcome": "..."}`
- `runtime_verification_command`: single curl a human can run
- `expected_true_positive_signature`: HTTP signature if vuln exists
- `expected_false_positive_signature`: HTTP signature if missed layer blocks

### Severity self-discipline
- `full` (all relevant layers + absence proof) → may claim Critical
- `partial` → claim Medium or below, set `needs_live_validation: true`
- `local_only` (single-file evidence) → claim Low, set `suspected_not_proven: true`

### Anti-patterns (learned from GitLab DH-AC-001, 2026-04-23)
- "Controller inherits from ApplicationController instead of AdminController" → **always local_only** unless you traced the full pipeline. Framework may enforce elsewhere.
- Identical TP/FP signatures → KRIPA rejects as malformed.
- Claiming CRITICAL without `runtime_verification_command` → auto-downgrade.

Better 10 honest Mediums than 4 overclaimed Criticals killed by runtime.


---

## Threat Model Calibration (v2 — MANDATORY for Critical/High)

Stacks with False Positive Prevention above. Before claiming any CRITICAL/HIGH, emit `threat_model` object on the candidate. KRIPA composes stacked caps (v1 evidence_completeness + v2 threat_model).

### Required fields on every candidate
- `attacker_privilege` — minimum privilege attacker needs. Values: unauth / authenticated / privileged / admin / superuser.
- `trust_boundary_crossed` — which boundary the attack crosses (if any). Values: none / cross-user / cross-tenant / privilege-escalation / unauth-to-auth / cross-org.
- `documented_as_intended` — bool. Check the target for docs, tests named `*_intended_spec`, comments like `# by design`. true → −1 tier (WONTFIX territory).
- `toolchain_presence_verified` — null (N/A) or bool (when claim depends on specific binary/library/config presence).
- `validation_layers_checked` — array from [router, middleware, controller, model, db-constraint, framework-default]. Under 3 layers → cap Medium for validation-gap claims.
- `prerequisite_actions` — array of human strings listing what attacker must already do.

### Framework-agnostic attacker-privilege mapping
- Rails: `current_user.nil?` = unauth; `current_user` = authenticated; `current_user.can?(...)` elevated scope = privileged; `current_user.admin?` = admin.
- Django: `@login_required` = authenticated; `@permission_required`/`UserPassesTest` = privileged; `@user_passes_test(is_superuser)` = admin.
- Spring: `@PreAuthorize("isAuthenticated()")` = authenticated; `hasRole("USER")` = privileged; `hasRole("ADMIN")` = admin.
- Laravel: `auth()->check()` = authenticated; gate/policy = privileged; `@can("admin")` = admin.
- Express: middleware-authenticated = authenticated; RBAC middleware = privileged; admin-only middleware = admin.


### Anti-inflation discipline (access-control)
- "Admin can change user email silently" → admin_privilege=admin + trust_boundary=none + documented=true (admin rescue feature) → Informational. Admin features aren't vulns.
- "Controller doesn't inherit from AdminController" → local_only evidence + admin_privilege=unauth on /admin/* = **incoherent** → KRIPA rejects.
- Real BFLA: non-admin reaches admin action → authenticated + privilege-escalation → +1 tier from any cap → Critical stays Critical.

### Universal principle
Admin acting on admin's own privilege surface is not a BFLA. BFLA is privilege ESCALATION — attacker gains capability they did not have. If you cannot articulate the privilege delta, re-check.
