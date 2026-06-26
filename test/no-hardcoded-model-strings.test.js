
const __roots = require('../paths') // portable roots (KURU_*_ROOT) — see paths.js
// test/no-hardcoded-model-strings.test.js
//
// Regression guard: the 4 files that were sweep-fixed on 2026-05-10 must NOT
// contain hardcoded `claude-haiku-*` / `claude-sonnet-*` / `claude-opus-*`
// model IDs in dispatch paths. Same regression class as 2026-04-20 stocks fix.
//
// If this test fails, someone re-introduced a hardcoded model string in one
// of the dispatch hot paths. Route through resolveLLMModel({family,override})
// from /root/agents/agents/llm-model-resolver.js instead.

const assert = require('node:assert')
const { test } = require('node:test')
const fs = require('node:fs')

const HARDCODE_PATTERN = /['"]claude-(?:haiku|sonnet|opus)-\d+-\d+['"]/g

const FILES = [
  (__roots.AGENTS_ROOT + '/agents/handoff-resolver.js'),
  (__roots.AGENTS_ROOT + '/event-bus.js'),
  (__roots.AGENTS_ROOT + '/scripts/run-judge-verifier.js'),
  (__roots.AGENTS_ROOT + '/scripts/process-handoff.js'),
]

// event-bus.js has many lines unrelated to the trajectory IIFE that legitimately
// reference model IDs (stocks fallback, validators, etc). We restrict the scan
// to the trajectory observer block. The other 3 files are scanned end-to-end.
const EVENT_BUS_TRAJECTORY_BLOCK_MARKER_START = 'trajectoryObserver.observeSpecialistOutput'
const EVENT_BUS_TRAJECTORY_BLOCK_LINES = 30 // window after the marker

function scanFileForHardcodes(file) {
  const text = fs.readFileSync(file, 'utf-8')
  if (file.endsWith('event-bus.js')) {
    const idx = text.indexOf(EVENT_BUS_TRAJECTORY_BLOCK_MARKER_START)
    if (idx === -1) return [] // marker gone — nothing to scan
    // Pull a window of ~30 lines starting at the marker
    const slice = text.slice(idx).split('\n').slice(0, EVENT_BUS_TRAJECTORY_BLOCK_LINES).join('\n')
    return slice.match(HARDCODE_PATTERN) || []
  }
  return text.match(HARDCODE_PATTERN) || []
}

test('handoff-resolver.js has no hardcoded model IDs in dispatch path', () => {
  const found = scanFileForHardcodes((__roots.AGENTS_ROOT + '/agents/handoff-resolver.js'))
  assert.deepStrictEqual(found, [],
    `Hardcoded model strings re-introduced: ${found.join(', ')}. Use resolveLLMModel({family,override}).`)
})

test('event-bus.js trajectory observer IIFE has no hardcoded model IDs', () => {
  const found = scanFileForHardcodes((__roots.AGENTS_ROOT + '/event-bus.js'))
  assert.deepStrictEqual(found, [],
    `Hardcoded model strings in trajectory IIFE: ${found.join(', ')}. Use resolveLLMModel({family:'fast'}).`)
})

test('run-judge-verifier.js has no hardcoded model IDs', () => {
  const found = scanFileForHardcodes((__roots.AGENTS_ROOT + '/scripts/run-judge-verifier.js'))
  assert.deepStrictEqual(found, [],
    `Hardcoded model strings re-introduced: ${found.join(', ')}. Use resolveLLMModel({family:'fast',override}).`)
})

test('process-handoff.js has no hardcoded model IDs', () => {
  const found = scanFileForHardcodes((__roots.AGENTS_ROOT + '/scripts/process-handoff.js'))
  assert.deepStrictEqual(found, [],
    `Hardcoded model strings re-introduced: ${found.join(', ')}. Use resolveLLMModel({family:'balanced',override}).`)
})

test('all 4 files reference resolveLLMModel (or import the resolver)', () => {
  for (const f of FILES) {
    const text = fs.readFileSync(f, 'utf-8')
    assert.ok(
      text.includes('resolveLLMModel') || text.includes('llm-model-resolver'),
      `${f} no longer references resolveLLMModel — refactor regressed?`
    )
  }
})
