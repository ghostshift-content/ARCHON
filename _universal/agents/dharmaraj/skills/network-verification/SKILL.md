# Network Pentest Verification

Independent verification of network penetration testing findings.

## What Gets Verified
- **Open ports** — does nmap/nc confirm the claimed open ports?
- **Service versions** — does banner grabbing match the claimed versions?
- **Default credentials** — do the claimed default logins actually work?
- **Protocol vulnerabilities** — are the claimed protocol weaknesses actually exploitable?
- **Network segmentation** — can you actually reach the claimed internal hosts?
- **SNMP/SMB/FTP misconfigs** — do the claimed misconfigurations actually exist?
- **SSL/TLS issues** — does the claimed weak cipher/expired cert actually exist?

## Verification Methods
1. **Port scanning** — `nmap -sV -p PORT TARGET` for specific claimed ports
2. **Banner grabbing** — `nc -v TARGET PORT` or `openssl s_client`
3. **Credential testing** — actual login attempt with claimed default creds
4. **Protocol probes** — `smbclient`, `snmpwalk`, `ftp` for specific services
5. **SSL analysis** — `openssl s_client -connect TARGET:PORT` for cert/cipher verification

## Anti-Rationalization Rules
- "Port 445 is open" → `nmap -sV -p 445 TARGET` — SHOW THE OUTPUT
- "Default credentials work" → ACTUALLY LOG IN AND SHOW THE SESSION
- "SSL cert is expired" → SHOW THE CERT DATES FROM openssl
- "SMB signing not required" → `nmap --script smb-security-mode TARGET`
- "Host is reachable" → PING IT OR SHOW THE CONNECTION

## Evaluation Criteria
- Each finding has an independently executed network probe
- Service versions confirmed with actual banner/version output
- Credential findings: actual successful authentication shown
- Network paths: each hop traceable with evidence
- False positives identified — especially "port filtered" vs "port open"
- CVE references validated against actual detected version
- Final VERDICT present with pass rate
