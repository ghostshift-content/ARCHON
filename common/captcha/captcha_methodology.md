# CAPTCHA Handling Methodology

Step-by-step methodology for Claude Code to handle CAPTCHAs during browser-based security testing.

---

## Detection Flow

### Decision Tree

```
Page loaded in Playwright
    |
    +-> Run CaptchaDetector.get_detection_script() via page.evaluate()
    |       |
    |       +-> captcha_detected: true
    |       |       |
    |       |       +-> CaptchaDetector.identify_captcha_type(result)
    |       |       |       |
    |       |       |       +-> Known type → handle with type-specific awareness
    |       |       |       +-> UNKNOWN → handle with generic element-gone detection
    |       |       |
    |       |       +-> CaptchaHandler.handle_captcha(url, context, type)
    |       |
    |       +-> captcha_detected: false
    |               |
    |               +-> Run check_cloudflare_challenge_page() via page.evaluate()
    |                       |
    |                       +-> true → Cloudflare interstitial, wait for auto-solve
    |                       +-> false → No CAPTCHA, proceed normally
    |
    +-> Continue with scan
```

### Step-by-Step Detection

1. **Navigate** to the target URL using Playwright MCP
2. **Wait** for page load (`networkidle` or `domcontentloaded`)
3. **Run detection script**: `page.evaluate(CaptchaDetector.get_detection_script())`
4. **Check result**: If `captcha_detected` is `true`, identify the type
5. **Cloudflare fallback**: If no CAPTCHA detected, run `check_cloudflare_challenge_page()` to catch full-page interstitials

---

## Per-CAPTCHA-Type Handling

### reCAPTCHA v2

- **Detection**: `.g-recaptcha` element, `grecaptcha` global variable
- **Behavior**: Checkbox appears → clicking it may trigger image challenge
- **Human action**: Click checkbox, solve image challenge if prompted
- **Solve detection**: `grecaptcha.getResponse()` returns non-empty string
- **Note**: Some sites auto-submit the form after reCAPTCHA solve

### reCAPTCHA v3

- **Detection**: `.grecaptcha-badge`, invisible sitekey, `render=` param in script
- **Behavior**: Invisible, score-based. Usually no human interaction needed
- **Handling**: If score too low triggers a fallback CAPTCHA, handle that fallback
- **Note**: Low scores may cause silent blocks — check for 403 or empty responses

### hCaptcha

- **Detection**: `.h-captcha` element, `hcaptcha` global variable
- **Behavior**: Similar to reCAPTCHA v2 — checkbox + image challenge
- **Human action**: Click checkbox, solve image challenge
- **Solve detection**: `hcaptcha.getResponse()` returns non-empty string

### Cloudflare Turnstile

- **Detection**: `.cf-turnstile` element, `turnstile` global, challenge iframes
- **Behavior**: Usually auto-solves (managed mode). May require a click
- **Full-page interstitials**: "Checking your browser..." page — wait 5-10 seconds
- **Solve detection**: Element disappears, page redirects to actual content
- **Note**: Turnstile managed mode often resolves without human action

### GeeTest

- **Detection**: `.geetest_holder`, `.geetest_btn` elements
- **Behavior**: Slide puzzle or click-on-target challenge
- **Human action**: Complete the puzzle interaction
- **Solve detection**: `.geetest_holder` disappears or success callback fires

### FunCaptcha (Arkose Labs)

- **Detection**: `#funcaptcha`, Arkose Labs iframes
- **Behavior**: Rotating 3D image matching
- **Human action**: Complete the image rotation/matching challenge
- **Solve detection**: iframe removed or success callback

---

## Integration Guide by Skill

### dast-automation

**Where**: `playwright_dast_scanner.py` → `authenticate()` method

```
Authentication Flow:
1. Check for saved session → restore_session()
2. If no session or expired:
   a. Navigate to login page
   b. Check for CAPTCHA → detect_captcha()
   c. If CAPTCHA present → handle_captcha()
   d. Fill credentials and submit
   e. Check for post-login CAPTCHA → detect_captcha()
   f. If post-login CAPTCHA → handle_captcha()
   g. Save session → save_session_state()
3. Verify authentication successful

Mid-Scan:
- Periodically run check_session_valid()
- If session expired or CAPTCHA re-appeared → re-authenticate
```

### api-security

**Where**: Before authenticated API testing begins

```
1. If API portal requires browser auth:
   a. Open portal URL in Playwright
   b. Detect and handle CAPTCHA if present
   c. Authenticate and capture API token/session
   d. Save session for reuse
2. Use captured session for API requests
```

### bug-bounty-recon

**Where**: During web reconnaissance and crawling

```
1. When crawling encounters a CAPTCHA wall:
   a. Detect CAPTCHA type
   b. Handle CAPTCHA (human solves)
   c. Save session
   d. Continue crawling with authenticated session
2. For Cloudflare-protected targets:
   a. Check for full-page interstitial
   b. Wait for auto-solve or handle manually
   c. Save cf_clearance cookie
```

---

## Session Restoration Flow

```
Before authentication attempt:
    |
    +-> SessionStore.load_session(url, context)
    |       |
    |       +-> Session exists
    |       |       |
    |       |       +-> SessionStore.is_session_expired(url, context)
    |       |               |
    |       |               +-> Not expired
    |       |               |       |
    |       |               |       +-> CaptchaHandler.restore_session(url, context)
    |       |               |       +-> Navigate to target
    |       |               |       +-> Verify session works
    |       |               |       |       |
    |       |               |       |       +-> Works → continue scanning
    |       |               |       |       +-> Failed → delete session, re-auth
    |       |               |
    |       |               +-> Expired
    |       |                       |
    |       |                       +-> Delete session
    |       |                       +-> Proceed to full authentication
    |       |
    |       +-> No session
    |               |
    |               +-> Proceed to full authentication
```

---

## Mid-Scan CAPTCHA Handling

Some targets re-trigger CAPTCHAs during active scanning (rate limiting, behavioral analysis). Handle this with periodic session validity checks.

### Detection During Scan

1. After each page navigation or every N requests, run `CaptchaHandler.check_session_valid()` via `page.evaluate()`
2. If `likely_expired` is `true`, check `reasons` array
3. If CAPTCHA re-appeared:
   - Pause current scan phase
   - Run full `handle_captcha()` flow
   - Save updated session
   - Resume from where scan paused
4. If session expired (login redirect):
   - Delete old session
   - Re-authenticate with CAPTCHA handling
   - Resume scan

### Rate Limiting Considerations

- If CAPTCHAs keep re-appearing, reduce scan speed
- Increase delay between requests (5-10 seconds)
- Reduce concurrent requests
- Consider scanning in smaller batches

---

## Troubleshooting

### CAPTCHA Not Detected

- Page may load CAPTCHA dynamically — add `page.waitForTimeout(3000)` after navigation
- CAPTCHA may be in an iframe — check for iframe-based CAPTCHAs specifically
- Custom CAPTCHA — use manual CSS selector if standard detection fails

### Human Solve Not Detected

- Some sites auto-submit after CAPTCHA solve — check for URL change
- Solve detection may race with page redirect — increase poll interval
- Token may be submitted via AJAX — monitor network requests

### Session Restoration Fails

- Cookies may be bound to IP — session won't transfer across networks
- Some cookies are HttpOnly — `document.cookie` won't capture them, use `context.cookies()`
- localStorage may not persist across origins — ensure same origin

### Cloudflare Challenge Loop

- Clear all Cloudflare cookies (`cf_clearance`, `__cf_bm`)
- Try with a different browser user-agent
- Some Cloudflare configs require JavaScript challenge completion — wait longer
- Check if target uses Cloudflare Bot Management (more aggressive)

### Session Expires Too Quickly

- Increase `SessionStore.ttl_seconds` to match server session timeout
- Some servers invalidate sessions on IP change
- Check if server rotates session tokens — save after each major interaction
