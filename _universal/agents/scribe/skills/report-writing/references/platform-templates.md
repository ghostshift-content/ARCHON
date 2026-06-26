# Platform Report Templates — Quick Reference

## CVSS 3.1
```
AV:[N/A/L/P]/AC:[L/H]/PR:[N/L/H]/UI:[N/R]/S:[U/C]/C:[N/L/H]/I:[N/L/H]/A:[N/L/H]
9.0-10=Critical  7.0-8.9=High  4.0-6.9=Medium  0.1-3.9=Low
```
| Finding | Vector | Score |
|---|---|---|
| ATO (no auth) | AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H | 9.8 Crit |
| Stored XSS (admin) | AV:N/AC:L/PR:L/UI:N/S:C/C:H/I:L/A:N | 8.1 High |
| SSRF (internal) | AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:L/A:N | 8.2 High |
| IDOR (PII read) | AV:N/AC:L/PR:L/UI:N/S:U/C:H/I:N/A:N | 6.5 Med |
| SQLi (auth bypass) | AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H | 9.8 Crit |

## Title Formula
`[Bug Class] in [endpoint] allows [attacker] to [impact]`

## Impact Formula
`"An attacker CAN [verb] [object] of [victim] by [method]"`
- Quantify: users affected, data types, financial impact, effort required
- **Never use:** "could potentially", "may allow", "theoretically", "further investigation needed"

| Weak | Strong |
|---|---|
| "affects some users" | **"affects ALL users"** |
| "requires user to click" | **"no user interaction required"** |
| "read-only access" | **"full account takeover"** |
| "requires attacker account" | **"unauthenticated attacker"** |

## Platform Sections

### HackerOne
Severity + CVSS vector | Summary | Steps to Reproduce (curl) | Impact | Remediation | Evidence

### Bugcrowd
VRT mapping required | Priority P1-P5 | Business Impact section
| Bug Class | VRT |
|---|---|
| XSS Stored | `cross_site_scripting > stored` |
| IDOR | `broken_access_control > insecure_direct_object_reference` |
| SQLi | `injection > sql_injection` |
| SSRF | `server_side_request_forgery` |
| Auth Bypass | `authentication_and_session_management > authentication_bypass` |

### Intigriti
Description (what/where/why) | Steps | Impact Assessment (C/I/A) | Fix + code snippet

### Immunefi (Web3)
Title: `[Vuln Type] in [Contract.sol] allows attacker to [impact]`
Severity by funds at risk (not CVSS): Crit >$1M | High <$1M | Medium: yield/griefing | Low: logic errors
PoC: Foundry test or tx sequence | Affected code snippet | Funds at risk calculation

## Platform Comparison
| | HackerOne | Bugcrowd | Intigriti | Immunefi |
|---|---|---|---|---|
| Severity | CVSS 3.1 | VRT P1-P5 | CVSS 3.1 | Funds at risk |
| PoC format | curl/steps | curl/screenshots | curl/Burp | Foundry/tx seq |
| Key diff | CVSS justification | VRT mapping | Context+fix code | On-chain verify |

## Checklist
- [ ] Title follows formula
- [ ] CVSS vector+score (or Immunefi severity+funds)
- [ ] VRT category (Bugcrowd)
- [ ] Impact quantified, no banned phrases
- [ ] Exact curl/steps to reproduce
- [ ] Specific remediation (not generic)
