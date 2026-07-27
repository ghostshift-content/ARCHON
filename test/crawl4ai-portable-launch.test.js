'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')

test('TRACER uses the portable runWithHeartbeat timeout instead of GNU timeout', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'event-bus.js'), 'utf8')
  const start = source.indexOf('const crawlCmd =')
  const end = source.indexOf('const crawlResult = await runWithHeartbeat', start)
  assert.ok(start >= 0 && end > start, 'crawl launcher block must exist')

  const block = source.slice(start, end)
  assert.doesNotMatch(block, /\btimeout\s+\d+\s+python3\b/)
  assert.match(block, /python3 .*crawl4ai_crawler\.py/)
})
