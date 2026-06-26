# Reporting Guide (Shared Across All Skills)

## Finding Format

All findings must follow `common/state/findings_schema.yaml`. Key fields:

```json
{
  "id": "SKILL-NNN",
  "title": "Descriptive vulnerability title",
  "severity": "critical|high|medium|low|info",
  "skill": "skill-name",
  "cwe_id": "CWE-XXX",
  "owasp_id": "API1:2023 or A01:2021",
  "description": "What was found",
  "impact": "Business impact",
  "remediation": "How to fix",
  "evidence": {
    "request": "HTTP request",
    "response": "HTTP response",
    "steps_to_reproduce": ["Step 1", "Step 2"]
  }
}
```

## Severity Classification

| Severity | CVSS | Criteria |
|----------|------|----------|
| Critical | 9.0-10.0 | RCE, auth bypass, full data breach, admin takeover |
| High | 7.0-8.9 | SQLi, SSRF with impact, privilege escalation, BOLA |
| Medium | 4.0-6.9 | XSS, CSRF, info disclosure, weak crypto |
| Low | 0.1-3.9 | Missing headers, verbose errors, minor misconfig |
| Info | 0.0 | Observations, hardening suggestions, best practices |

## Report Generation

```bash
# Generate from findings directory
python3 common/reporting/report_generator.py results/ --format html --output report.html
python3 common/reporting/report_generator.py results/ --format md --output report.md
python3 common/reporting/report_generator.py results/ --format json --output report.json
```

## Evidence Requirements

- **Critical/High**: Full request/response, screenshot, reproduction steps
- **Medium**: Request/response or tool output, reproduction steps
- **Low/Info**: Description and affected component sufficient
