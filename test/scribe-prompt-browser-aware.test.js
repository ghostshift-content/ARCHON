const assert = require('node:assert')
const { test } = require('node:test')
const fs = require('node:fs')

const SRC = fs.readFileSync(__dirname + '/../event-bus.js', 'utf-8')

test('SCRIBE prompt mentions BROWSER-VERIFICATION file', () => {
  assert.match(SRC, /BROWSER-VERIFICATION-\$\{taskId\}\.jsonl/)
})

test('SCRIBE prompt explains browser_fired=true means CONFIRM evidence', () => {
  assert.match(SRC, /browser_fired\s*===?\s*true.*(CONFIRM|Tier-1|strong)/is)
})

test('SCRIBE prompt explains browser_fired=false KILLED means downgrade or omit', () => {
  assert.match(SRC, /browser_fired\s*===?\s*false.*(downgrade|omit|AWAITING-MANUAL)/is)
})

test('SCRIBE prompt explains INDETERMINATE means fall back to AUDITOR', () => {
  assert.match(SRC, /INDETERMINATE.*(fall\s*back|AUDITOR)/is)
})

test('SCRIBE prompt update is INSIDE buildscribeReportPrompt body', () => {
  // Locate the function and ensure the BROWSER-VERIFICATION reference is within ~1500 chars after
  const fnStart = SRC.indexOf('function buildscribeReportPrompt')
  assert.ok(fnStart > 0, 'buildscribeReportPrompt missing')
  const fnSlice = SRC.slice(fnStart, fnStart + 9000)
  assert.match(fnSlice, /BROWSER-VERIFICATION/)
})
