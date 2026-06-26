// agents/handoff-marker-parser.js
//
// Sprint C.2 follow-up (2026-05-10): UNIVERSAL output-marker pattern.
// Specialists naturally produce TEXT in their stdout. Converting that text
// into actionable handoffs requires a marker pattern specialists CAN
// produce (a quoted block, not a shell command) plus a post-processor
// that scans for `<<HANDOFF ... >>` blocks and converts them into
// canonical handoff JSON in /root/intel/handoffs/inbox/.
//
// Root cause of the gap (round-7 + round-8c shipped with 0 canonical
// handoffs): specialists read the "use --create CLI" instruction as
// documentation, not as something to actually shell-out and run.
// They CAN reliably emit a text marker in their report stream — and the
// post-processor does the actual filesystem drop.
//
// Anti-sycophancy invariant: the parser STRIPS top-level analyst
// commentary fields (rationale, my_analysis, severity_claim) if present.
// The cross-squad expert must reason independently from raw evidence —
// it must NOT see the source specialist's pre-formed opinion.
//
// This module is pure: no fs/network/external deps. event-bus.js wires
// it into spawnAgent's resolve path so EVERY squad benefits with zero
// per-squad changes (same framework-wide pattern as trajectory observer).

'use strict'

// Top-level analyst-commentary fields that must NEVER reach the cross-squad
// expert. These get stripped from the marker (and from nested `evidence:`)
// before the handoff JSON is built.
const STRIPPED_FIELDS = Object.freeze([
  'rationale',
  'my_analysis',
  'my_opinion',
  'severity_claim',
  'severity',
  'analyst_note',
  'conclusion',
  'recommendation',
])

// Matches a complete `<<HANDOFF ... >>` block. `[\s\S]*?` lets the body
// span any number of lines; non-greedy so multiple markers in one output
// each match separately.
const MARKER_RE = /<<HANDOFF\s*\n([\s\S]*?)\n\s*>>/g

// Parse a YAML-ish key/value body. Supports:
//   key: value                       string value
//   key:                             starts a nested block
//     nested_key: nested_value       keys under the block (2+ space indent)
// Returns a plain object. Values are strings (no type coercion). Whitespace
// trimmed; empty bodies tolerated. This is intentionally simple — we own
// both the producer (the specialist prompt) and the consumer.
function parseYamlIsh(body) {
  const out = {}
  const lines = body.split('\n')
  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    if (!line.trim()) { i++; continue }
    // Top-level key (no leading whitespace).
    const top = line.match(/^(\S[^:]*?):\s*(.*)$/)
    if (!top) { i++; continue }
    const key = top[1].trim()
    const inlineVal = top[2]
    if (inlineVal && inlineVal.length > 0) {
      out[key] = inlineVal.trim()
      i++
      continue
    }
    // No inline value — maybe a nested block. Greedily consume indented lines.
    const nested = {}
    i++
    while (i < lines.length) {
      const nl = lines[i]
      if (!nl) { i++; continue } // blank line inside block — tolerated
      if (!/^\s+/.test(nl)) break // next top-level key
      const nm = nl.match(/^\s+(\S[^:]*?):\s*(.*)$/)
      if (!nm) { i++; continue }
      const nk = nm[1].trim()
      const nv = (nm[2] || '').trim()
      nested[nk] = nv
      i++
    }
    if (Object.keys(nested).length > 0) {
      out[key] = nested
    } else {
      out[key] = ''
    }
  }
  return out
}

// Anti-sycophancy: drop banned keys at both top level and inside `evidence`.
function stripAnalystCommentary(parsed) {
  for (const k of STRIPPED_FIELDS) {
    if (k in parsed) delete parsed[k]
  }
  if (parsed.evidence && typeof parsed.evidence === 'object') {
    for (const k of STRIPPED_FIELDS) {
      if (k in parsed.evidence) delete parsed.evidence[k]
    }
  }
  return parsed
}

// Normalize fields after parsing.
function normalize(parsed) {
  if (typeof parsed.expected_artifacts === 'string') {
    parsed.expected_artifacts = parsed.expected_artifacts
      .split(',')
      .map(s => s.trim())
      .filter(Boolean)
  } else if (parsed.expected_artifacts == null) {
    parsed.expected_artifacts = []
  }
  if (parsed.evidence == null) {
    parsed.evidence = {}
  } else if (typeof parsed.evidence === 'string') {
    parsed.evidence = { raw: parsed.evidence }
  }
  return parsed
}

// Stable dedup key.
function dedupKeyOf(m) {
  return [
    m.target_squad || '',
    m.target_capability || '',
    m.source_finding_id || '',
    (m.question || '').trim(),
  ].join('|')
}

// Validate. Returns marker with _invalid flag set on failure (does NOT throw)
// so one bad marker doesn't drop the good ones alongside it.
function validate(marker) {
  const required = ['target_squad', 'target_capability', 'source_finding_id', 'question']
  for (const k of required) {
    if (!marker[k] || (typeof marker[k] === 'string' && !marker[k].trim())) {
      marker._invalid = true
      marker._invalidReason = `missing required field: ${k}`
      return marker
    }
  }
  return marker
}

function extractHandoffMarkers(text) {
  if (!text || typeof text !== 'string') return []
  const out = []
  let match
  MARKER_RE.lastIndex = 0
  while ((match = MARKER_RE.exec(text)) !== null) {
    const body = match[1]
    let parsed
    try {
      parsed = parseYamlIsh(body)
    } catch {
      continue
    }
    stripAnalystCommentary(parsed)
    normalize(parsed)
    parsed._dedupKey = dedupKeyOf(parsed)
    validate(parsed)
    out.push(parsed)
  }
  return out
}

// Map the parsed marker (snake_case) onto createHandoff()'s camelCase API.
// Additional anti-sycophancy guard: never carry analyst commentary keys
// into the canonical request.evidence payload.
function convertMarkerToHandoffArgs({ marker, sourceTaskId, sourceSquad, sourceAgent }) {
  if (!marker) throw new Error('convertMarkerToHandoffArgs: marker is required')
  const safe = stripAnalystCommentary({ ...marker })
  const evidence = (safe.evidence && typeof safe.evidence === 'object') ? { ...safe.evidence } : {}
  for (const k of STRIPPED_FIELDS) delete evidence[k]
  return {
    sourceTaskId,
    sourceSquad,
    sourceAgent,
    sourceFindingId: safe.source_finding_id,
    targetSquad: safe.target_squad,
    targetCapability: safe.target_capability,
    request: {
      question: safe.question,
      evidence,
      expected_artifacts: Array.isArray(safe.expected_artifacts)
        ? safe.expected_artifacts
        : [],
    },
  }
}

module.exports = {
  extractHandoffMarkers,
  convertMarkerToHandoffArgs,
  STRIPPED_FIELDS,
  _parseYamlIsh: parseYamlIsh,
  _stripAnalystCommentary: stripAnalystCommentary,
  _dedupKeyOf: dedupKeyOf,
}
