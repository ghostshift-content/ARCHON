# Cloud Security Verification

Independent verification of cloud security assessment findings.

## What Gets Verified
- **IAM misconfigurations** — do the claimed overly-permissive policies actually exist?
- **Public exposure** — are the claimed public S3 buckets/endpoints actually accessible?
- **Network security groups** — do the claimed open ports actually accept connections?
- **Encryption gaps** — are volumes/databases actually unencrypted as claimed?
- **Logging gaps** — is CloudTrail/monitoring actually disabled as claimed?
- **Credential exposure** — are the claimed leaked keys actually valid/active?
- **Cross-account access** — does the claimed role assumption actually work?

## Verification Methods
1. **AWS CLI commands** — `aws s3 ls`, `aws iam get-policy`, `aws ec2 describe-security-groups`
2. **Direct HTTP probes** — curl public endpoints, check bucket policies
3. **Policy simulation** — `aws iam simulate-principal-policy` for permission claims
4. **Network probes** — nmap specific ports on claimed open security groups

## Anti-Rationalization Rules
- "This bucket appears public" → `curl -s https://s3.amazonaws.com/BUCKET/ | head`
- "IAM policy is too permissive" → SHOW THE ACTUAL POLICY JSON
- "Security group allows all traffic" → SHOW THE SG RULES, PROBE THE PORT
- "CloudTrail is disabled" → `aws cloudtrail get-trail-status --name TRAIL`
- "Agent found this misconfiguration" → VERIFY WITH YOUR OWN AWS CLI CALL

## Evaluation Criteria
- Each finding has an independently executed verification command
- Cloud-specific evidence: actual policy JSON, SG rules, bucket responses
- Region-specific checks: finding applies to claimed region
- Account context: correct account ID confirmed
- False positives identified — especially "default config" assumptions
- Compliance mapping accurate (CIS, SOC2, PCI-DSS)
- Final VERDICT present with pass rate
