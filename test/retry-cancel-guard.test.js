#!/usr/bin/env node

const __roots = require('../paths') // portable roots (KURU_*_ROOT) — see paths.js
// Regression guard: retry logic must skip when task.status=cancelled.
// Apr-21 Run 1 bug: first cancel-signal killed ARJUN/RUDRA at 23:34, the
// spawn-with-retry path re-spawned them 30s later because one of the two
// retry sites didn't call _isTaskCancelled. Fixed 2026-04-23.
//
// Run: node /root/agents/test/retry-cancel-guard.test.js

const fs = require('fs')

let passed = 0, failed = 0
function ok(label, cond) {
  if (cond) { console.log(`  ✓ ${label}`); passed++ }
  else      { console.log(`  ✗ ${label}`); failed++ }
}

console.log('retry cancel-guard tests:')

const src = fs.readFileSync((__roots.AGENTS_ROOT + '/event-bus.js'), 'utf-8')

// Every retry site (indicated by the "retrying in 30s" log string) must have
// a `_isTaskCancelled` call in the ~800 chars before it.
const retryLogRegex = /retrying in 30s/g
const sites = []
let m
while ((m = retryLogRegex.exec(src)) !== null) {
  const before = src.slice(Math.max(0, m.index - 800), m.index)
  sites.push({ hasGuard: /_isTaskCancelled\s*\(/.test(before) })
}
ok(`event-bus has at least 2 retry sites`, sites.length >= 2)
for (let i = 0; i < sites.length; i++) {
  ok(`retry site #${i + 1} guarded by _isTaskCancelled`, sites[i].hasGuard)
}

// smartRetry must check cancel before its first expensive action
const smartSlice = src.match(/async function smartRetry\([\s\S]{0,400}/)
ok('smartRetry function exists', !!smartSlice)
ok('smartRetry checks _isTaskCancelled early', smartSlice && /_isTaskCancelled/.test(smartSlice[0]))

// Helper itself recognizes cancelled + failed
const fnSlice = src.match(/function _isTaskCancelled\(taskId\)[\s\S]{0,400}/)
ok('_isTaskCancelled covers "cancelled"', fnSlice && /status === 'cancelled'/.test(fnSlice[0]))
ok('_isTaskCancelled covers "failed"', fnSlice && /status === 'failed'/.test(fnSlice[0]))

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed > 0 ? 1 : 0)
