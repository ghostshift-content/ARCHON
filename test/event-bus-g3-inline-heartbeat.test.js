// test/event-bus-g3-inline-heartbeat.test.js
//
// Round-4 fix: Phase G3's synchronous for-loop must inject persistCheckpointNow
// inline (every Nth iteration), because Node timers DON'T fire during a tight
// sync block — the wrapper's setInterval(verifying=true) is useless DURING
// Phase G3. Without inline refresh, checkpoint goes stale → supervisor SIGKILL.
//
// Caught during round-3 live verification 2026-05-09 (daemon SIGKILL'd at
// exactly 15min mark, the verifying=true threshold, despite setInterval).

const assert = require('node:assert')
const { test } = require('node:test')
const fs = require('node:fs')
const path = require('node:path')

const SRC = fs.readFileSync(path.resolve(__dirname, '..', 'event-bus.js'), 'utf-8')

function slicePhaseG3() {
  const start = SRC.indexOf('Phase G3: 302-to-SSO')
  assert.ok(start > 0, 'Phase G3 marker missing')
  return SRC.slice(start, start + 3000)
}

test('Phase G3 cap reduced to <=100 (was 200, too long)', () => {
  const slice = slicePhaseG3()
  const sliceMatch = slice.match(/\.slice\(0,\s*(\d+)\)/)
  assert.ok(sliceMatch, 'Phase G3 must use .slice(0, N) cap')
  const cap = parseInt(sliceMatch[1])
  assert.ok(cap <= 100, `cap must be <=100 (got ${cap}) — 200 was too long for 15-min verifying threshold`)
  assert.ok(cap >= 30, `cap must be >=30 to be useful (got ${cap})`)
})

test('Phase G3 for-loop calls persistCheckpointNow inline at periodic intervals', () => {
  const slice = slicePhaseG3()
  // The fix: persistCheckpointNow inside the for-loop body, gated on i % N
  assert.match(slice, /i\s*%\s*\d+\s*===?\s*\d+[\s\S]{0,200}?persistCheckpointNow\s*\(\s*\{\s*verifying\s*:\s*true\s*\}/,
    'Phase G3 for-loop must call persistCheckpointNow({ verifying: true }) periodically (i % N pattern)')
})

test('Phase G3 inline persistCheckpointNow is wrapped in try/catch', () => {
  const slice = slicePhaseG3()
  // The persistCheckpointNow call inside the loop should be try-wrapped so a
  // checkpoint write failure does not abort Phase G3.
  assert.match(slice, /try\s*\{\s*persistCheckpointNow\s*\(\s*\{\s*verifying\s*:\s*true\s*\}\s*\)\s*\}\s*catch\s*\{/,
    'inline persistCheckpointNow must be try-wrapped (checkpoint failure must not abort G3)')
})

test('Phase G3 still uses for-of or indexed for over urlsToProbe', () => {
  const slice = slicePhaseG3()
  assert.match(slice, /for\s*\(\s*(?:const url of urlsToProbe|let i = 0; i < urlsToProbe\.length)/,
    'Phase G3 must still iterate urlsToProbe')
})
