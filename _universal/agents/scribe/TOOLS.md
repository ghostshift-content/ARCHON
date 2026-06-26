# TOOLS.md — SCRIBE (Report Writing Specialist)

## Writing Tools
- **exec** — File manipulation, report generation
- **web_search** — Research remediation guidance, industry benchmarks
- **web_fetch** — Pull reference material, CVE details

## Report Sections
- **Executive Summary** — Business impact, risk overview, key stats
- **Methodology** — Scope, approach, tools used, testing period
- **Findings** — Individual vulns with severity, description, impact, PoC, remediation
- **Risk Summary** — Aggregate risk posture, critical/high/medium/low breakdown
- **Appendices** — Tool output, raw data, supporting evidence

## Severity Framework
- **CVSS v3.1** — Base, temporal, and environmental scoring
- **Risk rating:** Critical (9.0-10.0), High (7.0-8.9), Medium (4.0-6.9), Low (0.1-3.9), Info (0.0)

## Remediation References
- **OWASP** — Fix guidance per vulnerability class
- **CWE** — Common Weakness Enumeration mapping
- **NIST NVD** — Vulnerability database with remediation links
- **Vendor advisories** — Product-specific patch information

## Output
- Professional pentest report (markdown/PDF)
- Executive summary (1-2 pages)
- Remediation tracker with priority and effort estimates


### Browser — agent-browser (Stealth + SSRF Protected)
Primary browser tool. Rust-native, low RAM. ALWAYS use --stealth for pentest.

Commands:
- `agent-browser open <url> --stealth` — Open URL with anti-detection
- `agent-browser snapshot` — Get accessibility tree (best for AI parsing)
- `agent-browser screenshot <path>` — Take screenshot
- `agent-browser click <selector>` — Click element
- `agent-browser fill <selector> <text>` — Fill input field
- `agent-browser eval <js>` — Run JavaScript
- `agent-browser close` — Close browser

Stealth features (--stealth flag):
- navigator.webdriver masked
- window.chrome present
- Realistic plugins/languages
- WebGL vendor/renderer patched
- Hardware profile patched
- Cloudflare challenge auto-wait

SSRF Protection (--ssrf-protect):
- Blocks private IP ranges (10.x, 172.16-31.x, 192.168.x)
- Blocks loopback (127.x, ::1)
- Blocks link-local (169.254.x)

Snapshot refs: Use @ref from snapshot output for clicking/filling (e.g., `agent-browser click @e3`)
