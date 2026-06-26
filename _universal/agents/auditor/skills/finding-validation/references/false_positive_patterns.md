# False Positive Patterns Reference — AUDITOR

## XSS
| Indicator | Likely False Positive |
|---|---|
| Payload reflected but HTML-encoded (`&lt;script&gt;`) | Yes — encoding prevents execution |
| Payload in JSON response with correct Content-Type `application/json` | Usually — JSON context, not HTML |
| Payload reflected inside HTML comment (`<!-- payload -->`) | Usually — not executable unless via DOM sink |
| Scanner flagged word "script" in response | High FP rate — confirm actual tag injection |

## SQL Injection
| Indicator | Likely False Positive |
|---|---|
| Generic 500 error without DB-specific message | High FP — may be unrelated server error |
| Time delay < 2s | High FP — network jitter; retry 3x |
| Error contains "syntax" but not SQL keywords | Check if it's a non-DB validation error |
| WAF block (403/429) on payload | FP — WAF triggered, not actual SQLi |

## SSRF
| Indicator | Likely False Positive |
|---|---|
| Connection timeout on metadata URL | May be blocked, not necessarily absent |
| 404 from internal service | SSRF reached the service (CONFIRMED), not FP |
| OOB DNS resolved but no HTTP callback | Partial confirmation — DNS only, note carefully |

## LFI
| Indicator | Likely False Positive |
|---|---|
| Directory listing of traversal path appears | Different vuln (LFI), confirm file content |
| Response body is same as normal (no traversal) | FP — payload had no effect |
| Error "file not found" in response | Possibly FP or blind LFI — test known file |

## IDOR
| Indicator | Likely False Positive |
|---|---|
| Response returns same data for both users | Could be shared resource — verify it's user-specific |
| 403 for one user, 200 for another | CONFIRMED (different access = IDOR) |
| IDs are UUIDs and access denied | Likely FP if enforcement is consistent |

## Open Redirect
| Indicator | Likely False Positive |
|---|---|
| Redirect goes to same domain (subpath) | FP — not an open redirect |
| Redirect blocked by Content-Security-Policy | Tool still flags — but exploitability limited |
| Meta-refresh redirect vs Location header | Both valid, but confirm cross-domain target |

## Missing Security Headers
| Indicator | Likely False Positive |
|---|---|
| Header present in some pages, missing on one API endpoint | Partial — document specific endpoint |
| CSP present but `unsafe-inline` or `*` wildcard | Not FP — still a finding (just less severe) |
| Load balancer strips header — present in direct request | Confirm via intended access path |

## General FP Reduction Tips
- Always re-probe 2-3 times — intermittent results are suspect
- Compare response body length: same length = likely same response (FP)
- Check WAF rules: 403/429 on payload submission = blocked, not vulnerable
- For time-based: baseline response time before comparing sleep delay
