#!/usr/bin/env node

const __roots = require('../../paths') // portable roots (KURU_*_ROOT) — see paths.js
// Train from external vulnerability report — extract candidate techniques from a
// markdown/text file or URL, ask the user per-candidate, append approved entries
// to the target squad's lessons file.
//
// Borrowed from ARCHON_V0's "Train the framework" command (2026-04-23). Deterministic
// heuristic extraction (section-split on markdown headings). No LLM call — the
// operator is the final judge, and each candidate is a suggestion, not a claim.
//
// Usage:
//   node train-from-report.js <file-or-url> [--squad pentest-squad|stocks-squad|cloud-security|network-pentest]
//   node train-from-report.js report.md --squad pentest-squad --yes-to-all    # accept every candidate (testing only)
//   node train-from-report.js report.md --dry-run                              # extract only, don't prompt, don't write
//
// Output location: /root/intel/squad-lessons-<squad>.md (append-only)

const fs = require('fs')
const path = require('path')
const readline = require('readline')
const { execFileSync } = require('child_process')

const VALID_SQUADS = ['pentest-squad', 'stocks-squad', 'cloud-security', 'network-pentest', 'red-team']
const VALID_CATEGORIES = [
  'access_control', 'account_takeover', 'xss', 'sqli', 'ssrf',
  'rce', 'lfi', 'xxe', 'csrf', 'ssti', 'api_security', 'cloud', 'network', 'general',
]

function parseArgs(argv) {
  const args = { src: null, squad: 'pentest-squad', yesToAll: false, dryRun: false }
  for (const a of argv.slice(2)) {
    if (a === '--yes-to-all') args.yesToAll = true
    else if (a === '--dry-run') args.dryRun = true
    else if (a.startsWith('--squad')) {
      const [, v] = a.split('=')
      if (v) args.squad = v
    } else if (!args.src) args.src = a
    else if (VALID_SQUADS.includes(a)) args.squad = a
  }
  return args
}

function fetchSource(srcArg) {
  if (!srcArg) throw new Error('missing source file or URL')
  if (/^https?:\/\//i.test(srcArg)) {
    // Download to temp file via curl (already on PATH, battle-tested, respects redirects)
    const tmpFile = `/tmp/train-src-${Date.now()}.md`
    execFileSync('curl', ['-sL', '-o', tmpFile, '--max-time', '30', srcArg], { timeout: 35000 })
    const content = fs.readFileSync(tmpFile, 'utf-8')
    try { fs.unlinkSync(tmpFile) } catch {}
    return { content, source: srcArg }
  }
  if (!fs.existsSync(srcArg)) throw new Error(`file not found: ${srcArg}`)
  return { content: fs.readFileSync(srcArg, 'utf-8'), source: path.resolve(srcArg) }
}

// Heuristic: split on markdown headings (##, ###) and treat each section as a candidate.
// Minimum length filter avoids noise (section titles alone).
function extractCandidates(content) {
  const candidates = []
  const lines = content.split('\n')
  let buffer = []
  let title = null
  const flush = () => {
    if (!title) return
    const body = buffer.join('\n').trim()
    if (body.length < 80) return
    candidates.push({
      title: title.slice(0, 120),
      body: body.slice(0, 4000),
      category: inferCategory(title + ' ' + body),
    })
  }
  for (const line of lines) {
    const m = line.match(/^(#{2,4})\s+(.+)$/)
    if (m) {
      flush()
      title = m[2].trim()
      buffer = []
    } else {
      buffer.push(line)
    }
  }
  flush()
  return candidates
}

// Weak heuristic — ranks categories by keyword density. Operator can override.
function inferCategory(text) {
  const t = text.toLowerCase()
  const scores = {
    sqli: (t.match(/\bsql\s*injection|\bsqli\b|union\s+select|\bwhere\s+\d+=\d+|sleep\s*\(|benchmark\(/g) || []).length,
    xss: (t.match(/\bxss\b|cross[- ]site scripting|innerhtml|dompurify|script\s*tag|onerror=|javascript:/g) || []).length,
    ssrf: (t.match(/\bssrf\b|server[- ]side request|127\.0\.0\.1|169\.254|metadata endpoint/g) || []).length,
    rce: (t.match(/\brce\b|remote code exec|command injection|shell injection|\$\{.*\}.*exec/g) || []).length,
    lfi: (t.match(/\blfi\b|local file inclusion|path traversal|\.\.\/\.\.\//g) || []).length,
    xxe: (t.match(/\bxxe\b|xml external entity|doctype.*system|<!entity/g) || []).length,
    csrf: (t.match(/\bcsrf\b|cross[- ]site request forgery|samesite|token validation/g) || []).length,
    ssti: (t.match(/\bssti\b|server[- ]side template|template injection|jinja|twig/g) || []).length,
    access_control: (t.match(/idor|broken access|authorization bypass|privilege escalation|bola|bfla/g) || []).length,
    account_takeover: (t.match(/account takeover|ato\b|oauth|password reset|session hijack|2fa bypass|saml/g) || []).length,
    cloud: (t.match(/\baws\b|s3 bucket|iam policy|gcp\b|azure\b|kubernetes|k8s/g) || []).length,
    network: (t.match(/kerberoast|active directory|smb relay|ldap anon|ntlm|responder|mitm6|impacket/g) || []).length,
    api_security: (t.match(/graphql|jwt|rest api|openapi|swagger|broken object-level/g) || []).length,
  }
  let best = 'general', bestScore = 0
  for (const [cat, score] of Object.entries(scores)) {
    if (score > bestScore) { best = cat; bestScore = score }
  }
  return best
}

async function promptPerCandidate(candidates, { yesToAll }) {
  if (yesToAll) return candidates.map(c => ({ ...c, decision: 'y' }))
  if (!process.stdin.isTTY) {
    console.error('stdin is not a TTY — use --yes-to-all for non-interactive runs')
    return candidates.map(c => ({ ...c, decision: 'n' }))
  }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  const q = (prompt) => new Promise(res => rl.question(prompt, res))
  const decisions = []
  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i]
    console.log(`\n─── Candidate ${i + 1}/${candidates.length} ──────────────────────────`)
    console.log(`Title:    ${c.title}`)
    console.log(`Category: ${c.category} (inferred)`)
    console.log(`Preview:  ${c.body.slice(0, 240).replace(/\n/g, ' ')}${c.body.length > 240 ? '…' : ''}`)
    const ans = (await q(`[Y] save  [N] skip  [E] edit category  [Q] quit and save accepted so far > `)).trim().toLowerCase()
    if (ans === 'q') break
    if (ans === 'e') {
      const newCat = (await q(`New category (${VALID_CATEGORIES.join('/')}): `)).trim().toLowerCase()
      if (VALID_CATEGORIES.includes(newCat)) c.category = newCat
      decisions.push({ ...c, decision: 'y' })
    } else if (ans === 'y') {
      decisions.push({ ...c, decision: 'y' })
    } else {
      decisions.push({ ...c, decision: 'n' })
    }
  }
  rl.close()
  return decisions
}

function appendToLessons(squad, approved, source) {
  const file = `${__roots.INTEL_ROOT}/squad-lessons-${squad}.md`
  const now = new Date().toISOString().slice(0, 10)
  const entry = [
    '',
    `### ${now} — Trained from ${source}`,
  ]
  for (const a of approved) {
    const oneLine = a.body.replace(/\n/g, ' ').replace(/\s+/g, ' ').slice(0, 320)
    entry.push(`- **[${a.category}]** ${a.title} — ${oneLine}`)
  }
  entry.push('')
  fs.appendFileSync(file, entry.join('\n'))
  return file
}

async function main() {
  const args = parseArgs(process.argv)
  if (!args.src) {
    console.error('usage: train-from-report.js <file-or-url> [--squad <name>] [--yes-to-all] [--dry-run]')
    process.exit(2)
  }
  if (!VALID_SQUADS.includes(args.squad)) {
    console.error(`invalid --squad: ${args.squad}. Valid: ${VALID_SQUADS.join(', ')}`)
    process.exit(2)
  }
  const { content, source } = fetchSource(args.src)
  console.log(`Loaded ${content.length} chars from ${source}`)
  const candidates = extractCandidates(content)
  console.log(`Extracted ${candidates.length} candidate section(s)`)
  if (candidates.length === 0) {
    console.log('No candidates found (need sections >80 chars with ## headings). Exiting.')
    return
  }
  if (args.dryRun) {
    console.log('\n--- DRY RUN ---')
    for (const c of candidates) {
      console.log(`  [${c.category}] ${c.title}`)
    }
    return
  }
  const decisions = await promptPerCandidate(candidates, { yesToAll: args.yesToAll })
  const approved = decisions.filter(d => d.decision === 'y')
  if (approved.length === 0) {
    console.log('\nNo candidates approved. Nothing written.')
    return
  }
  const file = appendToLessons(args.squad, approved, source)
  console.log(`\n✅ Appended ${approved.length} entry(ies) to ${file}`)
}

if (require.main === module) {
  main().catch(err => { console.error('ERROR:', err.message); process.exit(1) })
}

module.exports = { parseArgs, fetchSource, extractCandidates, inferCategory, appendToLessons }
