# CVSS Scoring Guide

Use this for every confirmed, potential, or suspicious finding.

## Required Output

```markdown
## CVSS Assessment

- CVSS Vector:
- CVSS Score:
- Severity:
- Score Status: Final / Provisional — source-confirmed dynamic validation pending / Provisional — suspicious path exploitability pending
- Confidence: High / Medium / Low

| Metric | Value | Reason |
|---|---|---|
| AV | N/A/L/P | TBD |
| AC | L/H | TBD |
| PR | N/L/H | TBD |
| UI | N/R | TBD |
| S | U/C | TBD |
| C | N/L/H | TBD |
| I | N/L/H | TBD |
| A | N/L/H | TBD |
```

## Severity Bands

| Score Range | Severity |
|---|---|
| 0.0 | None |
| 0.1–3.9 | Low |
| 4.0–6.9 | Medium |
| 7.0–8.9 | High |
| 9.0–10.0 | Critical |

## Metric Notes

- Most Web/API/GraphQL vulnerabilities are `AV:N`.
- Use `PR:L` for authenticated-user attacks.
- Use `PR:H` only when the attacker needs high privilege in the victim resource.
- Use `UI:R` when victim interaction is required.
- Use `S:C` when impact crosses to browser, cloud, production, third-party systems, or protected external secrets.
- Use `S:U` when the impact stays within GitLab.
- Use `C:H` for token/session/private repository/full instance read disclosure.
- Use `C:L` for limited metadata or small-scope private data disclosure.
- Use `I:H` for critical or broad unauthorized modification.
- Use `I:L` for limited unauthorized modification.
- Use provisional scoring when dynamic validation may change exploitability or impact.
