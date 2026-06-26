# MITRE ATT&CK Mapping — Web & API Vulnerabilities
> Reference table: Vulnerability Type → MITRE Technique ID → Tactic
> Use when classifying findings in penetration test reports.

## Web Application Vulnerability → MITRE ATT&CK

| Vulnerability | MITRE Technique | Technique ID | Tactic | Notes |
|--------------|----------------|--------------|--------|-------|
| SQL Injection | Exploit Public-Facing Application | T1190 | Initial Access | For initial compromise |
| SQL Injection | Data from Information Repositories | T1213 | Collection | When used to exfiltrate data |
| SQL Injection | OS Command Execution via DB | T1059 | Execution | xp_cmdshell, INTO OUTFILE |
| XSS (Stored) | Drive-by Compromise | T1189 | Initial Access | Malicious script served to users |
| XSS (Reflected) | Phishing: Spearphishing Link | T1566.002 | Initial Access | Crafted URL with XSS payload |
| XSS (Any) | Steal Web Session Cookie | T1539 | Credential Access | Session hijacking via JS |
| SSRF | Cloud Instance Metadata API | T1552.005 | Credential Access | AWS/GCP/Azure metadata endpoint |
| SSRF | Internal Network Scan via Service | T1018 | Discovery | Using app as proxy to scan intranet |
| SSRF | Exploit Public-Facing Application | T1190 | Initial Access | SSRF to internal services |
| LFI / Path Traversal | File and Directory Discovery | T1083 | Discovery | Reading arbitrary files |
| LFI / Path Traversal | Unsecured Credentials in Files | T1552.001 | Credential Access | `/etc/passwd`, `.env`, `config.php` |
| RFI (Remote File Inclusion) | Exploit Public-Facing Application | T1190 | Initial Access | Loading remote malicious script |
| CSRF | Account Manipulation | T1098 | Persistence | Unauthorized account changes |
| CSRF | Valid Accounts | T1078 | Defense Evasion | Actions performed as victim's session |
| XXE (External Entity) | Exploit Public-Facing Application | T1190 | Initial Access | Parsing malicious XML |
| XXE (SSRF via XXE) | Cloud Instance Metadata API | T1552.005 | Credential Access | XXE to metadata endpoint |
| SSTI (Server-Side Template Injection) | Exploitation for Client Execution | T1203 | Execution | Template RCE (Jinja2, Twig, etc.) |
| SSTI | Command and Scripting Interpreter | T1059 | Execution | OS command execution via template |
| IDOR / BOLA | Valid Accounts | T1078 | Defense Evasion | Accessing other users' resources |
| IDOR / BOLA | Data from Cloud Storage Object | T1530 | Collection | Exfiltrating cloud-stored data |
| Command Injection (CMDi) | Command and Scripting Interpreter | T1059 | Execution | Shell command execution |
| CMDi | Exploit Public-Facing Application | T1190 | Initial Access | OS access via web param injection |
| JWT Abuse (none algorithm) | Exploitation for Privilege Escalation | T1068 | Privilege Escalation | Forging unsigned tokens |
| JWT Abuse (algorithm confusion) | Valid Accounts | T1078 | Defense Evasion | Bypassing authentication |
| JWT Abuse (secret brute-force) | Brute Force: Password Guessing | T1110.001 | Credential Access | Weak HMAC secret |
| GraphQL Introspection | Gather Victim Network Information | T1590 | Reconnaissance | Schema enumeration |
| GraphQL IDOR | Valid Accounts | T1078 | Defense Evasion | Object-level auth bypass |
| GraphQL Batch Query Abuse | Endpoint Denial of Service | T1499 | Impact | Complexity/depth attacks |
| Open Redirect | Phishing: Spearphishing Link | T1566.002 | Initial Access | Trusted domain redirect |
| Mass Assignment | Account Manipulation | T1098 | Persistence | Privilege escalation via field injection |
| Insecure Deserialization | Exploitation of Remote Services | T1210 | Lateral Movement | RCE via deserialization gadget |
| Broken Access Control (BFLA) | Exploitation for Privilege Escalation | T1068 | Privilege Escalation | Function-level auth bypass |
| Security Misconfiguration | Exploit Public-Facing Application | T1190 | Initial Access | Debug endpoints, default credentials |
| Sensitive Data Exposure | Data from Information Repositories | T1213 | Collection | Unprotected PII/secrets in responses |

---

## Active Directory / Kerberos → MITRE ATT&CK

| Technique | MITRE ID | Tactic |
|-----------|----------|--------|
| Kerberoasting (SPN ticket request) | T1558.003 | Credential Access |
| AS-REP Roasting (no pre-auth) | T1558.004 | Credential Access |
| Golden Ticket (forged TGT) | T1558.001 | Credential Access |
| Pass-the-Ticket | T1550.003 | Lateral Movement |
| Pass-the-Hash | T1550.002 | Lateral Movement |
| DCSync (AD replication abuse) | T1003.006 | Credential Access |
| ACL Abuse (GenericAll/WriteDACL) | T1222.001 | Defense Evasion |
| LDAP Enumeration | T1087.002 | Discovery |
| BloodHound path reading | T1069.002 | Discovery |

---

## Cloud → MITRE ATT&CK

| Technique | MITRE ID | Tactic |
|-----------|----------|--------|
| Cloud IAM privilege escalation | T1078.004 | Privilege Escalation |
| Cloud Instance Metadata API (SSRF) | T1552.005 | Credential Access |
| Cloud Storage data access | T1530 | Collection |
| Cloud service enumeration | T1526 | Discovery |
| Service account / SP credential abuse | T1078.004 | Persistence |
| Malicious OAuth app consent | T1550.001 | Credential Access |

---

## Container / Kubernetes → MITRE ATT&CK

| Technique | MITRE ID | Tactic |
|-----------|----------|--------|
| Container escape to host | T1611 | Privilege Escalation |
| Privileged container deployment | T1610 | Execution |
| K8s RBAC escalation | T1078.004 | Privilege Escalation |
| Service account token theft | T1528 | Credential Access |
| Container image implant | T1525 | Persistence |

---

## Reporting Format — Finding Classification

When writing a report finding, include:

```
Finding: [Vulnerability Name]
CVSS Score: [X.X]
MITRE ATT&CK: [Tactic] → [Technique] ([T####])
Risk: [Critical / High / Medium / Low]
Evidence: [Request/Response, screenshot, log excerpt]
Remediation: [Specific fix]
```
