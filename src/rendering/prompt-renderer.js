
const __roots = require('../../paths') // portable roots (KURU_*_ROOT) — see paths.js
// /root/agents/prompt-renderer.js
//
// Prompt Template Versioning — the foundation for git-tracked, rollback-safe prompts.
//
// Templates live in /root/agents/prompts/<role>/<version>.md and use Mustache-style
// {{var}} placeholders. Active versions are configured in /root/intel/prompts-config.json.
//
// Rollback model (3 layers of safety):
//   1. Per-role version pin in prompts-config.json.versions — edit to switch versions
//   2. prompts-config.json.rollback_mode = "inline" → renderer returns null → callers
//      fall back to their inline prompt builders
//   3. If a specific template file is missing/malformed → render() returns null → same fallback
//
// Syntax supported:
//   {{var}}             — substitute variable (missing vars expand to empty string)
//   {{var | default}}   — substitute with default when missing/empty
//   {{#if var}}...{{/if}} — include block only when var is truthy
//   {{#block:name}}     — insert block from second-arg helpers map (for reusable fragments)
//
// Escaping: placeholders inside fenced code blocks are STILL substituted (intentional —
// prompts often need interpolation inside examples). If you need a literal {{ in output,
// pass it as a variable.
//
// mtime cache invalidation per template file.

const fs = require('fs')
const path = require('path')

const CONFIG_PATH = (__roots.INTEL_ROOT + '/prompts-config.json')
const PROMPTS_DIR = (__roots.AGENTS_ROOT + '/prompts')

// ── Config cache ────────────────────────────────────────────────────
let _cfgCache = null
let _cfgMtime = 0
function loadConfig() {
  try {
    const stat = fs.statSync(CONFIG_PATH)
    if (_cfgCache && stat.mtimeMs === _cfgMtime) return _cfgCache
    _cfgCache = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'))
    _cfgMtime = stat.mtimeMs
    return _cfgCache
  } catch { return null }
}

// ── Template cache (per file) ───────────────────────────────────────
const _tmplCache = new Map() // path -> { content, mtime }
function loadTemplate(role, version) {
  const p = path.join(PROMPTS_DIR, role, `${version}.md`)
  try {
    const stat = fs.statSync(p)
    const cached = _tmplCache.get(p)
    if (cached && cached.mtime === stat.mtimeMs) return cached.content
    const content = fs.readFileSync(p, 'utf-8')
    _tmplCache.set(p, { content, mtime: stat.mtimeMs })
    return content
  } catch { return null }
}

function resetCache() {
  _cfgCache = null
  _cfgMtime = 0
  _tmplCache.clear()
}

// ── Renderer ─────────────────────────────────────────────────────────
// Two-pass substitution:
//   Pass 1: resolve {{#if var}}...{{/if}} blocks (remove whole block if var falsy)
//   Pass 2: resolve {{var}}, {{var | default}} placeholders
function render(template, vars = {}) {
  if (typeof template !== 'string') return null

  // Pass 1 — conditional blocks. Non-greedy + supports nested-simple blocks (no arbitrary nesting).
  let out = template.replace(/\{\{#if\s+([\w.]+)\}\}([\s\S]*?)\{\{\/if\}\}/g, (_, key, body) => {
    const v = getVar(vars, key)
    return v ? body : ''
  })

  // Pass 2 — variable substitution with optional default
  out = out.replace(/\{\{\s*([\w.]+)\s*(?:\|\s*([^}]+?))?\s*\}\}/g, (_, key, def) => {
    const v = getVar(vars, key)
    if (v === undefined || v === null || v === '') {
      return def !== undefined ? def.trim() : ''
    }
    return String(v)
  })

  // Strip a single trailing newline — POSIX text files end with LF but we want the
  // rendered prompt to match inline template-literal behavior (no trailing LF).
  if (out.endsWith('\n')) out = out.slice(0, -1)

  return out
}

// Support dotted paths like "profile.environment"
function getVar(vars, key) {
  const parts = key.split('.')
  let v = vars
  for (const p of parts) {
    if (v == null) return undefined
    v = v[p]
  }
  return v
}

// ── Main entry — resolve active version + render ───────────────────
// Returns the rendered prompt string, or null if:
//   - config disabled / rollback_mode set
//   - no active version configured for role
//   - template file missing or unreadable
// null is the signal for callers to fall back to their inline prompt.
function renderPrompt(role, vars = {}) {
  const cfg = loadConfig()
  if (!cfg || cfg.enabled === false) return null
  if (cfg.rollback_mode === 'inline') return null
  const version = cfg.versions?.[role]
  if (!version) return null
  const tmpl = loadTemplate(role, version)
  if (!tmpl) return null
  return render(tmpl, vars)
}

function listRoles() {
  const cfg = loadConfig()
  return cfg ? Object.keys(cfg.versions || {}) : []
}

function activeVersion(role) {
  const cfg = loadConfig()
  return cfg?.versions?.[role] || null
}

module.exports = {
  CONFIG_PATH,
  PROMPTS_DIR,
  loadConfig,
  loadTemplate,
  render,
  renderPrompt,
  resetCache,
  listRoles,
  activeVersion,
}
