# CAPTCHA Handler Module

Shared CAPTCHA detection and human-in-the-loop solving for browser-based security testing skills. When a target can't disable CAPTCHAs, provide test keys, or whitelist IPs, this module detects the CAPTCHA, pauses for the human operator to solve it in a visible browser, saves the session, and lets the scan continue.

## Supported CAPTCHA Types

| Type | Detection | Notes |
|------|-----------|-------|
| reCAPTCHA v2 | `.g-recaptcha`, `[data-sitekey]`, iframes, `grecaptcha` global | Checkbox + image challenge |
| reCAPTCHA v3 | `.grecaptcha-badge`, invisible sitekey, render param | Score-based, usually invisible |
| hCaptcha | `.h-captcha`, iframes, `hcaptcha` global | Image selection challenge |
| Cloudflare Turnstile | `.cf-turnstile`, challenge iframes, `turnstile` global | Inline widget + full-page interstitials |
| GeeTest | `.geetest_holder`, `.geetest_btn`, API scripts | Slide/click puzzle |
| FunCaptcha | `#funcaptcha`, `[data-pkey]`, Arkose Labs iframes | Rotating image puzzle |
| Custom | Falls back to `UNKNOWN` | Heuristic element-gone detection |

## Quick Start

```python
from common.captcha import CaptchaDetector, CaptchaHandler, CaptchaType, SessionStore

# 1. Detect CAPTCHAs
handler = CaptchaHandler()
detection = handler.detect_captcha("https://target.com/login")
# Claude Code runs detection["detection_script"] via page.evaluate()

# 2. Identify type from detection result
captcha_type = CaptchaDetector.identify_captcha_type(result)
# result comes from running the detection script in Playwright

# 3. Handle CAPTCHA (notify human, get wait scripts)
handling = handler.handle_captcha("https://target.com/login", "my-scan", captcha_type)
# Claude Code polls with handling["wait_scripts"]["checks"] until solved

# 4. Save session after solve
store = SessionStore()
store.save_session("https://target.com", "my-scan", cookies, local_storage, session_storage)

# 5. Restore session later
restored = handler.restore_session("https://target.com", "my-scan")
# Claude Code restores cookies and storage via Playwright MCP
```

## Session Storage Format

Sessions are saved as JSON under `.sessions/{context_name}/{domain_hash}.json`:

```json
{
  "domain": "target.com",
  "target_url": "https://target.com/login",
  "context_name": "my-scan",
  "created_at": 1709000000.0,
  "ttl_seconds": 14400,
  "cookies": [{"name": "session", "value": "...", "domain": ".target.com", ...}],
  "local_storage": {"key": "value"},
  "session_storage": {"key": "value"}
}
```

Default TTL is 4 hours. Configure via `SessionStore(ttl_seconds=7200)`.

## Session Management

```python
store = SessionStore()

# List all sessions
sessions = store.list_sessions()
sessions = store.list_sessions("my-scan")  # Filter by context

# Check expiry
if store.is_session_expired("https://target.com", "my-scan"):
    print("Session expired, need to re-authenticate")

# Clean up expired sessions
removed = store.cleanup_expired()
```

## Integration with Skills

This module integrates with any browser-based security testing skill:

- **dast-automation** — CAPTCHA-aware authentication in `playwright_dast_scanner.py`
- **api-security** — Handle CAPTCHAs on API portals/documentation sites
- **bug-bounty-recon** — Handle CAPTCHAs during web reconnaissance

See `captcha_methodology.md` for per-skill integration instructions.

## Mid-Scan CAPTCHA Handling

Use `CaptchaHandler.check_session_valid()` periodically during scanning to detect if:
- Session expired (redirected to login)
- CAPTCHA re-appeared
- Access was denied

```python
# Get the check script
check_script = CaptchaHandler.check_session_valid()
# Claude Code runs via page.evaluate() and inspects result["likely_expired"]
```

## Architecture

```
common/captcha/
├── __init__.py              # Package exports
├── captcha_handler.py       # CaptchaDetector, CaptchaHandler, CaptchaType
├── session_store.py         # SessionStore for session persistence
├── captcha_methodology.md   # Step-by-step methodology for Claude Code
├── README.md                # This file
└── .sessions/               # Session storage (created at runtime, gitignored)
    └── {context}/
        └── {domain_hash}.json
```
