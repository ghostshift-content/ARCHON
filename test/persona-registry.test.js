'use strict'
// M4: persona registry — 6 read-only built-ins + user-editable custom overlay, fail-soft, default fallback.
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path')

function withRoot(fn, seedBuiltin = true) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'persroot-'))
  fs.mkdirSync(path.join(root, 'builtin'), { recursive: true })
  fs.mkdirSync(path.join(root, 'custom', 'user-created'), { recursive: true })
  if (seedBuiltin) for (const f of fs.readdirSync(path.join(__dirname, '..', 'src', 'personas', 'builtin')).filter((x) => x.endsWith('.json')))
    fs.copyFileSync(path.join(__dirname, '..', 'src', 'personas', 'builtin', f), path.join(root, 'builtin', f))
  const prev = process.env.ARCHON_PERSONAS_ROOT
  process.env.ARCHON_PERSONAS_ROOT = root
  delete require.cache[require.resolve('../src/personas/registry')]
  const R = require('../src/personas/registry')
  try { return fn(R, root) } finally {
    if (prev === undefined) delete process.env.ARCHON_PERSONAS_ROOT; else process.env.ARCHON_PERSONAS_ROOT = prev
    delete require.cache[require.resolve('../src/personas/registry')]
    fs.rmSync(root, { recursive: true, force: true })
  }
}

test('M4: ships 6 read-only built-in personas', () => {
  withRoot((R) => {
    assert.ok(R.builtin().length >= 6)
    assert.equal(R.get('bug-bounty-hunter').report_style, 'bug_bounty')
    assert.ok(R.isBuiltin('appsec-reviewer'))
    assert.ok(R.builtin().every((p) => p.builtin === true), 'built-ins flagged read-only')
  })
})

test('M4: no persona selected ⇒ default (current behavior)', () => {
  withRoot((R) => {
    assert.equal(R.resolve(null).id, 'default')
    assert.equal(R.resolve('does-not-exist').id, 'default', 'unknown falls back to default')
  })
})

test('M4: a custom persona is user-editable and overlays', () => {
  withRoot((R, root) => {
    fs.writeFileSync(path.join(root, 'custom', 'user-created', 'mine.json'), JSON.stringify({ id: 'mine', name: 'My Persona', report_style: 'bug_bounty' }))
    const p = R.get('mine')
    assert.ok(p && p.builtin === false, 'custom persona is editable (not builtin)')
    assert.ok(R.custom().some((x) => x.id === 'mine'))
  })
})

test('M4: fail-soft on a malformed custom persona', () => {
  withRoot((R, root) => {
    fs.writeFileSync(path.join(root, 'custom', 'bad.json'), 'not json')
    fs.writeFileSync(path.join(root, 'custom', 'ok.json'), JSON.stringify({ id: 'ok', name: 'OK' }))
    assert.ok(R.get('ok'), 'valid persona loads despite a broken sibling')
    assert.ok(R.builtin().length >= 6, 'built-ins unaffected')
  })
})
