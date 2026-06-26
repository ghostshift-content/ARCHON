# Account Takeover Code Review — the code-review specialist skill

**Scope:** Authentication bypass, password reset flaws, OAuth/SAML exploitation, 2FA bypass, session hijack, token theft/forgery, email verification bypass, credential leakage, account enumeration, host header attacks, race conditions in auth, impersonation abuse.

**Sourced from:** ARCHON_V0 `frameworks/ACCOUNT_TAKEOVER.md` — 11 patterns, condensed 2026-04-23. Full reference at `/tmp/archon_v0/frameworks/ACCOUNT_TAKEOVER.md`.

---

## Methodology

### Phase 1: Master the authentication surfaces
Before hunting, answer:
1. **Every login method:** form, OAuth (which providers?), SAML, API key, JWT, passwordless, SSO, biometric.
2. **Every password mechanism:** reset, change, lockout, rate-limit, 2FA types (TOTP/SMS/WebAuthn).
3. **Every token:** session cookie, refresh token, access token, API key, service token, CSRF token. Where stored? What's the lifetime? How's it regenerated?
4. **Email flow:** signup verification, password reset, email change — each has its own attack surface.

Search to seed:
```
grep -rn "password_reset\|reset_password\|forgot_password" .
grep -rn "oauth\|omniauth\|passport\|openid_connect\|saml" .
grep -rn "two_factor\|totp\|2fa\|mfa\|webauthn" .
grep -rn "verify_email\|email_verification\|confirm_email" .
grep -rn "session_token\|access_token\|refresh_token\|api_key" .
```

---

## Priority-Ranked Pattern Library (11 patterns)

### P-0 — Password reset token manipulation (highest priority)
**Variants:**
- **Array injection:** `POST /reset { "email": ["victim@", "attacker@"] }` — app sends reset link to attacker but validates against victim
- **Token prediction:** reset token is timestamp+PRNG → predictable
- **Host header attack:** reset URL uses `Host:` header → attacker sets `Host: evil.com`, victim clicks link to evil.com which forwards token
- **Token leakage:** reset token in Referer header to third-party tracker
**Search:**
```
grep -rn "reset_token\|password_reset_token\|SecureRandom\|crypto.randomBytes" .
grep -rn "request.host\|req.headers.host\|HTTP_HOST" . | grep -i "reset\|email\|link"
grep -rn "params\[:email\]\|body\.email\|req\.body\.email" . | grep -i "reset"
```

### P-1 — OAuth flow exploitation
**Variants:**
- **Missing state param:** CSRF on OAuth login — attacker initiates flow, victim finishes in attacker's browser → victim logs in as attacker
- **redirect_uri bypass:** `redirect_uri=https://trusted.com.evil.com` or `redirect_uri=https://trusted.com/../attacker`
- **Auto-link vulnerability:** OAuth provider returns `email_verified: false` and app auto-links to existing account
**Search:**
```
grep -rn "redirect_uri\|callback_url\|return_to" .
grep -rn "state\s*=\s*" . | grep -i "oauth"
grep -rn "email_verified\|emailVerified\|email_confirmed" .
```

### P-2 — SAML assertion manipulation
**Variants:**
- **XPath injection:** attacker manipulates SAML response XPath to extract wrong attribute
- **Signature wrapping:** attacker wraps signed portion, extracts body, substitutes own
- **Comment truncation:** `<NameID>admin<!-- @company.com --></NameID>` — different parsers see different values
**Search:**
```
grep -rn "saml\|Saml\|SAML" . | grep -i "parse\|extract\|assert"
grep -rn "signature\|verify" . | grep -i "saml\|assertion"
```

### P-3 — 2FA/MFA bypass
**Variants:**
- **Token bypass:** send 2FA form without token → backend skips check
- **Remember-device forgery:** `remember_device_token` predictable or signable
- **Brute force:** no rate limit on TOTP entry
- **Fallback path:** "can't access 2FA" flow uses weaker verification
**Search:**
```
grep -rn "2fa\|two_factor\|totp\|otp" . | grep -iE "bypass|skip|remember"
grep -rn "remember_device\|trusted_device"
```

### P-4 — Session hijack + fixation
**Variants:**
- Session token in URL (leaks via Referer)
- Session doesn't rotate on login (fixation)
- Session cookie lacks HttpOnly/Secure/SameSite

### P-5 — Email verification bypass
**Pattern:** signup creates unverified account that can still log in / access sensitive features.

### P-6 — Credential leakage
**Variants:** password in URL query, password in logs, password in 4xx error response, API key in JS bundle, token in localStorage accessible to XSS.
**Search:**
```
grep -rn "console.log\|Rails.logger\|logger.info" . | grep -iE "password|token|secret"
```

### P-7 — Account enumeration
**Variants:**
- Different error: "user not found" vs "wrong password"
- Different timing: valid user = 200ms, invalid = 50ms
- Signup endpoint: "email already taken"

### P-8 — Host header attacks
Already covered in P-0 (reset) — standalone check for ALL endpoints that build URLs from request.host.

### P-9 — Race conditions in auth flows
**Variants:**
- Parallel password reset requests → multiple valid tokens simultaneously
- TOTP check not atomic → brute force via concurrent guesses
- Signup race → two accounts with same email
**Search:** `grep -rn "transaction\|lock\|mutex" . | grep -i "auth\|user"` → audit endpoints WITHOUT transaction wrapping.

### P-10 — Impersonation and delegation abuse
**Pattern:** admin "impersonate user" feature lacks audit log OR can be invoked without admin perms via API.

---

## Output Format
Same as access-control skill — JSON per candidate with `framework:"account-takeover"` and `pattern:"<P-N>"`.

Write to: `/root/intel/code-review/findings/<taskId>/vikarna-account-takeover.jsonl`

---

## False Positive Prevention (MANDATORY before emitting)

Universal discipline. Principle: don't claim a takeover path until every auth-lifecycle layer is inspected.

### Pipeline trace checklist — account-takeover
1. **Authentication entry point** — password reset / OAuth callback / SSO / magic link endpoint
2. **Token generation** — cryptographically strong, one-time-use, bound to user
3. **Identity binding** — token bound to the email/phone/user_id the request originated from
4. **Rate limiting** — per-user/per-IP throttling
5. **Notification layer** — victim gets email/push on account state change
6. **Session state** — invalidation on reset/link/OAuth
7. **MFA enforcement** — required for changes, not bypassable via email reset
8. **Audit trail** — state change logged

### Schema requirements, Severity, Anti-patterns
Same as DHRISHTADYUMNA — see access-control-review skill's False Positive Prevention section for the universal schema, severity tiers, and anti-patterns. The principle is identical; only the layer taxonomy differs per framework.


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


### Anti-inflation discipline (account-takeover)
- Admin destroying user 2FA: admin + none + documented=true (admin rescue) → Informational. Not a vuln — it IS the rescue feature.
- Admin injecting OAuth identity: admin + privilege-escalation (attacker gains new login path as victim) → +1 from Medium = High. Different from silent 2FA destroy because this IS a privilege transfer.
- Real ATO: unauth password reset flow leaks token → unauth + unauth-to-auth boundary → Critical.

### Universal principle
Silent admin change of user state is a UX/audit gap, not an ATO vulnerability. Genuine ATO gives the attacker access they did not have.
