#!/usr/bin/env node
// Regression test for tech fingerprint detection regex patterns.
// Apr-21 Run 1: regex matched "go" inside "login"/"going"/"nginx",
// "ruby" in passing prose, "rack" in "backpack" — emitted phantom
// Ruby/Go on ASP.NET-only target. Word-boundaries added in Fix D.

// The tech-detection regexes live inline in event-bus.js. Keep this list in
// sync with event-bus.js — tests here guard against regression.
const rules = [
  ['PHP',          /\bphp\b|x-powered-by.*php|\bwordpress\b|wp-content|wp-json|\blaravel\b|\bsymfony\b|\bdrupal\b|\bjoomla\b|\.php\b/i],
  ['Java',         /\bjava\b|\bspring\b|\btomcat\b|\bstruts\b|jsessionid|\.jsp\b|\.do\b|\.action\b|\bservlet\b|x-powered-by.*jboss/i],
  ['Node.js',      /\bnode\.?js\b|\bexpress\b|\bnext\.js\b|\bnuxt\b|\bkoa\b|x-powered-by.*express|x-powered-by.*next/i],
  ['.NET',         /\.net\b|asp\.net|\baspx\b|\bviewstate\b|__dopostback|\biis\b|x-aspnet-version/i],
  ['Python',       /\bpython\b|\bdjango\b|\bflask\b|\bgunicorn\b|\bwerkzeug\b|\bfastapi\b|x-powered-by.*python/i],
  ['Ruby',         /\bruby\b|x-powered-by.*ruby|\brails\b|\bsinatra\b|\.rb\b|rack-\d|x-runtime/i],
  ['Go',           /\bgolang\b|gin-gonic|gorilla\/mux|x-powered-by.*(?:fiber|echo|go-)|\bfasthttp\b|x-go-version/i],
  ['GraphQL',      /\bgraphql\b|__schema|introspection\s*(?:query|type)/i],
  ['OpenAPI',      /\bswagger\b|\bopenapi\b|api-docs|swagger-ui/i],
  ['SPA-Frontend', /\breact\b|\bangular\b|\bvue\.?js\b|\bsvelte\b|\bember\.?js\b/i],
]

function detect(text) {
  return rules.filter(([, rx]) => rx.test(text)).map(([name]) => name)
}

let passed = 0, failed = 0
function expect(label, text, wantHit, wantMiss = []) {
  const d = detect(text)
  const hitOk = wantHit.every(t => d.includes(t))
  const missOk = wantMiss.every(t => !d.includes(t))
  if (hitOk && missOk) {
    console.log(`  ✓ ${label}`)
    passed++
  } else {
    console.log(`  ✗ ${label}`)
    console.log(`    expected hits: ${wantHit.join(',')}, expected misses: ${wantMiss.join(',')}`)
    console.log(`    got: ${d.join(',')}`)
    failed++
  }
}

console.log('Tech fingerprint detection tests:')

// The Apr-21 Run 1 false positive case: ASP.NET only, NO Ruby/Go
expect(
  'ASP.NET-only target does NOT falsely detect Ruby/Go',
  `HTTP/1.1 200 OK
Server: Microsoft-IIS/10.0
X-AspNet-Version: 4.0.30319
Set-Cookie: ASP.NET_SessionId=abc123
Content-Type: text/html; charset=utf-8
<html><body><form action="/Public/Login.aspx"><input id="__VIEWSTATE"></form></body></html>
employee login going to azure SSO, user can view records, rolling out next sprint`,
  ['.NET'],
  ['Ruby', 'Go', 'Python', 'PHP', 'Java']  // prose "going"/"rolling" must NOT match
)

expect(
  'nginx does NOT trigger Go (was matching "gin" inside "nginx")',
  `Server: nginx/1.18.0
X-Powered-By: PHP/7.4`,
  ['PHP'],
  ['Go']
)

expect(
  'prose containing "go"/"login"/"going" does NOT trigger Go',
  `Attacker can login, go to admin panel, keep going through the flow. Logout required.`,
  [],
  ['Go', 'Ruby']
)

expect(
  'actual Ruby target IS detected',
  `X-Runtime: 0.123
Server: Passenger
X-Powered-By: Rails/7.0
<a href="/users.rb">edit</a>`,
  ['Ruby']
)

expect(
  'actual Go target IS detected',
  `X-Go-Version: go1.21
Server: fasthttp
framework: gin-gonic`,
  ['Go']
)

expect(
  'WordPress PHP detected',
  `<link rel="stylesheet" href="/wp-content/themes/x/style.css">
<script src="/wp-json/embed.js"></script>`,
  ['PHP']
)

expect(
  'Java Spring detected',
  `Set-Cookie: JSESSIONID=x
Server: Apache Tomcat/9.0
X-Powered-By: Spring Boot`,
  ['Java']
)

expect(
  'SPA-Frontend detected from script tags',
  `<script src="/static/react.production.min.js"></script>
<script src="/static/vue.js"></script>`,
  ['SPA-Frontend']
)

expect(
  'GraphQL detected',
  `POST /graphql
{"query":"{ __schema { types { name } } }"}`,
  ['GraphQL']
)

expect(
  'empty input → nothing detected',
  ``,
  []
)

expect(
  'pure noise → nothing detected',
  `Hello world. The server returned a page. Links: /home /about /contact.`,
  [],
  ['PHP', 'Java', 'Node.js', '.NET', 'Python', 'Ruby', 'Go', 'GraphQL', 'OpenAPI', 'SPA-Frontend']
)

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed > 0 ? 1 : 0)
