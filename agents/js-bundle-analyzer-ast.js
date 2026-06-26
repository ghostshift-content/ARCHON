// agents/js-bundle-analyzer-ast.js
//
// AST-based endpoint extraction for Phase 1.6 JS bundle analyzer. Complements
// the existing regex extractor — runs in parallel and the union is used.
//
// Why AST in addition to regex:
//   1. Template literals like `/api/users/${id}` — regex matches the literal
//      backtick-quoted string and gets confused by ${...} interpolation.
//      AST gives us the .quasis fragments cleanly.
//   2. Concatenations like '/api/' + 'v1/printLog' — regex sees two strings.
//      AST resolves the binary expression for the constant-folded case.
//   3. Strings nested deep in object literals — regex catches them too but
//      AST gives us the *property names* as additional context (route maps).
//
// Defensive: any parse error returns []. We don't break the pipeline if a
// minified bundle uses syntax acorn (sourceType=script + ecmaVersion=latest)
// can't parse. The regex extractor will still run.

'use strict'

const acorn = require('acorn')

const ENDPOINT_LIKE = /^\/[a-zA-Z0-9_\-./{}:]{2,200}$/
const MAX_RESULTS = 200

// Heuristic: looks like an API path or static asset path, not arbitrary prose.
// We reject obvious non-paths (CSS comments, log lines, fully qualified URLs
// that already have a scheme but no leading slash after the host).
function looksLikeEndpoint(s) {
  if (!s || typeof s !== 'string') return false
  if (s.length < 3 || s.length > 200) return false
  if (!s.startsWith('/')) return false
  if (!ENDPOINT_LIKE.test(s)) return false
  // Reject obvious file extensions that aren't endpoints (let regex handle .js/.css URLs)
  if (/\.(?:jpe?g|png|gif|svg|webp|ico|woff2?|ttf|eot|otf|map|css)(?:$|\?)/i.test(s)) return false
  return true
}

function _walk(node, visit) {
  if (!node || typeof node !== 'object') return
  visit(node)
  for (const key of Object.keys(node)) {
    if (key === 'parent' || key === 'loc' || key === 'start' || key === 'end' || key === 'range') continue
    const child = node[key]
    if (Array.isArray(child)) {
      for (const c of child) _walk(c, visit)
    } else if (child && typeof child === 'object' && typeof child.type === 'string') {
      _walk(child, visit)
    }
  }
}

function extractEndpointsFromAst(jsContent) {
  if (!jsContent || typeof jsContent !== 'string') return []
  let tree
  try {
    tree = acorn.parse(jsContent, {
      ecmaVersion: 'latest',
      sourceType: 'script',
      allowReturnOutsideFunction: true,
      allowImportExportEverywhere: true,
      allowAwaitOutsideFunction: true,
      allowHashBang: true,
    })
  } catch {
    try {
      tree = acorn.parse(jsContent, {
        ecmaVersion: 'latest',
        sourceType: 'module',
        allowReturnOutsideFunction: true,
      })
    } catch {
      return []
    }
  }

  const out = new Set()

  _walk(tree, (node) => {
    if (out.size >= MAX_RESULTS) return

    // Plain string literal
    if (node.type === 'Literal' && typeof node.value === 'string') {
      if (looksLikeEndpoint(node.value)) out.add(node.value)
      return
    }

    // Template literal — pull static quasis (template parts between ${...})
    if (node.type === 'TemplateLiteral') {
      const parts = (node.quasis || []).map(q => q.value && q.value.cooked).filter(Boolean)
      // Static prefix (first quasi, if non-empty)
      if (parts[0] && looksLikeEndpoint(parts[0])) {
        out.add(parts[0])
      }
      // Full joined fallback if no interpolation
      if ((node.expressions || []).length === 0 && parts.length > 0) {
        const joined = parts.join('')
        if (looksLikeEndpoint(joined)) out.add(joined)
      }
      return
    }

    // Binary expression — handle '/api/' + 'v1/foo' constant-folding
    if (
      node.type === 'BinaryExpression' &&
      node.operator === '+' &&
      node.left && node.right &&
      node.left.type === 'Literal' && typeof node.left.value === 'string' &&
      node.right.type === 'Literal' && typeof node.right.value === 'string'
    ) {
      const joined = node.left.value + node.right.value
      if (looksLikeEndpoint(joined)) out.add(joined)
    }
  })

  return [...out].slice(0, MAX_RESULTS).sort()
}

module.exports = {
  extractEndpointsFromAst,
  looksLikeEndpoint,
  MAX_RESULTS,
}
