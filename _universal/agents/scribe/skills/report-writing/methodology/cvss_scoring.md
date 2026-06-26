# CVSS 3.1 Scoring Methodology

## Purpose
Standardized vulnerability scoring using CVSS 3.1. Ensures consistent severity ratings across findings. Every pentest finding MUST include a CVSS vector string and numeric score.

---

## CVSS 3.1 Vector Format

```
CVSS:3.1/AV:X/AC:X/PR:X/UI:X/S:X/C:X/I:X/A:X
```

---

## Base Score Metrics

### Attack Vector (AV) — How the attacker reaches the target

| Value | Code | Description | Example |
|-------|------|-------------|---------|
| Network | N | Remotely exploitable via network | Web app SQLi |
| Adjacent | A | Requires same network segment | ARP spoofing |
| Local | L | Requires local access | Privilege escalation |
| Physical | P | Requires physical access | USB attack |

### Attack Complexity (AC) — Conditions beyond attacker's control

| Value | Code | Description | Example |
|-------|------|-------------|---------|
| Low | L | No special conditions needed | Direct exploit |
| High | H | Requires specific config/timing | Race condition |

### Privileges Required (PR) — Auth level needed

| Value | Code | Description | Example |
|-------|------|-------------|---------|
| None | N | No authentication needed | Unauthenticated SQLi |
| Low | L | Basic user account | IDOR with user session |
| High | H | Admin/privileged account | Admin panel RCE |

### User Interaction (UI) — Does victim need to do something?

| Value | Code | Description | Example |
|-------|------|-------------|---------|
| None | N | No user action needed | Server-side exploit |
| Required | R | User must click/visit | XSS, CSRF, phishing |

### Scope (S) — Does exploit affect other components?

| Value | Code | Description | Example |
|-------|------|-------------|---------|
| Unchanged | U | Only affects vulnerable component | App-level vuln |
| Changed | C | Impacts beyond vulnerable component | VM escape, XSS stealing other-origin data |

### Confidentiality Impact (C)

| Value | Code | Description |
|-------|------|-------------|
| None | N | No confidentiality impact |
| Low | L | Some restricted data exposed |
| High | H | All data accessible / total loss |

### Integrity Impact (I)

| Value | Code | Description |
|-------|------|-------------|
| None | N | No data modification |
| Low | L | Limited data can be modified |
| High | H | Complete data modification possible |

### Availability Impact (A)

| Value | Code | Description |
|-------|------|-------------|
| None | N | No availability impact |
| Low | L | Degraded performance |
| High | H | Complete denial of service |

---

## Common Vulnerability Scores

Quick reference for frequently-encountered vulnerabilities:

| Vulnerability | Vector | Score | Severity |
|--------------|--------|-------|----------|
| **Unauthenticated RCE** | AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H | 9.8 | Critical |
| **SQL Injection (unauth)** | AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:N | 9.1 | Critical |
| **Auth Bypass** | AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:N | 9.1 | Critical |
| **Stored XSS** | AV:N/AC:L/PR:L/UI:R/S:C/C:L/I:L/A:N | 5.4 | Medium |
| **Reflected XSS** | AV:N/AC:L/PR:N/UI:R/S:C/C:L/I:L/A:N | 6.1 | Medium |
| **CSRF (state change)** | AV:N/AC:L/PR:N/UI:R/S:U/C:N/I:H/A:N | 6.5 | Medium |
| **IDOR (data access)** | AV:N/AC:L/PR:L/UI:N/S:U/C:H/I:N/A:N | 6.5 | Medium |
| **SSRF (internal)** | AV:N/AC:L/PR:N/UI:N/S:C/C:L/I:N/A:N | 5.8 | Medium |
| **SSRF (cloud metadata)** | AV:N/AC:L/PR:N/UI:N/S:C/C:H/I:N/A:N | 8.6 | High |
| **Priv Escalation (local)** | AV:L/AC:L/PR:L/UI:N/S:U/C:H/I:H/A:H | 7.8 | High |
| **Open Redirect** | AV:N/AC:L/PR:N/UI:R/S:C/C:L/I:L/A:N | 6.1 | Medium |
| **Info Disclosure (verbose error)** | AV:N/AC:L/PR:N/UI:N/S:U/C:L/I:N/A:N | 5.3 | Medium |
| **Missing Security Headers** | AV:N/AC:L/PR:N/UI:N/S:U/C:N/I:N/A:N | 0.0 | Info |
| **Weak TLS** | AV:N/AC:H/PR:N/UI:N/S:U/C:H/I:N/A:N | 5.9 | Medium |

---

## Score Calculation Walkthrough

**Example: Unauthenticated SQL Injection in login form**

1. **AV:N** — Exploitable over the internet
2. **AC:L** — No special conditions, straightforward injection
3. **PR:N** — No account needed (it's the login form)
4. **UI:N** — Attacker exploits directly, no victim interaction
5. **S:U** — Affects only the database/application
6. **C:H** — Can dump entire database
7. **I:H** — Can modify/delete database records
8. **A:N** — Service stays up (unless DROP TABLE)

**Vector:** `CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:N`
**Score:** 9.1 (Critical)

---

## Calculator Tools

```bash
# Online FIRST calculator (official)
# https://www.first.org/cvss/calculator/3.1

# CLI calculator (Python)
pip install cvss
python3 -c "from cvss import CVSS3; c = CVSS3('CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:N'); print(c.base_score, c.severities()[0])"

# NVD calculator
# https://nvd.nist.gov/vuln-metrics/cvss/v3-calculator
```

---

## Scoring Checklist

- [ ] All 8 base metrics assessed (AV/AC/PR/UI/S/C/I/A)
- [ ] Vector string formatted correctly (CVSS:3.1/...)
- [ ] Score matches vector (verify with calculator)
- [ ] Severity label matches score range
- [ ] Score justified in finding description
- [ ] Consistent scoring across similar findings
- [ ] Scope (S) carefully evaluated (Changed vs Unchanged)
- [ ] Impact reflects actual demonstrated impact, not theoretical max
