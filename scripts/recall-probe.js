#!/usr/bin/env node
// recall-probe.js — THE quality metric of record for SUPPRESSION RECALL.
//
// Both independent reviews named this the single highest-leverage move: the live
// verification floor is 4 down-weight-only filters with nothing that promotes, so a
// genuine business-logic CRITICAL with no quotable string can be silently dropped to
// Low. The 40 "eval" dirs are rubric checklists, not recall fixtures — there was no
// number for "how often does the stack suppress a planted real bug?". This is that number.
//
// Method: run planted findings (eval/recall-fixtures.jsonl) through the REAL suppression
// stack — severity-profile.filterFindings (the down-weight) + the manual-review escalation
// (the counterweight wired in GATE-124). A genuine high-conviction finding is "recalled" if
// it is REPORTED or ESCALATED. It is a SILENT DROP (recall failure) if it is archived with
// no escalation. Recall = recalled / genuine-high-conviction.
//
// Usage: node scripts/recall-probe.js [--profile bounty|pentest|comprehensive] [--squad pentest]
//        exit 0 if recall == 100% on the seed set, 1 otherwise. Used by GATE-127.

'use strict'
const fs = require('fs')
const path = require('path')

const sevProfile = require('../agents/severity-profile')
const suppression = require('../agents/suppression-ledger')

function loadFixtures(file) {
  return fs.readFileSync(file, 'utf-8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l))
}

function isGenuineHighConviction(f) {
  if (f.ground_truth !== 'genuine') return false
  const orig = String(f.severity_original || f.severity || '').toLowerCase()
  return orig === 'high' || orig === 'critical'
}

function runProbe({ profileName = 'bounty', squad = 'pentest', fixturesPath } = {}) {
  const file = fixturesPath || path.join(__dirname, '..', 'eval', 'recall-fixtures.jsonl')
  const fixtures = loadFixtures(file)
  const squadPolicy = require(`../agents/squad-policy/${squad}`)

  const results = []
  for (const f of fixtures) {
    // 1. the down-weight filter: reported (kept) vs archived (suppressed)
    const { reported, archived } = sevProfile.filterFindings([f], profileName, squadPolicy)
    const kept = reported.length > 0
    // 2. the counterweight: archived high-conviction/low-evidence → escalated to manual review
    const escalated = !kept && suppression.isHighConvictionLowEvidence(f)
    const survived = kept || escalated
    results.push({ id: f.id, genuineHC: isGenuineHighConviction(f), kept, escalated, survived, ground_truth: f.ground_truth })
  }

  const genuine = results.filter(r => r.genuineHC)
  const recalled = genuine.filter(r => r.survived)
  const silentDrops = genuine.filter(r => !r.survived)
  const recall = genuine.length ? recalled.length / genuine.length : 1

  return { profileName, squad, total: fixtures.length, genuineHC: genuine.length, recalled: recalled.length, recall, silentDrops, results }
}

if (require.main === module) {
  const args = process.argv.slice(2)
  const profileName = (args[args.indexOf('--profile') + 1]) || (args.includes('--profile') ? 'bounty' : 'bounty')
  const squad = (args.indexOf('--squad') >= 0 && args[args.indexOf('--squad') + 1]) || 'pentest'
  const out = runProbe({ profileName, squad })
  process.stdout.write(`\nSUPPRESSION RECALL PROBE — profile=${out.profileName} squad=${out.squad}\n`)
  process.stdout.write(`  fixtures: ${out.total} | genuine high-conviction: ${out.genuineHC}\n`)
  process.stdout.write(`  recalled (reported OR escalated): ${out.recalled}/${out.genuineHC}\n`)
  process.stdout.write(`  RECALL: ${(out.recall * 100).toFixed(1)}%\n`)
  if (out.silentDrops.length) {
    process.stdout.write(`  ❌ SILENT DROPS (genuine high-conviction, archived without escalation):\n`)
    out.silentDrops.forEach(d => process.stdout.write(`     - ${d.id}\n`))
  } else {
    process.stdout.write(`  ✓ zero silent drops — every genuine high-conviction finding survived\n`)
  }
  process.exit(out.recall === 1 ? 0 : 1)
}

module.exports = { runProbe, isGenuineHighConviction }
