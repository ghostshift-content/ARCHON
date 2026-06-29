// test/handoff-subsystem-consistency.test.js
//
// Regression guard for the "dead A2A handoff subsystem" bug.
//
// The rule-based handoff generator (agents/rule-based-handoff-generator.js) emits
// cross-squad handoffs to target_squad/target_capability pairs (cloud-security,
// network-pentest, code-review/framework-cve). In this 2-squad build only
// squads/pentest/capabilities.json exists, so resolveTarget() returned null for
// EVERY rule and every emitted handoff dead-lettered to handoffs/failed/ — the
// SCRIBE cross-squad corroboration section was always empty.
//
// The fix disables the producer (Phase 3.45) via squad.json enabledPhases. This
// guard encodes the invariant that the bug violated: if Phase 3.45 IS enabled,
// every rule target MUST resolve against a real capabilities.json. So either the
// producer is off (no dead-letters possible) or its targets are all routable.

'use strict'
const __roots = require('../paths') // portable roots (KURU_*_ROOT) — see paths.js

const fs = require('node:fs')
const path = require('node:path')
const { test } = require('node:test')
const assert = require('node:assert/strict')

const { loadCapabilityMap, resolveTarget } = require((__roots.AGENTS_ROOT + '/agents/handoff-resolver'))
const { RULES } = require((__roots.AGENTS_ROOT + '/agents/rule-based-handoff-generator'))

function phase345Enabled() {
  const f = path.join(__roots.AGENTS_ROOT, 'agents', 'squads', 'pentest', 'squad.json')
  const cfg = JSON.parse(fs.readFileSync(f, 'utf8'))
  return !Array.isArray(cfg.enabledPhases) || cfg.enabledPhases.map(String).includes('3.45')
}

test('A2A handoffs are consistent: if Phase 3.45 is enabled, every rule target resolves', () => {
  if (!phase345Enabled()) return // producer disabled → no dead-letter possible → OK

  const map = loadCapabilityMap(__roots.a2aCapsDir())
  for (const rule of RULES) {
    const target = resolveTarget(map, rule.target_squad, rule.target_capability)
    assert.ok(
      target,
      `rule "${rule.id}" targets ${rule.target_squad}/${rule.target_capability}, which does ` +
      `NOT resolve against any squads/*/capabilities.json — handoffs would dead-letter to ` +
      `handoffs/failed/. Either add the capability/squad or remove "3.45" from ` +
      `agents/squads/pentest/squad.json enabledPhases.`
    )
  }
})

test('every handoff RULE has the fields the resolver/generator depend on', () => {
  assert.ok(Array.isArray(RULES) && RULES.length > 0, 'RULES must be a non-empty array')
  for (const rule of RULES) {
    assert.ok(rule.id, 'rule missing id')
    assert.ok(rule.target_squad, `rule "${rule.id}" missing target_squad`)
    assert.ok(rule.target_capability, `rule "${rule.id}" missing target_capability`)
    assert.equal(typeof rule.match, 'function', `rule "${rule.id}" missing match()`)
  }
})
