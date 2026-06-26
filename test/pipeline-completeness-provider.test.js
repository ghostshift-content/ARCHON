#!/usr/bin/env node
// Tests getPipelineCompletenessContext — gated by squad config, returns
// framework-agnostic text for code-review, empty for disabled squads.

const fl = require('../src/learning/feedback-loop')

let passed = 0, failed = 0
function ok(label, cond) { if (cond) { console.log('  ✓ ' + label); passed++ } else { console.log('  ✗ ' + label); failed++ } }

console.log('pipeline-completeness-provider tests:')

const crText = fl.getPipelineCompletenessContext('code-review', 'any-target')
ok('code-review returns non-empty context', typeof crText === 'string' && crText.length > 500)
ok('context mentions pipeline_trace', crText.includes('pipeline_trace'))
ok('context mentions 3-tier severity (full/partial/local_only)',
  crText.includes('full') && crText.includes('partial') && crText.includes('local_only'))
ok('context is framework-agnostic — mentions Rails + Django + Express + Spring + Laravel',
  crText.includes('Rails') && crText.includes('Django') && crText.includes('Express') && crText.includes('Spring') && crText.includes('Laravel'))
ok('context NOT hardcoded to GitLab', !crText.includes('GitLab') && !crText.includes('broadcast_messages'))

const stText = fl.getPipelineCompletenessContext('stocks', 'X')
ok('stocks returns empty (disabled)', stText === '')

const cloudText = fl.getPipelineCompletenessContext('cloud-security', 'aws-acct')
ok('cloud-security returns empty (enabled: false initially)', cloudText === '')

const unknownText = fl.getPipelineCompletenessContext('does-not-exist', 'x')
ok('unknown squad returns empty', unknownText === '')

console.log('\n' + passed + ' passed, ' + failed + ' failed')
process.exit(failed ? 1 : 0)
