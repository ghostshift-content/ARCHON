# Security Finding Template

## Purpose
Standardized template for documenting security vulnerabilities. Every finding must be clear enough for a developer to understand AND reproduce the issue.

---

## Finding Template

```markdown
## [FINDING-ID] — [Descriptive Title]

### Severity
**Rating:** Critical | High | Medium | Low | Informational
**CVSS 3.1 Score:** X.X
**CVSS Vector:** CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H

### Affected Asset(s)
- **URL/Endpoint:** https://target.com/api/endpoint
- **Parameter:** `username`
- **Method:** POST
- **Component:** Authentication Module v2.3

### Description
[2-4 sentences explaining the vulnerability in plain language.]

What is the vulnerability? Where does it exist? What type of attack does it enable?

Example:
> The application's login endpoint is vulnerable to SQL injection via the `username`
> parameter. User-supplied input is concatenated directly into SQL queries without
> parameterization or input validation, allowing an attacker to extract, modify,
> or delete database contents.

### Impact
[What can an attacker actually do? Be specific about business impact.]

- **Confidentiality:** [Data that can be accessed]
- **Integrity:** [Data that can be modified]
- **Availability:** [Services that can be disrupted]
- **Business Impact:** [Revenue loss, compliance violation, reputation damage]

### Steps to Reproduce

1. Navigate to `https://target.com/login`
2. Enter the following in the username field:
   ```
   admin' OR '1'='1'--
   ```
3. Enter any value in the password field
4. Click "Login"
5. Observe: Authentication is bypassed, logged in as admin

**Alternative (curl):**
```bash
curl -X POST https://target.com/api/login \
  -H "Content-Type: application/json" \
  -d '{"username":"admin'\'' OR '\''1'\''='\''1'\''--","password":"anything"}'
```

### Evidence / Proof of Concept

**Request:**
```http
POST /api/login HTTP/1.1
Host: target.com
Content-Type: application/json

{"username":"admin' OR '1'='1'--","password":"x"}
```

**Response:**
```http
HTTP/1.1 200 OK
Content-Type: application/json

{"status":"success","user":"admin","token":"eyJhbGciOiJ..."}
```

**Screenshots:**
- [screenshot_1.png] — Injected payload in login form
- [screenshot_2.png] — Admin dashboard accessed without credentials

### Remediation

**Immediate (Patch):**
- Use parameterized queries / prepared statements
- Example fix:
  ```python
  # VULNERABLE
  query = f"SELECT * FROM users WHERE username = '{username}'"
  
  # FIXED
  cursor.execute("SELECT * FROM users WHERE username = %s", (username,))
  ```

**Short-term (Mitigate):**
- Implement WAF rules to block SQL injection patterns
- Add input validation (whitelist alphanumeric for username)

**Long-term (Prevent):**
- Adopt ORM framework (SQLAlchemy, Hibernate)
- Implement SAST scanning in CI/CD pipeline
- Security code review for all database interactions

### References
- [OWASP SQL Injection](https://owasp.org/www-community/attacks/SQL_Injection)
- [CWE-89: SQL Injection](https://cwe.mitre.org/data/definitions/89.html)
- [CVE-XXXX-XXXX] (if applicable)

### Metadata
- **Found by:** [Tester Name]
- **Date Found:** YYYY-MM-DD
- **Status:** Open | Remediated | Accepted Risk
- **Retest Date:** YYYY-MM-DD
```

---

## Severity Classification Guide

| Severity | CVSS Range | Criteria |
|----------|-----------|----------|
| Critical | 9.0-10.0 | RCE, auth bypass, full data breach, no interaction needed |
| High | 7.0-8.9 | SQLi, privilege escalation, sensitive data exposure |
| Medium | 4.0-6.9 | Stored XSS, CSRF on important actions, info disclosure |
| Low | 0.1-3.9 | Reflected XSS (limited), verbose errors, minor info leak |
| Info | 0.0 | Best practice deviation, no direct exploit path |

---

## Writing Tips

1. **Title:** Action-oriented — "SQL Injection in Login Endpoint" not "Security Issue"
2. **Reproduce:** A developer who's never seen the app should be able to follow steps
3. **Evidence:** Always include raw HTTP request/response, not just screenshots
4. **Impact:** Translate technical risk to business risk
5. **Remediation:** Give code examples, not just "fix the vulnerability"
6. **One finding per issue** — don't bundle multiple vulns

---

## Checklist

- [ ] Descriptive title (not generic)
- [ ] CVSS score calculated and vector string included
- [ ] Affected asset clearly identified (URL, parameter, component)
- [ ] Description explains the vuln in plain language
- [ ] Business impact articulated (not just technical)
- [ ] Steps to reproduce are complete and sequential
- [ ] Raw HTTP request/response included as evidence
- [ ] Screenshots attached where helpful
- [ ] Remediation includes code-level fix examples
- [ ] References to OWASP/CWE/CVE included
- [ ] Finding reviewed for accuracy before submission
