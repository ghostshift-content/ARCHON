// Quarantine files a thrashing agent wrote during its silent thinking-loop.
// Apr-21 Run 1: SCOUT/RANGER looped 25min at ~10% CPU and during that window
// one of them wrote 4 hallucinated completion files (DELIVERY-REPORT.md,
// DELIVERY-STATUS.txt, DELIVERY-PACKAGE.md, RUN-1-SUMMARY.md) with fake
// "✅ COMPLETE" narratives mirroring the Apr-20 baseline — pure sycophancy.
// Caught manually. This helper moves such files to quarantine/<taskId>/ so
// SCRIBE doesn't consume them in later phases.
//
// Scope (intentionally conservative):
// - Only scans top-level of pentestDir (not subdirs like findings/, baselines/)
// - Only moves files whose NAME matches bogus-completion patterns OR is tagged
//   with the thrashing agent's name. Files without a name signal stay put.
// - Only files with mtime AFTER silentSince are candidates — prevents taking
//   out real output from earlier phases.
// Better to miss a bogus file than quarantine a sibling agent's real work.

const fs = require('fs')
const path = require('path')

const BOGUS_PATTERNS = /(DELIVERY-REPORT|DELIVERY-STATUS|DELIVERY-PACKAGE|COMPLETE-SUMMARY|RUN-\d+-SUMMARY|FRAMEWORK-VALIDATION|READY-FOR-CLIENT)/i

function quarantineThrashFiles(pentestDir, taskId, agentName, silentSince, logger = () => {}) {
  const quarantineDir = path.join(pentestDir, 'quarantine', String(taskId))
  const agentU = String(agentName || '').toUpperCase()
  const agentPrefixRx = agentU ? new RegExp(`^${agentU}[-_]`, 'i') : null
  let moved = 0
  try {
    const entries = fs.readdirSync(pentestDir, { withFileTypes: true })
    for (const e of entries) {
      if (!e.isFile()) continue
      const full = path.join(pentestDir, e.name)
      let stat
      try { stat = fs.statSync(full) } catch { continue }
      if (stat.mtimeMs < silentSince) continue
      const nameMatchesBogus = BOGUS_PATTERNS.test(e.name)
      const nameMatchesAgent = agentPrefixRx && agentPrefixRx.test(e.name)
      if (!nameMatchesBogus && !nameMatchesAgent) continue
      try {
        fs.mkdirSync(quarantineDir, { recursive: true })
        fs.renameSync(full, path.join(quarantineDir, e.name))
        moved++
      } catch {}
    }
  } catch {}
  if (moved > 0) {
    logger(`  🧹 Quarantined ${moved} thrash-period file(s) to ${quarantineDir}`)
  }
  return moved
}

module.exports = { quarantineThrashFiles, BOGUS_PATTERNS }
