// test/changelog-watcher.test.js
// Unit tests for agents/changelog-watcher.js
// Run: bun test test/changelog-watcher.test.js
//
// All tests are OFFLINE — no real network calls.
// DI via opts: inject fake binary paths, package.json paths, node_modules dirs, _fetch fn.

'use strict'

const assert = require('node:assert')
const { test } = require('node:test')
const fs = require('fs')
const path = require('path')
const os = require('os')

const {
  checkAll,
  runBreakChecks,
  checkClaudeBinary,
  checkAgentRunnerDefault,
  checkSdkVersionPinning,
  checkGateSuiteHealth,
  fetchChangelog,
  parseAtomFeed,
} = require('../agents/changelog-watcher')

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'changelog-watcher-test-'))
}

/**
 * Write a minimal executable script that prints `output` and exits 0.
 * Returns the path to the script.
 */
function makeFakeBinary(tmpDir, output, exitCode = 0) {
  const binPath = path.join(tmpDir, 'claude')
  fs.writeFileSync(binPath, `#!/bin/sh\necho "${output}"\nexit ${exitCode}\n`, { mode: 0o755 })
  return binPath
}

/**
 * Write a package.json with the given sdk version under the given dir.
 */
function makePackageJson(dir, sdkVersion) {
  const pkgPath = path.join(dir, 'package.json')
  fs.writeFileSync(pkgPath, JSON.stringify({
    name: 'test-pkg',
    version: '1.0.0',
    dependencies: {
      '@anthropic-ai/claude-agent-sdk': sdkVersion,
    },
  }))
  return pkgPath
}

/**
 * Write a fake node_modules/@anthropic-ai/claude-agent-sdk/package.json
 * with the given installed version.
 */
function makeInstalledSdk(nodeModulesDir, installedVersion) {
  const sdkDir = path.join(nodeModulesDir, '@anthropic-ai', 'claude-agent-sdk')
  fs.mkdirSync(sdkDir, { recursive: true })
  fs.writeFileSync(path.join(sdkDir, 'package.json'), JSON.stringify({
    name: '@anthropic-ai/claude-agent-sdk',
    version: installedVersion,
  }))
}

// A minimal valid Atom feed with 2 entries
const FAKE_ATOM_FEED = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>Release notes from claude-code</title>
  <entry>
    <title>v2.1.163</title>
    <updated>2026-06-01T00:00:00Z</updated>
    <link rel="alternate" href="https://github.com/anthropics/claude-code/releases/tag/v2.1.163"/>
  </entry>
  <entry>
    <title>v2.1.160</title>
    <updated>2026-05-28T00:00:00Z</updated>
    <link rel="alternate" href="https://github.com/anthropics/claude-code/releases/tag/v2.1.160"/>
  </entry>
</feed>`

const fakeFetch = (_url) => Promise.resolve(FAKE_ATOM_FEED)

// ---------------------------------------------------------------------------
// checkClaudeBinary
// ---------------------------------------------------------------------------

test('checkClaudeBinary: passes when binary exists and returns version', () => {
  const tmp = makeTempDir()
  try {
    const binPath = makeFakeBinary(tmp, '2.1.163 (Claude Code)')
    const result = checkClaudeBinary({ claudeBinPath: binPath })
    assert.strictEqual(result.name, 'claude-binary-present')
    assert.strictEqual(result.ok, true, `expected ok=true but got: ${result.message}`)
    assert.ok(result.message.includes('2.1.163'), `message should contain version: ${result.message}`)
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
})

test('checkClaudeBinary: fails when binary path does not exist', () => {
  const result = checkClaudeBinary({ claudeBinPath: '/tmp/__nonexistent_claude_binary_xyz__' })
  assert.strictEqual(result.name, 'claude-binary-present')
  assert.strictEqual(result.ok, false)
  assert.ok(result.message.includes('not found'), `message should say 'not found': ${result.message}`)
})

test('checkClaudeBinary: fails when binary exits non-zero', () => {
  const tmp = makeTempDir()
  try {
    const binPath = makeFakeBinary(tmp, '', 1)
    const result = checkClaudeBinary({ claudeBinPath: binPath })
    assert.strictEqual(result.ok, false)
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
})

test('checkClaudeBinary: fails when binary output has no version number', () => {
  const tmp = makeTempDir()
  try {
    const binPath = makeFakeBinary(tmp, 'Claude Code')
    const result = checkClaudeBinary({ claudeBinPath: binPath })
    assert.strictEqual(result.ok, false)
    assert.ok(result.message.includes('Unexpected version'), `message: ${result.message}`)
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// checkAgentRunnerDefault
// ---------------------------------------------------------------------------

test("checkAgentRunnerDefault: passes when agent-runner.js has || 'sdk' sentinel", () => {
  // The real file is the source of truth
  const result = checkAgentRunnerDefault({
    agentRunnerPath: path.resolve(__dirname, '../agents/runner/agent-runner.js'),
  })
  assert.strictEqual(result.name, 'agent-runner-sdk-default')
  assert.strictEqual(result.ok, true, `expected ok=true: ${result.message}`)
})

test("checkAgentRunnerDefault: fails when file lacks || 'sdk' sentinel", () => {
  const tmp = makeTempDir()
  try {
    const fakePath = path.join(tmp, 'agent-runner.js')
    // Write a file without the sentinel
    fs.writeFileSync(fakePath, `'use strict'\n// no default here\nconst x = 'cli'\n`)
    const result = checkAgentRunnerDefault({ agentRunnerPath: fakePath })
    assert.strictEqual(result.ok, false)
    assert.ok(result.message.includes("|| 'sdk'"), `message: ${result.message}`)
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
})

test('checkAgentRunnerDefault: fails gracefully when file does not exist', () => {
  const result = checkAgentRunnerDefault({ agentRunnerPath: '/tmp/__nonexistent_runner_xyz__.js' })
  assert.strictEqual(result.ok, false)
  assert.ok(result.message.includes('Could not read'), `message: ${result.message}`)
})

// ---------------------------------------------------------------------------
// checkSdkVersionPinning
// ---------------------------------------------------------------------------

test('checkSdkVersionPinning: passes when installed version matches pinned version', () => {
  const tmp = makeTempDir()
  try {
    const pkgPath = makePackageJson(tmp, '0.3.162')
    const nodeModulesDir = path.join(tmp, 'node_modules')
    makeInstalledSdk(nodeModulesDir, '0.3.162')
    const result = checkSdkVersionPinning({ packageJsonPath: pkgPath, nodeModulesDir })
    assert.strictEqual(result.name, 'claude-agent-sdk-version-pinned')
    assert.strictEqual(result.ok, true, `expected ok=true: ${result.message}`)
    assert.ok(result.message.includes('0.3.162'), `message: ${result.message}`)
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
})

test('checkSdkVersionPinning: detects sdk version mismatch', () => {
  const tmp = makeTempDir()
  try {
    const pkgPath = makePackageJson(tmp, '0.3.162')
    const nodeModulesDir = path.join(tmp, 'node_modules')
    makeInstalledSdk(nodeModulesDir, '0.3.200') // different installed version
    const result = checkSdkVersionPinning({ packageJsonPath: pkgPath, nodeModulesDir })
    assert.strictEqual(result.ok, false)
    assert.ok(result.message.includes('mismatch'), `message should say mismatch: ${result.message}`)
    assert.ok(result.message.includes('0.3.162'), `message should include pinned: ${result.message}`)
    assert.ok(result.message.includes('0.3.200'), `message should include installed: ${result.message}`)
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
})

test('checkSdkVersionPinning: fails when sdk not installed', () => {
  const tmp = makeTempDir()
  try {
    const pkgPath = makePackageJson(tmp, '0.3.162')
    const nodeModulesDir = path.join(tmp, 'node_modules') // empty, no sdk installed
    fs.mkdirSync(nodeModulesDir, { recursive: true })
    const result = checkSdkVersionPinning({ packageJsonPath: pkgPath, nodeModulesDir })
    assert.strictEqual(result.ok, false)
    assert.ok(result.message.includes('not installed'), `message: ${result.message}`)
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
})

test('checkSdkVersionPinning: fails when sdk not in package.json', () => {
  const tmp = makeTempDir()
  try {
    const pkgPath = path.join(tmp, 'package.json')
    fs.writeFileSync(pkgPath, JSON.stringify({ name: 'test', dependencies: {} }))
    const nodeModulesDir = path.join(tmp, 'node_modules')
    const result = checkSdkVersionPinning({ packageJsonPath: pkgPath, nodeModulesDir })
    assert.strictEqual(result.ok, false)
    assert.ok(result.message.includes('not found in package.json'), `message: ${result.message}`)
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// checkGateSuiteHealth
// ---------------------------------------------------------------------------

test('checkGateSuiteHealth: passes when verify-framework.js has enough gates', () => {
  const result = checkGateSuiteHealth({
    verifyFrameworkPath: path.resolve(__dirname, '../verify-framework.js'),
  })
  assert.strictEqual(result.name, 'gate-suite-health')
  assert.strictEqual(result.ok, true, `expected ok=true: ${result.message}`)
  assert.ok(result.message.includes('gate() calls'), `message: ${result.message}`)
})

test('checkGateSuiteHealth: fails when fewer than 97 gate() calls found', () => {
  const tmp = makeTempDir()
  try {
    const fakePath = path.join(tmp, 'verify-framework.js')
    // Write a file with fewer than 97 gate() calls (just 3)
    const lines = []
    for (let i = 0; i < 3; i++) {
      lines.push(`gate('GATE-${i}: dummy', () => { return 'ok' })`)
    }
    fs.writeFileSync(fakePath, lines.join('\n'))
    const result = checkGateSuiteHealth({ verifyFrameworkPath: fakePath })
    assert.strictEqual(result.ok, false)
    assert.ok(result.message.includes('only 3 gate() calls'), `message: ${result.message}`)
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// runBreakChecks
// ---------------------------------------------------------------------------

test('runBreakChecks: returns 4 checks by default', () => {
  const tmp = makeTempDir()
  try {
    // Use a fake binary path so it doesn't depend on system state
    const checks = runBreakChecks({
      claudeBinPath: '/tmp/__nonexistent_claude__',
      packageJsonPath: path.resolve(__dirname, '../package.json'),
      nodeModulesDir: path.resolve(__dirname, '../node_modules'),
      agentRunnerPath: path.resolve(__dirname, '../agents/runner/agent-runner.js'),
      verifyFrameworkPath: path.resolve(__dirname, '../verify-framework.js'),
    })
    assert.strictEqual(checks.length, 4)
    const names = checks.map(c => c.name)
    assert.ok(names.includes('claude-binary-present'), 'missing claude-binary-present check')
    assert.ok(names.includes('agent-runner-sdk-default'), 'missing agent-runner-sdk-default check')
    assert.ok(names.includes('claude-agent-sdk-version-pinned'), 'missing sdk version check')
    assert.ok(names.includes('gate-suite-health'), 'missing gate-suite-health check')
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// parseAtomFeed
// ---------------------------------------------------------------------------

test('parseAtomFeed: extracts entries from a valid atom feed', () => {
  const entries = parseAtomFeed(FAKE_ATOM_FEED)
  assert.strictEqual(entries.length, 2)
  assert.strictEqual(entries[0].title, 'v2.1.163')
  assert.strictEqual(entries[0].date, '2026-06-01T00:00:00Z')
  assert.ok(entries[0].url.includes('v2.1.163'), `url: ${entries[0].url}`)
  assert.strictEqual(entries[1].title, 'v2.1.160')
})

test('parseAtomFeed: returns empty array for empty feed', () => {
  const entries = parseAtomFeed('<feed></feed>')
  assert.strictEqual(entries.length, 0)
})

// ---------------------------------------------------------------------------
// checkAll with injected fetch (no real network)
// ---------------------------------------------------------------------------

test('checkAll with _fetch: resolves with structured output containing all fields', async () => {
  const tmp = makeTempDir()
  try {
    const binPath = makeFakeBinary(tmp, '2.1.163 (Claude Code)')
    const pkgPath = makePackageJson(tmp, '0.3.162')
    const nodeModulesDir = path.join(tmp, 'node_modules')
    makeInstalledSdk(nodeModulesDir, '0.3.162')

    const result = await checkAll({
      claudeBinPath: binPath,
      packageJsonPath: pkgPath,
      nodeModulesDir,
      agentRunnerPath: path.resolve(__dirname, '../agents/runner/agent-runner.js'),
      verifyFrameworkPath: path.resolve(__dirname, '../verify-framework.js'),
      _fetch: fakeFetch,
    })

    assert.ok(result.ts, 'should have ts field')
    assert.ok(Array.isArray(result.breakChecks), 'should have breakChecks array')
    assert.ok(Array.isArray(result.changelogEntries), 'should have changelogEntries array')
    assert.ok(Array.isArray(result.alerts), 'should have alerts array')
    assert.strictEqual(result.breakChecks.length, 4)
    assert.strictEqual(result.changelogEntries.length, 2, 'fake feed should yield 2 entries')
    assert.strictEqual(result.changelogEntries[0].title, 'v2.1.163')
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
})

test('checkAll with breaks-only mode: skips fetch, still runs break checks', async () => {
  const result = await checkAll({
    skipFetch: true,
    agentRunnerPath: path.resolve(__dirname, '../agents/runner/agent-runner.js'),
    verifyFrameworkPath: path.resolve(__dirname, '../verify-framework.js'),
    packageJsonPath: path.resolve(__dirname, '../package.json'),
    nodeModulesDir: path.resolve(__dirname, '../node_modules'),
    claudeBinPath: '/root/.local/bin/claude', // real binary if available, ok if not
  })

  assert.ok(result.ts, 'should have ts')
  assert.strictEqual(result.breakChecks.length, 4)
  assert.deepStrictEqual(result.changelogEntries, [], 'should be empty when skipFetch=true')
})

test('checkAll: alerts is non-empty when a break is detected', async () => {
  const result = await checkAll({
    skipFetch: true,
    claudeBinPath: '/tmp/__nonexistent_claude_abc123__', // will fail
    agentRunnerPath: path.resolve(__dirname, '../agents/runner/agent-runner.js'),
    verifyFrameworkPath: path.resolve(__dirname, '../verify-framework.js'),
    packageJsonPath: path.resolve(__dirname, '../package.json'),
    nodeModulesDir: path.resolve(__dirname, '../node_modules'),
  })

  const binaryCheck = result.breakChecks.find(c => c.name === 'claude-binary-present')
  assert.ok(binaryCheck, 'should have binary check')
  assert.strictEqual(binaryCheck.ok, false)
  assert.ok(result.alerts.length > 0, 'alerts should be non-empty when break detected')
  assert.ok(result.alerts[0].includes('BREAK'), `alert should start with BREAK: ${result.alerts[0]}`)
})

test('checkAll: fetch error is captured in alerts, does not throw', async () => {
  const result = await checkAll({
    skipFetch: false,
    claudeBinPath: '/tmp/__nonexistent_claude_abc123__',
    agentRunnerPath: path.resolve(__dirname, '../agents/runner/agent-runner.js'),
    verifyFrameworkPath: path.resolve(__dirname, '../verify-framework.js'),
    packageJsonPath: path.resolve(__dirname, '../package.json'),
    nodeModulesDir: path.resolve(__dirname, '../node_modules'),
    _fetch: (_url) => Promise.reject(new Error('network unavailable')),
  })

  assert.ok(Array.isArray(result.alerts), 'alerts must be array')
  const fetchAlert = result.alerts.find(a => a.includes('CHANGELOG-FETCH-ERROR'))
  assert.ok(fetchAlert, `should have fetch error alert. alerts: ${JSON.stringify(result.alerts)}`)
})
