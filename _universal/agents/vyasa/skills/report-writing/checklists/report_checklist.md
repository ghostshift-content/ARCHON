# Report Writing Checklist — VYASA

## Pre-Writing
- [ ] ACTIVITY-LOG received from KRIPA (validated findings only)
- [ ] All findings have status CONFIRMED or FALSE-POSITIVE
- [ ] Engagement scope, dates, and client name confirmed

## Executive Summary
- [ ] Client name and engagement type stated
- [ ] Testing dates included
- [ ] Total finding count by severity stated (Critical/High/Medium/Low/Info)
- [ ] Top 1-3 findings summarized with business impact
- [ ] Overall security posture described (honest, not sugar-coated)
- [ ] Immediate action items called out

## Findings Section
- [ ] Every CONFIRMED finding has its own section
- [ ] Each finding includes: severity, CVSS score, affected endpoint, parameter
- [ ] Each finding includes: description, evidence snippet, business impact, remediation
- [ ] CVSS vector string provided and verified
- [ ] Severity matches CVSS score range
- [ ] CWE and/or OWASP reference included for each finding
- [ ] False-positive findings NOT included in report body (note count only if asked)

## CVSS Scores
- [ ] All CVSS scores calculated (not estimated)
- [ ] CVSS v3.1 format used
- [ ] Scores cross-checked: CRITICAL ≥9.0, HIGH ≥7.0, MEDIUM ≥4.0

## Remediation
- [ ] Specific remediation provided for every finding (not generic)
- [ ] Short-term and long-term fixes differentiated where applicable
- [ ] Framework-specific guidance included where known

## Final Review
- [ ] Findings sorted by severity (Critical first)
- [ ] No placeholder text remaining
- [ ] No finding mentioned in exec summary that's missing from findings section
- [ ] Report reviewed with KRISHNA before delivery
- [ ] Report delivered to USER in agreed format
