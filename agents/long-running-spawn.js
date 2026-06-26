// agents/long-running-spawn.js
//
// Async subprocess wrapper that releases the event loop during the wait,
// fires periodic heartbeat callbacks, captures stdout/stderr, and enforces
// a hard timeout. Use this in place of synchronous subprocess calls for any
// command that may run longer than the supervisor's checkpoint stale-threshold
// (~5 min).
//
// Spec: docs/superpowers/plans/2026-05-08-supervisor-heartbeat-fix.md

const { spawn } = require('node:child_process')

/**
 * Run a shell command asynchronously with optional periodic heartbeat callback.
 *
 * @param {string} cmd - shell command (executed via `${shell} -c "<cmd>"`)
 * @param {object} opts
 * @param {number} [opts.timeout=60000] - hard timeout in ms; child is SIGTERM'd then SIGKILL'd
 * @param {number} [opts.heartbeatMs=30000] - interval to invoke onHeartbeat
 * @param {Function} [opts.onHeartbeat] - callback fired every heartbeatMs while child runs
 * @param {string} [opts.shell='/bin/sh'] - shell to invoke
 * @returns {Promise<{stdout: string, stderr: string, code: number|null, timedOut: boolean, error?: Error}>}
 *          Never throws. Errors surface as { error, code: null } on the resolved value.
 */
function runWithHeartbeat(cmd, opts = {}) {
  const {
    timeout = 60000,
    heartbeatMs = 30000,
    onHeartbeat = null,
    shell = '/bin/sh',
  } = opts

  return new Promise((resolve) => {
    let stdout = ''
    let stderr = ''
    let heartbeatTimer = null
    let timeoutTimer = null
    let killTimer = null
    let timedOut = false
    let resolved = false

    const cleanup = () => {
      if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null }
      if (timeoutTimer) { clearTimeout(timeoutTimer); timeoutTimer = null }
      if (killTimer) { clearTimeout(killTimer); killTimer = null }
    }

    const finish = (result) => {
      if (resolved) return
      resolved = true
      cleanup()
      resolve(result)
    }

    let child
    try {
      // detached: true makes the child its own process group leader, so we can
      // kill the whole group via process.kill(-pid). Without this, a shell-wrapped
      // subprocess (e.g. `sh -c "sleep 60"`) would orphan its grandchild on
      // SIGTERM-to-shell, and the grandchild would hold the stdout pipe open,
      // preventing 'close' from firing — the Promise would hang.
      child = spawn(shell, ['-c', cmd], {
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: true,
      })
    } catch (e) {
      return finish({ stdout: '', stderr: e.message, code: null, timedOut: false, error: e })
    }

    const killGroup = (signal) => {
      try { process.kill(-child.pid, signal) } catch (_) {
        try { child.kill(signal) } catch (_) {}  // fallback to direct kill
      }
    }

    if (onHeartbeat && heartbeatMs > 0) {
      heartbeatTimer = setInterval(() => {
        try { onHeartbeat() } catch (_) { /* swallow heartbeat errors */ }
      }, heartbeatMs)
    }

    if (timeout > 0) {
      timeoutTimer = setTimeout(() => {
        timedOut = true
        killGroup('SIGTERM')
        // Force-kill the whole group after 2s grace
        killTimer = setTimeout(() => {
          killGroup('SIGKILL')
          // Failsafe: if close still doesn't fire within 1s of SIGKILL,
          // force-resolve so callers never block on a runaway subprocess.
          setTimeout(() => {
            finish({ stdout, stderr, code: null, timedOut: true })
          }, 1000)
        }, 2000)
      }, timeout)
    }

    child.stdout.on('data', d => { stdout += d.toString('utf-8') })
    child.stderr.on('data', d => { stderr += d.toString('utf-8') })

    child.on('close', (code) => {
      finish({ stdout, stderr, code, timedOut })
    })

    child.on('error', (err) => {
      finish({ stdout, stderr: stderr || err.message, code: null, timedOut, error: err })
    })
  })
}

module.exports = { runWithHeartbeat }
