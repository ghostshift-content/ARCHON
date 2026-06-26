#!/usr/bin/env node

const __roots = require('../paths') // portable roots (KURU_*_ROOT) — see paths.js
// scripts/smoke-handoff.js
//
// Sprint C.2 Task 10 (synthetic, 2026-05-10): end-to-end smoke for the A2A
// handoff loop. Creates a fake pentest → cloud-security/data-residency
// handoff, drains it via processInboxOnce with a mock dispatcher, and
// confirms the file moved from inbox/ → done/. No real LLM cost.
//
// Usage: node scripts/smoke-handoff.js
// Exit codes: 0 = OK, 1 = smoke failed (mismatch, missing file, etc.)
//
// Intentionally uses an isolated tmp baseDir so it never touches production
// /root/intel/handoffs/. We still exercise the production capabilities.json
// files (squads/pentest, squads/cloud-security) since GATE-64 owns those.

const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')

const { createHandoff } = require('../agents/handoff-protocol')
const {
  loadCapabilityMap,
  processInboxOnce,
} = require('../agents/handoff-resolver')

function fail(msg) {
  console.error(`✗ smoke FAILED: ${msg}`)
  process.exit(1)
}

async function main() {
  const tmpBase = path.join(os.tmpdir(), `smoke-handoff-${Date.now()}`)
  fs.mkdirSync(path.join(tmpBase, 'inbox'), { recursive: true })

  console.log(`📨 Smoke base dir: ${tmpBase}`)

  // ── Step 1: synthesise a pentest → cloud-security/data-residency handoff ──
  const created = createHandoff({
    sourceTaskId: 'SMOKE-T1',
    sourceSquad: 'pentest',
    sourceAgent: 'FORGE',
    sourceFindingId: 'SMOKE-F1',
    targetSquad: 'cloud-security',
    targetCapability: 'data-residency',
    request: {
      question: '[SMOKE] Does this fake CDN endpoint route EU PII to us-east-1?',
      evidence: {
        cdn_url: 'https://fake-cdn.example.invalid/script.js',
        response_headers: { 'x-fake-aws-region': 'us-east-1' },
        sample_payload: { user_country: 'DE', email: 'fake@example.invalid' },
      },
      expected_artifacts: ['compliance_verdict'],
    },
  }, { baseDir: tmpBase })
  console.log(`  ✓ created handoff: ${created.handoff_id}`)

  const inboxPath = path.join(tmpBase, 'inbox', `${created.handoff_id}.json`)
  if (!fs.existsSync(inboxPath)) fail(`expected handoff in inbox: ${inboxPath}`)

  // ── Step 2: drain via processInboxOnce + mock dispatcher ──
  const capabilityMap = loadCapabilityMap((__roots.AGENTS_ROOT + '/squads'))
  if (!capabilityMap['cloud-security']?.['data-residency']) {
    fail('capability map missing cloud-security/data-residency — GATE-64 broken?')
  }
  console.log(`  ✓ capability map loaded (cloud-security/data-residency present)`)

  let dispatchSeen = false
  const dispatchAgent = async ({ agent, squad, capability, handoff }) => {
    dispatchSeen = true
    if (agent !== 'KUBERA') fail(`expected agent KUBERA, got "${agent}"`)
    if (squad !== 'cloud-security') fail(`expected squad cloud-security, got "${squad}"`)
    if (capability !== 'data-residency') fail(`expected capability data-residency, got "${capability}"`)
    if (handoff.handoff_id !== created.handoff_id) fail('handoff_id mismatch in dispatch')
    return {
      verdict: 'CONFIRMED',
      verdictReason: '[MOCK] GDPR Art. 44 violation — EU PII routed via us-east-1',
      evidenceAdded: { framework: 'GDPR', article: '44', confidence: 'high' },
      costActualUsd: 0,
    }
  }

  const sweep = await processInboxOnce({ capabilityMap, dispatchAgent, baseDir: tmpBase })
  console.log(`  ✓ sweep result: processed=${sweep.processed} succeeded=${sweep.succeeded} failed=${sweep.failed}`)
  if (!dispatchSeen) fail('dispatchAgent was never called')
  if (sweep.processed !== 1) fail(`expected processed=1, got ${sweep.processed}`)
  if (sweep.succeeded !== 1) fail(`expected succeeded=1, got ${sweep.succeeded}`)
  if (sweep.failed !== 0) fail(`expected failed=0, got ${sweep.failed}`)

  // ── Step 3: verify file moved inbox → done ──
  if (fs.existsSync(inboxPath)) fail(`handoff still in inbox after sweep: ${inboxPath}`)
  const donePath = path.join(tmpBase, 'done', `${created.handoff_id}.json`)
  if (!fs.existsSync(donePath)) fail(`handoff not moved to done/: ${donePath}`)
  const final = JSON.parse(fs.readFileSync(donePath, 'utf-8'))
  if (final.status !== 'completed') fail(`expected status=completed, got "${final.status}"`)
  if (final.verdict !== 'CONFIRMED') fail(`expected verdict=CONFIRMED, got "${final.verdict}"`)
  if (final.resolved_by_agent !== 'KUBERA') fail(`expected resolved_by_agent=KUBERA, got "${final.resolved_by_agent}"`)
  if (!final.evidence_added || final.evidence_added.framework !== 'GDPR') {
    fail('evidence_added not persisted into done record')
  }
  console.log(`  ✓ handoff moved inbox → done with verdict=CONFIRMED`)

  // ── Step 4: cleanup ──
  fs.rmSync(tmpBase, { recursive: true, force: true })
  console.log(`  ✓ cleaned up ${tmpBase}`)

  console.log(`\n✅ end-to-end OK — A2A handoff loop drains a synthetic finding cleanly`)
  process.exit(0)
}

if (require.main === module) {
  main().catch(e => {
    console.error(`✗ smoke EXCEPTION: ${e.message}`)
    console.error(e.stack)
    process.exit(1)
  })
}

module.exports = { main }
