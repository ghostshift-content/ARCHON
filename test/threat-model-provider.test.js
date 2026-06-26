#!/usr/bin/env node
// Tests getThreatModelContext — gated by squad config, returns
// framework-agnostic text for code-review, empty for disabled squads.

const fl = require('../src/learning/feedback-loop')

let passed = 0, failed = 0
function ok(l, c) { if (c) { console.log('  ✓ ' + l); passed++ } else { console.log('  ✗ ' + l); failed++ } }

console.log('threat-model-provider tests:')

const crText = fl.getThreatModelContext('code-review', 'any-target')
ok('code-review returns non-empty context', typeof crText === 'string' && crText.length > 1000)
ok('context mentions attacker_privilege', crText.includes('attacker_privilege'))
ok('context mentions trust_boundary_crossed', crText.includes('trust_boundary_crossed'))
ok('context mentions documented_as_intended', crText.includes('documented_as_intended'))
ok('context mentions toolchain_presence_verified', crText.includes('toolchain_presence_verified'))
ok('context mentions validation_layers_checked', crText.includes('validation_layers_checked'))
ok('context is framework-agnostic — cites Rails + Django + Express + Spring + Laravel',
  crText.includes('Rails') && crText.includes('Django') && crText.includes('Express') &&
  crText.includes('Spring') && crText.includes('Laravel'))
ok('context NOT hardcoded to GitLab', !crText.includes('broadcast_messages'))

const stText = fl.getThreatModelContext('stocks', 'X')
ok('stocks returns empty (disabled)', stText === '')

const cloudText = fl.getThreatModelContext('cloud-security', 'aws-acct')
ok('cloud-security returns empty (enabled: false initially)', cloudText === '')

const unknownText = fl.getThreatModelContext('does-not-exist', 'x')
ok('unknown squad returns empty', unknownText === '')

console.log('\n' + passed + ' passed, ' + failed + ' failed')
process.exit(failed ? 1 : 0)
