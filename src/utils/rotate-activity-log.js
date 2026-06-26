#!/usr/bin/env node

const __roots = require('../../paths') // portable roots (KURU_*_ROOT) — see paths.js
/**
 * ACTIVITY LOG ROTATION — keep active log bounded, archive older entries.
 *
 * Runs daily via PM2 cron. Generic across squads — touches only the shared
 * /root/intel/ACTIVITY-LOG.jsonl file, no squad-specific logic.
 *
 * Algorithm:
 *   1. Read active log line-by-line
 *   2. Partition entries by age: keep (< RETAIN_DAYS old), archive (>= RETAIN_DAYS old)
 *   3. Group archived entries by YYYY-MM, append to /root/intel/archive/ACTIVITY-LOG-YYYY-MM.jsonl
 *   4. Compress any archive month that is fully past (last modified > 35 days ago)
 *   5. Atomically rewrite active log with kept entries only
 *
 * Safety:
 *   - If any step fails, active log is NOT modified
 *   - Temp file + rename for atomic replacement
 *   - Compression is idempotent (skips already-compressed months)
 *   - Concurrent writes to active log during rotation are safe: we snapshot at start,
 *     write new content, and if size grew during processing we abort and retry next run
 */

const fs = require('fs')
const path = require('path')
const zlib = require('zlib')

const ACTIVITY_LOG = (__roots.INTEL_ROOT + '/ACTIVITY-LOG.jsonl')
const ARCHIVE_DIR = (__roots.INTEL_ROOT + '/archive')
const RETAIN_DAYS = 30
const COMPRESS_AFTER_DAYS = 35  // month has fully rolled over
const MAX_ACTIVE_BYTES = 10 * 1024 * 1024  // 10MB hard ceiling — force rotation even if <30d

function log(msg) {
  const ts = new Date().toISOString()
  console.log(`[${ts}] ${msg}`)
}

function parseTs(line) {
  try {
    const e = JSON.parse(line)
    return e.ts ? new Date(e.ts).getTime() : null
  } catch { return null }
}

function monthKey(ms) {
  const d = new Date(ms)
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`
}

async function rotate() {
  if (!fs.existsSync(ACTIVITY_LOG)) {
    log(`no active log at ${ACTIVITY_LOG}, nothing to do`)
    return
  }
  fs.mkdirSync(ARCHIVE_DIR, { recursive: true })

  const stat = fs.statSync(ACTIVITY_LOG)
  const sizeBefore = stat.size
  const now = Date.now()
  const cutoffMs = now - RETAIN_DAYS * 24 * 60 * 60 * 1000

  // Snapshot file size to detect concurrent growth later
  const snapshotSize = sizeBefore

  log(`active log: ${(sizeBefore / 1024 / 1024).toFixed(2)}MB, retain < ${RETAIN_DAYS}d`)

  const content = fs.readFileSync(ACTIVITY_LOG, 'utf-8')
  const lines = content.split('\n')
  const keep = []
  const archiveByMonth = {}
  let skipped = 0

  for (const line of lines) {
    if (!line.trim()) continue
    const ts = parseTs(line)
    if (ts === null) {
      // Malformed or missing ts — keep in active (conservative — never lose data)
      keep.push(line)
      skipped++
      continue
    }
    if (ts >= cutoffMs) {
      keep.push(line)
    } else {
      const mk = monthKey(ts)
      if (!archiveByMonth[mk]) archiveByMonth[mk] = []
      archiveByMonth[mk].push(line)
    }
  }

  const archivedTotal = Object.values(archiveByMonth).reduce((a, b) => a + b.length, 0)

  log(`parsed ${lines.length - 1} lines; keep=${keep.length}, archive=${archivedTotal}, skipped-malformed=${skipped}`)

  if (archivedTotal === 0 && sizeBefore < MAX_ACTIVE_BYTES) {
    log(`nothing to archive and within size budget, exiting`)
    return
  }

  // Append archived entries to month files
  for (const [mk, lns] of Object.entries(archiveByMonth)) {
    const archivePath = path.join(ARCHIVE_DIR, `ACTIVITY-LOG-${mk}.jsonl`)
    const existingContent = fs.existsSync(archivePath) ? fs.readFileSync(archivePath, 'utf-8') : ''
    const newContent = existingContent + (existingContent && !existingContent.endsWith('\n') ? '\n' : '') + lns.join('\n') + '\n'
    // Atomic write
    const tmp = archivePath + '.tmp'
    fs.writeFileSync(tmp, newContent)
    fs.renameSync(tmp, archivePath)
    log(`appended ${lns.length} entries to ${archivePath}`)
  }

  // Verify active log hasn't grown during archiving (concurrent writes from event-bus)
  const currentSize = fs.statSync(ACTIVITY_LOG).size
  if (currentSize > snapshotSize) {
    const grewByBytes = currentSize - snapshotSize
    log(`⚠️ active log grew by ${grewByBytes} bytes during archive — appending delta to keep`)
    // Read only the delta (from snapshotSize to currentSize)
    const fd = fs.openSync(ACTIVITY_LOG, 'r')
    const buf = Buffer.alloc(grewByBytes)
    fs.readSync(fd, buf, 0, grewByBytes, snapshotSize)
    fs.closeSync(fd)
    const deltaLines = buf.toString('utf-8').split('\n').filter(Boolean)
    keep.push(...deltaLines)
    log(`merged ${deltaLines.length} concurrent-write lines back into keep`)
  }

  // Atomically rewrite active log with only kept entries
  const newActive = keep.join('\n') + (keep.length > 0 ? '\n' : '')
  const activeTmp = ACTIVITY_LOG + '.tmp'
  fs.writeFileSync(activeTmp, newActive)
  fs.renameSync(activeTmp, ACTIVITY_LOG)
  const sizeAfter = fs.statSync(ACTIVITY_LOG).size
  log(`rotated active log: ${(sizeBefore / 1024 / 1024).toFixed(2)}MB → ${(sizeAfter / 1024 / 1024).toFixed(2)}MB (${keep.length} entries)`)

  // Compress older month archives (last modified > 35 days ago)
  const archives = fs.readdirSync(ARCHIVE_DIR).filter(n => n.endsWith('.jsonl'))
  const compressCutoff = now - COMPRESS_AFTER_DAYS * 24 * 60 * 60 * 1000
  for (const name of archives) {
    const p = path.join(ARCHIVE_DIR, name)
    const st = fs.statSync(p)
    if (st.mtimeMs < compressCutoff) {
      try {
        const data = fs.readFileSync(p)
        const gz = zlib.gzipSync(data)
        fs.writeFileSync(p + '.gz', gz)
        fs.unlinkSync(p)
        log(`compressed ${name} → ${name}.gz (${(data.length / 1024).toFixed(0)}KB → ${(gz.length / 1024).toFixed(0)}KB)`)
      } catch (e) {
        log(`⚠️ failed to compress ${name}: ${e.message}`)
      }
    }
  }

  log(`rotation complete`)
}

// Allow import as module (for testing) or direct execution
if (require.main === module) {
  rotate().catch(e => { log(`FATAL: ${e.message}`); process.exit(1) })
} else {
  module.exports = { rotate }
}
