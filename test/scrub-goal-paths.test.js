
const __roots = require('../paths') // portable roots (KURU_*_ROOT) — see paths.js
// test/scrub-goal-paths.test.js
//
// FIX 2 (2026-05-09): Goal-leak cleanup.
//
// Live pentest 1778394458903: dispatch goal text included the literal
// "/root/intel/trajectory-observations.jsonl". Result: 28+ specialists
// wrote NON-CANONICAL custom-schema entries to that file (verdicts like
// "HONEST", "CONFIRMED", "DISPROVEN" — none of which are our canonical
// verdicts). Same pattern caused FORGE to write
// /root/intel/CLOUD-SECURITY-HANDOFF-{taskId}.md instead of the proper
// inbox JSON.
//
// Specialists treat instructions in goals as instructions about output
// paths. Scrubber removes /root/intel/... mentions before goal text
// reaches the specialist prompt — leaving the rest of the goal readable.

const assert = require('node:assert')
const { test } = require('node:test')
const { scrubFilePathsFromGoal } = require('../src/safety/scrub-goal-paths')

test('scrubFilePathsFromGoal: leaves a goal with no /root/intel paths unchanged', () => {
  const goal = 'Test https://example.com for OWASP Top-10 vulnerabilities.'
  assert.strictEqual(scrubFilePathsFromGoal(goal), goal)
})

test('scrubFilePathsFromGoal: replaces /root/intel/<file>.jsonl with placeholder', () => {
  const goal = 'Cross-reference verdicts in JUDGED-FINDINGS, observations in /root/intel/trajectory-observations.jsonl, then continue.'
  const out = scrubFilePathsFromGoal(goal)
  assert.doesNotMatch(out, /\/root\/intel\/trajectory-observations\.jsonl/)
  assert.match(out, /\[file path scrubbed/)
  // The rest of the sentence must remain readable
  assert.match(out, /Cross-reference verdicts in JUDGED-FINDINGS/)
  assert.match(out, /then continue\./)
})

test('scrubFilePathsFromGoal: replaces /root/intel/<dir>/ paths', () => {
  const goal = 'Drop your output in /root/intel/handoffs/inbox/ when done.'
  const out = scrubFilePathsFromGoal(goal)
  assert.doesNotMatch(out, /\/root\/intel\/handoffs\/inbox/)
  assert.match(out, /\[file path scrubbed/)
})

test('scrubFilePathsFromGoal: replaces /root/intel/<file>.md (markdown handoffs)', () => {
  const goal = 'Write the handoff to /root/intel/CLOUD-SECURITY-HANDOFF-1234.md please.'
  const out = scrubFilePathsFromGoal(goal)
  assert.doesNotMatch(out, /\/root\/intel\/CLOUD-SECURITY-HANDOFF-1234\.md/)
  assert.match(out, /\[file path scrubbed/)
})

test('scrubFilePathsFromGoal: scrubs ALL paths when multiple appear', () => {
  const goal = `Steps:
- read ${__roots.INTEL_ROOT}/VALIDATED-FINDINGS.jsonl
- write trajectory observations to ${__roots.INTEL_ROOT}/trajectory-observations.jsonl
- emit handoffs in ${__roots.INTEL_ROOT}/handoffs/inbox/
End.`
  const out = scrubFilePathsFromGoal(goal)
  assert.doesNotMatch(out, /\/root\/intel\//,
    'no /root/intel/ path should survive')
  assert.match(out, /\[file path scrubbed/)
})

test('scrubFilePathsFromGoal: empty/null/undefined → safe empty default', () => {
  assert.strictEqual(scrubFilePathsFromGoal(''), '')
  assert.strictEqual(scrubFilePathsFromGoal(null), '')
  assert.strictEqual(scrubFilePathsFromGoal(undefined), '')
})

test('scrubFilePathsFromGoal: preserves URLs (no false-positive on http://)', () => {
  const goal = 'Test https://emiratesnbd.com and https://hrconnect.emiratesnbd.com — find vulns.'
  const out = scrubFilePathsFromGoal(goal)
  // URLs must be intact
  assert.match(out, /https:\/\/emiratesnbd\.com/)
  assert.match(out, /https:\/\/hrconnect\.emiratesnbd\.com/)
})

test('scrubFilePathsFromGoal: preserves non-/root/intel paths (e.g. /tmp, /var/log)', () => {
  const goal = 'Look at /tmp/scan.log and /var/log/auth.log for evidence.'
  const out = scrubFilePathsFromGoal(goal)
  // We only scrub /root/intel/. Other paths are left for the specialist
  // since they're typically external artefacts, not canonical squad files.
  assert.match(out, /\/tmp\/scan\.log/)
  assert.match(out, /\/var\/log\/auth\.log/)
})

test('scrubFilePathsFromGoal: handles a path at the very end of input', () => {
  const goal = 'Append observations to /root/intel/trajectory-observations.jsonl'
  const out = scrubFilePathsFromGoal(goal)
  assert.doesNotMatch(out, /trajectory-observations/)
  assert.match(out, /\[file path scrubbed/)
})

test('scrubFilePathsFromGoal: handles a path at the very start of input', () => {
  const goal = (__roots.INTEL_ROOT + '/handoffs/inbox/ — drop here.')
  const out = scrubFilePathsFromGoal(goal)
  assert.doesNotMatch(out, /\/root\/intel\//)
  assert.match(out, /\[file path scrubbed/)
})

test('scrubFilePathsFromGoal: leaves a literal "/root/intel" with no trailing slash unchanged', () => {
  // Conservative: we only match `/root/intel/<something>`. A bare mention
  // of the directory name has no actionable path implication.
  const goal = 'The /root/intel directory holds canonical artefacts.'
  const out = scrubFilePathsFromGoal(goal)
  assert.match(out, /\/root\/intel directory/)
})

test('scrubFilePathsFromGoal: idempotent — running twice gives same result', () => {
  const goal = 'Read /root/intel/X.jsonl, write to /root/intel/Y.jsonl, done.'
  const once = scrubFilePathsFromGoal(goal)
  const twice = scrubFilePathsFromGoal(once)
  assert.strictEqual(once, twice)
})

test('scrubFilePathsFromGoal: non-string input returns empty default', () => {
  assert.strictEqual(scrubFilePathsFromGoal(42), '')
  assert.strictEqual(scrubFilePathsFromGoal({foo:'bar'}), '')
  assert.strictEqual(scrubFilePathsFromGoal(['a','b']), '')
})
