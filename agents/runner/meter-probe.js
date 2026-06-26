// agents/runner/meter-probe.js
//
// MEASURE-FIRST: billing meter-probe + passive usage ledger.
//
// PURPOSE: Before any June-15 adapter cutover, establish a data-driven
// baseline of which Claude usage pool each adapter draws from, plus
// historical per-squad cost/usage from the existing ACTIVITY-LOG.
//
// POOL INFERENCE NOTE:
//   The Claude API response does NOT reveal which billing pool was drawn.
//   We use a static policy mapping (documented below). Post-June-15, verify
//   these mappings against the real Anthropic usage dashboard and update.
//   Mapping basis: 'static-policy-mapping-2026-06'
//     cli  → 'capped-sdk'   (headless programmatic path, not interactive terminal)
//     sdk  → 'capped-sdk'   (headless programmatic path, not interactive terminal)
//     interactive → 'interactive'  (terminal session — future adapter, stub only)
//
// SCHEDULING: Run `ledger` daily via existing supervisor/cron infra.
//   DO NOT add to crontab here — manual decision per house rule
//   (crontab edits have wiped tables; coordinate separately).
//
// USAGE:
//   node agents/runner/meter-probe.js probe   — run billing probe (2 haiku calls)
//   node agents/runner/meter-probe.js ledger  — passive usage snapshot (0 LLM calls)

'use strict'
const __roots = require('../../paths') // portable roots (KURU_*_ROOT) — see paths.js


const fs = require('fs')
const path = require('path')

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const PROBE_PROMPT = 'Reply with exactly: PROBE-OK'
const PROBE_MODEL = 'claude-haiku-4-5-20251001'
const PROBE_TIMEOUT_MS = 120000
const POLICY_BASIS = 'static-policy-mapping-2026-06'

// Pool mapping (static inference — see file header)
const POOL_MAP = {
  cli: 'capped-sdk',
  sdk: 'capped-sdk',
  interactive: 'interactive',
}

// Output directory (overridable via _setOutDir for tests)
let _outDir = __roots.INTEL_ROOT

// TEST-ONLY seam — never call from production code; redirects ALL probe/ledger output.
function _setOutDir(dir) {
  _outDir = dir
}

function _probeFile() {
  return path.join(_outDir, 'billing-probe.jsonl')
}

function _ledgerFile() {
  return path.join(_outDir, 'usage-ledger.jsonl')
}

function _defaultActivityLog() {
  return path.join(__roots.INTEL_ROOT, 'ACTIVITY-LOG.jsonl')
}

// ---------------------------------------------------------------------------
// appendLine — atomic enough for single-writer append
// ---------------------------------------------------------------------------

function appendLine(file, obj) {
  fs.appendFileSync(file, JSON.stringify(obj) + '\n', 'utf8')
}

// ---------------------------------------------------------------------------
// meterProbe
// ---------------------------------------------------------------------------

/**
 * Run a tiny identical prompt through cli and sdk adapters SEQUENTIALLY.
 * Appends 3 JSONL lines to billing-probe.jsonl:
 *   1. cli result (ok or error)
 *   2. sdk result (ok or error)
 *   3. interactive stub (always ok:false — no adapter yet)
 *
 * One adapter failing MUST NOT abort the other — both are always recorded.
 *
 * @param {object} [opts]
 * @param {Function} [opts._runAgent]   DI for tests (offline). If omitted, uses real runAgent.
 * @returns {Promise<Array>} The array of line objects appended THIS run (3 items).
 */
async function meterProbe({ _runAgent } = {}) {
  const runAgent = _runAgent || require('./agent-runner').runAgent

  const probeAdapters = ['cli', 'sdk']
  const writtenLines = []

  for (const adapter of probeAdapters) {
    const ts = new Date().toISOString()
    let line
    try {
      const result = await runAgent({
        userPrompt: PROBE_PROMPT,
        model: PROBE_MODEL,
        timeoutMs: PROBE_TIMEOUT_MS,
        agentName: 'METER-PROBE',
        taskId: 'meter-probe-' + adapter,
        adapter,
      })

      const u = result.usage || {}
      line = {
        ts,
        adapter,
        poolDrawn: POOL_MAP[adapter] || 'unknown',
        basis: POLICY_BASIS,
        model: result.model || 'unknown',
        tokens: {
          input: u.input_tokens || 0,
          output: u.output_tokens || 0,
          cache_creation: u.cache_creation_input_tokens || 0,
          cache_read: u.cache_read_input_tokens || 0,
        },
        ok: true,
      }
    } catch (err) {
      line = {
        ts,
        adapter,
        poolDrawn: 'unknown',
        basis: POLICY_BASIS,
        ok: false,
        error: err && err.message ? err.message : String(err),
      }
    }
    appendLine(_probeFile(), line)
    writtenLines.push(line)
  }

  // Interactive stub — no adapter exists yet; document the shape
  const interactiveLine = {
    ts: new Date().toISOString(),
    adapter: 'interactive',
    poolDrawn: 'interactive',
    basis: POLICY_BASIS,
    ok: false,
    error: 'probe-stub: no interactive adapter yet',
  }
  appendLine(_probeFile(), interactiveLine)
  writtenLines.push(interactiveLine)

  return writtenLines
}

// ---------------------------------------------------------------------------
// collectUsageLedger
// ---------------------------------------------------------------------------

/**
 * Zero-LLM passive usage snapshot. Reads ACTIVITY-LOG.jsonl, tallies per-squad
 * cost/usage for the past windowDays days, and appends ONE line to
 * usage-ledger.jsonl.
 *
 * IDEMPOTENT: if a snapshot for today's UTC date already exists, skips append.
 *
 * Cost data is extracted from type='cost' events in ACTIVITY-LOG.
 * Details field format: "Model: <model>\nTokens: 0\nTotal: $<amount>"
 *
 * @param {object} [opts]
 * @param {string} [opts.activityLogPath]  Override path for tests (default: /root/intel/ACTIVITY-LOG.jsonl)
 * @param {number} [opts.windowDays=1]     Look-back window in days
 * @returns {Promise<void>}
 */
async function collectUsageLedger({ activityLogPath, windowDays = 1 } = {}) {
  const logPath = activityLogPath || _defaultActivityLog()
  const ledger = _ledgerFile()
  const todayUtc = new Date().toISOString().slice(0, 10) // YYYY-MM-DD

  // Idempotency check: scan ledger tail for today's snapshot with same windowDays
  // Key = (UTC date, windowDays) — different windows may coexist on the same day
  if (fs.existsSync(ledger)) {
    const raw = fs.readFileSync(ledger, 'utf8').trim()
    if (raw) {
      const existingLines = raw.split('\n').filter(Boolean)
      for (const line of existingLines) {
        try {
          const parsed = JSON.parse(line)
          if (
            parsed.kind === 'daily-snapshot' &&
            parsed.ts &&
            parsed.ts.slice(0, 10) === todayUtc &&
            parsed.windowDays === windowDays
          ) {
            // Already have today's snapshot for this window — skip
            return
          }
        } catch {}
      }
    }
  }

  // Parse ACTIVITY-LOG
  const cutoff = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000).toISOString()
  const perSquad = {}
  const perAgent = {}
  let totalEvents = 0
  let totalCostUSD = 0
  let hasCostData = false

  if (fs.existsSync(logPath)) {
    const rawLog = fs.readFileSync(logPath, 'utf8')
    const logLines = rawLog.split('\n').filter(Boolean)

    for (const line of logLines) {
      let evt
      try {
        evt = JSON.parse(line)
      } catch {
        continue
      }
      if (!evt || typeof evt !== 'object') continue
      if (evt.type !== 'cost') continue
      // Within window
      if (evt.ts && evt.ts < cutoff) continue

      const squad = evt.squad || 'unknown'
      const agent = evt.agent || 'unknown'
      const details = evt.details || ''

      // Parse cost from details: "Total: $1.2345"
      let costUSD = 0
      const costMatch = details.match(/Total:\s*\$([0-9.]+)/)
      if (costMatch) {
        costUSD = parseFloat(costMatch[1])
        hasCostData = true
      }

      if (!perSquad[squad]) {
        perSquad[squad] = { events: 0, totalCostUSD: 0 }
      }
      perSquad[squad].events++
      perSquad[squad].totalCostUSD = Math.round((perSquad[squad].totalCostUSD + costUSD) * 10000) / 10000

      if (!perAgent[agent]) {
        perAgent[agent] = { events: 0, totalCostUSD: 0 }
      }
      perAgent[agent].events++
      perAgent[agent].totalCostUSD = Math.round((perAgent[agent].totalCostUSD + costUSD) * 10000) / 10000

      totalCostUSD = Math.round((totalCostUSD + costUSD) * 10000) / 10000
      totalEvents++
    }
  }

  // Round per-squad and per-agent costs
  for (const sq of Object.keys(perSquad)) {
    perSquad[sq].totalCostUSD = Math.round(perSquad[sq].totalCostUSD * 10000) / 10000
  }
  for (const ag of Object.keys(perAgent)) {
    perAgent[ag].totalCostUSD = Math.round(perAgent[ag].totalCostUSD * 10000) / 10000
  }

  // Cache savings from billing probe data — read cache_read_input_tokens tallied by runAgent
  let cacheSavingsUSD = 0
  let cacheHitTokens = 0
  const probeFile = _probeFile()
  if (fs.existsSync(probeFile)) {
    try {
      const probeLines = fs.readFileSync(probeFile, 'utf8').split('\n').filter(Boolean)
        .map(l => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)
      for (const p of probeLines) {
        if (p.tokens && p.tokens.cache_read) {
          cacheHitTokens += p.tokens.cache_read
        }
      }
      // Haiku pricing: input ~$0.80/MTok, cache read ~$0.08/MTok → 90% saving
      // We approximate with the ratio rather than hardcoding model price
      cacheSavingsUSD = Math.round((cacheHitTokens / 1_000_000) * 0.72 * 10000) / 10000 // 0.80-0.08 = 0.72 saving per MTok
    } catch {}
  }

  const snapshot = {
    ts: new Date().toISOString(),
    kind: 'daily-snapshot',
    windowDays,
    perSquad,
    perAgent,
    totals: {
      events: totalEvents,
      totalCostUSD: Math.round(totalCostUSD * 10000) / 10000,
    },
    cache: {
      hitTokens: cacheHitTokens,
      estimatedSavingsUSD: cacheSavingsUSD,
    },
    costData: hasCostData,
    source: logPath,
  }

  appendLine(ledger, snapshot)
}

// ---------------------------------------------------------------------------
// CLI entrypoint
// ---------------------------------------------------------------------------

async function main() {
  const args = process.argv.slice(2)
  const cmd = args[0]

  // Parse --window <N> flag (default 1)
  let windowDays = 1
  const windowIdx = args.indexOf('--window')
  if (windowIdx !== -1 && args[windowIdx + 1]) {
    const parsed = parseInt(args[windowIdx + 1], 10)
    if (!isNaN(parsed) && parsed > 0) windowDays = parsed
  }

  if (cmd === 'probe') {
    console.log('[meter-probe] Running billing probe (cli + sdk + interactive stub)...')
    const writtenLines = await meterProbe()
    console.log('[meter-probe] Done. Output:', _probeFile())
    // Exit nonzero only if ALL real adapters failed this run (interactive stub is always ok:false)
    const realAdapters = writtenLines.filter((l) => l.adapter !== 'interactive')
    if (realAdapters.every((l) => !l.ok)) {
      console.error('[meter-probe] ALL real adapters failed — nonzero exit')
      process.exit(1)
    }
  } else if (cmd === 'ledger') {
    console.log(`[meter-probe] Collecting usage ledger snapshot (windowDays=${windowDays})...`)
    await collectUsageLedger({ windowDays })
    console.log('[meter-probe] Done. Output:', _ledgerFile())
  } else {
    console.error('Usage: node agents/runner/meter-probe.js probe|ledger [--window <days>]')
    process.exit(1)
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error('[meter-probe] Fatal:', err)
    process.exit(1)
  })
}

module.exports = { meterProbe, collectUsageLedger, _setOutDir }
