
const __roots = require('../../paths') // portable roots (KURU_*_ROOT) — see paths.js
// /root/agents/offensive-vaccine.js
// Offensive Vaccine — converts pentest findings into defensive actions + verification commands
// Inspired by Decepticon's "Offensive Vaccine" model
// Universal: works for all squads

const fs = require('fs')
const path = require('path')

const INTEL_DIR = __roots.INTEL_ROOT

/**
 * Defense mapping: finding category → remediation template + verification
 */
const DEFENSE_MAP = {
  // Web Security
  'cors': {
    category: 'CORS Misconfiguration',
    remediation: 'Restrict Access-Control-Allow-Origin to explicit trusted domains. Remove wildcard (*). Set Access-Control-Allow-Credentials: false unless needed.',
    config: {
      nginx: 'add_header Access-Control-Allow-Origin "https://trusted-domain.com" always;\nadd_header Access-Control-Allow-Credentials "false" always;',
      apache: 'Header set Access-Control-Allow-Origin "https://trusted-domain.com"\nHeader set Access-Control-Allow-Credentials "false"',
    },
    verify: 'curl -s -D- -o /dev/null -H "Origin: https://evil.com" TARGET_URL | grep -i "access-control-allow-origin"',
    expected: 'Should NOT reflect evil.com. Should show trusted domain or be absent.',
  },
  'csrf': {
    category: 'Cross-Site Request Forgery',
    remediation: 'Implement CSRF tokens on all state-changing forms. Use SameSite=Strict on session cookies. Validate Origin/Referer headers server-side.',
    config: {
      generic: '// Add to form rendering:\n<input type="hidden" name="_csrf" value="<%= csrfToken %>">\n// Add to session cookie:\nSet-Cookie: session=xxx; SameSite=Strict; Secure; HttpOnly',
    },
    verify: 'curl -s -X POST TARGET_URL -d "param=value" -H "Origin: https://evil.com" | grep -i "forbidden\\|csrf\\|invalid token"',
    expected: 'Should return 403 Forbidden or CSRF validation error.',
  },
  'xss': {
    category: 'Cross-Site Scripting',
    remediation: 'Encode all user input on output. Implement Content-Security-Policy header. Use HttpOnly flag on session cookies.',
    config: {
      nginx: "add_header Content-Security-Policy \"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'\" always;",
      apache: "Header set Content-Security-Policy \"default-src 'self'; script-src 'self'\"",
    },
    verify: 'curl -s "TARGET_URL?param=<script>alert(1)</script>" | grep -c "<script>alert"',
    expected: 'Should return 0 (payload encoded/stripped). CSP header should be present.',
  },
  'sqli': {
    category: 'SQL Injection',
    remediation: 'Use parameterized queries/prepared statements. Implement input validation. Use ORM instead of raw SQL.',
    config: {
      generic: "// Replace:\nquery = \"SELECT * FROM users WHERE id = '\" + userId + \"'\"\n// With:\nquery = \"SELECT * FROM users WHERE id = ?\"\nparams = [userId]",
    },
    verify: "curl -s \"TARGET_URL?id=1'%20OR%201=1--\" | grep -i \"error\\|syntax\\|mysql\\|sql\"",
    expected: 'Should return normal response (not SQL error). Input should be sanitized.',
  },
  'missing_headers': {
    category: 'Missing Security Headers',
    remediation: 'Add security headers: X-Frame-Options, X-Content-Type-Options, Strict-Transport-Security, Content-Security-Policy, X-XSS-Protection.',
    config: {
      nginx: 'add_header X-Frame-Options "DENY" always;\nadd_header X-Content-Type-Options "nosniff" always;\nadd_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;\nadd_header Referrer-Policy "strict-origin-when-cross-origin" always;',
      apache: 'Header set X-Frame-Options "DENY"\nHeader set X-Content-Type-Options "nosniff"\nHeader set Strict-Transport-Security "max-age=31536000; includeSubDomains"',
    },
    verify: 'curl -s -D- -o /dev/null TARGET_URL | grep -iE "x-frame-options|x-content-type|strict-transport|content-security-policy"',
    expected: 'All four headers should be present in response.',
  },
  'rate_limiting': {
    category: 'Missing Rate Limiting',
    remediation: 'Implement rate limiting on authentication endpoints. Use progressive delays or account lockout after N failed attempts.',
    config: {
      nginx: 'limit_req_zone $binary_remote_addr zone=login:10m rate=5r/m;\nlocation /login {\n  limit_req zone=login burst=3 nodelay;\n}',
    },
    verify: 'for i in $(seq 1 10); do curl -s -o /dev/null -w "%{http_code}\\n" -X POST TARGET_URL -d "user=test&pass=wrong$i"; done | sort | uniq -c',
    expected: 'Should see 429 (Too Many Requests) after 5th attempt.',
  },
  'file_upload': {
    category: 'Unrestricted File Upload',
    remediation: 'Validate file type server-side (not just extension). Limit file size. Store uploads outside web root. Rename files with random names. Scan for malware.',
    config: {
      generic: '// Server-side validation:\nconst ALLOWED_TYPES = ["image/jpeg", "image/png", "application/pdf"];\nif (!ALLOWED_TYPES.includes(file.mimetype)) reject();\nif (file.size > 5 * 1024 * 1024) reject(); // 5MB max\n// Rename: const filename = crypto.randomUUID() + path.extname(file.name);',
    },
    verify: 'curl -s -X POST TARGET_URL -F "file=@/tmp/test.php;type=application/x-php" | grep -i "rejected\\|invalid\\|not allowed"',
    expected: 'Should reject PHP file upload. Only allow whitelisted types.',
  },
  'info_disclosure': {
    category: 'Information Disclosure',
    remediation: 'Disable verbose errors in production. Remove server version headers. Set customErrors=On (ASP.NET). Disable stack traces.',
    config: {
      aspnet: '<system.web>\n  <customErrors mode="On" defaultRedirect="~/Error" />\n  <compilation debug="false" />\n</system.web>',
      nginx: 'server_tokens off;',
    },
    verify: 'curl -s TARGET_URL/nonexistent | grep -ciE "stack trace\\|exception\\|at System\\.|at Microsoft\\."',
    expected: 'Should return 0 (no stack traces in error pages).',
  },
  'open_redirect': {
    category: 'Open Redirect',
    remediation: 'Validate redirect URLs against whitelist of allowed domains. Use relative paths only. Never embed user input in redirect targets.',
    config: {
      generic: '// Validate redirect:\nconst ALLOWED_HOSTS = ["app.example.com", "auth.example.com"];\nconst url = new URL(redirectUrl);\nif (!ALLOWED_HOSTS.includes(url.hostname)) reject();',
    },
    verify: 'curl -s -D- -o /dev/null "TARGET_URL?redirect=https://evil.com" | grep -i "location:" | grep -c "evil.com"',
    expected: 'Should return 0 (redirect to evil.com blocked).',
  },
  'auth_bypass': {
    category: 'Authentication Bypass',
    remediation: 'Enforce authentication on all sensitive endpoints. Use middleware/filters consistently. Audit all routes for missing auth checks.',
    config: {
      generic: '// Add auth middleware to ALL sensitive routes:\napp.use("/admin/*", requireAuth);\napp.use("/api/*", requireAuth);\n// ASP.NET: Add [Authorize] attribute to all controllers',
    },
    verify: 'curl -s -o /dev/null -w "%{http_code}" TARGET_URL',
    expected: 'Should return 401 or 302 (redirect to login), not 200.',
  },
  'user_enumeration': {
    category: 'User Enumeration',
    remediation: 'Return identical responses for valid and invalid usernames. Use generic error messages like "Invalid credentials".',
    config: {
      generic: '// Replace:\nif (!user) return "User not found";\nif (!validPassword) return "Wrong password";\n// With:\nreturn "Invalid username or password";',
    },
    verify: 'diff <(curl -s -X POST TARGET_URL -d "user=admin&pass=x" | wc -c) <(curl -s -X POST TARGET_URL -d "user=nonexist999&pass=x" | wc -c)',
    expected: 'Response sizes should be identical for valid and invalid usernames.',
  },
}

/**
 * Match a finding to a defense category
 */
function categorize(finding) {
  const text = ((finding.action || '') + ' ' + (finding.details || '')).toLowerCase()

  if (text.includes('cors') || text.includes('origin reflect') || text.includes('access-control')) return 'cors'
  if (text.includes('csrf') || text.includes('cross-site request')) return 'csrf'
  if (text.includes('xss') || text.includes('cross-site script') || text.includes('javascript:')) return 'xss'
  if (text.includes('sqli') || text.includes('sql injection') || text.includes('sql inject')) return 'sqli'
  if (text.includes('missing') && (text.includes('header') || text.includes('x-frame') || text.includes('csp'))) return 'missing_headers'
  if (text.includes('rate limit') || text.includes('brute force') || text.includes('no lockout')) return 'rate_limiting'
  if (text.includes('file upload') || text.includes('upload') || text.includes('webshell')) return 'file_upload'
  if (text.includes('verbose') || text.includes('stack trace') || text.includes('disclosure') || text.includes('customErrors')) return 'info_disclosure'
  if (text.includes('open redirect') || text.includes('redirect')) return 'open_redirect'
  if (text.includes('auth bypass') || text.includes('without auth') || text.includes('unauthenticated') || text.includes('bfla')) return 'auth_bypass'
  if (text.includes('user enum') || text.includes('username enum') || text.includes('enumeration')) return 'user_enumeration'

  return null
}

/**
 * Generate defensive actions from task findings
 * Called after KRIPA validation, before VYASA report
 */
function generateDefensiveActions(taskId, targetUrl) {
  const activityLog = path.join(INTEL_DIR, 'ACTIVITY-LOG.jsonl')
  if (!fs.existsSync(activityLog)) return []

  // Read confirmed findings for this task
  const lines = fs.readFileSync(activityLog, 'utf-8').split('\n').filter(Boolean)
  const confirmed = []
  for (const line of lines) {
    try {
      const e = JSON.parse(line)
      if (String(e.taskId) !== String(taskId)) continue
      const action = (e.action || '').toUpperCase()
      if ((action.includes('CONFIRMED') && action.includes('FINDING')) || (e.agent === 'KRIPA' && action.includes('CONFIRMED'))) {
        confirmed.push(e)
      }
    } catch {}
  }

  if (confirmed.length === 0) return []

  // Generate defensive actions
  const actions = []
  const seenCategories = new Set()

  for (const finding of confirmed) {
    const category = categorize(finding)
    if (!category || seenCategories.has(category)) continue
    seenCategories.add(category)

    const defense = DEFENSE_MAP[category]
    if (!defense) continue

    const verifyCmd = defense.verify.replace(/TARGET_URL/g, targetUrl)

    actions.push({
      finding_id: `${finding.agent}-${category}`,
      finding_summary: (finding.action || '').replace(/CONFIRMED.*?:\s*/, '').slice(0, 120),
      category: defense.category,
      remediation: defense.remediation,
      config: defense.config,
      verify_command: verifyCmd,
      expected_result: defense.expected,
      priority: ['sqli', 'file_upload', 'auth_bypass', 'xss'].includes(category) ? 'CRITICAL' :
                ['cors', 'csrf', 'rate_limiting'].includes(category) ? 'HIGH' : 'MEDIUM',
    })
  }

  // Sort by priority
  const priorityOrder = { CRITICAL: 0, HIGH: 1, MEDIUM: 2 }
  actions.sort((a, b) => (priorityOrder[a.priority] || 3) - (priorityOrder[b.priority] || 3))

  // Save to file
  const outputPath = path.join(INTEL_DIR, `defensive-actions-${taskId}.json`)
  fs.writeFileSync(outputPath, JSON.stringify(actions, null, 2))

  return actions
}

/**
 * Format defensive actions for VYASA report injection
 */
function formatForReport(actions) {
  if (!actions || actions.length === 0) return ''

  let text = '\n## DEFENSIVE ACTIONS — Remediation + Verification\n'
  text += 'For each finding below: apply the fix, then run the verification command to confirm.\n\n'

  for (const action of actions) {
    text += `### [${action.priority}] ${action.category}\n`
    text += `**Finding:** ${action.finding_summary}\n`
    text += `**Remediation:** ${action.remediation}\n`

    // Pick first available config
    const configType = Object.keys(action.config)[0]
    if (configType) {
      text += `**Config (${configType}):**\n\`\`\`\n${action.config[configType]}\n\`\`\`\n`
    }

    text += `**Verify fix:**\n\`\`\`bash\n${action.verify_command}\n\`\`\`\n`
    text += `**Expected:** ${action.expected_result}\n\n`
  }

  return text
}

module.exports = {
  generateDefensiveActions,
  formatForReport,
  categorize,
  DEFENSE_MAP,
}
