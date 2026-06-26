const assert = require('node:assert')
const { test } = require('node:test')
const fs = require('node:fs')

const SRC = fs.readFileSync(__dirname + '/../event-bus.js', 'utf-8')

test('event-bus.js requires browser-verifier module from ./agents/ (not bare ./)', () => {
  // Path bug regression guard: browser-verifier.js lives at agents/browser-verifier.js,
  // not at the project root. Original wiring used `./browser-verifier` which threw
  // "Cannot find module" on every Phase 3.8 dispatch (caught 2026-05-01 at 15:47Z).
  assert.match(SRC, /freshRequire\(['"]\.\/agents\/browser-verifier['"]\)|require\(['"]\.\/agents\/browser-verifier['"]\)/)
  // Negative assertion: bare './browser-verifier' must NOT appear.
  assert.doesNotMatch(SRC, /freshRequire\(['"]\.\/browser-verifier['"]\)/)
})

test('event-bus.js requires pentest-browser-recipe-constructor from ./agents/ (not bare ./)', () => {
  assert.match(SRC, /freshRequire\(['"]\.\/agents\/pentest-browser-recipe-constructor['"]\)|require\(['"]\.\/agents\/pentest-browser-recipe-constructor['"]\)/)
  assert.doesNotMatch(SRC, /freshRequire\(['"]\.\/pentest-browser-recipe-constructor['"]\)/)
})

test('event-bus.js dispatches Phase 3.8 AFTER Offensive Vaccine and BEFORE SCRIBE', () => {
  // Existing Offensive Vaccine block emits 'Offensive Vaccine: <N> defensive actions'
  // Existing SCRIBE dispatch is preceded by 'Phase 4: SCRIBE writing final report'
  const idxOffensiveVaccine = SRC.indexOf('Offensive Vaccine: ${defActions.length}')
  const idxBrowserVerify = SRC.indexOf('verifyAll(')
  const idxscribe = SRC.indexOf('Phase 4: SCRIBE writing final report')
  assert.ok(idxOffensiveVaccine > 0, 'Offensive Vaccine block missing')
  assert.ok(idxBrowserVerify > 0, 'browser-verifier call missing')
  assert.ok(idxscribe > 0, 'SCRIBE dispatch missing')
  assert.ok(idxOffensiveVaccine < idxBrowserVerify, 'browser-verifier must come AFTER Offensive Vaccine')
  assert.ok(idxBrowserVerify < idxscribe, 'browser-verifier must come BEFORE SCRIBE')
})

test('event-bus.js logs the Phase 3.8 banner', () => {
  assert.match(SRC, /Phase 3\.8.*[Bb]rowser/)
})

test('event-bus.js writes BROWSER-VERIFICATION jsonl with taskId substitution', () => {
  assert.match(SRC, /BROWSER-VERIFICATION-\$\{taskId\}/)
})

test('event-bus.js skips Phase 3.8 when no browser-relevant findings', () => {
  // Look for an early-skip guard. Acceptable shapes:
  //   if (browserCandidates.length === 0) ...
  //   if (!browserCandidates.length) ...
  //   if (recipes.length === 0) ...
  assert.match(SRC, /browserCandidates\.length\s*===\s*0|!browserCandidates\.length|recipes\.length\s*===\s*0/)
})

test('event-bus.js wraps Phase 3.8 in try/catch (best-effort, never blocks SCRIBE)', () => {
  // Find the browser-verifier call and walk up looking for the enclosing try.
  // Use a generous 8000-char window — the inner block has grown over multiple
  // sprints with diagnostic logging, parser logic, etc., but the outer
  // try-catch still wraps everything.
  const idxBrowserVerify = SRC.indexOf('verifyAll(')
  const before = SRC.slice(Math.max(0, idxBrowserVerify - 8000), idxBrowserVerify)
  assert.match(before, /try\s*\{/)
  // And confirm the catch handler logs a Phase 3.8 error message
  const after = SRC.slice(idxBrowserVerify, idxBrowserVerify + 4000)
  assert.match(after, /catch.*Phase 3\.8.*error/s)
})
