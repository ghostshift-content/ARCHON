# Pentest Report Writing & Documentation — VYASA

## Trigger Phrases
- "write report", "pentest report", "document findings", "executive summary"
- "CVSS score", "remediation", "finding template", "final deliverable"

## Platform-Specific Templates (Bug Bounty)
For HackerOne, Bugcrowd, Intigriti, and Immunefi (Web3) report formats:
```
cat /root/agents/vyasa/skills/report-writing/references/platform-templates.md
```
Includes: per-platform templates, CVSS quick reference, impact language patterns, title formulas, escalation phrases, and a Immunefi/Web3 Foundry PoC template.

## (MANDATORY) Report Header — Top of Every Report

```markdown
**Engagement Type:** Blackbox / Greybox / Whitebox
**Target:** [domain/IP]
**Date:** [YYYY-MM-DD]
**Overall Risk: [Critical/High/Medium/Low]**
```

## Report Structure

```
[1] COVER PAGE
    ├── Client name, project name, date range
    ├── Engagement type (blackbox/greybox/whitebox) ← MANDATORY
    ├── Document classification (Confidential)
    ├── Version, author, reviewer
    └── Distribution list
        │
[2] EXECUTIVE SUMMARY (1-2 pages, non-technical)
    ├── Scope and objectives
    ├── Engagement type stated ← MANDATORY
    ├── Overall Risk Rating: [Critical/High/Medium/Low] ← MANDATORY
    ├── Key statistics: X findings (Y critical, Z high...)
    ├── Top 3 risks in plain English
    └── Strategic recommendations (prioritized)
        │
[3] METHODOLOGY
    ├── Testing approach (black/grey/white box) ← state explicitly
    ├── Standards followed (OWASP, PTES, NIST)
    ├── Tools used
    ├── Timeline
    └── Limitations and exclusions
        │
[4] FINDINGS (bulk of report)
    ├── Each finding uses the Finding Template below
    ├── Reproduction steps MANDATORY for every finding
    ├── Ordered by severity (Critical → Info)
    └── Grouped by category if >15 findings
        │
[5] RECOMMENDATIONS SUMMARY ← MANDATORY SECTION
    ├── Numbered list of top fixes
    ├── Ordered by severity/priority
    └── One-line action per recommendation
        │
[6] APPENDICES
    ├── Full tool output / raw evidence
    ├── Severity rating methodology
    ├── Glossary of terms
    └── Remediation verification notes
```

## (MANDATORY) Recommendations Summary Section

Every VYASA report MUST include this section:

```markdown
## Recommendations Summary

1. [Critical] [Fix title] — Immediate action required
2. [High] [Fix title] — Remediate within 24 hours
3. [High] [Fix title] — Remediate within 24 hours
4. [Medium] [Fix title] — Remediate within 7 days
5. [Low] [Fix title] — Remediate within 30 days
...
```

VYASA must log in activity log:
```json
{"agent":"VYASA","action":"Recommendations: [N] items","details":"Recommendations: 1. [fix1] 2. [fix2] 3. [fix3]..."}
{"agent":"VYASA","action":"Overall Risk: High","details":"Overall Risk Rating: High — based on N confirmed findings (Critical: X, High: Y)"}
```

## Finding Template

```markdown
### F-[NUMBER]: [DESCRIPTIVE TITLE]

**Severity:** Critical / High / Medium / Low / Info
**CVSS 3.1:** [Score] ([Vector String])
**Status:** Open / Remediated / Accepted Risk
**CWE:** CWE-[ID] — [Name]
**OWASP:** [Category, e.g., A01:2021 Broken Access Control]

#### Description
[2-3 sentences: what the vulnerability is and where it exists]

#### Affected Assets
| Asset          | Endpoint/URL              | Parameter   |
|----------------|---------------------------|-------------|
| Web App        | POST /api/users/:id       | id          |

#### Reproduction Steps (MANDATORY — exact curl or numbered steps)
```bash
# Exact reproduction command:
curl -s -X [METHOD] "https://[TARGET]/[ENDPOINT]" \
  -H "Cookie: [SESSION]" \
  -d "[PAYLOAD]"
# Expected response: [what to look for]
```
OR numbered steps:
1. Navigate to [URL]
2. Enter [PAYLOAD] in [FIELD]
3. Observe [RESPONSE/BEHAVIOR]

#### Proof of Concept
[Step-by-step reproduction with screenshots/requests/responses]

**Request:**
```http
GET /api/users/124 HTTP/1.1
Host: target.com
Authorization: Bearer <user_A_token>
```

**Response:**
```json
{"id": 124, "email": "userB@example.com", "ssn": "XXX-XX-XXXX"}
```

#### Impact
[Business impact: what an attacker could achieve, data at risk, affected users]

#### Remediation
**Short-term:** [Immediate fix]
**Long-term:** [Architectural improvement]
**Reference:** [Link to OWASP/CWE remediation guide]

#### References
- [OWASP link]
- [CWE link]
```

## CVSS 3.1 Quick Scoring Guide

```
CVSS Vector: AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H = 9.8 Critical

Attack Vector (AV):    Network=0.85  Adjacent=0.62  Local=0.55  Physical=0.20
Attack Complexity (AC): Low=0.77     High=0.44
Privileges Required:    None=0.85    Low=0.62/0.68  High=0.27/0.50
User Interaction (UI):  None=0.85    Required=0.62
Scope (S):             Unchanged     Changed (affects other components)
CIA Impact:            None=0  Low=0.22  High=0.56

Score Ranges:
  9.0 - 10.0 = Critical (red)
  7.0 - 8.9  = High (orange)
  4.0 - 6.9  = Medium (yellow)
  0.1 - 3.9  = Low (blue)
  0.0        = Info (gray)
```

## Common Findings — Quick CVSS Reference

| Finding                          | Typical CVSS | Vector                                    |
|----------------------------------|-------------|-------------------------------------------|
| RCE (unauthenticated)            | 9.8         | AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H     |
| SQLi with data extraction        | 9.8         | AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H     |
| IDOR (PII access)                | 7.5         | AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:N/A:N     |
| Stored XSS                       | 6.1         | AV:N/AC:L/PR:N/UI:R/S:C/C:L/I:L/A:N     |
| CSRF (state change)              | 4.3         | AV:N/AC:L/PR:N/UI:R/S:U/C:N/I:L/A:N     |
| Missing security headers         | 3.7         | AV:N/AC:H/PR:N/UI:N/S:U/C:N/I:L/A:N     |
| Information disclosure           | 5.3         | AV:N/AC:L/PR:N/UI:N/S:U/C:L/I:N/A:N     |

## Writing Guidelines

### Executive Summary Rules
1. **No jargon.** Write for a CEO, not a pentester
2. **Lead with risk.** "An attacker could steal all customer data" not "We found a SQL injection"
3. **Include business context.** "This affects 50,000 users' payment data"
4. **Recommend actions.** Not just "fix it" — prioritized roadmap
5. **One page ideal, two max.** Brevity is respect for the reader's time

### Finding Description Rules
1. **Be specific.** Not "the application is vulnerable" → "The /api/users endpoint allows..."
2. **Explain impact.** Not "data could be exposed" → "All 12,000 user records including SSN..."
3. **PoC must be reproducible.** Another tester should replicate from your steps alone
4. **Include both request AND response.** Always.
5. **Redact sensitive data.** Mask SSNs, passwords, real PII in report
6. **Reproduction steps are NON-NEGOTIABLE.** Every finding MUST include exact curl command or numbered steps. No exceptions. No finding without repro steps reaches the final report.

### Remediation Rules
1. **Be actionable.** Code examples when possible
2. **Short-term + long-term.** Quick patch AND architectural fix
3. **Reference standards.** Link to OWASP, CWE, vendor docs
4. **Don't just say "input validation."** Specify: parameterized queries, output encoding, etc.

## Report Quality Checklist

```
Before Delivery:
  [ ] All findings have CVSS score + vector string
  [ ] All findings have PoC with request/response
  [ ] Executive summary is non-technical and actionable
  [ ] Findings ordered by severity
  [ ] No copy-paste artifacts or placeholder text
  [ ] Scope matches engagement agreement
  [ ] All screenshots are legible and annotated
  [ ] Sensitive data redacted (passwords, real PII)
  [ ] Spell check and grammar review done
  [ ] PDF generated with proper formatting
  [ ] Table of contents is accurate
  [ ] Client name/project name consistent throughout
  [ ] Version number and date on cover page
  [ ] Classification marking on every page
```

## Severity Distribution Template (for Exec Summary)

```
Findings Summary:
  ████████ Critical:  2
  ██████████████ High:  5
  ████████████████████ Medium:  8
  ██████ Low:  3
  ████ Info:  2
  ─────────────────────
  Total: 20 findings
```


## HackerOne Report Template Format

When writing for bug bounty submission (HackerOne/Bugcrowd), use this format:

### Title Formula
`[Bug Class] in [Endpoint] allows [actor] to [impact]`

**Examples:**
- `Stored XSS in /api/comments allows unauthenticated attacker to steal admin session cookies`
- `IDOR in /api/users/{id} allows any authenticated user to read other users' PII`
- `SSRF in /api/fetch allows attacker to access AWS metadata and steal IAM credentials`

**Never write:** "Potential XSS vulnerability found" or "Possible SQL injection"

### CVSS 3.1 Quick Reference

```
Vector: AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H = 9.8 (Critical)

Attack Vector:     Network=0.85 | Adjacent=0.62 | Local=0.55 | Physical=0.20
Attack Complexity: Low=0.77    | High=0.44
Privileges:        None=0.85   | Low=0.62      | High=0.27
User Interaction:  None=0.85   | Required=0.62
Scope:             Unchanged   | Changed
CIA Impact:        None=0      | Low=0.22      | High=0.56

9.0-10.0 = Critical | 7.0-8.9 = High | 4.0-6.9 = Medium | 0.1-3.9 = Low
```

### Impact-First Language (MANDATORY)

**Always use:** "Attacker CAN [verb] [object]"
- "An attacker CAN read all user records including email and SSN"
- "An attacker CAN execute arbitrary JavaScript in the context of an admin session"
- "An attacker CAN access AWS IAM credentials via the metadata endpoint"

**NEVER use these phrases:**
| ❌ Banned Phrase | ✅ Replace With |
|---|---|
| "could potentially" | "CAN" (if proven) or don't mention |
| "may allow" | "allows" |
| "theoretically" | Delete — if it's theoretical, don't report it |
| "it is possible that" | "attacker CAN" |
| "might be exploitable" | "is exploitable" or don't include |
| "under certain conditions" | State the exact conditions |
| "further investigation needed" | Investigate now or don't mention |

### Bug Bounty Report Structure
```markdown
## Summary
[One sentence: what, where, impact]

## Severity
[CVSS score + vector string + justification]

## Steps to Reproduce
1. [Exact step with URL]
2. [Exact curl command or browser action]
3. [What to observe]

## Impact
[What attacker CAN do. Business impact. Affected users/data.]

## Remediation
[Specific fix. Code example if possible.]

## Supporting Material
[Screenshots, HTTP requests/responses, video if complex]
```

## (MANDATORY) Operating Philosophy

**Detection and accuracy over aggression.** Work methodically.
- Use minimal inputs first, observe outputs
- Document findings with exact evidence
- Pass suspected issues through KRIPA validation
- Only confirmed findings reach VYASA report
