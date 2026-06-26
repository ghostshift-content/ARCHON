# Server-Side Request Forgery Code Review — BEACON skill

**Scope:** Direct SSRF, indirect/stored SSRF, blind SSRF, cloud-metadata SSRF, DNS-rebinding, protocol smuggling (gopher/file/dict), URL-parser confusion, IPv6/decimal/octal bypasses, PDF/image/Open-Graph fetchers, webhook callbacks.

**Priority-ranked pattern library — 12 patterns (B-0 highest, B-11 lowest).**

---

## Methodology

### Phase 1: Map outbound HTTP
Before hunting, answer:
1. **HTTP clients in use** — `requests`, `urllib`, `httpx`, `aiohttp` (Py); `net/http`, `fasthttp` (Go); `HttpClient`, `HttpURLConnection`, `OkHttp` (Java); `fetch`, `axios`, `node-fetch`, `got` (JS); `cURL`/`Guzzle` (PHP); `NSURLSession` (Swift); `HttpClient` (.NET).
2. **Allowlist / blocklist logic** — is there an SSRF filter middleware? Where does it sit?
3. **DNS resolution** — does the app resolve the hostname BEFORE the filter, or does it rely on string matching on the URL (rebinding vulnerable)?
4. **Redirect following** — does the client follow 3xx redirects without re-validating target?
5. **Cloud environment** — AWS (IMDS at `169.254.169.254`), GCP (`metadata.google.internal`), Azure (IMDS). SSRF is catastrophic in cloud.

### Phase 2: Build the Fetch Inventory
| # | File:line | Client lib | URL source | Allowlist? | DNS revalidated? | Follows redirects? |

---

## Priority-Ranked Pattern Library (12 patterns)

### B-0 — Direct user-URL in outbound fetch (highest priority)
User-controlled URL passed directly to HTTP client.

Multi-language grep:
```bash
# Python
grep -rn "requests\.get(.*request\|requests\.post(.*req\|httpx\.get(.*params\|urlopen(.*request" . --include="*.py"
# JS/TS
grep -rn "fetch(.*req\.body\|axios\.get(.*req\.\|got(.*req\.\|http\.get(.*request\." . --include="*.{js,ts,jsx,tsx}"
# Ruby
grep -rn "Net::HTTP.*URI(params\|open(params\|HTTParty\.get(params\|Faraday\.get(params" . --include="*.rb"
# Java
grep -rn 'new URL(.*request\.\|HttpClient.*newRequest(.*request' . --include="*.java"
# PHP
grep -rn "file_get_contents(\\\$_\|curl_setopt.*CURLOPT_URL.*\\\$_\|fopen(\\\$_" . --include="*.php"
# Go
grep -rn 'http\.Get(r\.\|client\.Get(req\|http\.Post(r\.Form' . --include="*.go"
# C#
grep -rn 'HttpClient.*GetAsync.*Request\.\|WebClient.*Download.*request' . --include="*.cs"
```

**Candidate rule:** Any match + no allowlist + no IP validation = SSRF candidate.

### B-1 — User-URL in PDF / image / preview generator
```bash
grep -rn "wkhtmltopdf\|puppeteer.*goto\|chromedp.*Navigate\|playwright.*goto" . 
grep -rn "Image\.open(\\\$_\|Imagick.*\\\$_\|PIL.*fromURL" . 
grep -rn "URL preview\|og:image fetch\|unfurl" . -i
```
PDF generators + image fetchers are classic SSRF sinks — they often run with network access to internal services.

### B-2 — Webhook URL storage → later call
User registers a webhook URL → server calls it later. Server-side, out of user's direct observation = blind SSRF.

```bash
grep -rn "webhook_url\|callback_url\|notification_url\|endpoint_url" . 
grep -rn "webhooks\.create\|Webhook\.new" . 
```

### B-3 — Redirect-following without re-validation
Library follows 3xx. First URL = allowed host. Redirect target = internal IP.

```bash
grep -rn "allow_redirects\|follow_redirects\|followRedirects" . 
# Check: is the redirected URL re-validated against the allowlist?
```

### B-4 — Host allowlist with string-match bug
Common bugs:
- `url.startswith("https://trusted.com")` → `https://trusted.com@attacker.com` bypasses
- `"allowed.com" in url` → `https://attacker.com/?x=allowed.com` bypasses
- Case-insensitive check on hostname, but libcurl normalizes differently

### B-5 — DNS rebinding vulnerability
App resolves DNS once (gets allowed IP), then HTTP client resolves again (gets internal IP). Very-low-TTL DNS makes this trivial.

**Detection:** app does NOT pin the resolved IP and pass it to the client. Instead, passes the hostname through twice.

### B-6 — Protocol smuggling
libcurl / pycurl / php-curl support `gopher://`, `file://`, `dict://`, `ftp://`, `ldap://` by default.

```bash
grep -rn "CURLOPT_URL\|curl_init\|curl\.setopt" . 
# Check: is the protocol allowlisted? (CURLOPT_PROTOCOLS)
```

### B-7 — IPv4 bypass encoding
Raw app allowlist checks `127.0.0.1`? These all resolve to same:
- `0` (shorthand for 0.0.0.0)
- `127.1`
- `2130706433` (decimal)
- `0177.0.0.1` (octal)
- `0x7F000001` (hex)

### B-8 — IPv6 / hostname bypass
```bash
# IPv6 localhost
[::1] / [0:0:0:0:0:0:0:1] / [::ffff:127.0.0.1]
# Public DNS aliases to internal
# 127.0.0.1.nip.io, spoofdns services
```

### B-9 — Cloud metadata endpoint fetch
If the app runs on EC2/GCP/Azure and has any SSRF surface, attacker pivots to metadata.

Target URLs to grep for in defenses:
- `169.254.169.254` (AWS, Azure, GCP)
- `metadata.google.internal`
- `100.100.100.200` (Alibaba)

### B-10 — XXE-to-SSRF
XML parser with external entities enabled → `<!ENTITY x SYSTEM "http://169.254.169.254/">`.

```bash
grep -rn "XMLReader\|DOMDocument\|SAXParser\|DocumentBuilderFactory" . 
# Check: are external entities disabled?
```

### B-11 — SVG / XML upload with external entity
User uploads SVG → parsed server-side → fetches external URL inside.

---

## Output Format

Write to: `/root/intel/code-review/findings/<taskId>/beacon-ssrf.jsonl`

```json
{
  "id": "BA-SS-001",
  "framework": "ssrf",
  "pattern": "B-0",
  "severity": "High",
  "title": "User-controlled URL in OG-preview fetcher",
  "file": "app/services/url_preview_service.rb",
  "line": 23,
  "source": "params[:url]",
  "sink": "HTTParty.get(params[:url])",
  "gap": "No allowlist, no IP validation; follows redirects by default",
  "attack_plan": "curl 'https://target/api/preview?url=http://169.254.169.254/latest/meta-data/iam/security-credentials/'",
  "evidence": "File:line cited. HTTParty follows redirects by default.",
  "needs_live_validation": true
}
```

---

## Verification Notes
- Allowlisting by hostname is weak — attacker controls their DNS. Post-resolution IP validation is the correct defense.
- Blocking `127.0.0.0/8` and `10.0.0.0/8` but forgetting `169.254.0.0/16` = allowed metadata SSRF.
- Redirect following is the #1 silent SSRF enabler. Always check.
- Mark `needs_live_validation: true` for candidates where the IP allowlist correctness depends on the runtime DNS.

---

## False Positive Prevention (MANDATORY before emitting)

Universal discipline. Principle: don't claim SSRF until every URL-validation/DNS/IP-guard layer is inspected.

### Pipeline trace checklist — ssrf
1. **Source** — user-controlled URL / hostname / path
2. **Scheme validation** — scheme restricted (http/https only)
3. **Hostname allowlist** — allowlist or domain constraint
4. **DNS resolution** — resolved once + IP used, vs hostname passed through
5. **IP range blocking** — rejects private ranges (10/8, 172.16/12, 192.168/16, 169.254/16, ::1, fc00::/7)
6. **Redirect following** — HTTP client follows redirects without re-validating
7. **Sink** — outbound request call

### Schema requirements, Severity, Anti-patterns
Same as MARSHAL — universal schema + 3-tier severity + anti-patterns apply.


---

## Threat Model Calibration (v2 — MANDATORY for Critical/High)

Stacks with False Positive Prevention above. Before claiming any CRITICAL/HIGH, emit `threat_model` object on the candidate. AUDITOR composes stacked caps (v1 evidence_completeness + v2 threat_model).

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


### Anti-inflation discipline (SSRF)
- Default config flag "allow_local_requests" = true: documented + admin-toggleable → documented_as_intended=true → −1 tier. Documented tradeoff, not vuln.
- Admin-only hook that SSRFs internal services: admin + none + documented → Informational. Admins can already shell the box.
- Server reflects fetch-response body to admin UI: admin + none → Low. Admin seeing internal response ≈ admin SSHing.
- REAL SSRF: unauth/authenticated triggers SSRF to metadata (169.254.169.254) → privilege-escalation if stealing cloud creds → +1 tier → Critical.

### Universal principle
SSRF severity scales with attacker_privilege × whether response reaches the attacker. Admin-side SSRF ≈ admin SSH. Real SSRF is unauth or authenticated user triggering fetches to places they cannot reach.
