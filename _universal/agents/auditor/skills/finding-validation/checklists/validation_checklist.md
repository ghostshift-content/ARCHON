# Finding Validation Checklist — AUDITOR

## For Each Incoming Finding

### Initial Triage
- [ ] Finding type identified
- [ ] Original detecting agent noted
- [ ] Endpoint and parameter documented
- [ ] Initial severity from detecting agent noted

### Re-Probe
- [ ] Re-probe executed at least 2x (consistency check)
- [ ] Correct confirmation method used for this finding type
- [ ] Response captured and saved as evidence

### Confirmation
- [ ] Evidence meets CONFIRMED threshold (see methodology)
  - OR
- [ ] Evidence shows FALSE-POSITIVE (with specific reason noted)

### Evidence Captured
- [ ] Request/response pair saved
- [ ] Payload that triggered finding documented
- [ ] Timestamp recorded

### Severity Review
- [ ] Final severity assigned: CRITICAL / HIGH / MEDIUM / LOW / INFO
- [ ] Severity adjusted from original if needed (with reasoning)
- [ ] Chaining potential checked (does this combine with other findings?)

### ACTIVITY-LOG Update
- [ ] Status updated: CONFIRMED or FALSE-POSITIVE
- [ ] Evidence file reference added to log entry
- [ ] Final severity written to log

## Batch Completion
- [ ] All POTENTIAL/UNCONFIRMED findings processed
- [ ] Zero unresolved statuses remaining
- [ ] ACTIVITY-LOG ready for SCRIBE
- [ ] Critical/High confirmed findings already escalated to USER (if not done by detecting agent)
- [ ] Notified ATLAS that validation is complete
