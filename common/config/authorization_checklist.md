# Pre-Engagement Authorization Checklist

Complete this checklist before starting any security assessment.

## Authorization
- [ ] Written authorization/contract obtained
- [ ] Scope document reviewed and signed
- [ ] Legal review completed (if required)
- [ ] Rules of engagement defined

## Contacts
- [ ] Primary technical contact identified
- [ ] Emergency contact and phone number documented
- [ ] Escalation path defined
- [ ] Communication channel established (Slack, email, etc.)

## Scope Verification
- [ ] In-scope targets confirmed (domains, IPs, apps)
- [ ] Out-of-scope targets clearly documented
- [ ] Testing window/schedule confirmed
- [ ] Rate limiting requirements understood
- [ ] Third-party dependencies identified (CDNs, APIs, cloud providers)

## Environment
- [ ] Testing environment identified (production, staging, dev)
- [ ] Backup/rollback procedures confirmed
- [ ] Monitoring teams notified
- [ ] WAF/IDS teams notified (if applicable)

## Data Handling
- [ ] Data classification understood
- [ ] PII handling procedures defined
- [ ] Evidence storage location secured
- [ ] Data retention/destruction policy agreed

## Tools & Access
- [ ] Required tools installed and verified (run check_tools.sh)
- [ ] Test accounts provisioned (if authenticated testing)
- [ ] VPN/network access configured
- [ ] Proxy/interception certificates installed
