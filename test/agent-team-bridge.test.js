'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')

test('runtime-v2 bridge is off by default and writes an atomic shadow plan when enabled', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'archon-team-'))
  const intel = path.join(root, 'intel')
  const priorRoot = process.env.KURU_AGENTS_ROOT
  const priorIntel = process.env.KURU_INTEL_ROOT
  const priorFlag = process.env.ARCHON_RUNTIME_V2
  process.env.KURU_AGENTS_ROOT = root
  process.env.KURU_INTEL_ROOT = intel

  for (const modulePath of ['../paths', '../src/runtime/agent-team-bridge']) {
    delete require.cache[require.resolve(modulePath)]
  }
  let bridge = require('../src/runtime/agent-team-bridge')
  delete process.env.ARCHON_RUNTIME_V2
  assert.equal(bridge.planMission('off-task', { mode: 'static', workstreams: [] }), null)

  process.env.ARCHON_RUNTIME_V2 = 'shadow'
  const artifact = bridge.planMission('shadow-task', {
    mode: 'blackbox',
    strategy: 'direct',
    workstreams: [{ id: 'target-1', endpoints: ['https://example.test/app'] }],
    applicableSkills: ['access-control', 'xss'],
  })
  assert.equal(artifact.runtime_mode, 'shadow')
  assert.equal(artifact.drives_execution, false)
  assert.equal(artifact.assignments.length, 1)
  assert.ok(fs.existsSync(path.join(intel, 'agent-team-plan-shadow-task.json')))

  process.env.ARCHON_RUNTIME_V2 = 'active'
  const requestedActive = bridge.planMission('active-task', {
    mode: 'static',
    workstreams: [{ id: 'source-1', files: ['app.js'] }],
  })
  assert.equal(requestedActive.runtime_mode, 'active')
  assert.equal(requestedActive.drives_execution, false, 'bridge never falsely claims to drive the legacy dispatcher')
  assert.match(requestedActive.execution_note, /parity gate/)

  if (priorRoot === undefined) delete process.env.KURU_AGENTS_ROOT
  else process.env.KURU_AGENTS_ROOT = priorRoot
  if (priorIntel === undefined) delete process.env.KURU_INTEL_ROOT
  else process.env.KURU_INTEL_ROOT = priorIntel
  if (priorFlag === undefined) delete process.env.ARCHON_RUNTIME_V2
  else process.env.ARCHON_RUNTIME_V2 = priorFlag
})
