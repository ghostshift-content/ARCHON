// test/handoff-end-to-end-monitor.test.js

const assert = require('node:assert')
const { test } = require('node:test')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const monitor = require('../agents/handoff-end-to-end-monitor')

function mkBase() { return fs.mkdtempSync(path.join(os.tmpdir(), 'handoff-mon-')) }

test('reports zero counts when no handoffs exist', () => {
  const base = mkBase()
  fs.mkdirSync(path.join(base, 'inbox'))
  fs.mkdirSync(path.join(base, 'done'))
  fs.mkdirSync(path.join(base, 'failed'))
  const r = monitor.statsForTask('T-1', { baseDir: base })
  assert.deepStrictEqual(r, { inbox: 0, done: 0, failed: 0, total: 0, target_squads: {} })
  fs.rmSync(base, { recursive: true, force: true })
})

test('counts handoffs by status + target squad', () => {
  const base = mkBase()
  fs.mkdirSync(path.join(base, 'inbox'), { recursive: true })
  fs.mkdirSync(path.join(base, 'done'), { recursive: true })
  fs.mkdirSync(path.join(base, 'failed'), { recursive: true })
  fs.writeFileSync(path.join(base, 'inbox', 'h1.json'),
    JSON.stringify({ source_task_id: 'T-1', target_squad: 'cloud-security' }))
  fs.writeFileSync(path.join(base, 'done', 'h2.json'),
    JSON.stringify({ source_task_id: 'T-1', target_squad: 'cloud-security' }))
  fs.writeFileSync(path.join(base, 'done', 'h3.json'),
    JSON.stringify({ source_task_id: 'T-1', target_squad: 'network-pentest' }))
  fs.writeFileSync(path.join(base, 'failed', 'h4.json'),
    JSON.stringify({ source_task_id: 'T-2', target_squad: 'cloud-security' }))
  const r = monitor.statsForTask('T-1', { baseDir: base })
  assert.strictEqual(r.inbox, 1)
  assert.strictEqual(r.done, 2)
  assert.strictEqual(r.failed, 0)
  assert.strictEqual(r.total, 3)
  assert.strictEqual(r.target_squads['cloud-security'], 2)
  assert.strictEqual(r.target_squads['network-pentest'], 1)
  fs.rmSync(base, { recursive: true, force: true })
})
