'use strict'

const fs = require('fs')
const path = require('path')

const DEFAULT_TIMEOUT_MS = 5_000
const DEFAULT_STALE_MS = 30_000
const WAIT_ARRAY = new Int32Array(new SharedArrayBuffer(4))

function sleep(ms) {
  Atomics.wait(WAIT_ARRAY, 0, 0, Math.max(1, Number(ms) || 1))
}

function withFileLock(lockPath, fn, opts = {}) {
  const timeoutMs = Math.max(100, Number(opts.timeoutMs) || DEFAULT_TIMEOUT_MS)
  const staleMs = Math.max(timeoutMs, Number(opts.staleMs) || DEFAULT_STALE_MS)
  const retryMs = Math.max(5, Number(opts.retryMs) || 10)
  const deadline = Date.now() + timeoutMs
  let fd = null

  fs.mkdirSync(path.dirname(lockPath), { recursive: true })
  while (fd == null) {
    try {
      fd = fs.openSync(lockPath, 'wx', 0o600)
      fs.writeFileSync(fd, JSON.stringify({
        pid: process.pid,
        created_at: new Date().toISOString(),
      }))
    } catch (error) {
      if (!error || error.code !== 'EEXIST') throw error
      try {
        if (Date.now() - fs.statSync(lockPath).mtimeMs > staleMs) {
          fs.unlinkSync(lockPath)
          continue
        }
      } catch (statError) {
        if (statError && statError.code !== 'ENOENT') throw statError
        continue
      }
      if (Date.now() >= deadline) {
        const timeout = new Error(`Timed out waiting for runtime lock: ${path.basename(lockPath)}`)
        timeout.code = 'ARCHON_LOCK_TIMEOUT'
        throw timeout
      }
      sleep(Math.min(retryMs, Math.max(1, deadline - Date.now())))
    }
  }

  try {
    return fn()
  } finally {
    try { fs.closeSync(fd) } catch {}
    try { fs.unlinkSync(lockPath) } catch {}
  }
}

module.exports = {
  DEFAULT_TIMEOUT_MS,
  DEFAULT_STALE_MS,
  withFileLock,
}
