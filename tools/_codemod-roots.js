#!/usr/bin/env node
// Offset-preserving codemod: rewrite hardcoded /root/intel + /root/agents path
// literals so they derive from paths.js (env-overridable roots). Comments are
// left untouched (they don't affect runtime). Each file is re-parsed after the
// edit and rolled back if it no longer parses. Defaults in paths.js are
// unchanged, so an unset env reproduces the old absolute paths byte-for-byte.
//
// Usage: node tools/_codemod-roots.js <file-list.txt> [--apply]
//   without --apply  → dry run (report only)
const fs = require('fs')
const path = require('path')
const acorn = require('acorn')

const APPLY = process.argv.includes('--apply')
const listFile = process.argv[2]
const PATHS_ABS = path.resolve(__dirname, '..', 'paths.js')

const files = fs.readFileSync(listFile, 'utf8').split('\n').map(s => s.trim()).filter(Boolean)

const ROOTS = [
  { lit: '/root/intel', acc: 'INTEL_ROOT' },
  { lit: '/root/agents', acc: 'AGENTS_ROOT' },
]

function parse(src) {
  for (const st of ['script', 'module']) {
    try {
      return acorn.parse(src, { ecmaVersion: 'latest', sourceType: st, allowHashBang: true, allowReturnOutsideFunction: true })
    } catch { /* try next */ }
  }
  return null
}

// Find an existing `const X = require('...paths')` and return X, else null.
function existingPathsVar(src) {
  const m = src.match(/(?:const|let|var)\s+([A-Za-z0-9_$]+)\s*=\s*require\((['"])((?:\.\.?\/)+paths)\2\)/)
  return m ? m[1] : null
}

function rootMatch(value) {
  // returns {acc, suffix} if value STARTS WITH a root literal, else null
  for (const r of ROOTS) {
    if (value === r.lit) return { acc: r.acc, suffix: '' }
    if (value.startsWith(r.lit + '/')) return { acc: r.acc, suffix: value.slice(r.lit.length) }
  }
  return null
}

let summary = { files: 0, edited: 0, strings: 0, templates: 0, injected: 0, rolledBack: [], skipped: [] }

for (const f of files) {
  if (path.resolve(f) === PATHS_ABS) { summary.skipped.push(f + ' (paths.js itself)'); continue }
  summary.files++
  const orig = fs.readFileSync(f, 'utf8')
  let ast = parse(orig)
  if (!ast) { summary.skipped.push(f + ' (parse fail)'); continue }

  let pvar = existingPathsVar(orig)
  const VAR = pvar || '__roots'
  const edits = [] // {start, end, text}
  let usedAcc = false

  ;(function walk(node) {
    if (!node || typeof node !== 'object') return
    if (Array.isArray(node)) { node.forEach(walk); return }
    if (node.type === 'Literal' && typeof node.value === 'string') {
      const rm = rootMatch(node.value)
      if (rm) {
        const expr = rm.suffix
          ? `(${VAR}.${rm.acc} + '${rm.suffix.replace(/'/g, "\\'")}')`
          : `${VAR}.${rm.acc}`
        edits.push({ start: node.start, end: node.end, text: expr })
        usedAcc = true; summary.strings++
      }
    }
    if (node.type === 'TemplateElement') {
      const raw = orig.slice(node.start, node.end)
      let nraw = raw
      for (const r of ROOTS) nraw = nraw.split(r.lit).join('${' + VAR + '.' + r.acc + '}')
      if (nraw !== raw) {
        edits.push({ start: node.start, end: node.end, text: nraw })
        usedAcc = true; summary.templates++
      }
    }
    for (const k in node) {
      if (k === 'start' || k === 'end' || k === 'loc' || k === 'range') continue
      const v = node[k]
      if (v && typeof v === 'object') walk(v)
    }
  })(ast)

  if (!edits.length) { continue }

  // Build the require-injection edit if we synthesized a var.
  let injectEdit = null
  if (!pvar && usedAcc) {
    let rel = path.relative(path.dirname(path.resolve(f)), PATHS_ABS).replace(/\.js$/, '')
    if (!rel.startsWith('.')) rel = './' + rel
    const requireLine = `\nconst ${VAR} = require('${rel}') // portable roots (KURU_*_ROOT) — see paths.js\n`
    // Insert after shebang + leading 'use strict' directive, else at top.
    let at = 0
    if (orig.startsWith('#!')) at = orig.indexOf('\n') + 1
    const first = ast.body[0]
    if (first && first.type === 'ExpressionStatement' && first.expression &&
        first.expression.type === 'Literal' && /use strict/.test(String(first.expression.value))) {
      at = Math.max(at, first.end)
    }
    injectEdit = { start: at, end: at, text: requireLine }
  }

  // Apply edits from highest offset to lowest so positions stay valid.
  const all = injectEdit ? edits.concat([injectEdit]) : edits.slice()
  all.sort((a, b) => b.start - a.start)
  let out = orig
  for (const e of all) out = out.slice(0, e.start) + e.text + out.slice(e.end)

  // Validate the result still parses; rollback this file otherwise.
  if (!parse(out)) { summary.rolledBack.push(f); continue }

  summary.edited++
  if (injectEdit) summary.injected++
  if (APPLY) fs.writeFileSync(f, out)
}

console.log(`${APPLY ? 'APPLIED' : 'DRY RUN'}  files=${summary.files} edited=${summary.edited} injected-require=${summary.injected}`)
console.log(`  string-literal rewrites : ${summary.strings}`)
console.log(`  template rewrites       : ${summary.templates}`)
if (summary.rolledBack.length) { console.log('  ROLLED BACK (post-edit parse fail):'); summary.rolledBack.forEach(f => console.log('    ' + f)) }
if (summary.skipped.length) { console.log('  skipped:'); summary.skipped.forEach(s => console.log('    ' + s)) }
