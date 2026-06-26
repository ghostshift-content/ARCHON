#!/usr/bin/env node
// Unit tests for /root/agents/task-log.js
// Run: node /root/agents/test/task-log.test.js

const assert = require('assert')
const fs = require('fs')
const path = require('path')
const os = require('os')
const { spawn } = require('child_process')

const tl = require('../src/utils/task-log')

const TEST_PREFIX = `test-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
const createdIds = []
function uniqueId(suffix = '') {
  const id = `${TEST_PREFIX}-${suffix || Math.random().toString(36).slice(2, 8)}`
  createdIds.push(id)
  return id
}

function cleanup() {
  for (const id of createdIds) {
    try {
      const p = tl.taskLogPath(id)
      if (fs.existsSync(p)) fs.unlinkSync(p)
    } catch {}
  }
}
process.on('exit', cleanup)
process.on('uncaughtException', (e) => { cleanup(); console.error(e); process.exit(1) })

let failures = 0
let passed = 0
function test(name, fn) {
  try {
    fn()
    console.log(`  ✓ ${name}`)
    passed++
  } catch (e) {
    console.log(`  ✗ ${name}`)
    console.log(`    ${e.message}`)
    failures++
  }
}
async function atest(name, fn) {
  try {
    await fn()
    console.log(`  ✓ ${name}`)
    passed++
  } catch (e) {
    console.log(`  ✗ ${name}`)
    console.log(`    ${e.message}`)
    failures++
  }
}

async function main() {
  console.log('task-log tests:')

  test('empty / null / undefined taskId is rejected', () => {
    assert.throws(() => tl.taskLogPath(''), /empty|required/)
    assert.throws(() => tl.taskLogPath(null), /required|empty/)
    assert.throws(() => tl.taskLogPath(undefined), /required|empty/)
    assert.throws(() => tl.appendToTaskLog('', { a: 1 }), /empty|required/)
  })

  test('taskId sanitization strips unsafe chars + blocks path traversal', () => {
    // Path traversal attempt — should end up as a plain filename in TASK_LOGS_DIR
    const dangerous = '../../etc/passwd'
    const p = tl.taskLogPath(dangerous)
    assert.ok(p.startsWith(tl.TASK_LOGS_DIR + '/'), `path must live under ${tl.TASK_LOGS_DIR}`)
    assert.ok(!p.includes('..'), 'path must not contain ..')
    assert.ok(!p.includes('/etc/'), 'path must not escape to /etc')

    // Only alphanumeric + dash/underscore survives
    const id = 'abc-123_XYZ'
    assert.strictEqual(tl.sanitizeTaskId(id), 'abc-123_XYZ')
    assert.strictEqual(tl.sanitizeTaskId('abc!@#$%'), 'abc')
    assert.strictEqual(tl.sanitizeTaskId('a b c'), 'abc')

    // Pure-unsafe input throws
    assert.throws(() => tl.sanitizeTaskId('!@#$%'), /no safe characters/)
    assert.throws(() => tl.sanitizeTaskId('.'), /reserved|no safe characters/)
    assert.throws(() => tl.sanitizeTaskId('..'), /reserved|no safe characters/)
  })

  test('mkdir on first write creates /root/intel/task-logs', () => {
    const id = uniqueId('mkdir')
    tl.appendToTaskLog(id, { hello: 'world' })
    assert.ok(fs.existsSync(tl.TASK_LOGS_DIR), 'task-logs dir must exist after first write')
    assert.ok(fs.existsSync(tl.taskLogPath(id)), 'log file must exist after append')
  })

  test('appendToTaskLog + readTaskLog: single entry round-trip', () => {
    const id = uniqueId('single')
    const entry = { ts: '2026-04-19T00:00:00Z', agent: 'SCOUT', action: 'Recon complete', taskId: id }
    tl.appendToTaskLog(id, entry)
    const out = tl.readTaskLog(id)
    assert.strictEqual(out.length, 1)
    assert.deepStrictEqual(out[0], entry)
  })

  test('readTaskLog returns [] for missing file (no throw)', () => {
    const id = uniqueId('missing')
    const out = tl.readTaskLog(id)
    assert.ok(Array.isArray(out))
    assert.strictEqual(out.length, 0)
  })

  test('readTaskLog skips corrupt lines without throwing', () => {
    const id = uniqueId('corrupt')
    tl.appendToTaskLog(id, { ok: 1 })
    fs.appendFileSync(tl.taskLogPath(id), 'not valid json\n')
    tl.appendToTaskLog(id, { ok: 2 })
    const out = tl.readTaskLog(id)
    assert.strictEqual(out.length, 2, 'corrupt line should be skipped')
    assert.strictEqual(out[0].ok, 1)
    assert.strictEqual(out[1].ok, 2)
  })

  test('multiple entries preserve insertion order', () => {
    const id = uniqueId('order')
    for (let i = 0; i < 20; i++) {
      tl.appendToTaskLog(id, { n: i })
    }
    const out = tl.readTaskLog(id)
    assert.strictEqual(out.length, 20)
    for (let i = 0; i < 20; i++) {
      assert.strictEqual(out[i].n, i, `entry ${i} out of order`)
    }
  })

  test('taskLogPath is pure (does not touch FS) + deterministic', () => {
    const id = uniqueId('pure')
    const p1 = tl.taskLogPath(id)
    const p2 = tl.taskLogPath(id)
    assert.strictEqual(p1, p2)
    assert.ok(p1.endsWith(`.jsonl`))
    assert.ok(p1.startsWith(tl.TASK_LOGS_DIR))
  })

  test('taskLogExists reflects file existence accurately', () => {
    const id = uniqueId('exists')
    assert.strictEqual(tl.taskLogExists(id), false)
    tl.appendToTaskLog(id, { ok: true })
    assert.strictEqual(tl.taskLogExists(id), true)
  })

  // ── Concurrency: THE critical property ────────────────────────────────
  // Spawn 10 child procs, each appending 10 entries → 100 total lines.
  // If appendFileSync isn't atomic, we'd see line corruption or losses.
  await atest('concurrent appends from 10 child processes do not corrupt or lose lines', async () => {
    const id = uniqueId('concurrent')
    const scriptPath = path.join(os.tmpdir(), `task-log-concurrent-${process.pid}.js`)
    const script = `
      const tl = require(${JSON.stringify(path.resolve(__dirname, '..', 'src/utils/task-log.js'))})
      const taskId = process.argv[2]
      const workerId = process.argv[3]
      for (let i = 0; i < 10; i++) {
        tl.appendToTaskLog(taskId, { worker: workerId, i })
      }
    `
    fs.writeFileSync(scriptPath, script)

    try {
      const procs = []
      for (let w = 0; w < 10; w++) {
        procs.push(new Promise((resolve, reject) => {
          const p = spawn('node', [scriptPath, id, String(w)], { stdio: 'ignore' })
          p.on('exit', (code) => code === 0 ? resolve() : reject(new Error(`worker ${w} exit ${code}`)))
          p.on('error', reject)
        }))
      }
      await Promise.all(procs)

      const out = tl.readTaskLog(id)
      assert.strictEqual(out.length, 100, `expected 100 lines, got ${out.length}`)
      for (let w = 0; w < 10; w++) {
        const fromW = out.filter(e => e.worker === String(w))
        assert.strictEqual(fromW.length, 10, `worker ${w} should have 10 entries, got ${fromW.length}`)
        for (let i = 0; i < 10; i++) {
          assert.strictEqual(fromW[i].i, i, `worker ${w} entry ${i} out of order`)
        }
      }
    } finally {
      try { fs.unlinkSync(scriptPath) } catch {}
    }
  })

  console.log(`\n${passed} passed, ${failures} failed`)
  cleanup()
  process.exit(failures > 0 ? 1 : 0)
}

main().catch((e) => {
  console.error(e)
  cleanup()
  process.exit(1)
})
