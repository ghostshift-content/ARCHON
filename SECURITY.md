# Security Policy

## Reporting a vulnerability in ARCHON

Please report security issues **privately** via GitHub Security Advisories:
**Security → Report a vulnerability** on this repository. Do not open a public issue for a
suspected vulnerability. We aim to acknowledge within a few days and will coordinate a fix and
disclosure timeline with you.

Include: affected version/commit, a description, reproduction steps, and impact.

## Authorized use only

ARCHON is an **offensive** security tool: it generates and fires payloads against web targets.
Run it **only** against systems you own or are explicitly authorized to test (a signed engagement,
a bug-bounty program in scope, a CTF, or your own lab). Unauthorized testing is illegal.

The tool ships with a safety perimeter, and it must stay intact:
- **Scope is fail-closed** — a dispatch with no scope config is blocked (`agents/scope-prevalidator.js`;
  override only in a lab with `ARCHON_SCOPE_OVERRIDE=1`).
- **Impact demonstration is gated** — payloads that *prove* impact (e.g. real RCE) fire only behind
  the active-PoC 3-gate perimeter (engagement mode + permission token + `ARCHON_ACTIVE_POC`); the
  default fires nothing beyond detection payloads.
- Do not remove, weaken, or bypass these gates in a contribution.

## Non-destructive by default (production safety)

ARCHON is meant to be pointed at **live production** by bug-bounty users, so detection is
**non-destructive by design**. Every agent prompt carries a hard contract (`GATE-14 [PRODUCTION-SAFE]`
in `src/core/squad-framework.js`, defined in `src/safety/production-safety.js`):

- **Never** delete or modify data (`DELETE`/`DROP`/`TRUNCATE`/`UPDATE`, `rm`, file overwrite), change
  credentials / passwords / MFA / roles, or delete/lock accounts.
- **IDOR / access-control is tested read-only** — prove it by *reading* an object you shouldn't see.
- **Bounded** — at most **10 attempts** when testing rate-limiting / lockout / brute-force; no signup
  floods or mass record creation; no DoS / stress / ReDoS; back off on WAF / 429 / CAPTCHA.
- Only a **benign** impact proof (e.g. `echo <nonce>` for RCE) may fire, and only under active-poc.

Enforcement layers: (1) the prompt contract above, injected into every agent via `MUST_GATES`;
(2) a deterministic destructive-pattern guard (`guardRequest()`) on the request paths ARCHON runs itself
(the chain-verifier curl replay), which skips any destructive / state-changing step.

**Local-machine safety.** The specialist agents run with a full shell (`bypassPermissions`) to drive
their tools, so a hallucination — or a prompt-injection payload returned by a malicious target and read
by the agent — could try a destructive command on the OPERATOR'S OWN machine (`rm -rf`, `mkfs`,
`curl … | sh`, `shutdown`, a fork bomb, …). The default **SDK adapter** wires a **PreToolUse hook**
(`agents/runner/adapters/sdk.js` → `guardLocalCommand()` in `src/safety/production-safety.js`) that
**hard-denies** these before the shell runs them — a real interlock that fires even under
`bypassPermissions`, not just the prompt. A normal `rm <file>` (no `-r`/`-f`) and ordinary recon tools
are unaffected. The `ADAPTER=cli` rollback path relies on the prompt contract for this; the SDK adapter
is the default and the recommended one. Authorized destructive testing opts out with
`ARCHON_ALLOW_DESTRUCTIVE=1`.

**Residual risk (stated honestly):** specialist agents fire their own HTTP through their tools
(curl / nuclei / sqlmap). ARCHON can now *route* that traffic through an operator-configured
intercepting proxy for visibility — `ARCHON_PROXY_URL` (see README's "Proxying traffic through Burp
Suite" and `src/integrations/proxy-config.js`) — but the proxy is passive: it does not itself enforce
the destructive-pattern guard, so the guarantee on that traffic remains the prompt contract, not a
network interlock. For maximum safety on sensitive production targets, prefer a **static / white-box**
run (reads source, fires **zero** requests) or use **test accounts**. A proxy layer that also
*enforces* the guard for all agent traffic (not just observes it) remains on the roadmap. Authorized
destructive testing (e.g. your own staging) can opt out with `ARCHON_ALLOW_DESTRUCTIVE=1` (default off).

## No secrets or client data in the repo

This is a public repository. It must never contain:
- private keys, API tokens, or credentials;
- real client hostnames, internal infrastructure, real IP addresses, or personal data (emails, names);
- hardcoded developer/home paths.

Enforcement (defense in depth):
- **`scripts/scan-secrets.js`** — a self-contained scanner for the classes above, verified by
  `test/scan-secrets.test.js`. Run it any time with `npm run scan`.
- **Pre-commit hook** (`.githooks/pre-commit`) — blocks a commit that introduces any of the above.
  Enable it once per clone: `npm run setup:hooks` (also run by `bash setup.sh`), or manually
  `git config core.hooksPath .githooks`.
- **CI** runs the scanner on every push and pull request.

If you must commit a genuine false positive (an example key in the KB, a documentation placeholder),
add a trailing `scan-allow` comment on that line. Use it sparingly.

## Supported versions

The `main` branch is the supported line; security fixes land there. Pin a commit for reproducibility.
