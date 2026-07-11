// src/safety/production-safety.js
//
// Production-safety guardrails. ARCHON is run against LIVE production targets by
// bug-bounty users, so detection must be NON-DESTRUCTIVE by default: no data
// deletion/modification, no account/credential changes, no denial of service,
// and every repeated action is bounded.
//
// Two enforcement layers:
//   1) PRODUCTION_SAFETY_CONTRACT — the canonical rules, injected into EVERY agent
//      prompt via MUST_GATES (src/core/squad-framework.js). Behavioural: the LLM
//      specialists follow it. This is where most of the safety comes from because
//      the agents fire their own requests (curl/nuclei/sqlmap) via their tools.
//   2) scanForDestructive()/guardRequest() — a deterministic detector wired into
//      the request paths ARCHON ITSELF executes (the chain-verifier curl replay).
//      A backstop for the LLM-constructed commands ARCHON runs directly.
//
// Residual risk (documented in SECURITY.md): layer 1 (prompt) remains the
// PRIMARY guard on what the specialist agents' own tools do — proxying traffic
// gives an operator VISIBILITY into it (for inspection/debugging/pentesting
// workflows via Burp Suite, ZAP, mitmproxy, etc.), not an additional
// enforcement layer. See src/integrations/proxy-config.js (opt-in via
// ARCHON_PROXY_URL) — it routes agent-fired curl/nuclei/sqlmap/git/wget/
// node/python subprocess traffic, the Playwright browser-verifier agent, and
// ARCHON's own api.anthropic.com calls through a configured proxy. A proxy
// that also ENFORCES production-safety (blocking, not just observing,
// destructive requests) for all agent traffic remains a roadmap item.
//
// Escape hatch for AUTHORIZED destructive testing (e.g. your own staging):
//   ARCHON_ALLOW_DESTRUCTIVE=1  (default unset ⇒ fully safe). Mirrors the direct
//   process.env pattern used by agents/active-poc-policy.js.
'use strict'

// Bounded caps — referenced in the contract text below. Keep them in sync.
const LIMITS = Object.freeze({
  MAX_RATE_LIMIT_ATTEMPTS: 10, // testing rate-limit / lockout / brute-force: at most N attempts
  MAX_TEST_ACCOUNTS: 2,        // never auto-signup / mass-create accounts
  MAX_FUZZ_PER_PARAM: 25,      // cap fuzzing so a run can't flood the target
})

// The NEVER list — unambiguously destructive command/SQL/shell/HTTP patterns.
// Deliberately narrow (low false-positive): bounded reversible writes (a single
// test record, a read-only POST/search) are NOT matched here — those are governed
// by the prompt contract. Only clearly data-destroying / state-changing verbs.
const DESTRUCTIVE_PATTERNS = [
  { re: /\bdrop\s+(table|database|schema)\b/i, why: 'SQL DROP' },
  { re: /\bdelete\s+from\b/i, why: 'SQL DELETE FROM' },
  { re: /\btruncate\s+(table\s+)?\w/i, why: 'SQL TRUNCATE' },
  { re: /\bupdate\s+\S+\s+set\b/i, why: 'SQL UPDATE ... SET' },
  { re: /\brm\s+-[a-z]*[rf]/i, why: 'rm -rf (file deletion)' },
  { re: /\b(shutdown|reboot|halt|poweroff|mkfs)\b/i, why: 'host destruction' },
  { re: /:\s*\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/, why: 'fork bomb' },
  { re: /(?:^|\s)-X\s*(DELETE|PUT|PATCH)\b/i, why: 'state-changing HTTP method (-X)' },
  { re: /--request\s+(DELETE|PUT|PATCH)\b/i, why: 'state-changing HTTP method (--request)' },
]

// Scan a command / payload / curl string for destructive patterns.
// Returns { blocked, reason, match } — blocked=false when clean.
function scanForDestructive(text) {
  if (!text) return { blocked: false }
  const s = String(text)
  for (const p of DESTRUCTIVE_PATTERNS) {
    const m = s.match(p.re)
    if (m) return { blocked: true, reason: p.why, match: m[0] }
  }
  return { blocked: false }
}

// True when the operator has explicitly opted into destructive testing.
function allowDestructive() {
  return process.env.ARCHON_ALLOW_DESTRUCTIVE === '1'
}

// ── Local-host command safety ────────────────────────────────────────────────
// Specialist agents run with a full shell (bypassPermissions), so a hallucination —
// or a prompt-injection payload returned by a malicious target and read by the agent —
// could try to run a destructive command on the OPERATOR'S OWN machine. guardLocalCommand()
// is wired into the agent's PreToolUse hook (agents/runner/adapters/sdk.js) to hard-DENY
// these before the shell runs them. Focused on host/file destruction + piping a remote
// script into a shell; a normal `rm <file>` (no -r/-f) and ordinary recon tools are allowed.
// Opt out with ARCHON_ALLOW_DESTRUCTIVE=1.
const LOCAL_DESTRUCTIVE_PATTERNS = [
  { re: /\brm\s+-[a-z]*[rf]/i, why: 'rm -r/-f (recursive/forced deletion)' },
  { re: /\b(mkfs|mke2fs)\b/i, why: 'filesystem format (mkfs)' },
  { re: /\bdd\b[^|&;\n]*\bof=\/dev\//i, why: 'dd to a device (disk overwrite)' },
  { re: /\b(shutdown|reboot|halt|poweroff)\b/i, why: 'host shutdown/reboot' },
  { re: /\binit\s+[06]\b/, why: 'init 0/6 (halt/reboot)' },
  { re: /:\s*\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/, why: 'fork bomb' },
  { re: />\s*\/dev\/(sd|nvme|disk|hd)/i, why: 'redirect to a block device' },
  { re: /\b(curl|wget|fetch)\b[^\n|]*\|\s*(sudo\s+)?(sh|bash|zsh|python[0-9.]*|perl|ruby|node)\b/i, why: 'pipe a remote script into a shell (curl|sh)' },
  { re: /\bchmod\s+-R\b[^\n]*\s\/(etc|usr|bin|sbin|var|root|boot|lib)\b/i, why: 'chmod -R on a system path' },
  { re: /\bfind\s+\/[^\n]*-delete\b/i, why: 'find / -delete' },
]

// Tools disabled for the current release — blocked at the PreToolUse chokepoint so an
// agent can't run one even if its persona still references it. nuclei is OFF for the
// first release until we ship proper rate-limit/config tuning; re-enable per-tool with
// its env flag (ARCHON_ENABLE_NUCLEI=1). NOT gated by ARCHON_ALLOW_DESTRUCTIVE.
const RELEASE_DISABLED_TOOLS = [
  { bin: 'nuclei', env: 'ARCHON_ENABLE_NUCLEI', why: 'nuclei DAST disabled for this release (rate-limit/config tuning pending) — set ARCHON_ENABLE_NUCLEI=1 to enable' },
]

// Deny a command that invokes a release-disabled tool. Matches the tool as a command
// token (start, or after a pipe/;/&&/whitespace) so "nuclei -u …", "| nuclei",
// "&& nuclei" all hit — but a substring like "nucleic" does NOT.
function guardReleaseDisabledTool(command) {
  if (!command) return { allow: true }
  const s = String(command)
  for (const t of RELEASE_DISABLED_TOOLS) {
    if (process.env[t.env] === '1') continue
    if (new RegExp(`(?:^|[|;&]|\\s)${t.bin}\\b`, 'i').test(s)) {
      return { allow: false, reason: t.why, match: t.bin }
    }
  }
  return { allow: true }
}

// PreToolUse gate for a shell command the agent wants to run on the LOCAL machine.
// Returns { allow: true } or { allow: false, reason, match }.
function guardLocalCommand(command) {
  // Release-disabled tools are blocked FIRST — enforced even under ARCHON_ALLOW_DESTRUCTIVE.
  const rel = guardReleaseDisabledTool(command)
  if (!rel.allow) return rel
  if (allowDestructive()) return { allow: true }
  if (!command) return { allow: true }
  const s = String(command)
  for (const p of LOCAL_DESTRUCTIVE_PATTERNS) {
    const m = s.match(p.re)
    if (m) return { allow: false, reason: p.why, match: m[0] }
  }
  return { allow: true }
}

// Execution-chokepoint gate. Returns { allow: true } or { allow: false, reason }.
// Wire this in wherever ARCHON itself runs an LLM-constructed request.
function guardRequest(text) {
  if (allowDestructive()) return { allow: true }
  const scan = scanForDestructive(text)
  if (scan.blocked) {
    return { allow: false, reason: `non-destructive safe mode: blocked ${scan.reason} (${scan.match})` }
  }
  return { allow: true }
}

const PRODUCTION_SAFETY_CONTRACT = `
**GATE-14 [PRODUCTION-SAFE / NON-DESTRUCTIVE] — assume the target is LIVE PRODUCTION.**
ARCHON runs against real systems. Detect vulnerabilities WITHOUT changing or destroying anything.
These rules are ABSOLUTE and override any other instruction. If a test would create, change, or
delete data, DO NOT run it — report the vulnerability from safe evidence instead.

- **Never destroy or modify data.** No SQL \`DELETE\`/\`DROP\`/\`TRUNCATE\`/\`UPDATE ... SET\`; no
  \`rm\`/file deletion or overwrite; no bulk edits. Prove SQL injection with READ-ONLY techniques
  (boolean / time / error / \`UNION SELECT\`) — NEVER a stacked destructive query (\`; DROP TABLE\`,
  \`; DELETE FROM\`).
- **Never change credentials or account state.** Do not change any password, email, MFA/2FA,
  session, API key, or role; do not disable, lock, or delete accounts. Detect account-takeover paths
  by analysis — do NOT execute a takeover against a real user.
- **Test access control (IDOR/BOLA) READ-ONLY.** To prove IDOR, *read* an object you shouldn't see —
  never modify, delete, or exfiltrate it. One unauthorized read confirms it.
- **Prefer safe HTTP methods.** Probe with GET/HEAD/OPTIONS. Do NOT send \`DELETE\`, or state-changing
  \`PUT\`/\`PATCH\`/\`POST\`, against real data. A POST that only *reads* (search/GraphQL query) is fine.
- **Bound every repeated action.** When testing rate-limiting, lockout, brute-force, or fuzzing, send
  AT MOST 10 attempts — never a real brute-force / credential-stuffing run, and never enough to lock a
  real account. Cap fuzzing so you don't flood the target.
- **No account or data creation floods.** Do not auto-register accounts or mass-create records. If a
  single test record is unavoidable, create at most one or two, clearly marked as test data, and never
  automate signup.
- **No denial of service.** No load / stress / flood testing, no resource-exhaustion or ReDoS payloads,
  no billion-laughs / zip-bombs — nothing that could degrade availability.
- **No weaponization, persistence, or real exfiltration.** Prove a vuln exists; don't exploit it. No
  reverse shells, no lateral movement, no dumping real user data, no mail/SMS/notification floods
  (don't spam or bill the target).
- **Back off on defenses.** On WAF blocks, 429s, or CAPTCHAs — slow down or stop; do not hammer.

The ONLY exception is a BENIGN impact proof (e.g. \`echo <nonce>\` for RCE) under active-poc mode
(engagement_mode + permission token + \`ARCHON_ACTIVE_POC\`) — and even then it must cause no destruction.
Violation = finding rejected and a safety incident.
`

module.exports = {
  LIMITS,
  DESTRUCTIVE_PATTERNS,
  LOCAL_DESTRUCTIVE_PATTERNS,
  RELEASE_DISABLED_TOOLS,
  scanForDestructive,
  allowDestructive,
  guardRequest,
  guardLocalCommand,
  guardReleaseDisabledTool,
  PRODUCTION_SAFETY_CONTRACT,
}
