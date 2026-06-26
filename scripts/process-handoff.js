#!/usr/bin/env node

const __roots = require('../paths') // portable roots (KURU_*_ROOT) — see paths.js
// scripts/process-handoff.js
//
// Sprint C.2 Task 7 (2026-05-10): CLI runner for the A2A handoff resolver.
// Drains /root/intel/handoffs/inbox/ — one or all handoffs — using either the
// real Claude subprocess or a mock dispatcher (for smoke / dry-run).
//
// Sprint C.2 follow-up (2026-05-10): adds --create / --create-stdin /
// --create-file modes. Specialists couldn't fire handoffs because the
// A2A_HANDOFF_SECTION in event-bus.js advertised `--create` but it didn't
// exist. They silently fell back to dropping markdown into /root/intel/
// (e.g. CLOUD-SECURITY-HANDOFF-1778394458903.md) which VYASA never reads.
//
// Usage:
//   node scripts/process-handoff.js                  # process all inbox handoffs
//   node scripts/process-handoff.js <handoff_id>     # process one specific handoff
//   node scripts/process-handoff.js --mock           # use mock LLM (always CONFIRMED)
//   node scripts/process-handoff.js --model <id>     # override LLM model
//   node scripts/process-handoff.js --create '<json>'         # drop a handoff into inbox/
//   node scripts/process-handoff.js --create-stdin            # read JSON from stdin
//   node scripts/process-handoff.js --create-file <path>      # read JSON from file
//   node scripts/process-handoff.js --base-dir <path>         # override inbox root (testing)
//
// Spec: docs/superpowers/plans/2026-05-10-sprint-c2-a2a-handoff.md

const fs = require('node:fs')
const path = require('node:path')
const {
  loadCapabilityMap,
  processInboxOnce,
  processHandoff,
  buildClaudeDispatcher,
} = require('../agents/handoff-resolver')
const { HANDOFFS_INBOX_DIR, HANDOFFS_BASE_DIR, createHandoff } = require('../agents/handoff-protocol')
const { callRealLLM } = require('./run-judge-verifier')
const { resolveLLMModel } = require('../agents/llm-model-resolver')

// 2026-05-10: DEFAULT_MODEL now resolves via the centralized helper instead of
// a hardcoded `claude-sonnet-4-6`. HANDOFF_LLM_MODEL env override still wins
// (passed in as `override`). Same regression class as 2026-04-20 stocks fix.
const DEFAULT_MODEL = resolveLLMModel({
  family: 'balanced',
  override: process.env.HANDOFF_LLM_MODEL,
})

function parseArgs(argv) {
  const opts = { mock: false, model: DEFAULT_MODEL }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--mock') opts.mock = true
    else if (a === '--model') opts.model = argv[++i]
    else if (a === '--squads-dir') opts.squadsDir = argv[++i]
    else if (a === '--base-dir') opts.baseDir = argv[++i]
    else if (a === '--create') { opts.create = true; opts.createJson = argv[++i] }
    else if (a === '--create-stdin') { opts.create = true; opts.createStdin = true }
    else if (a === '--create-file') { opts.create = true; opts.createFile = argv[++i] }
    else if (!a.startsWith('--') && !opts.handoffId) opts.handoffId = a
  }
  return opts
}

function buildMockDispatcher() {
  return async ({ agent, squad, capability, handoff }) => ({
    verdict: 'CONFIRMED',
    verdictReason: `[MOCK] ${agent}@${squad}/${capability} confirmed handoff ${handoff.handoff_id}`,
    evidenceAdded: { mock: true },
    costActualUsd: 0,
  })
}

// ── Sprint C.2 follow-up: --create mode ─────────────────────────────────────
// Maps the on-disk JSON spec (snake_case per protocol) onto the camelCase
// API of createHandoff().  Returns the createHandoff()-shaped argument
// object — required-field validation lives inside createHandoff() itself
// so the error wording stays canonical.
function snakeToCamelArg(spec) {
  return {
    sourceTaskId:     spec.source_task_id,
    sourceSquad:      spec.source_squad,
    sourceAgent:      spec.source_agent,
    sourceFindingId:  spec.source_finding_id,
    targetSquad:      spec.target_squad,
    targetCapability: spec.target_capability,
    request:          spec.request,
    parentHandoffId:  spec.parent_handoff_id || null,
    chainDepth:       spec.chain_depth || 0,
    budgetUsd:        spec.cost_budget_usd, // undefined → falls back to default in createHandoff
  }
}

function readStdinSync() {
  // Block until stdin EOF. spawnSync's `input` arrives as fd 0 readable.
  return fs.readFileSync(0, 'utf-8')
}

function loadCreateJson(opts) {
  if (opts.createStdin) return readStdinSync()
  if (opts.createFile) {
    if (!fs.existsSync(opts.createFile)) {
      throw new Error(`file not found: ${opts.createFile}`)
    }
    return fs.readFileSync(opts.createFile, 'utf-8')
  }
  if (opts.createJson == null || opts.createJson === '') {
    throw new Error('--create requires a JSON argument (or use --create-stdin / --create-file)')
  }
  return opts.createJson
}

function runCreate(opts) {
  const baseDir = opts.baseDir || HANDOFFS_BASE_DIR
  let raw
  try {
    raw = loadCreateJson(opts)
  } catch (e) {
    console.error(`❌ ${e.message}`)
    process.exit(1)
  }
  let spec
  try {
    spec = JSON.parse(raw)
  } catch (e) {
    console.error(`❌ invalid JSON: ${e.message}`)
    process.exit(1)
  }
  // Strip the camelCase arg call so createHandoff's own validation surfaces
  // the canonical "missing required field: <name>" error verbatim.
  const arg = snakeToCamelArg(spec)
  let result
  try {
    result = createHandoff(arg, { baseDir })
  } catch (e) {
    console.error(`❌ ${e.message}`)
    process.exit(1)
  }
  console.log(`✅ Handoff created: ${result.handoff_id}`)
  console.log(`   ${result.path}`)
  process.exit(0)
}

async function main() {
  const opts = parseArgs(process.argv.slice(2))

  if (opts.create) {
    runCreate(opts)
    return // (runCreate calls process.exit, but keep the early return explicit)
  }

  const baseDir = opts.baseDir || HANDOFFS_BASE_DIR
  const squadsDir = opts.squadsDir || (__roots.AGENTS_ROOT + '/squads')

  const dispatchAgent = opts.mock
    ? buildMockDispatcher()
    : buildClaudeDispatcher({
        callLLM: (prompt, o) => callRealLLM(prompt, { model: o?.model || opts.model }),
        model: opts.model,
      })

  const capabilityMap = loadCapabilityMap(squadsDir)

  if (opts.handoffId) {
    // Process one specific handoff
    const filePath = path.join(baseDir, 'inbox', `${opts.handoffId}.json`)
    if (!fs.existsSync(filePath)) {
      console.error(`✗ handoff not found in inbox: ${filePath}`)
      process.exit(1)
    }
    const result = await processHandoff(filePath, capabilityMap, { dispatchAgent, baseDir })
    console.log(`${result.status === 'completed' ? '✅' : '✗'} ${opts.handoffId}: ${result.status}${result.reason ? ' (' + result.reason + ')' : ''}`)
    process.exit(result.status === 'completed' ? 0 : 1)
  }

  const startedAt = Date.now()
  const r = await processInboxOnce({ capabilityMap, dispatchAgent, baseDir })
  const elapsedMs = Date.now() - startedAt
  console.log(`📨 Handoff sweep complete in ${(elapsedMs / 1000).toFixed(1)}s`)
  console.log(`   Processed: ${r.processed}`)
  console.log(`   Succeeded: ${r.succeeded}`)
  console.log(`   Failed:    ${r.failed}`)
  console.log(`   Mode:      ${opts.mock ? 'MOCK' : 'real (' + opts.model + ')'}`)
  process.exit(r.failed > 0 ? 2 : 0) // exit 2 = some failures, 0 = clean
}

if (require.main === module) {
  main().catch(e => {
    console.error(`✗ ${e.message}`)
    console.error(e.stack)
    process.exit(1)
  })
}

module.exports = { parseArgs, buildMockDispatcher, snakeToCamelArg }
