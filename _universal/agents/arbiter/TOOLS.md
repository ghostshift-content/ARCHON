# TOOLS.md — ARBITER Verification Tools

## Available Tools
- **curl** — HTTP requests, API testing
- **nmap** — Port verification, service detection
- **nikto** — Web vulnerability scanning (verification)
- **python3** — Custom scripts for exploit PoCs
- **nc/ncat** — Raw socket connections
- **sqlmap** — SQLi verification (read-only mode)
- **ffuf/gobuster** — Directory/parameter fuzzing
- **nuclei** — Templated vulnerability verification
- **openssl** — TLS/SSL verification
- **dig/nslookup** — DNS verification

## Tool Usage Pattern
1. Always use the simplest tool first
2. curl before anything complex
3. If first tool fails, try alternative approach
4. Document EVERY command and output
