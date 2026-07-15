'use strict'
// suspected-dedup.js — collapse the raw live-findings pile into a clean, bounded set
// of DISTINCT suspected findings for AUDITOR to validate.
//
// Why: specialists emit the SAME finding 100–270× (fire→observe→mutate loops) plus
// progress noise ("DISCOVERY", "RECON Complete"). AUDITOR was handed a raw grep of the
// whole ACTIVITY-LOG (2737 lines for one run) and, being an LLM, validated only a handful
// — so real High/Critical findings (RCE, command injection) never got a verdict and never
// reached the board. This deterministic pass gives AUDITOR ONE line per real, distinct
// finding so it can validate each. Pure + tested; the daemon writes the result to
// SUSPECTED-FINDINGS-<taskId>.jsonl and points AUDITOR there (with the grep as fallback).

// Progress/status markers and non-vuln bookkeeping that leak into live-findings — never
// findings, always dropped before AUDITOR sees them.
const NOISE_TYPES = new Set(['info', 'in-progress', 'running', 'status', 'done', 'submitted', 'disproven', 'discovery', 'recon'])
const NOISE_TITLE = /^(discovery|recon complete|recon|python3?|scan(ning)?|starting|progress|status|note)\b/i

// Canonical identity of a finding for dedup: same agent + vuln class + normalized claim.
// Digits are collapsed (→ #) so "FTP creds in PCAP 33 / 34 / 35" become ONE finding, and
// case/whitespace are folded. This is what turns 270 near-identical emits into 1 line.
function canonicalKey(f) {
  const agent = String(f.agent || f.original_agent || '').toLowerCase().trim()
  const cls = String(f.cwe || f.owasp || f.type || '').toLowerCase().replace(/\s+/g, '').replace(/[^a-z0-9]/g, '').slice(0, 24)
  const title = String(f.details || f.title || f.finding || '')
    .split(/[:.\n]/)[0].toLowerCase().replace(/\d+/g, '#').replace(/\s+/g, ' ').trim().slice(0, 60)
  return `${agent}|${cls}|${title}`
}

// The IMMUTABLE queue/dedup/retry identity. A source-review candidate carries its own candidate_id /
// duplicate_key — a mode-independent weakness identity (asset + location + class + invariant + sink) where two
// DISTINCT weaknesses (read-IDOR vs update-IDOR on the same controller) have DISTINCT keys. Prefer it so
// distinct candidates never collapse. Fall back to the fuzzy canonicalKey ONLY when neither exists (black-box
// emits with no id — there the 270× digit-collapse is exactly what we want). This is the ONE identity used by
// nextBatch (pickup dedup), the triage join, and the retry/quarantine counters — so they can never disagree.
function identityKey(f) {
  const cid = f && (f.candidate_id || f.duplicate_key)
  return cid ? String(cid).trim().toLowerCase() : canonicalKey(f)
}

const SEV_RANK = { critical: 0, high: 1, medium: 2, low: 3, info: 4, none: 5 }
function sevRank(f) { return SEV_RANK[String(f.severity || 'medium').toLowerCase()] ?? 2 }

// A record is a real candidate finding (not progress noise, has a claim to validate).
function isCandidate(f) {
  if (!f || typeof f !== 'object') return false
  const type = String(f.type || '').toLowerCase()
  if (NOISE_TYPES.has(type)) return false
  const title = String(f.details || f.title || f.finding || '').trim()
  if (!title || NOISE_TITLE.test(title)) return false
  return true
}

/**
 * Collapse raw finding records → distinct suspected findings for AUDITOR.
 * @param {object[]} records - parsed live-findings records
 * @param {object} [opts] - { cap = 80 } max distinct findings AUDITOR should validate
 * @returns {{ findings: object[], total: number, distinct: number, capped: number }}
 */
function dedupeSuspected(records, { cap = 80 } = {}) {
  const groups = new Map()
  let total = 0
  for (const f of (records || [])) {
    if (!isCandidate(f)) continue
    total++
    const key = canonicalKey(f)
    const g = groups.get(key)
    if (!g) { groups.set(key, { rep: f, count: 1 }) }
    else {
      g.count++
      // keep the richest representative: prefer higher severity, then more evidence text
      const better = sevRank(f) < sevRank(g.rep) ||
        (sevRank(f) === sevRank(g.rep) && String(f.reproduction || f.details || '').length > String(g.rep.reproduction || g.rep.details || '').length)
      if (better) g.rep = f
    }
  }
  let findings = [...groups.values()]
    .sort((a, b) => sevRank(a.rep) - sevRank(b.rep) || b.count - a.count)
    .map((g, i) => ({
      id: `S-${i + 1}`,
      title: String(g.rep.details || g.rep.title || g.rep.finding || '').split(/[:.\n]/)[0].slice(0, 100),
      severity: g.rep.severity || 'Medium',
      type: g.rep.type || '', cwe: g.rep.cwe || '', owasp: g.rep.owasp || '',
      url: g.rep.url || '', agent: g.rep.agent || g.rep.original_agent || '',
      details: g.rep.details || '', reproduction: g.rep.reproduction || '', impact: g.rep.impact || '',
      _merged_count: g.count,
    }))
  const distinct = findings.length
  const capped = Math.max(0, distinct - cap)
  if (capped > 0) findings = findings.slice(0, cap) // already severity-sorted → keep the worst
  return { findings, total, distinct, capped }
}

module.exports = { dedupeSuspected, canonicalKey, identityKey, isCandidate }

// self-check: the exact ee08 shape — 2737 raw with 270× repeats + progress noise → distinct.
if (require.main === module) {
  const assert = require('node:assert')
  const raw = []
  for (let i = 0; i < 270; i++) raw.push({ type: 'confirmed', agent: 'VAULT', severity: 'High', cwe: 'CWE-200', details: `FTP Credentials Exposed in PCAP ${i} Download`, reproduction: 'curl ...' })
  for (let i = 0; i < 156; i++) raw.push({ type: 'confirmed', agent: 'FORGE', severity: 'Critical', details: 'Unauthenticated Root-Level Code Execution Design' })
  for (let i = 0; i < 309; i++) raw.push({ type: 'info', agent: 'SCOUT', details: 'DISCOVERY' })
  for (let i = 0; i < 309; i++) raw.push({ type: 'in-progress', agent: 'RANGER', details: 'RECON Complete' })
  raw.push({ type: 'confirmed', agent: 'DECOY', severity: 'High', details: 'CSRF + Unauthenticated IDOR via Sequential Capture IDs' })
  const out = dedupeSuspected(raw)
  assert.strictEqual(out.distinct, 3, `expected 3 distinct (FTP, RCE, CSRF), got ${out.distinct}`)
  assert.strictEqual(out.total, 427, `candidates should exclude the 618 noise rows, got ${out.total}`)
  assert.strictEqual(out.findings[0].severity, 'Critical', 'worst severity sorts first (RCE)')
  assert.ok(out.findings.some(f => /Code Execution/.test(f.title)), 'RCE survives — the finding that was being lost')
  assert.strictEqual(out.findings.find(f => /FTP/.test(f.title))._merged_count, 270, '270 FTP emits collapse to 1')
  // cap keeps the worst-severity findings
  const many = Array.from({ length: 100 }, (_, i) => ({ type: 'confirmed', agent: 'A', severity: 'Low', details: `finding ${String.fromCharCode(65 + (i % 26))}${i}` }))
  many.unshift({ type: 'confirmed', agent: 'A', severity: 'Critical', details: 'keep me' })
  const capped = dedupeSuspected(many, { cap: 10 })
  assert.strictEqual(capped.findings.length, 10, 'cap enforced')
  assert.strictEqual(capped.findings[0].severity, 'Critical', 'cap keeps worst severity first')
  assert.ok(capped.capped > 0, 'capped count reported')
  // identityKey: two DISTINCT source candidates on the same file/class must NOT collapse (the Gate-3 12→11 loss),
  // while black-box emits with no id still fold via canonicalKey.
  const readIdor = { candidate_id: 'user-accounts:access-control:users_controller.rb:show-idor', agent: 'marshal', cwe: 'CWE-639', details: 'IDOR in user-accounts' }
  const updIdor = { candidate_id: 'user-accounts:access-control:users_controller.rb:update-ownership', agent: 'marshal', cwe: 'CWE-639', details: 'IDOR in user-accounts' }
  assert.notStrictEqual(identityKey(readIdor), identityKey(updIdor), 'distinct candidate_ids stay distinct')
  assert.strictEqual(canonicalKey(readIdor), canonicalKey(updIdor), '...even though the fuzzy canonicalKey WOULD have collapsed them')
  const bbA = { agent: 'VAULT', cwe: 'CWE-200', details: 'FTP creds in PCAP 5' }
  const bbB = { agent: 'VAULT', cwe: 'CWE-200', details: 'FTP creds in PCAP 6' }
  assert.strictEqual(identityKey(bbA), identityKey(bbB), 'no id → canonicalKey still collapses black-box repeats')
  console.log('ok — suspected-dedup collapses raw emits + noise → distinct, worst-first, capped; identityKey preserves distinct candidates')
}
