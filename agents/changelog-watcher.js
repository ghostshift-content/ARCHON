// agents/changelog-watcher.js
//
// Anthropic / Claude Code changelog watcher + primitive break-detection.
//
// Run weekly via cron or PM2 scheduler. Never modify code autonomously —
// all adapter changes are human-authored.
//
// Usage:
//   node agents/changelog-watcher.js check          — break-detection + network fetch
//   node agents/changelog-watcher.js breaks-only    — break-detection only (no network, good for cron)
//
// Output: JSON to stdout
//   { ts, breakChecks: [{name, ok, message}], changelogEntries: [{title, date, url}], alerts: string[] }
//
// Exit codes:
//   0 = no breaks detected
//   1 = one or more breaks detected

'use strict'
const __roots = require('../paths') // portable roots (KURU_*_ROOT) — see paths.js


const fs = require('fs')
const path = require('path')
const https = require('https')
const { spawnSync } = require('child_process')

// ---------------------------------------------------------------------------
// Config / paths (injectable for tests)
// ---------------------------------------------------------------------------

const DEFAULTS = {
  claudeBinPath: process.env.KURU_CLAUDE_BIN || 'claude',
  packageJsonPath: path.resolve(__dirname, '../package.json'),
  nodeModulesDir: path.resolve(__dirname, '../node_modules'),
  agentRunnerPath: path.resolve(__dirname, 'runner/agent-runner.js'),
  verifyFrameworkPath: path.resolve(__dirname, '../verify-framework.js'),
  changelogUrl: 'https://github.com/anthropics/claude-code/releases.atom',
  outboxDir: (__roots.INTEL_ROOT + '/telegram-outbox'),
}

// ---------------------------------------------------------------------------
// Break-detection checks (all LOCAL — no network)
// ---------------------------------------------------------------------------

/**
 * Check 1: claude binary exists and emits a recognizable version string.
 * Alert if binary is missing or outputs nothing / error.
 */
function checkClaudeBinary(opts = {}) {
  const binPath = opts.claudeBinPath || DEFAULTS.claudeBinPath
  const name = 'claude-binary-present'

  if (!fs.existsSync(binPath)) {
    return { name, ok: false, message: `Claude binary not found at ${binPath}` }
  }

  try {
    const r = spawnSync(binPath, ['--version'], { encoding: 'utf-8', timeout: 10000 })
    const output = (r.stdout || '').trim()
    // Expect something like "2.1.163 (Claude Code)"
    if (!output || r.status !== 0) {
      return { name, ok: false, message: `claude --version failed: ${(r.stderr || '').slice(0, 200)}` }
    }
    // Sanity: should contain a version number pattern
    if (!/\d+\.\d+/.test(output)) {
      return { name, ok: false, message: `Unexpected version output: ${output.slice(0, 100)}` }
    }
    return { name, ok: true, message: `version: ${output}` }
  } catch (e) {
    return { name, ok: false, message: `Error running claude --version: ${e.message}` }
  }
}

/**
 * Check 2: agent-runner.js still has `|| 'sdk'` as the default adapter sentinel.
 * This confirms our key constant didn't drift after refactors.
 */
function checkAgentRunnerDefault(opts = {}) {
  const runnerPath = opts.agentRunnerPath || DEFAULTS.agentRunnerPath
  const name = 'agent-runner-sdk-default'

  try {
    const src = fs.readFileSync(runnerPath, 'utf-8')
    // Look for the default adapter fallback pattern
    const hasDefault = src.includes("|| 'sdk'") || src.includes('|| "sdk"')
    if (!hasDefault) {
      return { name, ok: false, message: `agent-runner.js: could not find || 'sdk' default fallback — adapter default may have drifted` }
    }
    return { name, ok: true, message: `agent-runner.js default sentinel || 'sdk' present` }
  } catch (e) {
    return { name, ok: false, message: `Could not read agent-runner.js: ${e.message}` }
  }
}

/**
 * Check 3: @anthropic-ai/claude-agent-sdk version in node_modules matches
 * the pinned version in package.json. Version drift = potential API surface change.
 */
function checkSdkVersionPinning(opts = {}) {
  const pkgPath = opts.packageJsonPath || DEFAULTS.packageJsonPath
  const nmDir = opts.nodeModulesDir || DEFAULTS.nodeModulesDir
  const name = 'claude-agent-sdk-version-pinned'

  const SDK_NAME = '@anthropic-ai/claude-agent-sdk'

  try {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'))
    const pinnedVersion = (pkg.dependencies || {})[SDK_NAME] || (pkg.devDependencies || {})[SDK_NAME]

    if (!pinnedVersion) {
      return { name, ok: false, message: `${SDK_NAME} not found in package.json dependencies` }
    }

    // Strip semver range qualifiers (^, ~, >=, etc.) from pinned version for comparison
    // Our package.json pins it exactly without a prefix: "0.3.162"
    const pinnedClean = pinnedVersion.replace(/^[~^>=<]+/, '').trim()

    const installedPkgPath = path.join(nmDir, SDK_NAME, 'package.json')
    if (!fs.existsSync(installedPkgPath)) {
      return { name, ok: false, message: `${SDK_NAME} not installed (node_modules/${SDK_NAME}/package.json missing)` }
    }

    const installedPkg = JSON.parse(fs.readFileSync(installedPkgPath, 'utf-8'))
    const installedVersion = installedPkg.version

    if (installedVersion !== pinnedClean) {
      return {
        name,
        ok: false,
        message: `SDK version mismatch: package.json pins ${pinnedClean} but node_modules has ${installedVersion}`,
      }
    }

    return { name, ok: true, message: `${SDK_NAME}@${installedVersion} matches package.json pin` }
  } catch (e) {
    return { name, ok: false, message: `SDK version check error: ${e.message}` }
  }
}

/**
 * Check 4: verify-framework.js gate suite is healthy.
 * We check that verify-framework.js RESULT line shows 97+ gates passed,
 * or — to avoid a 60s runtime — we do a static grep for the gate count
 * constant (the file tracks the expected total).
 * Static approach: count gate() calls in verify-framework.js — if the count
 * drops significantly below the known baseline (100), something was removed.
 */
function checkGateSuiteHealth(opts = {}) {
  const vfPath = opts.verifyFrameworkPath || DEFAULTS.verifyFrameworkPath
  const name = 'gate-suite-health'
  const MIN_GATE_COUNT = 97 // we know we're at 100+ now, alert if someone stripped gates

  try {
    const src = fs.readFileSync(vfPath, 'utf-8')
    // Count gate() calls
    const matches = src.match(/^gate\(/gm)
    const count = matches ? matches.length : 0
    if (count < MIN_GATE_COUNT) {
      return {
        name,
        ok: false,
        message: `verify-framework.js has only ${count} gate() calls — expected >= ${MIN_GATE_COUNT}. Gates may have been removed.`,
      }
    }
    return { name, ok: true, message: `verify-framework.js has ${count} gate() calls (>= ${MIN_GATE_COUNT} threshold)` }
  } catch (e) {
    return { name, ok: false, message: `Could not read verify-framework.js: ${e.message}` }
  }
}

// ---------------------------------------------------------------------------
// Run all break-detection checks
// ---------------------------------------------------------------------------

function runBreakChecks(opts = {}) {
  return [
    checkClaudeBinary(opts),
    checkAgentRunnerDefault(opts),
    checkSdkVersionPinning(opts),
    checkGateSuiteHealth(opts),
  ]
}

// ---------------------------------------------------------------------------
// Changelog fetch (network — skipped in breaks-only mode)
// ---------------------------------------------------------------------------

/**
 * Fetch and parse the GitHub releases atom feed for claude-code.
 * Returns an array of { title, date, url }.
 *
 * The _fetch option is injectable for tests:
 *   opts._fetch = (url) => Promise<string>  (resolves with the raw response body)
 */
function fetchChangelog(opts = {}) {
  const url = opts.changelogUrl || DEFAULTS.changelogUrl
  const fetchFn = opts._fetch || defaultHttpsFetch

  return fetchFn(url).then(body => parseAtomFeed(body))
}

/**
 * Default implementation: HTTPS GET via Node's built-in https module.
 * Returns a Promise<string>.
 */
function defaultHttpsFetch(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { timeout: 15000 }, res => {
      let body = ''
      res.on('data', chunk => { body += chunk })
      res.on('end', () => {
        if (res.statusCode && res.statusCode >= 400) {
          reject(new Error(`HTTP ${res.statusCode} fetching ${url}`))
        } else {
          resolve(body)
        }
      })
    })
    req.on('error', reject)
    req.on('timeout', () => {
      req.destroy()
      reject(new Error(`Timeout fetching ${url}`))
    })
  })
}

/**
 * Parse an Atom XML feed. Extracts <entry> blocks and pulls out
 * title, updated date, and link href.
 * No external XML parser — regex is sufficient for this well-structured feed.
 */
function parseAtomFeed(xml) {
  const entries = []
  // Split on <entry> blocks
  const entryRe = /<entry>([\s\S]*?)<\/entry>/g
  let m
  while ((m = entryRe.exec(xml)) !== null) {
    const block = m[1]

    // title — strip CDATA if present
    const titleMatch = block.match(/<title[^>]*>([\s\S]*?)<\/title>/)
    const title = titleMatch ? titleMatch[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/, '$1').trim() : '(unknown)'

    // updated date
    const dateMatch = block.match(/<updated>([\s\S]*?)<\/updated>/)
    const date = dateMatch ? dateMatch[1].trim() : null

    // link href
    const linkMatch = block.match(/<link[^>]+rel="alternate"[^>]+href="([^"]+)"/) ||
                      block.match(/<link[^>]+href="([^"]+)"/)
    const url = linkMatch ? linkMatch[1].trim() : null

    if (title !== '(unknown)' || date || url) {
      entries.push({ title, date, url })
    }
  }
  return entries
}

// ---------------------------------------------------------------------------
// Telegram notification (optional, outbox-drop pattern)
// ---------------------------------------------------------------------------

function maybeSendTelegramAlert(message, opts = {}) {
  const chatId = process.env.TELEGRAM_WATCHER_CHAT_ID
  if (!chatId) return

  const outboxDir = opts.outboxDir || DEFAULTS.outboxDir

  try {
    fs.mkdirSync(outboxDir, { recursive: true })
    const fname = `changelog-watcher-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`
    const tmp = path.join(outboxDir, fname + '.tmp')
    const final = path.join(outboxDir, fname)
    fs.writeFileSync(tmp, JSON.stringify({ chat_id: chatId, text: message }))
    fs.renameSync(tmp, final)
  } catch (e) {
    // Non-fatal — watcher still exits correctly
    process.stderr.write(`[changelog-watcher] telegram notify failed: ${e.message}\n`)
  }
}

// ---------------------------------------------------------------------------
// Main check function — injectable for tests
// ---------------------------------------------------------------------------

async function checkAll(opts = {}) {
  const ts = new Date().toISOString()
  const breakChecks = runBreakChecks(opts)
  const alerts = []

  // Collect break alerts
  for (const c of breakChecks) {
    if (!c.ok) {
      alerts.push(`BREAK [${c.name}]: ${c.message}`)
    }
  }

  let changelogEntries = []
  if (!opts.skipFetch) {
    try {
      changelogEntries = await fetchChangelog(opts)
    } catch (e) {
      alerts.push(`CHANGELOG-FETCH-ERROR: ${e.message}`)
    }
  }

  return { ts, breakChecks, changelogEntries, alerts }
}

// ---------------------------------------------------------------------------
// CLI entrypoint
// ---------------------------------------------------------------------------

async function main() {
  const cmd = process.argv[2] || 'check'

  if (cmd !== 'check' && cmd !== 'breaks-only') {
    process.stderr.write(`Usage: node agents/changelog-watcher.js [check|breaks-only]\n`)
    process.exit(2)
  }

  const skipFetch = cmd === 'breaks-only'

  let result
  try {
    result = await checkAll({ skipFetch })
  } catch (e) {
    process.stderr.write(`[changelog-watcher] fatal error: ${e.message}\n`)
    process.exit(1)
  }

  // Emit JSON
  process.stdout.write(JSON.stringify(result, null, 2) + '\n')

  const hasBreaks = result.breakChecks.some(c => !c.ok)

  // Telegram notification if breaks found and chat ID configured
  if (hasBreaks) {
    const breakSummary = result.alerts.join('\n')
    maybeSendTelegramAlert(`⚠️ [changelog-watcher] Break detected:\n${breakSummary}`)
  }

  process.exit(hasBreaks ? 1 : 0)
}

// Only run CLI if executed directly
if (require.main === module) {
  main().catch(e => {
    process.stderr.write(`[changelog-watcher] unhandled error: ${e.message}\n`)
    process.exit(1)
  })
}

// ---------------------------------------------------------------------------
// Exports (for tests and GATE-102)
// ---------------------------------------------------------------------------

module.exports = {
  checkAll,
  runBreakChecks,
  checkClaudeBinary,
  checkAgentRunnerDefault,
  checkSdkVersionPinning,
  checkGateSuiteHealth,
  fetchChangelog,
  parseAtomFeed,
  defaultHttpsFetch,
  maybeSendTelegramAlert,
}
