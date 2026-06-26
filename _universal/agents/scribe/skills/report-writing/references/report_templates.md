# Report Templates & Reference — SCRIBE

## Executive Summary Template

```
## Executive Summary

[Client Name] engaged [Team] to conduct a [pentest type] of [scope description]
between [start date] and [end date].

The assessment identified [N] vulnerabilities: [X] Critical, [X] High, [X] Medium,
[X] Low, [X] Informational.

The most significant findings include [1-3 sentence summary of top findings and
their business impact].

[1-2 sentences on overall security posture — honest but professional.]

Immediate remediation is recommended for all Critical and High severity findings.
```

---

## Finding Schema (one block per finding)

```markdown
### FINDING-[N]: [Finding Title]

**Severity:** CRITICAL / HIGH / MEDIUM / LOW / INFORMATIONAL
**CVSS Score:** [score] ([vector string])
**Status:** CONFIRMED
**Detected by:** [Agent Name]
**Validated by:** AUDITOR

**Affected Endpoint:**
`[METHOD] [URL/path]`
**Affected Parameter:** `[parameter name]`

**Description:**
[2-4 sentences: what the vulnerability is, why it exists.]

**Evidence:**
```
[Request/response snippet or screenshot reference]
```

**Business Impact:**
[1-3 sentences: what an attacker could do, what data/systems are at risk.]

**Remediation:**
[Specific, actionable fix. Not generic advice.]

**References:**
- OWASP: [link]
- CWE-[N]: [title]
```

---

## CVSS v3.1 Scoring Quick Guide

**Base Score Ranges:**
- 9.0–10.0 → CRITICAL
- 7.0–8.9  → HIGH
- 4.0–6.9  → MEDIUM
- 0.1–3.9  → LOW
- 0.0      → INFORMATIONAL

**Common Vector Components:**
| Metric | Options |
|---|---|
| Attack Vector (AV) | Network (N), Adjacent (A), Local (L), Physical (P) |
| Attack Complexity (AC) | Low (L), High (H) |
| Privileges Required (PR) | None (N), Low (L), High (H) |
| User Interaction (UI) | None (N), Required (R) |
| Scope (S) | Unchanged (U), Changed (C) |
| Confidentiality (C) | None (N), Low (L), High (H) |
| Integrity (I) | None (N), Low (L), High (H) |
| Availability (A) | None (N), Low (L), High (H) |

**Example vectors:**
- Stored XSS: `CVSS:3.1/AV:N/AC:L/PR:L/UI:R/S:C/C:L/I:L/A:N` → 5.4 MEDIUM
- RCE no auth: `CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:C/C:H/I:H/A:H` → 10.0 CRITICAL
- SQLi auth required: `CVSS:3.1/AV:N/AC:L/PR:L/UI:N/S:U/C:H/I:H/A:H` → 8.8 HIGH

Use https://www.first.org/cvss/calculator/3.1 to calculate.

---

## Remediation Language Guide
- Be specific: "Implement parameterized queries" not "fix SQL injection"
- Include framework-specific advice when known (e.g., Django ORM, PreparedStatement)
- Provide short-term fix (mitigate) and long-term fix (resolve) when applicable
- Reference OWASP Cheat Sheets where relevant
