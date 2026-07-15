'use strict'
// Project/Target Profiler (SPEC §3). For static/white-box: measures the source (files, bytes → est tokens,
// languages) so the workstream planner can pack coherent, context-sized sessions. For black-box the adapter
// supplies surface size dynamically. Pure-ish + fail-soft. The budget formula:
//   usable_context = model_context − instructions − blueprint − reasoning_reserve − output_reserve − safety_margin

const fs = require('fs')
const path = require('path')

// ~4 chars/token is the standard rough estimate for code.
function estimateTokens(bytes) { return Math.ceil((Number(bytes) || 0) / 4) }

const DEFAULT_RESERVES = { instructions: 20_000, blueprint: 40_000, reasoning_reserve: 250_000, output_reserve: 120_000, safety_margin: 50_000 }
function usableContext(opts = {}) {
  const model = Number(opts.model_context) || 1_000_000 // Opus 1M default
  const r = { ...DEFAULT_RESERVES, ...(opts.reserves || {}) }
  const used = r.instructions + r.blueprint + r.reasoning_reserve + r.output_reserve + r.safety_margin
  return Math.max(50_000, model - used) // never below a sane floor
}

const CODE_EXT = new Set(['.rb', '.py', '.js', '.ts', '.jsx', '.tsx', '.go', '.java', '.php', '.cs', '.c', '.cc', '.cpp', '.h', '.hpp', '.rs', '.kt', '.swift', '.scala', '.ex', '.exs', '.erl', '.clj', '.groovy', '.pl', '.pm', '.sh', '.sql', '.graphql', '.gql', '.vue', '.svelte', '.html', '.erb', '.haml', '.yml', '.yaml', '.json', '.tf'])
const SKIP_DIR = new Set(['node_modules', '.git', 'vendor', 'dist', 'build', 'coverage', '.next', 'tmp', 'log', 'logs', '__pycache__'])

// Walk a source tree (fail-soft). Returns { files, bytes, byLang:{ext:bytes}, skippedDirs }.
function walkSource(dir, acc = { files: 0, bytes: 0, byLang: {}, skippedDirs: 0 }) {
  let entries; try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return acc }
  for (const e of entries) {
    if (e.isDirectory()) { if (SKIP_DIR.has(e.name)) { acc.skippedDirs++; continue } walkSource(path.join(dir, e.name), acc); continue }
    const ext = path.extname(e.name).toLowerCase()
    if (!CODE_EXT.has(ext)) continue
    try { const st = fs.statSync(path.join(dir, e.name)); acc.files++; acc.bytes += st.size; acc.byLang[ext] = (acc.byLang[ext] || 0) + st.size } catch {}
  }
  return acc
}

// Profile a source repository. opts.model_context / opts.reserves tune the budget.
function profileSource(sourceDir, opts = {}) {
  const w = walkSource(sourceDir)
  const est_tokens = estimateTokens(w.bytes)
  const languages = Object.entries(w.byLang).sort((a, b) => b[1] - a[1]).map(([ext]) => ext.replace('.', ''))
  const usable = usableContext(opts)
  return {
    mode: opts.mode || 'static', sourceDir, files: w.files, bytes: w.bytes, est_tokens, languages,
    skipped_dirs: w.skippedDirs, model_context: Number(opts.model_context) || 1_000_000, usable_context: usable,
    fits_in_one_session: est_tokens <= usable,
    min_sessions: Math.max(1, Math.ceil(est_tokens / usable)),
  }
}

module.exports = { estimateTokens, usableContext, walkSource, profileSource, DEFAULT_RESERVES, CODE_EXT }

// self-check
if (require.main === module) {
  const assert = require('node:assert')
  assert.strictEqual(estimateTokens(400), 100)
  const u = usableContext({ model_context: 1_000_000 })
  assert.ok(u > 400_000 && u < 700_000, 'usable ~520k for 1M model')
  const os = require('os')
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'prof-'))
  fs.mkdirSync(path.join(d, 'app')); fs.writeFileSync(path.join(d, 'app', 'a.rb'), 'class A; end\n')
  fs.mkdirSync(path.join(d, 'node_modules')); fs.writeFileSync(path.join(d, 'node_modules', 'big.js'), 'x'.repeat(10_000))
  const p = profileSource(d)
  assert.strictEqual(p.files, 1, 'node_modules skipped')
  assert.ok(p.fits_in_one_session && p.min_sessions === 1)
  fs.rmSync(d, { recursive: true, force: true })
  console.log('ok — profiler: token estimate, usable-context budget, source walk (skips vendor)')
}
