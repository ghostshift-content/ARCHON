# Finding Validation Workflow — AUDITOR

## Purpose
AUDITOR receives POTENTIAL findings from specialist agents and either confirms them
(CONFIRMED) or rejects them (FALSE-POSITIVE) before passing to SCRIBE for reporting.

## Step 1 — Triage Incoming Findings
- Read ACTIVITY-LOG from the engagement
- Collect all findings with status: POTENTIAL or UNCONFIRMED
- Group by finding type (XSS, SQLi, SSRF, etc.)
- Note: already-CONFIRMED or already-FALSE-POSITIVE findings are passed through

## Step 2 — Re-Probe Each Finding
Run `validate_finding.sh <type> <target>` or manually reproduce:

| Finding Type | Confirmation Evidence Required |
|---|---|
| XSS (Reflected) | Canary string appears in response body unencoded; script context confirmed |
| XSS (Stored) | Canary persists on page refresh; renders in browser |
| SQLi | DB error message OR time delay of ≥3s OR data extracted |
| LFI | File content (e.g., /etc/passwd) appears in response |
| SSRF | Internal service response OR OOB DNS/HTTP callback received |
| IDOR | User A can access User B's resource (authenticated, different accounts) |
| Open Redirect | Browser follows redirect to controlled external domain |
| Header Missing | Header confirmed absent in response (multiple requests) |
| CSRF | Request accepted without valid CSRF token (or SameSite=None) |
| RCE | Command output appears in response OR OOB callback received |

## Step 3 — Evidence Collection
For each CONFIRMED finding:
- Save request/response pair (curl command + output)
- Take screenshot if UI-based proof
- Note timestamp, payload used, endpoint, parameter name

## Step 4 — Severity Confirmation
Review severity assigned by detecting agent:
- Severity should reflect: data accessible, auth bypass possible, code execution
- Downgrade if: impact is limited (no sensitive data, no auth bypass)
- Upgrade if: finding chains with another (e.g., SSRF → RCE)

## Step 5 — Update ACTIVITY-LOG
For each finding:
- Change status to CONFIRMED (with evidence reference) or FALSE-POSITIVE (with reason)
- Assign final severity: CRITICAL / HIGH / MEDIUM / LOW / INFORMATIONAL
- Document exact reproduction steps

## Step 6 — Hand off to SCRIBE
- Notify ATLAS that validation is complete
- Pass updated ACTIVITY-LOG to SCRIBE for report writing
