// test/event-bus-task-actions-dedup.test.js
//
// Regression test for the round-7 coverage-variance bug (2026-05-11).
//
// Root cause: processTaskActionsInbox would queue a duplicate dispatch when
// rename to /root/intel/inbox/processed/ failed (transient ENOENT or fs.watch
// re-firing), because the source file stayed in the inbox and the next watcher
// tick re-read it. Two pending dispatches for the same taskId then led to
// two concurrent dispatchPentestParallel runs, two TRACER crawls, and the
// SECOND crawl overwriting the first run's endpoint map.
//
// Evidence: round-7 logged "TRACER complete: 16716 URLs" at 06:39:45 but the
// endpoint file's crawledAt was 06:41:26 with totalUrls=160 — a second crawl
// overwrote the first.
//
// Fix: dedupe in processTaskActionsInbox — if a pending/processing dispatch
// already exists for the same taskId, skip queuing (still delete the file).

const assert = require('node:assert')
const { test } = require('node:test')
const fs = require('node:fs')
const path = require('node:path')

const SRC = fs.readFileSync(path.resolve(__dirname, '..', 'event-bus.js'), 'utf-8')

test('processTaskActionsInbox dedupes by taskId before queuing', () => {
  // Locate processTaskActionsInbox body
  const fnStart = SRC.indexOf('function processTaskActionsInbox(')
  assert.ok(fnStart > 0, 'processTaskActionsInbox must exist')
  // Find the matching closing brace
  let depth = 0
  let end = fnStart
  let inFn = false
  for (let i = fnStart; i < fnStart + 8000; i++) {
    if (SRC[i] === '{') { depth++; inFn = true }
    else if (SRC[i] === '}') { depth--; if (inFn && depth === 0) { end = i; break } }
  }
  const body = SRC.slice(fnStart, end + 1)

  // Must check existing queue for same taskId before adding (dedup guard)
  assert.match(body, /alreadyQueued|already.queued|isDuplicateDispatch|dedupe.*taskId|queue\.some.*taskId/i,
    'processTaskActionsInbox must check if a dispatch for the same taskId already exists before queuing')
})

test('processTaskActionsInbox uses atomic-claim rename BEFORE reading file', () => {
  // The atomic-claim fix renames the source file FIRST so concurrent ticks
  // find nothing. This is what eliminates the original race-window where two
  // ticks could both read+queue the same file.
  const fnStart = SRC.indexOf('function processTaskActionsInbox(')
  let depth = 0, end = fnStart, inFn = false
  for (let i = fnStart; i < fnStart + 8000; i++) {
    if (SRC[i] === '{') { depth++; inFn = true }
    else if (SRC[i] === '}') { depth--; if (inFn && depth === 0) { end = i; break } }
  }
  const body = SRC.slice(fnStart, end + 1)

  // Must reference an atomic-claim path with "processing" segment
  assert.match(body, /['"`]\/root\/intel\/inbox\/processing/,
    'must claim into /root/intel/inbox/processing/ before reading the file')
  // The claim must happen BEFORE the JSON.parse(fs.readFileSync(...)) of the
  // task-action file. We use the index of the FIRST fs.renameSync vs the
  // FIRST JSON.parse(fs.readFileSync to verify ordering.
  const claimIdx = body.search(/fs\.renameSync\s*\(\s*filePath\s*,\s*claimedPath\s*\)/)
  const readIdx = body.search(/JSON\.parse\s*\(\s*fs\.readFileSync\s*\(\s*claimedPath/)
  assert.ok(claimIdx > 0, 'must atomically claim filePath → claimedPath via renameSync')
  assert.ok(readIdx > 0, 'must read from claimedPath (not the original filePath)')
  assert.ok(claimIdx < readIdx, 'atomic-claim rename must happen BEFORE reading the file content')
})

test('processTaskActionsInbox always cleans up source file (no silent loop)', () => {
  // Regardless of dedup outcome, the file must NOT be left in the inbox.
  // The fix uses an atomic claim that moves the file to processing/ before
  // any work. After work completes (queue or dedup-skip), the file is moved
  // to processed/ or unlinked.
  const fnStart = SRC.indexOf('function processTaskActionsInbox(')
  let depth = 0, end = fnStart, inFn = false
  for (let i = fnStart; i < fnStart + 8000; i++) {
    if (SRC[i] === '{') { depth++; inFn = true }
    else if (SRC[i] === '}') { depth--; if (inFn && depth === 0) { end = i; break } }
  }
  const body = SRC.slice(fnStart, end + 1)

  // Must have at least one unlinkSync fallback so processing/ never accumulates orphans
  assert.match(body, /fs\.unlinkSync\(claimedPath\)/,
    'must have an unlinkSync fallback so processing/ never accumulates orphans on rename failure')
})

test('runtracerAgent has in-flight de-duplication (same taskId returns same promise)', () => {
  // The wrapper should track pending crawls so a second concurrent call for the
  // same taskId returns the in-flight promise, NOT spawn a new crawl that
  // overwrites the first run's endpoint file.
  const wrapperStart = SRC.indexOf('async function runtracerAgent(target, taskId) {')
  assert.ok(wrapperStart > 0, 'runtracerAgent must exist')
  // Find function body
  let depth = 0, end = wrapperStart, inFn = false
  for (let i = wrapperStart; i < wrapperStart + 5000; i++) {
    if (SRC[i] === '{') { depth++; inFn = true }
    else if (SRC[i] === '}') { depth--; if (inFn && depth === 0) { end = i; break } }
  }
  const wrapperBody = SRC.slice(wrapperStart, end + 1)

  // Must reference an in-flight map / cache for de-dup
  assert.match(wrapperBody, /_inFlightCrawls|_tracerInFlight|inFlight\w*\.has|inFlight\w*\.get|inFlight\w*\.set/i,
    'runtracerAgent wrapper must track in-flight crawls per-taskId to prevent concurrent duplicate runs')
})

test('_runtracerAgentInner emits a low-coverage warning when crawl returns < 500 URLs', () => {
  // Regression guard: if discovered.size is suspiciously small, log a warning.
  // This catches future TRACER failures that silently overwrite richer prior
  // results, instead of letting specialists silently get a 160-URL map.
  const innerStart = SRC.indexOf('async function _runtracerAgentInner(')
  assert.ok(innerStart > 0, '_runtracerAgentInner must exist')
  // Find closing brace
  let depth = 0, end = innerStart, inFn = false
  for (let i = innerStart; i < SRC.length; i++) {
    if (SRC[i] === '{') { depth++; inFn = true }
    else if (SRC[i] === '}') { depth--; if (inFn && depth === 0) { end = i; break } }
  }
  const innerBody = SRC.slice(innerStart, end + 1)

  // Must emit a warning for suspicious low coverage
  assert.match(innerBody, /low[-_ ]?coverage|suspicious.*URL|coverage.*warning|too.*few.*URL/i,
    '_runtracerAgentInner must emit a warning when discovered.size is suspiciously low (< 500)')
})

test('_runtracerAgentInner refuses to overwrite a larger pre-existing endpoint map', () => {
  // The most direct fix: if outFile already exists with totalUrls >> current
  // discovered.size, log a warning and keep the larger file. This prevents
  // the round-7 scenario where a second TRACER run silently overwrote a
  // 16716-URL map with a 160-URL map.
  const innerStart = SRC.indexOf('async function _runtracerAgentInner(')
  let depth = 0, end = innerStart, inFn = false
  for (let i = innerStart; i < SRC.length; i++) {
    if (SRC[i] === '{') { depth++; inFn = true }
    else if (SRC[i] === '}') { depth--; if (inFn && depth === 0) { end = i; break } }
  }
  const innerBody = SRC.slice(innerStart, end + 1)

  assert.match(innerBody, /(existing\w*Map|priorMap|previousTotalUrls|existingTotalUrls)/i,
    '_runtracerAgentInner must read any existing endpoint map and refuse to overwrite if the prior crawl was much larger')
})
