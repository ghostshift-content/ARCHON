// agents/dossier-selector.js
//
// Selects the best dossier file from scan directories — i.e. WHICH .md is the
// canonical published report for a task.
//
// 2026-06-09 (canonical-selection fix + hardening): the published report must be
// the CANONICAL AUTHOR's output — the squad LEADER for analysis squads (CHANAKYA),
// the universal REPORTER (SCRIBE) for security squads — NOT whichever analyst
// happened to stuff the taskId into its FILENAME. Canonical-ness is a DECLARED
// FACT (sidecar + marker, both stamped only by saveAgentReport), with corrected,
// AUTHOR-BOUND heuristics as fallback so the back-catalog degrades to a CORRECT
// pick. Selection priority (highest first):
//   P0a  Sidecar  /root/intel/reports/<taskId>.canonical {path} — honored only if
//        its taskId matches AND its author matches the resolved canonical author
//   P0b  Marker   <!-- ARCHON-CANONICAL taskId=<taskId> author=<A> --> — honored
//        only if its author matches the resolved canonical author (or has none)
//   F1   canonical-author file + taskId in FILENAME (race-safe across tasks)
//   F2   canonical-author file + taskId in CONTENT (matches "Internal Ref")
//   F3   canonical-author file, best in window
//   F4   ANY filename has taskId   F5 ANY filename has teamleader param
//   F6   ANY content has taskId    F7 best in window
//
// "canonical-author" (opts.canonicalSpec) matches by FILENAME PREFIX (startsWith),
// not substring — so NARAD-CHANAKYA-FINAL or ATLAS-FINAL-REPORT-NOTES can no
// longer impersonate teamleader/reporter. security squads: filename starts with the
// finalReportName token (FINAL-REPORT); analysis squads (finalReportName null):
// filename starts with leaderName (CHANAKYA) AND contains a FINAL/DOSSIER marker.
// Within a tier, ties prefer the materially LARGER file (a stale 1KB draft can't
// beat the 28KB final), then newer mtime.
//
// Legacy 4-arg callers (no canonicalSpec) collapse to taskId>leader>content>newest
// (+ marker/sidecar support + widened regex) — backward-compatible.
//
// History: 2026-05-15 taskId-preference (parallel race); 2026-05-16 leader>content
// (Chennai); 2026-06-09 canonical-by-role + declared marker/sidecar (ITC: NARAD
// analyst file out-ranked CHANAKYA synthesis) + author-binding/prefix/size hardening.
//
// Returns: { name, path, mtime, size, via } or null

'use strict'
const __roots = require('../paths') // portable roots (KURU_*_ROOT) — see paths.js

const fs = require('fs')
const path = require('path')

const HEADER_SCAN_BYTES = 4096
const DEFAULT_SIDECAR_DIR = (__roots.INTEL_ROOT + '/reports')
const SIZE_TIEBREAK_RATIO = 1.2 // a file >20% larger wins the within-tier tie

function _readHeader(fp) {
  try {
    const fd = fs.openSync(fp, 'r')
    try {
      const buf = Buffer.alloc(HEADER_SCAN_BYTES)
      const n = fs.readSync(fd, buf, 0, HEADER_SCAN_BYTES, 0)
      return buf.slice(0, n).toString('utf-8')
    } finally {
      fs.closeSync(fd)
    }
  } catch {
    return ''
  }
}

// Content taskId match. Includes "Internal Ref" — CHANAKYA-ITC-FINAL writes the
// taskId as "Internal Ref: <taskId>", which a Task-ID-only regex would miss.
function _headerHasTaskId(header, taskIdStr) {
  if (!header || !taskIdStr) return false
  const re = new RegExp(`(?:Task\\s?ID|"taskId"|Internal\\s?Ref)[:\\s"*]+${taskIdStr}\\b`, 'i')
  return re.test(header)
}

// Returns the marker's author for THIS taskId, or undefined if the marker is
// absent / for a different taskId. Returns '' when the marker matches but carries
// no author= field (older markers — accepted, not author-bound).
function _markerAuthorFor(header, taskIdStr) {
  if (!header || !taskIdStr) return undefined
  const m = header.match(new RegExp(`<!--\\s*ARCHON-CANONICAL\\b[^>]*\\btaskId=${taskIdStr}\\b[^>]*-->`, 'i'))
  if (!m) return undefined
  const a = m[0].match(/\bauthor=([^\s>]+)/i)
  return a ? a[1].toUpperCase() : ''
}

// Canonical-author matcher from the spec. PREFIX match (startsWith), not substring,
// so an analyst can't impersonate teamleader by embedding the name mid-filename.
function _makeCanonMatcher(spec) {
  if (!spec) return () => false
  const finalTok = spec.finalReportName ? String(spec.finalReportName).replace(/\.md$/i, '').toUpperCase() : ''
  const leaderName = spec.leaderName ? String(spec.leaderName).toUpperCase() : ''
  const markers = (Array.isArray(spec.markers) && spec.markers.length ? spec.markers : ['FINAL', 'DOSSIER']).map(m => String(m).toUpperCase())
  return function isCanonicalAuthorName(name) {
    const up = String(name).toUpperCase()
    if (finalTok && up.startsWith(finalTok)) return true
    if (leaderName && up.startsWith(leaderName) && markers.some(m => up.includes(m))) return true
    return false
  }
}

function _entry(name, fp, st, via) {
  return { name, path: fp, mtime: st.mtimeMs, size: st.size, via }
}

// Within a tier, prefer the materially larger file (so a stale small draft can't
// beat the full synthesis), then fall back to newer mtime.
function _better(cur, st) {
  if (!cur) return true
  if (st.size > cur.size * SIZE_TIEBREAK_RATIO) return true
  if (cur.size > st.size * SIZE_TIEBREAK_RATIO) return false
  return st.mtimeMs > cur.mtime
}

function selectBestDossierFile(scanDirs, taskId, leader, cutoffMs, opts = {}) {
  const taskIdStr = taskId === null || taskId === undefined ? '' : String(taskId)
  const leaderUpper = leader ? String(leader).toUpperCase() : ''
  const spec = opts && opts.canonicalSpec ? opts.canonicalSpec : null
  const sidecarDir = (opts && opts.sidecarDir) || DEFAULT_SIDECAR_DIR
  const isCanon = _makeCanonMatcher(spec)
  // The author a declared/canonical signal must belong to. From the spec's
  // leaderName (the role-resolved canonical author) or teamleader param.
  const expectedAuthor = String((spec && spec.leaderName) || leader || '').toUpperCase()
  const _authorOk = (a) => !a || !expectedAuthor || a.toUpperCase() === expectedAuthor

  // ── P0a: DECLARED canonical via sidecar pointer (checked first, fail-soft) ──
  // Honored only if (a) the sidecar's taskId matches the requested one (no cross-task
  // poisoning) and (b) its author matches the resolved canonical author.
  if (taskIdStr) {
    try {
      const sc = path.join(sidecarDir, `${taskIdStr}.canonical`)
      if (fs.existsSync(sc)) {
        const decl = JSON.parse(fs.readFileSync(sc, 'utf-8'))
        const tidOk = !decl.taskId || String(decl.taskId) === taskIdStr
        if (decl && decl.path && String(decl.path).endsWith('.md') && tidOk && _authorOk(decl.author) && fs.existsSync(decl.path)) {
          const st = fs.statSync(decl.path)
          if (st.isFile() && st.mtimeMs >= cutoffMs) {
            return _entry(path.basename(decl.path), decl.path, st, 'sidecar')
          }
        }
      }
    } catch { /* fail-soft → fall through to scan */ }
  }

  let markerMatch = null      // P0b
  let canonTaskIdName = null  // F1
  let canonContentTid = null  // F2
  let canonNewest = null      // F3
  let taskIdName = null       // F4
  let leaderNameMatch = null  // F5 (legacy P2 back-compat)
  let contentTid = null       // F6
  let anyNewest = null        // F7

  for (const dir of scanDirs || []) {
    if (!dir || !fs.existsSync(dir)) continue
    let names
    try { names = fs.readdirSync(dir) } catch { continue }
    for (const name of names) {
      if (!name.endsWith('.md')) continue
      const fp = path.join(dir, name)
      let st
      try { st = fs.statSync(fp) } catch { continue }
      if (!st.isFile() || st.mtimeMs < cutoffMs) continue

      const header = _readHeader(fp)

      // P0b: explicit marker for this taskId — author-bound (reject a planted
      // marker that claims a non-canonical author, e.g. author=NARAD).
      const mkAuthor = _markerAuthorFor(header, taskIdStr)
      if (mkAuthor !== undefined && _authorOk(mkAuthor)) {
        if (_better(markerMatch, st)) markerMatch = _entry(name, fp, st, 'marker')
        continue
      }

      const nameHasTid = taskIdStr && name.includes(taskIdStr)
      const contentHasTid = _headerHasTaskId(header, taskIdStr)
      const canon = isCanon(name)

      if (canon && nameHasTid && _better(canonTaskIdName, st)) canonTaskIdName = _entry(name, fp, st, 'canon+filename-taskId')
      if (canon && contentHasTid && _better(canonContentTid, st)) canonContentTid = _entry(name, fp, st, 'canon+content-taskId')
      if (canon && _better(canonNewest, st)) canonNewest = _entry(name, fp, st, 'canon-best')
      if (nameHasTid && _better(taskIdName, st)) taskIdName = _entry(name, fp, st, 'filename-taskId')
      if (leaderUpper && name.toUpperCase().includes(leaderUpper) && _better(leaderNameMatch, st)) leaderNameMatch = _entry(name, fp, st, 'leader-name')
      if (contentHasTid && _better(contentTid, st)) contentTid = _entry(name, fp, st, 'content-taskId')
      if (_better(anyNewest, st)) anyNewest = _entry(name, fp, st, 'best')
    }
  }

  return markerMatch
    || canonTaskIdName
    || canonContentTid
    || canonNewest
    || taskIdName
    || leaderNameMatch
    || contentTid
    || anyNewest
    || null
}

module.exports = { selectBestDossierFile }
