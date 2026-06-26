# XSS / Client-Side Injection Code Review — the code-review specialist skill

**Scope:** Stored/Reflected/DOM XSS, HTML injection, CSS injection, script gadget chains, CSP bypass, postMessage abuse, DOM clobbering, prototype pollution leading to XSS, mXSS, file-upload XSS.

**Sourced from:** ARCHON_V0 `frameworks/XSS_CLIENT_SIDE.md` — 12 patterns, condensed 2026-04-23. Full reference at `/tmp/archon_v0/frameworks/XSS_CLIENT_SIDE.md`.

---

## Methodology

### Phase 1: Master the rendering architecture
Before hunting, answer:
1. **Template engine** — ERB, Jinja2, Handlebars, EJS, Blade, Razor, Pug, Thymeleaf, JSX/TSX, Vue SFC. What's the auto-escape behavior? What's the "raw" syntax?
2. **Frontend framework** — React, Vue, Angular, Svelte, vanilla. What bypasses escaping? (`v-html`, React's DANGEROUS_SET_INNER_HTML prop, `[innerHTML]`, `{@html}`)
3. **CSP policy** — grab from `Content-Security-Policy` header or meta tag. `script-src` analysis:
   - `'unsafe-inline'` → inline scripts work, CSP offers NO XSS protection
   - `'unsafe-eval'` → eval/Function/setTimeout-with-string work
   - `'strict-dynamic'` + nonce → nonce'd scripts can load more; bypass via stored nonce reuse
   - Specific domains → can any host attacker JS? Is `'self'` user-uploadable?
   - Missing `base-uri` → `<base>` tag injection hijacks all relative URLs
   - Missing `form-action` → injected `<form action=evil>` exfils data
4. **Sanitization library** — DOMPurify, Bleach, Sanitize, HtmlSanitizer. Global config? ADD_TAGS/ADD_ATTR overrides? ALLOW_DATA_ATTR? ALLOW_UNKNOWN_PROTOCOLS?
5. **Markdown/rich-text pipeline** — what library? Does it allow raw HTML? Is output sanitized AFTER render?

### Phase 2: Build the Context Inventory
For every place user data reaches the browser, record:
| # | Source | Sink | Context (HTML body / attr / JS / CSS / URL / comment) | Auto-escaped? | Sanitized? | CSP protects? |

Every row with any "No" is a candidate.

---

## Priority-Ranked Pattern Library (12 patterns)

### P-0 — Raw/Unsafe output of user data (highest priority)
Template bypasses auto-escape with explicit `raw`/`safe` output syntax.

Search (multi-language):
```
grep -rn "html_safe\|\.raw\|mark_safe\|v-html\|\[innerHTML\]\|{!!\|<%==\|{{{" views/ templates/ components/ src/
grep -rn "@Html\.Raw\|th:utext\|template\.HTML\|{@html\|!{" views/ templates/ components/ src/
grep -rn "React.createElement.*__html" src/
```
The React prop name is `dangerously` + `SetInnerHTML` — search for that substring directly when scanning JSX.

**Candidate rule:** Any match + user-controlled data in argument + no sanitizer between = confirmed XSS unless CSP with no bypass.

### P-1 — innerHTML / jQuery HTML manipulation
JS directly sets `innerHTML` or uses jQuery's HTML-parsing methods with user data.

Search:
```
grep -rn "innerHTML\s*=\|outerHTML\s*=" app/assets/ src/ public/
grep -rn "\.html(\|\.append(\|\.prepend(\|\.after(\|\.before(\|\.replaceWith(" app/assets/ src/
grep -rn "document\.write\|insertAdjacentHTML" .
```
Trace `data` source: API response? URL param (`location.search`/`location.hash`)? postMessage? WebSocket?

### P-2 — Wrong-context escaping
Data HTML-escaped but used in JS/CSS/URL context (HTML escaping doesn't protect).

Examples:
- `<script>var name = "<%= user.name %>"</script>` — `user.name = "; alert(1); "` bypasses
- `<a href="<%= user.url %>">` — `javascript:alert(1)` works
- `<div style="background: url(<%= user.bg %>)">` — CSS injection
- `<script>var data = <%= data.to_json %></script>` — `to_json` doesn't escape `</script>`

Search:
```
grep -rn "<script.*<%\|<script.*{{\|<script.*\${" views/ templates/
grep -rn "href=.*<%\|href=.*{{\|src=.*<%\|src=.*{{" views/ templates/
grep -rn "to_json\|JSON\.stringify\|json_encode" . | grep "<script\|script>"
```

### P-3 — Mutation XSS (mXSS)
Server sanitizer's HTML parser differs from browser parser. Sanitized output re-parses into different DOM in browser, letting malicious tags escape.

Trigger: server sanitize → client-side innerHTML rendering chain.
Dangerous elements: `<math>`, `<svg>`, `<table>`, `<select>`, `<template>`, `<noscript>`, `<style>` (different parsing rules create mXSS openings).

### P-4 — JavaScript URI in href/src
User-controlled URL in `href`/`src`/`action` without scheme validation.

Bypasses: `JaVaScRiPt:`, URL-encoded `%6a%61...`, whitespace `java\nscript:`, `data:`, `vbscript:`, `blob:`.

Search:
```
grep -rn "href=.*user\|href=.*params\|src=.*user\|action=.*user" views/ templates/
grep -rn ":href\|:src\|:action\|v-bind:href" components/
# Then check: does the validator block the dangerous schemes?
grep -rn "javascript:\|data:\|vbscript:" . | grep -i "block\|reject\|sanitize\|validate"
```

### P-5 — CSP bypass via script gadgets
Gadget types:
- **Data attribute gadgets:** `<div data-remote="true" data-url="attacker.com">` → Rails UJS triggers
- **Class-based gadgets:** `<div class="js-auto-submit" data-endpoint="/api/tokens?scope=admin">`
- **DOM clobbering:** `<a id="config" href="attacker.com">` clobbers `window.config`
- **Base tag injection:** `<base href="//evil.com/">` redirects all relative URLs

Search:
```
grep -rn "data-toggle\|data-remote\|data-method\|data-url\|data-action" views/
grep -rn "window\.config\|window\.defaults\|window\." . | grep -c "||"
```

### P-6 — postMessage without origin validation
`window.addEventListener('message', handler)` with no `event.origin` check.

Search:
```
grep -rn "addEventListener.*message\|onmessage\s*=" . | head
grep -rn -A5 "message.*=>\|message.*function" . | grep -c "event.origin"
```

### P-7 — Prototype pollution → XSS
Merge/clone/extend on user JSON pollutes `Object.prototype`, which then affects rendering libraries.

Search:
```
grep -rn "Object.assign\|_.merge\|_.extend\|lodash.*merge\|deepmerge" . | grep -i "body\|params\|query"
```

### P-8 — File upload Content-Type XSS
Uploaded file served with `Content-Type: text/html` OR `Content-Disposition: inline` → HTML executes in origin.
Check: how does the app set response Content-Type on served uploads?

### P-9 — Third-party rendering library CVEs
Libraries to audit: PDF.js (CVE-2024-4367), SVG renderers, Jupyter viewers, Swagger UI, syntax highlighters (Rouge/Prism), diagram renderers (Mermaid/PlantUML), WYSIWYGs (TipTap/CKEditor/TinyMCE).
Check: grep for each library + version from package manifest; cross-ref with recent CVEs.

### P-10 — DOM clobbering
Code reads `window.X || default` where `X` can be clobbered by an injected HTML element with `id="X"` or `name="X"`.

### P-11 — CSS injection for data exfiltration
User-controlled CSS (e.g. custom theme, user bio with unescaped `style`) → uses `@import url(...)` or attribute selectors to exfil secrets via side-channel.

---

## Output Format
Same JSON schema as other frameworks. `framework:"xss"`, `pattern:"P-<N>"`.

Write to: `/root/intel/code-review/findings/<taskId>/virata-xss.jsonl`

## Verification Notes
- An XSS is only CONFIRMED when `<script>alert(document.domain)</script>` or equivalent executes in the browser AND reaches OTHER users (not self).
- CSP-blocked = FALSE_POSITIVE for the XSS, but may still be a finding as "script tag reflection" (informational).
- Self-XSS (victim = attacker) is generally FALSE_POSITIVE unless combined with a CSRF delivery mechanism.

---

## False Positive Prevention (MANDATORY before emitting)

Universal discipline. Principle: don't claim XSS until every escape/sanitization/CSP layer is inspected.

### Pipeline trace checklist — xss
1. **Source** — user input entry (param, header, body, websocket, uploaded file)
2. **Framework auto-escape** — template engine auto-escapes at this render site
3. **Explicit unsafe marker** — raw / safe / html_safe / v-html / similar
4. **Sanitizer library call** — sanitizer before render (DOMPurify, Bleach, Sanitize gem)
5. **Context switch** — HTML body vs attribute vs JS string vs CSS vs URL escaping
6. **CSP header** — blocks inline / external / eval
7. **Sink** — the actual DOM/HTML/response write

### Schema requirements, Severity, Anti-patterns
Same as DHRISHTADYUMNA — universal schema + 3-tier severity + anti-patterns apply.


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


### Anti-inflation discipline (XSS)
- Admin UI stored XSS where only admins view: admin + none (admin-to-admin) + maybe documented → Low. Admins already have full instance control.
- Stored XSS in user bio rendering cross-user: authenticated + cross-user → no cap → Critical/High stays.
- CSP-mitigated XSS: toolchain_presence_verified MANDATORY — check CSP header exists + script-src directive + nonces. If CSP blocks → max Medium.

### Universal principle
Admin seeing admin content is not XSS impact. XSS severity comes from who the payload reaches, not who injected it.
