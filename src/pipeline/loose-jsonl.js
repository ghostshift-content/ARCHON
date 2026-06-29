'use strict'
// Tolerant reader for agent-written findings JSONL.
//
// Findings are emitted by specialists via `echo '{...}' >> live-findings.jsonl`
// (event-bus.js). LLM-built JSON routinely carries two corruptions that make a
// strict per-line JSON.parse drop the record entirely:
//   1. raw (unescaped) newlines inside a string field — a multi-line HTTP request
//      or evidence block splits one finding across several physical lines.
//   2. invalid JSON escapes — shell/regex backslashes (`USER\|PASS`, `\K`, `\d`)
//      that JSON.parse rejects.
// This recovers both so no confirmed finding is silently lost.
//
// ponytail: salvage parser, not a JSON repair lib. Record boundary = a line
// starting with `{`; a string value containing a literal "\n{" would mis-split
// (rare, accepted). Upgrade path: emit findings via JSON.stringify at the writer.

// repair one candidate record (possibly spanning joined lines) into an object, or null
function repairRecord(rec) {
  rec = rec.trim() // drop boundary whitespace (a trailing blank line would otherwise become an invalid \n)
  try { return JSON.parse(rec) } catch {}
  // we joined continuation lines with real "\n"; those newlines were inside
  // string values, so escape every literal control char, then fix bad escapes.
  let s = rec.replace(/\r/g, '').replace(/\n/g, '\\n').replace(/\t/g, '\\t')
  s = s.replace(/\\(?!["\\/bfnrtu])/g, '\\\\') // backslash not starting a valid escape → literal
  try { return JSON.parse(s) } catch {}
  return null
}

// parse a findings JSONL blob, recovering corrupted records. Returns object[].
function parseFindingsJsonl(raw) {
  if (!raw || !raw.trim()) return []
  const lines = raw.split('\n')
  const records = []
  let buf = ''
  for (const line of lines) {
    if (/^\s*\{/.test(line)) { if (buf.trim()) records.push(buf); buf = line } // new record starts
    else buf += '\n' + line // continuation of a record split by a raw newline
  }
  if (buf.trim()) records.push(buf)
  const out = []
  for (const rec of records) { const o = repairRecord(rec); if (o && typeof o === 'object') out.push(o) }
  return out
}

module.exports = { parseFindingsJsonl, repairRecord }

// self-check: assert recovery of the two corruption classes (run directly)
if (require.main === module) {
  const assert = require('assert')
  // 1. clean line + 2. raw-newline split + 3. invalid \| escape
  const blob = [
    '{"id":"A","type":"confirmed","severity":"high"}',
    '{"id":"B","type":"confirmed","evidence":"line one',
    'Host: x","severity":"critical"}',
    '{"id":"C","reproduction":"grep -E USER\\|PASS","severity":"medium"}',
    '',
  ].join('\n')
  // note: the JS string above has \\| → the file on disk holds a single backslash, the real corruption
  const got = parseFindingsJsonl(blob)
  assert.strictEqual(got.length, 3, `expected 3 recovered, got ${got.length}`)
  assert.strictEqual(got[1].id, 'B')
  assert.strictEqual(got[1].evidence, 'line one\nHost: x')
  assert.strictEqual(got[2].id, 'C')
  // strict parse would only get the first
  const strict = blob.split('\n').filter(Boolean).filter(l => { try { JSON.parse(l); return true } catch { return false } })
  assert.ok(strict.length < 3, 'strict parse should drop the corrupted ones')
  console.log(`ok — recovered ${got.length}/3 (strict got ${strict.length})`)
}
