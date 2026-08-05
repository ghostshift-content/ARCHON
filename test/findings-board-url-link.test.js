const assert = require('node:assert')
const { test } = require('node:test')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

// ui/app.js is browser SPA code (no module system, touches `window`), so we lift the two
// functions under test into a sandbox rather than require()-ing the file.
const SRC = fs.readFileSync(path.join(__dirname, '..', 'ui', 'app.js'), 'utf8')

function loadFns() {
  const grab = name => {
    const i = SRC.indexOf(`function ${name}(`)
    assert.notStrictEqual(i, -1, `${name}() not found in ui/app.js`)
    // walk braces from the first { after the signature to find the function body end
    const start = SRC.indexOf('{', i)
    let depth = 0
    for (let j = start; j < SRC.length; j++) {
      if (SRC[j] === '{') depth++
      else if (SRC[j] === '}') { depth--; if (depth === 0) return SRC.slice(i, j + 1) }
    }
    throw new Error(`could not delimit ${name}()`)
  }
  const ctx = {
    window: { location: { origin: 'https://console.local' } },
    URL,
    // same escaper as the SPA
    esc: s => String(s == null ? '' : s).replace(/[&<>"]/g,
      c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])),
  }
  vm.createContext(ctx)
  vm.runInContext(`${grab('safeUrl')}\n${grab('fbUrlCell')}`, ctx)
  return ctx
}

const { safeUrl, fbUrlCell } = loadFns()

// ── safeUrl: scheme allowlist ────────────────────────────────────────────────

test('safeUrl accepts http and https', () => {
  assert.strictEqual(safeUrl('https://target.example/api/v1/x'), 'https://target.example/api/v1/x')
  assert.strictEqual(safeUrl('http://target.example/'), 'http://target.example/')
})

test('safeUrl resolves a bare path against the console origin', () => {
  assert.strictEqual(safeUrl('/hms_ms/api/v1/payment/get_hotel_data'),
    'https://console.local/hms_ms/api/v1/payment/get_hotel_data')
})

test('safeUrl rejects javascript: — findings are agent-supplied, this would be self-XSS', () => {
  assert.strictEqual(safeUrl('javascript:alert(document.cookie)'), null)
  assert.strictEqual(safeUrl('  JaVaScRiPt:alert(1)  '), null)
})

test('safeUrl rejects data:, vbscript: and file:', () => {
  assert.strictEqual(safeUrl('data:text/html,<script>alert(1)</script>'), null)
  assert.strictEqual(safeUrl('vbscript:msgbox(1)'), null)
  assert.strictEqual(safeUrl('file:///etc/passwd'), null)
})

test('safeUrl handles empty/missing values', () => {
  for (const v of ['', '   ', null, undefined]) assert.strictEqual(safeUrl(v), null)
})

// ── fbUrlCell: markup ────────────────────────────────────────────────────────

test('fbUrlCell renders nothing when the finding has no url', () => {
  assert.strictEqual(fbUrlCell({ title: 'x' }), '')
})

test('fbUrlCell links a safe url, in a new tab, with noopener', () => {
  const html = fbUrlCell({ url: 'https://target.example/a', method: 'GET' })
  assert.match(html, /<a class="fb-link" href="https:\/\/target\.example\/a"/)
  assert.match(html, /target="_blank"/)
  assert.match(html, /rel="noopener noreferrer"/)
  assert.match(html, /GET/)
})

test('fbUrlCell degrades to plain text for an unsafe url — and never emits an href', () => {
  const html = fbUrlCell({ url: 'javascript:alert(1)', method: 'GET' })
  assert.ok(!html.includes('<a '), 'must not produce an anchor')
  assert.ok(!html.includes('href'), 'must not produce an href')
  assert.match(html, /javascript:alert\(1\)/)   // still shown to the operator, inert
})

test('fbUrlCell escapes angle brackets and quotes in the displayed url', () => {
  const html = fbUrlCell({ url: 'https://t.example/"><img src=x onerror=alert(1)>' })
  assert.ok(!html.includes('<img'), 'raw tag must not survive into the DOM string')
  assert.match(html, /&lt;img/, 'displayed url must be html-escaped')

  // The breakout risk is a raw quote or angle bracket *inside* the href value; URL parsing
  // percent-encodes them, so assert on the extracted attribute rather than the whole string
  // (the literal word "onerror" legitimately appears, encoded, in the visible text).
  const href = html.match(/href="([^"]*)"/)[1]
  assert.ok(!/["'<>]/.test(href), `href must contain no raw quote or bracket, got: ${href}`)
  assert.match(href, /%3Cimg/, 'angle bracket should be percent-encoded in the href')

  // and only one anchor was produced — no injected second tag
  assert.strictEqual(html.match(/<a /g).length, 1)
})

test('fbUrlCell tolerates a missing method', () => {
  const html = fbUrlCell({ url: 'https://target.example/a' })
  assert.match(html, /<a class="fb-link"/)
})
