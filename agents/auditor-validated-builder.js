// agents/auditor-validated-builder.js
//
// 2026-05-11: Bridges AUDITOR's ACTIVITY-LOG verdicts → VALIDATED-FINDINGS-
// {taskId}.jsonl, which Phase 3.9 (judge) + Phase 3.45 (rule-based handoff)
// require but no producer ever wrote.
//
// Root cause: AUDITOR's prompt instructs it to write CONFIRMED/KILLED entries
// to /root/intel/ACTIVITY-LOG.jsonl (which it actually does). But Phase 3.9
// expects /root/intel/pentest/VALIDATED-FINDINGS.jsonl (singular, shared) —
// a fossil from a prior prompt design. The shared file is never updated;
// stale 26-entry file from earlier runs causes Phase 3.9 to judge old data,
// producing false-positive verdicts (round-9 88% was partial luck from
// motorola-era stale entries matching the target).
//
// This module fixes the gap deterministically (same pattern as
// rule-based-handoff-generator: when prompt-to-action gap exists, replace
// the agent's "write structured file" step with deterministic code).
//
// AUDITOR still writes ACTIVITY-LOG entries (that works). This module reads
// those entries post-Phase-3 and writes the per-task VALIDATED-FINDINGS
// file Phase 3.9 + 3.45 need.
//
// 2026-05-15: VERDICT_RE relaxed to handle AUDITOR's current free-text output.
// Bug: regex demanded F-NNN: prefix, but AUDITOR writes free-text titles:
//   "KILLED — crossDomainLogout CSRF (TRACER-025/KEYRING-032)"
// Impact: 0 records written to VALIDATED-FINDINGS → Phase 3.075 + 3.9
// silently starved. Verified on passport.lenovo.com pentest run 2026-05-15.
// Fix: relaxed VERDICT_RE + new parseVerdictLine helper with 3-tier findingId
// extraction: (1) legacy F-NNN: prefix, (2) first agent-ID in parens,
// (3) sha256-hash fallback AUDITOR-FN-{8char}.

'use strict'
const __roots = require('../paths') // portable roots (KURU_*_ROOT) — see paths.js


const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const { extractFirstUrl } = require('./url-extractor')
const { validateFinding } = require('./finding-schema')
const { enforceContract } = require('../src/pipeline/evidence-contract')

const ACTIVITY_LOG = (__roots.INTEL_ROOT + '/ACTIVITY-LOG.jsonl')
const INTEL_DIR = __roots.INTEL_ROOT

// Relaxed VERDICT_RE: matches any CONFIRMED/KILLED line with em-dash (U+2014).
// Em-dash is U+2014 (—), not double-hyphen. Both legacy F-NNN: format and
// current free-text format are captured by group 2 (raw_body).
//   Legacy: "CONFIRMED — F-001: No Account Lockout on VPN Authentication"
//   Current: "KILLED — crossDomainLogout CSRF (TRACER-025/KEYRING-032)"
const VERDICT_RE = /^(CONFIRMED|KILLED)\s+—\s+(.+)$/

// Legacy F-NNN: prefix pattern (e.g. "F-001: title text")
const LEGACY_ID_RE = /^(F-\d+):\s*(.+)$/

// Agent-ID pattern in trailing parens (e.g. "(TRACER-025/KEYRING-032)")
// Captures first agent-ID from slash-separated list.
const AGENT_ID_RE = /\(([A-Z]+-\d+)/

// Parse a raw verdict line (the action string, NOT a JSONL log line).
// Returns { verdict, findingId, title } or null if not a verdict line.
// This is the pure parser used by tests and by parseauditorEntry.
// KILLED entries ARE returned (caller decides to drop or keep).
function parseVerdictLine(line) {
  if (!line) return null
  const m = String(line).match(VERDICT_RE)
  if (!m) return null
  const verdict = m[1]
  const rawBody = m[2].trim()

  // Tier 1: legacy F-NNN: prefix
  const legacyMatch = rawBody.match(LEGACY_ID_RE)
  if (legacyMatch) {
    return { verdict, findingId: legacyMatch[1], title: legacyMatch[2].trim() }
  }

  // Tier 2: first agent-ID from trailing parens e.g. "(TRACER-025/KEYRING-032)"
  // Strip the parens suffix from title for cleanliness.
  const agentMatch = rawBody.match(AGENT_ID_RE)
  const title = rawBody.replace(/\s*\([^)]*\)\s*$/, '').trim() || rawBody
  if (agentMatch) {
    return { verdict, findingId: agentMatch[1], title }
  }

  // Tier 3: deterministic hash fallback — AUDITOR-FN-{first 8 hex of sha256(rawBody)}
  const hash = crypto.createHash('sha256').update(rawBody).digest('hex').slice(0, 8)
  return { verdict, findingId: `AUDITOR-FN-${hash}`, title }
}

// Extract the source-agent name embedded in title parens, e.g.:
//   "F-003: Logout CSRF Bypass (Multiple Agents: VIPER, DECOY, SPECTRE)"
//   → 'VIPER,DECOY,SPECTRE'
// Returns 'unknown' when the title carries no agent tag.
function extractOriginalAgent(title) {
  const m = title.match(/\(([^)]+)\)/)
  if (!m) return 'unknown'
  const inner = m[1]
  // "Multiple Agents: A, B, C" → "A,B,C"
  const colonIdx = inner.indexOf(':')
  const list = colonIdx >= 0 ? inner.slice(colonIdx + 1) : inner
  return list.split(/[,\s]+/).filter(Boolean).join(',') || 'unknown'
}

// Severity inference is intentionally crude — Phase 3.9 (judge) is the
// authoritative classifier downstream. We just need a starting point so the
// judge's rubric has something to operate on. Defaults to Medium when no
// signal is present.
function inferSeverity(title) {
  const t = String(title || '').toLowerCase()
  if (/\b(rce|sqli|sql injection|account takeover|privilege escalation|brute force|unauth.*credential|credential stuffing|deserialization)\b/.test(t)) {
    return 'High'
  }
  if (/\b(authentication bypass|sensitive disclosure|saml|jwt|sso bypass|directory traversal|lfi|ssrf)\b/.test(t)) {
    return 'High'
  }
  if (/\b(no rate limit|no lockout|csrf|stored xss|reflected xss|idor|broken auth)\b/.test(t)) {
    return 'Medium'
  }
  if (/\b(disclosure|leak|enumeration|deprecated|info disclosure)\b/.test(t)
      || /\bmissing\b.*\bheader\b/.test(t)) {
    return 'Low'
  }
  return 'Medium'
}

// Parse one ACTIVITY-LOG line; return validated record OR null.
// Uses parseVerdictLine internally; drops KILLED verdicts (only CONFIRMED
// findings flow into Phase 3.9 / 3.45 downstream).
function parseauditorEntry(rawLine, taskId) {
  let entry
  try { entry = JSON.parse(rawLine) } catch { return null }
  if (entry.agent !== 'AUDITOR') return null
  if (String(entry.taskId || '') !== String(taskId)) return null
  const parsed = parseVerdictLine(String(entry.action || ''))
  if (!parsed) return null
  if (parsed.verdict !== 'CONFIRMED') return null // KILLED → drop, never reaches judge

  const { findingId: id, title } = parsed
  // Canonical url field — Phase 3.06 scope-validator checks this first.
  // AUDITOR's ACTIVITY-LOG entries don't carry a top-level url; URL is buried
  // in details/notes free text like:
  //   "Confirmed via curl: curl -sI 'https://uatcommercial.lenovo.com/eticket/login'"
  // Producer-side extraction here means the consumer no longer needs to
  // guess. Fall-through order: explicit top-level url > affected_url > target,
  // then regex-extract from details, then notes, then empty.
  const url =
    (entry.url || entry.affected_url || entry.target) ||
    extractFirstUrl(entry.details || '') ||
    extractFirstUrl(entry.notes || '') ||
    ''
  // Extract reproduction_method + reproduction_result from AUDITOR's free-text details.
  // These fields feed judge-verifier.js's extractEvidence() — without them
  // ARBITER evaluates every finding as "(no evidence)" (GATE-116 fix 2026-06-05).
  // AUDITOR's details look like: "Confirmed via curl: curl -sI 'URL' → 200 OK, header absent"
  const detailsText = entry.details || ''
  let reproMethod = ''
  let reproResult = ''
  // Extract curl/http command from details
  const curlMatch = detailsText.match(/curl\s[^\n]+/i)
  if (curlMatch) {
    reproMethod = curlMatch[0].trim()
    // Everything after the curl command is the result
    const afterCurl = detailsText.slice(detailsText.indexOf(curlMatch[0]) + curlMatch[0].length).trim()
    if (afterCurl) reproResult = afterCurl.slice(0, 500) // cap at 500 chars
  } else if (detailsText) {
    // No curl found — use full details as reproduction context
    reproMethod = detailsText.slice(0, 400)
  }

  const record = {
    id,
    title,
    url,
    validation_status: 'CONFIRMED',
    severity: inferSeverity(title),
    original_agent: extractOriginalAgent(title),
    notes: entry.details || '',
    details: entry.details || entry.action,
    // Evidence fields for ARBITER judge (extractEvidence() reads these)
    reproduction_method: reproMethod || undefined,
    reproduction_result: reproResult || undefined,
    proof: detailsText ? detailsText.slice(0, 600) : undefined,
    confidence: entry.confidence || undefined, // from AUDITOR's structured output if present
    taskId: String(taskId),
    sentry_ts: entry.ts || new Date().toISOString(),
    source: 'auditor-validated-builder',
  }
  // Evidence contract: a CONFIRMED record with no replayable evidence is demoted
  // to NEEDS-LIVE (not treated as proven) rather than silently published.
  const contracted = enforceContract(record)
  if (contracted.evidence_demoted) {
    console.warn(`[auditor-validated-builder] evidence-contract: ${contracted.id} demoted CONFIRMED→NEEDS-LIVE (no replayable evidence) taskId=${contracted.taskId || '?'}`)
  }
  // Task 4: enforce FindingSchema at producer boundary. Auto-repair + warn,
  // never reject — silent data loss is the failure mode we're closing.
  const validated = validateFinding(contracted)
  if (validated.warnings.length > 0) {
    for (const w of validated.warnings) {
      console.warn(`[auditor-validated-builder] auto-repair: ${w} (taskId=${record.taskId || '?'})`)
    }
  }
  return validated.finding
}

// Pure function: parse a full activity-log buffer (string) for one taskId,
// return validated record array. Useful for tests with synthetic data.
function buildFromBuffer(activityLogBuffer, taskId) {
  if (!activityLogBuffer) return []
  const out = []
  const seen = new Set()
  for (const line of String(activityLogBuffer).split('\n')) {
    const t = line.trim()
    if (!t) continue
    const rec = parseauditorEntry(t, taskId)
    if (!rec) continue
    if (seen.has(rec.id)) continue // de-dup: re-runs may emit twice
    seen.add(rec.id)
    out.push(rec)
  }
  return out
}

// Real I/O wrapper: read ACTIVITY-LOG from disk + parse for taskId.
function buildFromActivityLog(taskId, { activityLogPath = ACTIVITY_LOG } = {}) {
  if (!fs.existsSync(activityLogPath)) return []
  const raw = fs.readFileSync(activityLogPath, 'utf-8')
  return buildFromBuffer(raw, taskId)
}

// Write validated findings to /root/intel/VALIDATED-FINDINGS-{taskId}.jsonl
// (the path run-judge-verifier already prefers when present). Returns the
// path and the count of records written. Atomic via tmp+rename so a crash
// mid-write can never leave Phase 3.9 reading half a file.
function writeValidatedFindingsFile(records, taskId, { intelDir = INTEL_DIR } = {}) {
  const outPath = path.join(intelDir, `VALIDATED-FINDINGS-${taskId}.jsonl`)
  const tmpPath = outPath + '.tmp'
  const lines = records.map(r => JSON.stringify(r)).join('\n')
  fs.writeFileSync(tmpPath, lines + (lines ? '\n' : ''))
  fs.renameSync(tmpPath, outPath)
  return { path: outPath, count: records.length }
}

// Main entry point: end-to-end build + write. Fail-soft: throws on critical
// errors (caller decides whether to surface). Returns {path, count, records}.
function buildAndWriteForTask(taskId, opts = {}) {
  if (!taskId) throw new Error('buildAndWriteForTask: taskId required')
  const records = buildFromActivityLog(taskId, opts)
  const { path: outPath, count } = writeValidatedFindingsFile(records, taskId, opts)
  return { path: outPath, count, records }
}

module.exports = {
  buildFromBuffer,
  buildFromActivityLog,
  writeValidatedFindingsFile,
  buildAndWriteForTask,
  parseauditorEntry,
  parseVerdictLine,
  inferSeverity,
  extractOriginalAgent,
  VERDICT_RE,
}
