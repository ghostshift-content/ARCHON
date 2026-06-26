"""
CAPTCHA Handler for Browser-Based Security Testing

Detects CAPTCHAs on target pages, notifies the human operator, waits for manual
solving via visible browser, and saves session state for scan continuation.

This module is designed to work WITH Claude Code's Playwright MCP integration.
All browser operations are documented in docstrings so Claude Code can execute
them via MCP. No direct Playwright imports are used.
"""

import json
from enum import Enum
from urllib.parse import urlparse

from common.captcha.session_store import SessionStore


class CaptchaType(Enum):
    """Supported CAPTCHA types for detection and handling."""
    RECAPTCHA_V2 = "recaptcha_v2"
    RECAPTCHA_V3 = "recaptcha_v3"
    HCAPTCHA = "hcaptcha"
    CLOUDFLARE_TURNSTILE = "cloudflare_turnstile"
    GEETEST = "geetest"
    FUNCAPTCHA = "funcaptcha"
    CUSTOM = "custom"
    UNKNOWN = "unknown"


# CSS selectors, iframe sources, and script sources for each CAPTCHA type.
# Used by CaptchaDetector to build detection scripts.
CAPTCHA_SIGNATURES = {
    CaptchaType.RECAPTCHA_V2: {
        "selectors": [
            ".g-recaptcha",
            "[data-sitekey]",
            "#rc-imageselect",
            ".rc-anchor-container",
            "iframe[src*='recaptcha/api2']",
        ],
        "iframe_sources": [
            "google.com/recaptcha/api2",
            "recaptcha.net/recaptcha/api2",
        ],
        "script_sources": [
            "google.com/recaptcha/api.js",
            "recaptcha.net/recaptcha/api.js",
            "gstatic.com/recaptcha",
        ],
    },
    CaptchaType.RECAPTCHA_V3: {
        "selectors": [
            ".grecaptcha-badge",
            "[data-sitekey][data-size='invisible']",
        ],
        "iframe_sources": [
            "google.com/recaptcha/api2",
        ],
        "script_sources": [
            "google.com/recaptcha/api.js?render=",
            "recaptcha.net/recaptcha/api.js?render=",
        ],
    },
    CaptchaType.HCAPTCHA: {
        "selectors": [
            ".h-captcha",
            "[data-hcaptcha-sitekey]",
            "iframe[src*='hcaptcha.com']",
        ],
        "iframe_sources": [
            "hcaptcha.com/captcha",
            "assets.hcaptcha.com",
        ],
        "script_sources": [
            "hcaptcha.com/1/api.js",
            "js.hcaptcha.com",
        ],
    },
    CaptchaType.CLOUDFLARE_TURNSTILE: {
        "selectors": [
            ".cf-turnstile",
            "[data-sitekey]",
            "iframe[src*='challenges.cloudflare.com']",
        ],
        "iframe_sources": [
            "challenges.cloudflare.com/cdn-cgi/challenge-platform",
        ],
        "script_sources": [
            "challenges.cloudflare.com/turnstile",
        ],
    },
    CaptchaType.GEETEST: {
        "selectors": [
            ".geetest_holder",
            ".geetest_radar_tip",
            ".geetest_btn",
            "#geetest-wrap",
        ],
        "iframe_sources": [],
        "script_sources": [
            "static.geetest.com",
            "api.geetest.com",
        ],
    },
    CaptchaType.FUNCAPTCHA: {
        "selectors": [
            "#funcaptcha",
            "[data-pkey]",
            "iframe[src*='funcaptcha.com']",
            "iframe[src*='arkoselabs.com']",
        ],
        "iframe_sources": [
            "funcaptcha.com",
            "arkoselabs.com",
        ],
        "script_sources": [
            "funcaptcha.com/fc",
            "arkoselabs.com",
        ],
    },
}


class CaptchaDetector:
    """
    Detects CAPTCHA presence and type on web pages.

    Claude Code uses this class to:
    1. Get CSS selectors for quick element checks
    2. Get a JavaScript detection script to run via page.evaluate()
    3. Identify the specific CAPTCHA type from detection results
    """

    @staticmethod
    def get_detection_selectors():
        """
        Return a flat list of all CSS selectors across all CAPTCHA types.

        Claude Code can use these with Playwright's page.querySelector() or
        page.locator() for quick presence checks.

        Returns:
            List of CSS selector strings.
        """
        selectors = []
        for sig in CAPTCHA_SIGNATURES.values():
            selectors.extend(sig["selectors"])
        return selectors

    @staticmethod
    def get_detection_script():
        """
        Return a JavaScript snippet for page.evaluate() that checks for all
        known CAPTCHA types in a single pass.

        The script checks:
        - DOM elements matching CAPTCHA selectors
        - Iframes with CAPTCHA-related src attributes
        - Script tags loading CAPTCHA libraries
        - Global JS variables set by CAPTCHA SDKs

        Returns:
            JavaScript string that returns a detection result object:
            {
                "captcha_detected": bool,
                "matched_selectors": [...],
                "matched_iframes": [...],
                "matched_scripts": [...],
                "global_vars": {...}
            }
        """
        all_selectors = []
        all_iframe_sources = []
        all_script_sources = []

        for sig in CAPTCHA_SIGNATURES.values():
            all_selectors.extend(sig["selectors"])
            all_iframe_sources.extend(sig["iframe_sources"])
            all_script_sources.extend(sig["script_sources"])

        # Escape quotes for embedding in JS
        selectors_js = json.dumps(list(set(all_selectors)))
        iframes_js = json.dumps(list(set(all_iframe_sources)))
        scripts_js = json.dumps(list(set(all_script_sources)))

        return f"""
        (() => {{
            const result = {{
                captcha_detected: false,
                matched_selectors: [],
                matched_iframes: [],
                matched_scripts: [],
                global_vars: {{}}
            }};

            // Check CSS selectors
            const selectors = {selectors_js};
            for (const sel of selectors) {{
                try {{
                    if (document.querySelector(sel)) {{
                        result.matched_selectors.push(sel);
                    }}
                }} catch (e) {{}}
            }}

            // Check iframes
            const iframeSources = {iframes_js};
            const iframes = document.querySelectorAll('iframe[src]');
            for (const iframe of iframes) {{
                const src = iframe.src || '';
                for (const pattern of iframeSources) {{
                    if (src.includes(pattern)) {{
                        result.matched_iframes.push(src);
                    }}
                }}
            }}

            // Check script tags
            const scriptSources = {scripts_js};
            const scripts = document.querySelectorAll('script[src]');
            for (const script of scripts) {{
                const src = script.src || '';
                for (const pattern of scriptSources) {{
                    if (src.includes(pattern)) {{
                        result.matched_scripts.push(src);
                    }}
                }}
            }}

            // Check global variables
            if (typeof window.grecaptcha !== 'undefined') {{
                result.global_vars.grecaptcha = true;
            }}
            if (typeof window.hcaptcha !== 'undefined') {{
                result.global_vars.hcaptcha = true;
            }}
            if (typeof window.turnstile !== 'undefined') {{
                result.global_vars.turnstile = true;
            }}
            if (typeof window.initGeetest !== 'undefined') {{
                result.global_vars.geetest = true;
            }}

            result.captcha_detected = (
                result.matched_selectors.length > 0 ||
                result.matched_iframes.length > 0 ||
                result.matched_scripts.length > 0 ||
                Object.keys(result.global_vars).length > 0
            );

            return result;
        }})()
        """

    @staticmethod
    def identify_captcha_type(detection_result):
        """
        Map detection results to a specific CaptchaType.

        Args:
            detection_result: Dict returned by get_detection_script().

        Returns:
            CaptchaType enum value.
        """
        if not detection_result.get("captcha_detected"):
            return None

        matched = (
            detection_result.get("matched_selectors", [])
            + detection_result.get("matched_iframes", [])
            + detection_result.get("matched_scripts", [])
        )
        matched_str = " ".join(matched).lower()
        global_vars = detection_result.get("global_vars", {})

        # Check each type in priority order
        if global_vars.get("hcaptcha") or "hcaptcha" in matched_str:
            return CaptchaType.HCAPTCHA

        if global_vars.get("turnstile") or "turnstile" in matched_str or "challenges.cloudflare" in matched_str:
            return CaptchaType.CLOUDFLARE_TURNSTILE

        if global_vars.get("geetest") or "geetest" in matched_str:
            return CaptchaType.GEETEST

        if "funcaptcha" in matched_str or "arkoselabs" in matched_str:
            return CaptchaType.FUNCAPTCHA

        # reCAPTCHA v3 before v2 (v3 is a subset indicator)
        if global_vars.get("grecaptcha"):
            if "grecaptcha-badge" in matched_str or "invisible" in matched_str:
                return CaptchaType.RECAPTCHA_V3
            return CaptchaType.RECAPTCHA_V2

        if "recaptcha" in matched_str:
            if "invisible" in matched_str:
                return CaptchaType.RECAPTCHA_V3
            return CaptchaType.RECAPTCHA_V2

        return CaptchaType.UNKNOWN

    @staticmethod
    def check_cloudflare_challenge_page():
        """
        Return a JavaScript snippet to detect Cloudflare full-page interstitials
        (challenge pages that appear before the target site loads).

        These are different from inline Turnstile widgets — the entire page is a
        Cloudflare challenge with "Checking your browser..." messaging.

        Returns:
            JavaScript string that returns a bool.
        """
        return """
        (() => {
            // Cloudflare challenge page indicators
            const bodyText = document.body ? document.body.innerText : '';
            const title = document.title || '';

            const indicators = [
                bodyText.includes('Checking your browser'),
                bodyText.includes('Just a moment'),
                bodyText.includes('Enable JavaScript and cookies'),
                bodyText.includes('DDoS protection by'),
                title.includes('Just a moment'),
                title.includes('Attention Required'),
                !!document.querySelector('#challenge-form'),
                !!document.querySelector('#challenge-running'),
                !!document.querySelector('.cf-browser-verification'),
                !!document.querySelector('[data-ray]'),
            ];

            return indicators.some(i => i);
        })()
        """


class CaptchaHandler:
    """
    Orchestrates CAPTCHA detection, human notification, solve waiting, and
    session persistence.

    Workflow:
    1. detect_captcha(page_url) — check if page has a CAPTCHA
    2. handle_captcha(target_url, context_name) — full flow: detect → notify → wait → save
    3. restore_session(target_url, context_name) — restore a previously saved session

    NOTE: All browser interactions are performed by Claude Code via Playwright MCP.
    This class provides the logic framework and JavaScript snippets. Claude Code
    should call these methods and execute the returned JS via page.evaluate().
    """

    # Polling interval and timeout for waiting on human CAPTCHA solving
    POLL_INTERVAL_SECONDS = 2
    SOLVE_TIMEOUT_SECONDS = 300  # 5 minutes

    def __init__(self, session_store=None):
        """
        Initialize CaptchaHandler.

        Args:
            session_store: SessionStore instance. Created with defaults if None.
        """
        self.session_store = session_store or SessionStore()
        self.detector = CaptchaDetector()

    def detect_captcha(self, page_url):
        """
        Orchestrate CAPTCHA detection on a page.

        Claude Code should:
        1. Navigate to page_url with Playwright MCP
        2. Run self.detector.get_detection_script() via page.evaluate()
        3. Pass result to self.detector.identify_captcha_type()
        4. If no CAPTCHA found, also run
           self.detector.check_cloudflare_challenge_page() via page.evaluate()

        Args:
            page_url: URL to check for CAPTCHAs.

        Returns:
            Dict with detection instructions:
            {
                "detection_script": str (JS to run via page.evaluate),
                "cloudflare_check_script": str (JS for Cloudflare interstitials),
                "selectors": list (CSS selectors for quick checks),
            }
        """
        return {
            "detection_script": self.detector.get_detection_script(),
            "cloudflare_check_script": self.detector.check_cloudflare_challenge_page(),
            "selectors": self.detector.get_detection_selectors(),
        }

    def handle_captcha(self, target_url, context_name, captcha_type=None):
        """
        Full CAPTCHA handling flow.

        Claude Code should execute this sequence:
        1. Detect CAPTCHA type (if not provided)
        2. Call _notify_human() to alert the operator
        3. Ensure browser is visible (headless=False or bring to front)
        4. Call wait_for_solve() — poll until human solves it
        5. Call save_session_state() — persist cookies/storage
        6. Resume scanning

        Args:
            target_url: URL where CAPTCHA was encountered.
            context_name: Scan context name for session storage.
            captcha_type: CaptchaType if already identified, else None.

        Returns:
            Dict with handling instructions and scripts.
        """
        type_label = captcha_type.value if captcha_type else "unknown"
        self._notify_human(target_url, type_label)

        return {
            "instructions": [
                "1. Ensure browser window is visible (not headless)",
                "2. Bring browser window to front if possible",
                f"3. Wait for human to solve {type_label} CAPTCHA",
                "4. Use wait_for_solve() polling scripts below",
                "5. After solve confirmed, run save_session_state()",
            ],
            "wait_scripts": self.wait_for_solve(),
            "save_instructions": self.save_session_state(target_url, context_name),
        }

    def wait_for_solve(self):
        """
        Return polling scripts to detect when a human has solved the CAPTCHA.

        Claude Code should run these checks in a loop (every 2 seconds, up to
        5 minutes). A CAPTCHA is considered solved when ANY check returns True.

        Returns:
            Dict of named JavaScript snippets for page.evaluate().
        """
        return {
            "poll_interval_seconds": self.POLL_INTERVAL_SECONDS,
            "timeout_seconds": self.SOLVE_TIMEOUT_SECONDS,
            "checks": {
                "url_changed": """
                    // Check 1: URL changed (redirect after CAPTCHA solve)
                    // Compare current window.location.href to the URL before CAPTCHA
                    (() => window.location.href)()
                """,
                "captcha_element_gone": """
                    // Check 2: CAPTCHA elements disappeared from DOM
                    (() => {
                        const captchaSelectors = [
                            '.g-recaptcha', '.h-captcha', '.cf-turnstile',
                            '.geetest_holder', '#funcaptcha',
                            '#challenge-form', '#challenge-running',
                            '.cf-browser-verification'
                        ];
                        for (const sel of captchaSelectors) {
                            const el = document.querySelector(sel);
                            if (el && el.offsetParent !== null) {
                                return false;  // CAPTCHA still visible
                            }
                        }
                        return true;  // No visible CAPTCHA elements
                    })()
                """,
                "cookie_changed": """
                    // Check 3: New authentication/session cookies appeared
                    // Compare document.cookie to snapshot taken before CAPTCHA
                    (() => document.cookie)()
                """,
                "recaptcha_token_present": """
                    // Check 4: reCAPTCHA response token populated
                    (() => {
                        if (typeof window.grecaptcha !== 'undefined') {
                            try {
                                const response = window.grecaptcha.getResponse();
                                return response && response.length > 0;
                            } catch (e) {}
                        }
                        // hCaptcha
                        if (typeof window.hcaptcha !== 'undefined') {
                            try {
                                const response = window.hcaptcha.getResponse();
                                return response && response.length > 0;
                            } catch (e) {}
                        }
                        return false;
                    })()
                """,
                "page_content_changed": """
                    // Check 5: Page content indicates success (post-login content)
                    (() => {
                        const body = document.body ? document.body.innerText : '';
                        const successIndicators = [
                            'dashboard', 'welcome', 'logout', 'sign out',
                            'my account', 'profile'
                        ];
                        const failIndicators = [
                            'checking your browser', 'just a moment',
                            'verify you are human', 'complete the captcha'
                        ];
                        const lower = body.toLowerCase();
                        const hasSuccess = successIndicators.some(s => lower.includes(s));
                        const hasFail = failIndicators.some(s => lower.includes(s));
                        return hasSuccess && !hasFail;
                    })()
                """,
            },
        }

    def save_session_state(self, target_url, context_name):
        """
        Return instructions and scripts for saving session state after CAPTCHA solve.

        Claude Code should:
        1. Run the localStorage/sessionStorage extraction script via page.evaluate()
        2. Get cookies via Playwright's context.cookies()
        3. Call session_store.save_session() with the extracted data

        Args:
            target_url: URL the session belongs to.
            context_name: Scan context name.

        Returns:
            Dict with extraction scripts and save instructions.
        """
        return {
            "extract_storage_script": """
                (() => {
                    const result = { local_storage: {}, session_storage: {} };
                    try {
                        for (let i = 0; i < localStorage.length; i++) {
                            const key = localStorage.key(i);
                            result.local_storage[key] = localStorage.getItem(key);
                        }
                    } catch (e) {}
                    try {
                        for (let i = 0; i < sessionStorage.length; i++) {
                            const key = sessionStorage.key(i);
                            result.session_storage[key] = sessionStorage.getItem(key);
                        }
                    } catch (e) {}
                    return result;
                })()
            """,
            "cookies_instruction": (
                "Use Playwright MCP: context.cookies() to get all cookies"
            ),
            "save_call": (
                f"session_store.save_session('{target_url}', '{context_name}', "
                f"cookies, local_storage, session_storage)"
            ),
            "target_url": target_url,
            "context_name": context_name,
        }

    def restore_session(self, target_url, context_name):
        """
        Load saved session and return restoration instructions.

        Claude Code should:
        1. Call session_store.load_session() to get saved data
        2. Check expiry with session_store.is_session_expired()
        3. If valid, restore cookies via context.addCookies()
        4. Restore localStorage/sessionStorage via page.evaluate()
        5. Navigate to target_url and verify session is active

        Args:
            target_url: URL to restore session for.
            context_name: Scan context name.

        Returns:
            Dict with session data and restoration scripts, or None if no valid session.
        """
        if self.session_store.is_session_expired(target_url, context_name):
            return None

        session = self.session_store.load_session(target_url, context_name)
        if session is None:
            return None

        local_storage = session.get("local_storage", {})
        session_storage = session.get("session_storage", {})

        import json as _json
        ls_json = _json.dumps(local_storage)
        ss_json = _json.dumps(session_storage)

        return {
            "cookies": session.get("cookies", []),
            "restore_storage_script": f"""
                (() => {{
                    const ls = {ls_json};
                    const ss = {ss_json};
                    try {{
                        for (const [k, v] of Object.entries(ls)) {{
                            localStorage.setItem(k, v);
                        }}
                    }} catch (e) {{}}
                    try {{
                        for (const [k, v] of Object.entries(ss)) {{
                            sessionStorage.setItem(k, v);
                        }}
                    }} catch (e) {{}}
                    return true;
                }})()
            """,
            "instructions": [
                "1. Add cookies via context.addCookies(cookies)",
                "2. Navigate to target URL",
                "3. Run restore_storage_script via page.evaluate()",
                "4. Reload page to apply restored session",
                "5. Verify session is active (check for logged-in indicators)",
            ],
        }

    @staticmethod
    def check_session_valid():
        """
        Return a JavaScript snippet to detect if a session has expired mid-scan.

        Claude Code should run this periodically during scanning to detect if the
        session has been invalidated (e.g., server-side timeout, CAPTCHA re-triggered).

        Returns:
            JavaScript string that returns a dict with validity indicators.
        """
        return """
        (() => {
            const result = {
                likely_expired: false,
                reasons: []
            };

            const body = document.body ? document.body.innerText.toLowerCase() : '';
            const url = window.location.href.toLowerCase();

            // Login page redirect
            const loginIndicators = ['login', 'sign in', 'signin', 'log in'];
            if (loginIndicators.some(s => url.includes(s))) {
                result.likely_expired = true;
                result.reasons.push('Redirected to login page');
            }

            // Session expired messages
            const expiryMessages = [
                'session expired', 'session timed out', 'please log in',
                'please sign in', 'your session has', 'unauthorized',
                'access denied', '401', 'authentication required'
            ];
            for (const msg of expiryMessages) {
                if (body.includes(msg)) {
                    result.likely_expired = true;
                    result.reasons.push('Page contains: ' + msg);
                }
            }

            // CAPTCHA re-appeared
            const captchaSelectors = [
                '.g-recaptcha', '.h-captcha', '.cf-turnstile',
                '#challenge-form', '.geetest_holder'
            ];
            for (const sel of captchaSelectors) {
                if (document.querySelector(sel)) {
                    result.likely_expired = true;
                    result.reasons.push('CAPTCHA re-appeared: ' + sel);
                }
            }

            return result;
        })()
        """

    @staticmethod
    def _notify_human(url, captcha_type):
        """
        Print a prominent terminal notification for the human operator.

        Args:
            url: URL where CAPTCHA was encountered.
            captcha_type: String label for the CAPTCHA type.
        """
        domain = urlparse(url).netloc
        border = "=" * 60
        print(f"\n{border}")
        print("  CAPTCHA DETECTED — HUMAN ACTION REQUIRED")
        print(border)
        print(f"  Type   : {captcha_type}")
        print(f"  Domain : {domain}")
        print(f"  URL    : {url}")
        print()
        print("  Please solve the CAPTCHA in the browser window.")
        print("  The scan will resume automatically once solved.")
        print(border)
        print()

