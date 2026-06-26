#!/usr/bin/env node

const __roots = require('../paths') // portable roots (KURU_*_ROOT) — see paths.js
// Test: published reports must have zero internal agent name leaks.
// Reads every agent name from /root/mission-control/data/agents.json (canonical
// source of truth), grep-checks every /root/intel/reports/*.md for leaks, and
// fails loudly if any are found.

const fs = require('fs')
const path = require('path')

const AGENTS_JSON = '/root/mission-control/data/agents.json'
const REPORTS_DIR = (__roots.INTEL_ROOT + '/reports')

function loadAgentNames() {
  const roster = JSON.parse(fs.readFileSync(AGENTS_JSON, 'utf-8'))
  return roster.map(a => String(a.name || '').toUpperCase()).filter(Boolean)
}

function countLeaks(text, names) {
  const leaks = {}
  for (const name of names) {
    const re = new RegExp(`\\b${name}\\b`, 'gi')
    const matches = text.match(re)
    if (matches && matches.length > 0) leaks[name] = matches.length
  }
  return leaks
}

function main() {
  const names = loadAgentNames()
  const targetId = process.argv[2] // optional: scan one report
  const files = fs.readdirSync(REPORTS_DIR).filter(f => f.endsWith('.md'))
  const scanList = targetId ? files.filter(f => f.includes(targetId)) : files

  let totalLeakFiles = 0
  let totalLeaks = 0

  for (const f of scanList) {
    const fp = path.join(REPORTS_DIR, f)
    const text = fs.readFileSync(fp, 'utf-8')
    const leaks = countLeaks(text, names)
    const count = Object.values(leaks).reduce((a, b) => a + b, 0)
    if (count > 0) {
      console.log(`❌ ${f} — ${count} leaks:`, leaks)
      totalLeakFiles++
      totalLeaks += count
    }
  }

  console.log(`\nScanned ${scanList.length} reports. ${totalLeakFiles} leaky, ${totalLeaks} total leaks.`)
  process.exit(totalLeakFiles > 0 ? 1 : 0)
}

main()
