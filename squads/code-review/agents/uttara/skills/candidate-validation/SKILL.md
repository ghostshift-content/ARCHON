# Candidate Validation — UTTARA skill

## Purpose
Prove or disprove each the code-review specialist candidate against a deployed instance of the target application. CONFIRMED, FALSE_POSITIVE, or INFORMATIONAL per candidate.

## Inputs
- Candidate list from `/root/intel/code-review/findings/<taskId>/*-*.jsonl`
- Deployment details from dispatcher: base URL, test accounts (attacker + victim per role), cookies, CSP headers observed
- Framework-specific context from prompt (which framework's candidates to focus on)

## Validation Recipe (per candidate)

### Step 1 — Baseline
Before attacking, capture what SHOULD happen. Call the endpoint as each role (unauthorized, authenticated-non-privileged, privileged). Record:
- Status code
- Response body (first 500 bytes)
- Set-Cookie headers
- Custom headers

### Step 2 — Primary Exploit
Execute the `attack_plan` from the candidate. Record:
- Exact curl command
- Full response (status + headers + body preview)
- Diff vs baseline

### Step 3 — Variation Matrix (try at minimum these 10)
1. **Self-reference:** target = `me`, `current`, `0`, `-1`, own user ID
2. **Format switching:** `?format=json` → `?format=xml` → `?format=yaml`
3. **Content-Type games:** `application/json` → `application/x-www-form-urlencoded` → `multipart/form-data`
4. **Method override:** `X-HTTP-Method-Override: DELETE` header over a POST
5. **Case variations:** uppercase/lowercase path, case-variant headers
6. **URL encoding tricks:** `%2F` for `/`, `%00` null byte, `%2E%2E` for `..`, double encoding
7. **Parameter pollution:** `?id=1&id=2` — which one wins?
8. **Credential swap:** session cookie vs API token vs refresh token vs OAuth bearer
9. **GraphQL aliases:** if target has GraphQL, try aliasing the field or using `__typename` tricks
10. **Tenant/org context swap:** `X-Tenant-ID: other-org` mid-request

### Step 4 — Race Conditions (if relevant)
If the candidate is a race condition pattern:
```
seq 10 | xargs -P10 -I{} curl -X POST ... &
```
Observe if concurrent requests produce different state than serial.

### Step 5 — Integrity Test
If the exploit reveals READ access (IDOR), ALSO test WRITE access:
- Try PATCH with same ID
- Try DELETE with same ID
- Record what changed

### Step 6 — Documentation Check
Before marking CONFIRMED, check:
- OpenAPI / Swagger spec — is this behavior documented as intentional?
- README — is this a feature?
- Test files — do existing tests cover this case as expected?

If the behavior is INTENTIONAL per docs → mark INFORMATIONAL not CONFIRMED.

## Verdict Rules

**CONFIRMED** — ALL of these true:
- Exploit reached intended state (read/write that should've been denied)
- Affected OTHER users or crossed a trust boundary (not self-XSS, not own-data)
- Baseline (expected) differed from exploit result
- You have exact curl + exact evidence

**FALSE_POSITIVE** — ANY of these true:
- Framework auto-protects (CSRF token valid, auto-escape works, auth enforced at middleware)
- CSP blocks execution with no bypass you tried
- Non-default config required to exploit (edge case only)
- 3+ variations failed and baseline was actually correct

**INFORMATIONAL** — neither confirmed nor falsified but still worth a note:
- Intended behavior but looks risky
- Defense-in-depth hardening opportunity
- Needs live data to reproduce (access to prod customer's real records)

## Output Format
Write to: `/root/intel/code-review/findings/<taskId>/uttara-verdicts.jsonl`
```json
{
  "candidateId": "CT-AC-042",
  "verdict": "CONFIRMED",
  "severity": "Critical",
  "reproCommand": "curl -H 'Cookie: session=<victim>' https://target/api/users/123/admin-panel",
  "actualOutput": "{\"users\":[...],\"roles\":[...]}",
  "expectedBaseline": "HTTP 403 Forbidden",
  "variationsTested": 12,
  "reason": "No authorization check — any authenticated user reaches admin-panel. Confirmed across 3 role levels.",
  "affectsOtherUsers": true
}
```

## Detection-First Constraints
- NEVER modify target data unless explicitly authorized by dispatcher
- If target is offline / auth broken, tag `blocked_env: true` and skip — do NOT make up verdicts
- If 30 variations tried without reproduction, mark FALSE_POSITIVE with `exhausted: true`

## Anti-Bias Discipline
- Read the candidate's `attack_plan` but don't trust it blindly — the code-review specialist read code, you test runtime. Code says `User.find(params[:id])` unscoped — but runtime has a middleware the code-review specialist missed. Test it.
- Do NOT confirm just because "looks exploitable." Ship evidence.
- "Could not reproduce" after 3 attempts = FALSE_POSITIVE. Don't leave candidates in limbo.
