#!/usr/bin/env node

const __roots = require('../paths') // portable roots (KURU_*_ROOT) — see paths.js
// Unit tests for /root/agents/prompt-renderer.js
// Run: node /root/agents/test/prompt-renderer.test.js

const assert = require('assert')
const fs = require('fs')
const pr = require('../src/rendering/prompt-renderer')

let failures = 0
let passed = 0
function test(name, fn) {
  try {
    fn()
    console.log(`  ✓ ${name}`)
    passed++
  } catch (e) {
    console.log(`  ✗ ${name}`)
    console.log(`    ${e.stack || e.message}`)
    failures++
  }
}

console.log('prompt-renderer tests:')

pr.resetCache()

test('config loads + has enabled + rollback_mode + versions', () => {
  const cfg = pr.loadConfig()
  assert.ok(cfg, 'config must load')
  assert.ok('enabled' in cfg, 'enabled flag required')
  assert.ok('rollback_mode' in cfg, 'rollback_mode required')
  assert.ok(cfg.versions, 'versions map required')
  assert.ok(cfg.versions.specialist, 'specialist version must be configured')
})

test('render substitutes {{var}} placeholders', () => {
  const out = pr.render('Hello {{name}}, you are {{role}}.', { name: 'ARJUN', role: 'recon' })
  assert.strictEqual(out, 'Hello ARJUN, you are recon.')
})

test('render handles missing vars as empty string', () => {
  const out = pr.render('X {{present}} Y {{missing}} Z', { present: 'A' })
  assert.strictEqual(out, 'X A Y  Z')
})

test('render supports {{var | default}} fallback', () => {
  const out = pr.render('WAF: {{waf | unknown}}', {})
  assert.strictEqual(out, 'WAF: unknown')
  const out2 = pr.render('WAF: {{waf | unknown}}', { waf: 'cloudflare' })
  assert.strictEqual(out2, 'WAF: cloudflare')
})

test('render supports {{#if var}}...{{/if}} blocks', () => {
  const tmpl = 'A{{#if show}} middle{{/if}} Z'
  assert.strictEqual(pr.render(tmpl, { show: true }), 'A middle Z')
  assert.strictEqual(pr.render(tmpl, { show: false }), 'A Z')
  assert.strictEqual(pr.render(tmpl, {}), 'A Z')
})

test('render supports dotted paths', () => {
  const out = pr.render('{{profile.environment}} / {{profile.domain}}', {
    profile: { environment: 'prod', domain: 'fintech' }
  })
  assert.strictEqual(out, 'prod / fintech')
})

test('loadTemplate reads specialist v1.md from disk', () => {
  const tmpl = pr.loadTemplate('specialist', 'v1')
  assert.ok(tmpl, 'specialist v1 template should exist')
  assert.ok(tmpl.includes('{{agentUpper}}'), 'template must reference agentUpper')
  assert.ok(tmpl.includes('pentest specialist'), 'template must contain role text')
})

test('loadTemplate returns null for missing template', () => {
  assert.strictEqual(pr.loadTemplate('nonexistent-role', 'v999'), null)
})

test('renderPrompt returns rendered string for valid role', () => {
  const out = pr.renderPrompt('specialist', {
    agentUpper: 'ARJUN', agentLower: 'arjun',
    squad: 'pentest', targetUrl: 'https://example.com',
    taskTitle: 'Test', taskId: 'T1', wafStatus: 'cloudflare',
    goalContext: '', techStack: '',
    profileFragment: '', mustGates: '',
    feedbackCtx: '', liveFindings: '', graphCtx: '',
    projectId: '',
  })
  assert.ok(out, 'should render')
  assert.ok(out.includes('ARJUN'), 'agentUpper must interpolate')
  assert.ok(out.includes('https://example.com'), 'target URL must interpolate')
  assert.ok(out.includes('cloudflare'), 'wafStatus must interpolate')
  assert.ok(!out.includes('{{'), 'no unresolved placeholders')
})

test('renderPrompt returns null when rollback_mode=inline', () => {
  const cfgPath = pr.CONFIG_PATH
  const original = fs.readFileSync(cfgPath, 'utf-8')
  try {
    const raw = JSON.parse(original)
    raw.rollback_mode = 'inline'
    fs.writeFileSync(cfgPath, JSON.stringify(raw))
    pr.resetCache()
    const out = pr.renderPrompt('specialist', { agentUpper: 'ARJUN' })
    assert.strictEqual(out, null, 'must return null so caller falls back to inline')
  } finally {
    fs.writeFileSync(cfgPath, original)
    pr.resetCache()
  }
})

test('renderPrompt returns null when config enabled=false', () => {
  const cfgPath = pr.CONFIG_PATH
  const original = fs.readFileSync(cfgPath, 'utf-8')
  try {
    const raw = JSON.parse(original)
    raw.enabled = false
    fs.writeFileSync(cfgPath, JSON.stringify(raw))
    pr.resetCache()
    assert.strictEqual(pr.renderPrompt('specialist', {}), null)
  } finally {
    fs.writeFileSync(cfgPath, original)
    pr.resetCache()
  }
})

test('renderPrompt returns null for role with no configured version', () => {
  assert.strictEqual(pr.renderPrompt('nonexistent-role', {}), null)
})

test('activeVersion returns configured version', () => {
  assert.strictEqual(pr.activeVersion('specialist'), 'v1')
  assert.strictEqual(pr.activeVersion('nonexistent'), null)
})

test('listRoles returns configured roles', () => {
  const roles = pr.listRoles()
  assert.ok(Array.isArray(roles))
  assert.ok(roles.includes('specialist'))
})

test('template cache invalidates on mtime change', () => {
  // Write a throwaway template
  const tmpPath = (__roots.AGENTS_ROOT + '/prompts/specialist/test-cache.md')
  fs.writeFileSync(tmpPath, 'First: {{x}}')
  try {
    const first = pr.loadTemplate('specialist', 'test-cache')
    assert.strictEqual(first, 'First: {{x}}')
    // Change the file content + force newer mtime
    fs.writeFileSync(tmpPath, 'Second: {{x}}')
    // Bump mtime explicitly to make sure it's different
    const now = new Date()
    fs.utimesSync(tmpPath, now, new Date(now.getTime() + 10))
    const second = pr.loadTemplate('specialist', 'test-cache')
    assert.strictEqual(second, 'Second: {{x}}')
  } finally {
    fs.unlinkSync(tmpPath)
  }
})

console.log(`\n${passed} passed, ${failures} failed`)
process.exit(failures > 0 ? 1 : 0)
