'use strict'
// R2: the mission workspace — durable per-scan folder + per-feature workstreams. Additive, observe-only, fail-soft.
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path')
const M = require('../src/runtime/mission-workspace')

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'mw-')) }

test('R2: ensureMission creates the workspace skeleton', () => {
  const root = tmp()
  M.ensureMission('t1', { mode: 'static', goal: 'review', featureCount: 3, plan: { session_count: 2 } }, root)
  const dir = M.missionDir('t1', root)
  assert.ok(fs.existsSync(path.join(dir, 'mission-context.md')))
  assert.ok(fs.existsSync(path.join(dir, 'mission-plan.json')))
  assert.ok(fs.existsSync(path.join(dir, 'agent-messages.jsonl')))
  assert.ok(fs.existsSync(path.join(dir, 'workstreams')))
  assert.match(fs.readFileSync(path.join(dir, 'mission-context.md'), 'utf8'), /Mode:\*\* static/)
  fs.rmSync(root, { recursive: true, force: true })
})

test('R2: ensureWorkstream creates per-feature context + the three streams', () => {
  const root = tmp()
  M.ensureWorkstream('t1', 'auth-token-funnel', { risk: 'high', classes: ['access-control'] }, root)
  const wd = M.workstreamDir('t1', 'auth-token-funnel', root)
  for (const f of ['context.md', 'evidence.jsonl', 'candidates.jsonl', 'notes.md']) assert.ok(fs.existsSync(path.join(wd, f)), f)
  assert.match(fs.readFileSync(path.join(wd, 'context.md'), 'utf8'), /auth-token-funnel/)
  fs.rmSync(root, { recursive: true, force: true })
})

test('R2: append candidate / evidence / agent-message', () => {
  const root = tmp()
  M.ensureWorkstream('t1', 'uploads', {}, root)
  M.appendCandidate('t1', 'uploads', { id: 'C1', title: 'path traversal' }, root)
  M.appendEvidence('t1', 'uploads', { file: 'up.rb', line: 12 }, root)
  M.appendAgentMessage('t1', { from: 'MARSHAL', to: 'TRIAGER', message: 'candidate ready' }, root)
  assert.equal(fs.readFileSync(path.join(M.workstreamDir('t1', 'uploads', root), 'candidates.jsonl'), 'utf8').trim().split('\n').length, 1)
  assert.match(fs.readFileSync(path.join(M.missionDir('t1', root), 'agent-messages.jsonl'), 'utf8'), /MARSHAL/)
  fs.rmSync(root, { recursive: true, force: true })
})

test('R2: mirror copies canonical live artifacts into the mission dir (fail-soft on missing)', () => {
  const root = tmp()
  fs.writeFileSync(path.join(root, 'task-board-t1.jsonl'), '{"id":"MAP-1"}\n')
  fs.writeFileSync(path.join(root, 'coverage-t1.json'), '{"taskId":"t1"}')
  M.ensureMission('t1', {}, root)
  M.mirror('t1', root)
  assert.ok(fs.existsSync(path.join(M.missionDir('t1', root), 'task-board.jsonl')))
  assert.ok(fs.existsSync(path.join(M.missionDir('t1', root), 'coverage.json')))
  assert.ok(!fs.existsSync(path.join(M.missionDir('t1', root), 'decisions.jsonl')), 'missing source skipped, no throw')
  fs.rmSync(root, { recursive: true, force: true })
})
