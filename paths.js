// /root/agents/paths.js
// THE single resolver chokepoint for persona + squad paths (restructure Phase 1, 2026-06-07).
// Design: docs/research/2026-06-07-kurukshetra-restructure-design.md
//
// Contract:
//   - NO case transformation: callers pass the exact name they always did
//     (existing call sites keep their .toLowerCase()). This guarantees byte-identical
//     output in legacy mode — the Phase-1 acceptance criterion.
//   - personaCode(name)  → where SOUL.md + skills/ live (code, git-tracked)
//   - personaState(name) → where memory/, sessions/, recon/ live (runtime state)
//     In stateMode=inline (today) state lives inside the code dir; in evicted mode
//     it moves to var/state/agents/<name>/ — flipping the mode IS the Phase-2 cutover.
//   - personaMode=nested (Phase 3) resolves a persona's home through OWNERSHIP
//     (derived from squad rosters); legacy ignores OWNERSHIP entirely.
//   - GATE-121 forbids any raw persona-path literal outside this file.
//
// layout.config.json is mtime-cached (same pattern as model-router.js) so a mode
// flip needs only pm2 reload, and reads cost ~nothing on the hot path.

const path = require('path')
const fs = require('fs')

// ── .env.local autoload (local-dev convenience, 2026-06-17) ──
// paths.js is required by virtually every module + entry point + spawned node
// subprocess, and it's the roots authority — so loading a dotenv file HERE makes
// the whole framework env-aware with no per-entry-point wiring. We read it
// relative to THIS file's directory (the repo root) so resolution never depends
// on the very env vars we're about to set (no chicken-and-egg). Fail-soft, and
// never clobbers a var already present in the real environment (shell wins).
;(function loadDotEnvLocal() {
  try {
    const envPath = path.join(__dirname, '.env.local')
    if (!fs.existsSync(envPath)) return
    for (const raw of fs.readFileSync(envPath, 'utf-8').split('\n')) {
      const line = raw.trim()
      if (!line || line.startsWith('#')) continue
      const eq = line.indexOf('=')
      if (eq < 0) continue
      const key = line.slice(0, eq).trim()
      let val = line.slice(eq + 1).trim()
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1)
      }
      if (key && process.env[key] === undefined) process.env[key] = val
    }
  } catch { /* fail-soft: no .env.local = production defaults */ }
})()

// ── Portable roots (local-dev cutover, 2026-06-17) ──
// AGENTS_ROOT (code) and INTEL_ROOT (data layer) are the two deployment roots.
// They default to the production server layout (/root/agents, /root/intel) so a
// real deploy with the env unset is byte-identical to before — every gate stays
// green. For local development point them elsewhere via env (no /root access,
// no sudo): KURU_AGENTS_ROOT + KURU_INTEL_ROOT (e.g. <repo> and <repo>/var/intel).
// THIS is the single source of truth for both roots — never hardcode either path
// outside this file (GATE-121 for AGENTS_ROOT; same discipline for INTEL_ROOT).
const AGENTS_ROOT = process.env.KURU_AGENTS_ROOT || '/root/agents'
const INTEL_ROOT = process.env.KURU_INTEL_ROOT || '/root/intel'
const CONFIG_PATH = path.join(AGENTS_ROOT, 'layout.config.json')
const OWNERSHIP_PATH = path.join(AGENTS_ROOT, 'ownership.json')

const DEFAULT_CONFIG = { personaMode: 'legacy', stateMode: 'inline' }

let _cfg = null
let _cfgMtime = 0
function config() {
  try {
    const mtime = fs.statSync(CONFIG_PATH).mtimeMs
    if (!_cfg || mtime !== _cfgMtime) {
      _cfg = { ...DEFAULT_CONFIG, ...JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8')) }
      _cfgMtime = mtime
    }
  } catch {
    _cfg = DEFAULT_CONFIG // fail-soft: missing/corrupt config = today's layout
  }
  return _cfg
}

// Phase-3 ownership map: persona dir name → home relative to AGENTS_ROOT.
// Runtime-read from ownership.json (mtime-cached) so populating it + flipping
// personaMode is a config cutover, NOT a code change. Legacy mode never consults it.
// Universal agents (kripa, vyasa, dharmaraj, rof) → '_universal'.
let _own = null
let _ownMtime = 0
function ownership() {
  try {
    const mtime = fs.statSync(OWNERSHIP_PATH).mtimeMs
    if (!_own || mtime !== _ownMtime) {
      _own = JSON.parse(fs.readFileSync(OWNERSHIP_PATH, 'utf-8')).map || {}
      _ownMtime = mtime
    }
  } catch {
    _own = {} // fail-soft: missing/corrupt = flat resolution
  }
  return _own
}

function personaCode(name) {
  // lowercase — ownership keys + on-disk dirs are all lowercase, and the dashboard
  // mirror (agent-paths.ts) lowercases too. Without this, personaCode('ARJUN') →
  // a broken flat path while the dashboard resolves it correctly (GATE-121 parity).
  const n = String(name).toLowerCase()
  if (config().personaMode === 'nested') {
    // ownership value = squad home relative to AGENTS_ROOT (e.g. 'squads/pentest' or
    // '_universal'); personas live under <home>/agents/<name> (uniform for every squad).
    const home = ownership()[n]
    if (home) {
      const nested = path.join(AGENTS_ROOT, home, 'agents', n)
      // fail-soft: if the nested dir isn't there yet, fall back to flat so a
      // half-applied move never starves a SOUL/skill read
      if (fs.existsSync(nested)) return nested
    }
  }
  return path.join(AGENTS_ROOT, n)
}

function personaState(name) {
  if (config().stateMode === 'evicted') {
    return path.join(AGENTS_ROOT, 'var', 'state', 'agents', String(name).toLowerCase())
  }
  return personaCode(name) // inline: state lives in the code dir (today's layout)
}

// ── Derived accessors (code-side) ──
function soulPath(name) { return path.join(personaCode(name), 'SOUL.md') }
function skillsDir(name) { return path.join(personaCode(name), 'skills') }

// ── Derived accessors (state-side) ──
function memoryDir(name) { return path.join(personaState(name), 'memory') }
function lessonsPath(name) { return path.join(memoryDir(name), 'lessons.md') }
function sessionsDir(name) { return path.join(personaState(name), 'sessions') }

// ── Squad-family accessors ──
// Phase 3 consolidates capabilities.json into squads/<sq>/; until then this is
// the top-level squads/ dir GATE-64 already asserts.
function a2aCapsDir() { return path.join(AGENTS_ROOT, 'squads') }

module.exports = {
  AGENTS_ROOT,
  INTEL_ROOT,
  personaCode,
  personaState,
  soulPath,
  skillsDir,
  memoryDir,
  lessonsPath,
  sessionsDir,
  a2aCapsDir,
  _config: config, // exposed for gates/tests
}
