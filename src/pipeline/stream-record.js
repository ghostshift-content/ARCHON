'use strict'
// M1: shape a triaged streaming finding into a VALIDATED-FINDINGS record — the ONE place that decides
// source vs live. A source finding (file/line, no url) ALWAYS carries the source location +
// SOURCE_CONFIRMED and NEVER a url, so deriveConfirmationStatus (finding-schema.js) can never promote
// it to RUNTIME_CONFIRMED. A live finding keeps the url/method shape. Pure + tested because a wrong
// guess fabricates runtime proof for a source-only bug — the whole "never mark source-only as
// runtime-confirmed" rule lives here.

// A finding is source-shaped when it has a source location and NO live url.
function isSourceFinding(f) {
  return !!(f && typeof f === 'object' && !f.url && (f.file || f.code_block || f.vulnerable_code))
}

/**
 * Build the VALIDATED record from a triaged finding.
 * @param f the original live-findings record (the candidate)
 * @param d the triager's written detail object
 * @param meta { id, title, agent, taskId }
 */
function shapeStreamValidated(f, d, meta = {}) {
  d = d || {}; f = f || {}
  const { id, title, agent, taskId } = meta
  const base = {
    id, title: d.title || title, severity: d.severity || f.severity || 'Medium',
    validation_status: 'CONFIRMED', original_agent: agent,
    cvss_vector: d.cvss_vector || '', cvss_score: (typeof d.cvss_score === 'number' ? d.cvss_score : null),
    cwe: d.cwe || f.cwe || '', taskId: String(taskId), source: 'streaming-triage',
    // F22: retain the correlation fields so validated records stay linkable (feature ↔ candidate ↔ workstream).
    feature: f.feature || d.feature || '', vulnerability_class: f.vulnerability_class || f.cwe || d.cwe || '',
    duplicate_key: f.duplicate_key || '', candidate_id: f.candidate_id || f.id || id,
    workstream_id: f.workstream_id || '', session_id: f.session_id || '',
    requires_runtime_validation: (f.requires_runtime_validation != null ? f.requires_runtime_validation : undefined),
  }
  // Source finding → source shape, ALWAYS. Even if the triager tried to write a url/response, a
  // source candidate stays SOURCE_CONFIRMED with no url (that fabrication is exactly what this guards).
  let rec
  if (isSourceFinding(f)) {
    const needsLive = d.confirmation_status === 'NEEDS_LIVE_VALIDATION'
    // The proof of a source finding IS the vulnerable code at file:line — carry it (+ the source→sink trace)
    // so the board and report render a "Vulnerable code" block. Prefer the triager's verbatim quote; fall
    // back to the specialist's evidence snippet so the block is never empty when the location is known.
    const codeBlk = d.code_block || d.vulnerable_code || f.code_block || f.vulnerable_code || f.evidence || ''
    rec = {
      ...base,
      // §6/bug#6: the evidence LOCATION is immutable — it comes from the original candidate, NEVER the triager.
      // The triager could otherwise re-point file/line/source/sink at a different code path (cross-wiring). It
      // contributes only the writeup (code_block quote) + verdict, not where the vulnerability lives.
      file: f.file || d.file || '', line: (f.line ?? d.line ?? ''),
      code_block: codeBlk, vulnerable_code: codeBlk,   // code_block → UI/report · vulnerable_code → schema/evidence-tier
      source: f.source || d.source || '', sink: f.sink || d.sink || '',
      confirmation_status: needsLive ? 'NEEDS_LIVE_VALIDATION' : 'SOURCE_CONFIRMED',
      validation_status: needsLive ? 'NEEDS-LIVE' : 'CONFIRMED',
      // §7: derive the boolean from the status — a SOURCE_CONFIRMED record can never carry requires_runtime_validation:true.
      requires_runtime_validation: needsLive,
      // M4: carry the live-validation task so white-box source→runtime (buildSourceGuidance) can aim the
      // deferred pentest at this candidate with the specialist's own required evidence.
      required_blackbox_proof: d.required_blackbox_proof || f.required_blackbox_proof || '',
      affected_endpoint: f.endpoint || f.affected_endpoint || d.endpoint || '',
    }
  } else {
    rec = { ...base, url: f.url || d.url || '', method: f.method || '' }
  }
  // M5: stamp the evidence quality tier (L0–L4), computed over the full evidence view (finding + detail).
  try { rec.evidence_tier = require('./evidence-tier').evidenceTier({ ...f, ...d, ...rec }) } catch { /* fail-soft */ }
  return rec
}

module.exports = { isSourceFinding, shapeStreamValidated }

// self-check: the #1 M1 risk — a source finding can NEVER carry a url / become RUNTIME_CONFIRMED.
if (require.main === module) {
  const assert = require('node:assert')
  const meta = { id: 'T-1', title: 't', agent: 'CIPHER', taskId: 'task-1' }
  const src = { agent: 'cipher', file: 'app.rb', line: 3, severity: 'High' }
  const r1 = shapeStreamValidated(src, { title: 'IDOR', severity: 'High' }, meta)
  assert.strictEqual(r1.url, undefined, 'source record must NOT carry a url')
  assert.strictEqual(r1.confirmation_status, 'SOURCE_CONFIRMED', 'source → SOURCE_CONFIRMED')
  assert.strictEqual(r1.file, 'app.rb', 'source location preserved')
  // even if the triager fabricates a url in its detail, a source finding stays source-shaped
  const r2 = shapeStreamValidated(src, { url: 'https://evil.test', title: 'x' }, meta)
  assert.strictEqual(r2.url, undefined, 'fabricated url on a source finding is DROPPED')
  assert.strictEqual(r2.confirmation_status, 'SOURCE_CONFIRMED', 'still SOURCE_CONFIRMED')
  // needs-live source candidate is demoted, not confirmed
  const r3 = shapeStreamValidated(src, { confirmation_status: 'NEEDS_LIVE_VALIDATION' }, meta)
  assert.strictEqual(r3.validation_status, 'NEEDS-LIVE', 'NEEDS_LIVE_VALIDATION → NEEDS-LIVE')
  // a live finding (has url) keeps the runtime shape
  const live = { agent: 'drill', url: 'https://x.test/a', method: 'POST', severity: 'Critical' }
  const r4 = shapeStreamValidated(live, { title: 'SQLi' }, meta)
  assert.strictEqual(r4.url, 'https://x.test/a', 'live record keeps its url')
  assert.strictEqual(r4.confirmation_status, undefined, 'live record status derived downstream, not forced here')
  console.log('ok — stream-record: source stays SOURCE_CONFIRMED (never a url), live keeps runtime shape')
}
