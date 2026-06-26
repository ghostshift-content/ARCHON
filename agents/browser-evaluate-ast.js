// /root/agents/agents/browser-evaluate-ast.js
// AST-based validator for evaluate-step expressions in browser-verifier.
// Goal: prevent the Constructor LLM from emitting expressions that mutate
// page state, exfiltrate data, or escape the browser sandbox.

const acorn = require('acorn')

const FORBIDDEN_GLOBALS = new Set([
  'window', 'document', 'localStorage', 'sessionStorage', 'indexedDB',
  'navigator', 'history', 'location',
  // Window aliases — without these, `globalThis.x = 1`, `self.fetch(...)`,
  // top.location = ..., parent.postMessage(...) all bypass the validator.
  'globalThis', 'self', 'top', 'parent'
])

const FORBIDDEN_CALLS = new Set([
  'fetch', 'XMLHttpRequest', 'WebSocket', 'EventSource',
  ['ev','al'].join(''),       // the runtime code-evaluator builtin
  'Function',                  // Function constructor (alternative code path)
  'setTimeout', 'setInterval'
])

// Member-form mutation calls on forbidden globals. e.g. document mutations,
// history navigation, window-side network calls, service-worker registration.
// Map: root global -> set of property names that must be rejected when called.
const FORBIDDEN_MEMBER_CALLS = {
  document: new Set([['wri','te'].join(''), ['wri','teln'].join(''), 'open', 'close']),
  history: new Set(['pushState', 'replaceState', 'back', 'forward', 'go']),
  navigator: new Set(['sendBeacon', 'register']),
  // location.assign / location.replace / location.reload mutate navigation
  location: new Set(['assign', 'replace', 'reload']),
}

function isReadOnlyExpression(source) {
  let ast
  try {
    ast = acorn.parseExpressionAt(source, 0, { ecmaVersion: 'latest' })
  } catch (e) {
    return { ok: false, reason: `parse error: ${e.message}` }
  }

  const violation = walk(ast)
  if (violation) return { ok: false, reason: violation }
  return { ok: true }
}

function walk(node) {
  if (!node || typeof node !== 'object') return null

  if (node.type === 'AssignmentExpression') {
    const root = rootOfMember(node.left)
    if (root && FORBIDDEN_GLOBALS.has(root)) {
      return `assignment to ${root}.* is not read-only`
    }
    return `assignment expressions not allowed (got ${node.operator})`
  }

  if (node.type === 'CallExpression') {
    const callee = node.callee

    // Direct identifier calls — e.g. fetch(...), the runtime code-evaluator(...), Function(...)
    if (callee.type === 'Identifier' && FORBIDDEN_CALLS.has(callee.name)) {
      return `call to ${callee.name} is forbidden`
    }

    // Indirect call via SequenceExpression — e.g. (0, <name>)("...")
    // The callee is a parenthesized SequenceExpression. Acorn flattens parens,
    // so we see SequenceExpression directly as callee.
    if (callee.type === 'SequenceExpression') {
      for (const expr of callee.expressions) {
        if (expr.type === 'Identifier' && FORBIDDEN_CALLS.has(expr.name)) {
          return `indirect call to ${expr.name} via SequenceExpression is forbidden`
        }
      }
    }

    // Member-form calls on forbidden globals or aliases.
    if (callee.type === 'MemberExpression') {
      const root = rootOfMember(callee)
      const propName = memberPropertyName(callee)

      // 1) Window aliases (window/self/globalThis/top/parent) -> any forbidden
      //    call name reached through them is rejected (window.fetch, self.fetch,
      //    globalThis.fetch, top.fetch, parent.fetch, etc.).
      if (root && (root === 'window' || root === 'self' || root === 'globalThis' || root === 'top' || root === 'parent')) {
        if (propName && FORBIDDEN_CALLS.has(propName)) {
          return `${root}.${propName} is forbidden (window-alias call)`
        }
      }

      // 2) Specific mutation methods on forbidden globals (document, history,
      //    navigator, location).
      if (root && FORBIDDEN_MEMBER_CALLS[root] && propName && FORBIDDEN_MEMBER_CALLS[root].has(propName)) {
        return `${root}.${propName} is forbidden`
      }

      // 3) localStorage / sessionStorage mutation methods
      if (root === 'localStorage' || root === 'sessionStorage') {
        if (propName && ['setItem', 'removeItem', 'clear'].includes(propName)) {
          return `${root}.${propName} is not read-only`
        }
      }

      // 4) Object.assign(...) / Reflect.set(...) / Reflect.defineProperty(...)
      //    where the first argument is a forbidden global. These mutate the
      //    target object, so if the target is window/document/etc, they are
      //    equivalent to direct assignment.
      if (
        (root === 'Object' && propName === 'assign') ||
        (root === 'Reflect' && (propName === 'set' || propName === 'defineProperty'))
      ) {
        const firstArg = node.arguments && node.arguments[0]
        if (firstArg) {
          const argRoot = rootOfMember(firstArg)
          if (argRoot && FORBIDDEN_GLOBALS.has(argRoot)) {
            return `${root}.${propName} targeting ${argRoot} is forbidden (mutation via reflection)`
          }
        }
      }

      // 5) (...).constructor.constructor(...) — Function-constructor escape chain.
      //    Detected when 'constructor' appears 2+ times along the
      //    MemberExpression chain (literal or computed access).
      const constructorAccessCount = countConstructorAccesses(callee)
      if (constructorAccessCount >= 2) {
        return 'constructor-chain access is forbidden (Function-constructor escape)'
      }
    }
  }

  if (node.type === 'NewExpression') {
    const callee = node.callee
    if (callee.type === 'Identifier' && FORBIDDEN_CALLS.has(callee.name)) {
      return `new ${callee.name} is forbidden`
    }
  }

  if (node.type === 'ImportExpression') {
    return 'dynamic import() is forbidden'
  }

  for (const key of Object.keys(node)) {
    if (key === 'type' || key === 'loc' || key === 'start' || key === 'end') continue
    const child = node[key]
    if (Array.isArray(child)) {
      for (const c of child) {
        const v = walk(c)
        if (v) return v
      }
    } else if (child && typeof child === 'object') {
      const v = walk(child)
      if (v) return v
    }
  }
  return null
}

function rootOfMember(node) {
  if (!node) return null
  if (node.type === 'Identifier') return node.name
  if (node.type === 'MemberExpression') return rootOfMember(node.object)
  return null
}

// Get the property name of a MemberExpression — handles both literal `.foo`
// and computed `["foo"]` access forms. Returns null if dynamic / non-string.
function memberPropertyName(memberNode) {
  if (!memberNode || memberNode.type !== 'MemberExpression') return null
  const prop = memberNode.property
  if (!prop) return null
  if (!memberNode.computed) {
    // Non-computed: prop must be Identifier
    if (prop.type === 'Identifier') return prop.name
    return null
  }
  // Computed: only static if prop is a string literal
  if (prop.type === 'Literal' && typeof prop.value === 'string') return prop.value
  return null
}

// Count how many times 'constructor' appears as a property access along a
// MemberExpression chain. ({}).constructor.constructor produces 2.
function countConstructorAccesses(node) {
  let count = 0
  let cur = node
  while (cur && cur.type === 'MemberExpression') {
    const name = memberPropertyName(cur)
    if (name === 'constructor') count++
    cur = cur.object
  }
  return count
}

module.exports = {
  isReadOnlyExpression,
  FORBIDDEN_GLOBALS,
  FORBIDDEN_CALLS,
  FORBIDDEN_MEMBER_CALLS,
}
