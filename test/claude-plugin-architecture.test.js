'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')

const ROOT = path.join(__dirname, '..')
const read = relative => fs.readFileSync(path.join(ROOT, relative), 'utf8')

test('Claude plugin exposes the canonical ARCHON team', () => {
  const manifest = JSON.parse(read('.claude-plugin/plugin.json'))
  assert.equal(manifest.name, 'archon')
  for (const name of ['lead', 'inventory', 'researcher', 'explore', 'verifier']) {
    assert.ok(fs.existsSync(path.join(ROOT, 'agents', `archon-${name}.md`)), `${name} agent exists`)
  }
  assert.ok(fs.existsSync(path.join(ROOT, 'skills/archon/SKILL.md')))
  assert.ok(fs.existsSync(path.join(ROOT, 'workflows/scan.js')))
})

test('agent delegation is bounded: only Researcher and Verifier can call Explore', () => {
  const inventory = read('agents/archon-inventory.md')
  const explore = read('agents/archon-explore.md')
  const researcher = read('agents/archon-researcher.md')
  const verifier = read('agents/archon-verifier.md')
  assert.doesNotMatch(inventory, /Agent\(/)
  assert.doesNotMatch(explore, /Agent\(/)
  assert.match(researcher, /Agent\(archon:archon-explore\)/)
  assert.match(verifier, /Agent\(archon:archon-explore\)/)
  assert.match(researcher, /at most two Explore children/i)
})

test('workflow is holistic and uses deterministic three-lens batched verification', () => {
  const workflow = read('workflows/scan.js')
  assert.match(workflow, /REACHABILITY.*IMPACT.*DEFENSES/)
  assert.match(workflow, /agentType: "archon:archon-inventory"/)
  assert.match(workflow, /workstreams\.map/)
  assert.match(workflow, /batches\.flatMap/)
  assert.match(workflow, /complete && trueVotes >= 2/)
  assert.doesNotMatch(workflow, /MARSHAL|CIPHER|SIPHON|QUILL|BEACON|BREAKER/)
  assert.doesNotMatch(workflow, /feature\s*\*\s*class|feature\s*x\s*class/i)
})
