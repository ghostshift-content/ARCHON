# Red Team Verification

Independent verification of red team engagement findings. For each claimed attack path:

1. **Reproduce the attack step** — execute the exact command/technique claimed
2. **Record exact output** as evidence (not paraphrased)
3. **Verify lateral movement claims** — each hop must be independently confirmed
4. **Issue verdict:** CONFIRMED / FALSE_POSITIVE / PARTIAL

## What Gets Verified
- **Initial access** — does the entry vector actually work?
- **Privilege escalation** — does the escalation path produce elevated access?
- **Lateral movement** — can you actually reach the claimed next hop?
- **Persistence** — is the persistence mechanism actually installed/functional?
- **Data exfiltration** — can data actually leave through the claimed channel?
- **Detection evasion** — were the claimed evasion techniques actually used?

## Anti-Rationalization Rules
- "This technique should work" → RUN IT AND SHOW THE OUTPUT
- "Common misconfiguration" → VERIFY THIS SPECIFIC TARGET HAS IT
- "Standard lateral movement path" → PROVE EACH HOP INDEPENDENTLY
- "Agent confirmed access" → AGENT IS AN LLM, GET YOUR OWN SHELL

## Evaluation Criteria
- Each attack step has an independently executed command
- Command output included as evidence
- Multi-step chains: each step verified, not just the first and last
- False positives identified — especially "assumed" access without proof
- Kill chain completeness: are there gaps between steps?
- Severity justified with actual achieved impact
- Final VERDICT present with pass rate
